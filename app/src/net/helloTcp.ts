/**
 * GET /hello over AuthDeck's own TCP on native platforms: React Native's fetch would inflate a
 * compressed body in native code with no limit. Reads at most MAX_HELLO_BYTES in all, headers
 * included, and accepts only a 200 with no content encoding, delimited by a Content-Length or
 * chunked (Node sends the agent's /hello chunked).
 */
import { utf8Decode, utf8Encode } from '../vault/bytes';
import { readResponseHead, type ResponseHead } from './httpHead';
import type { ByteStream, TcpTransport } from './tcp';

const DECIMAL = /^\d{1,7}$/;
const CHUNK_SIZE_LINE = /^([0-9a-fA-F]{1,4})\r\n/;
/** The longest chunk-size line: four hex digits and CRLF. */
const CHUNK_SIZE_LINE_MAX = 6;

/**
 * Reads one answer may take. The agent's answer comes in one or two; a peer dripping it a byte per
 * read would otherwise cost the JS thread one event per byte, on every address of a sweep.
 */
export const MAX_HELLO_READS = 64;

function helloRequest(host: string, port: number, path: string): string {
  const name = host.includes(':') ? `[${host}]` : host;
  return [`GET ${path} HTTP/1.1`, `Host: ${name}:${port}`, 'Connection: close', 'Accept-Encoding: identity', '', ''].join('\r\n');
}

/** How the body is delimited: a Content-Length, or chunked (how Node sends the agent's /hello). */
type BodyFraming = { kind: 'length'; length: number } | { kind: 'chunked' };

/** How a plain 200 delimits its body, or null for any other answer (another status, any encoding). */
export function bodyFraming(head: ResponseHead): BodyFraming | null {
  if (head.status !== 200) return null;
  // Any content encoding is refused, identity included: the agent sends none.
  if (head.headers.has('content-encoding')) return null;
  const transfer = head.headers.get('transfer-encoding');
  const length = head.headers.get('content-length');
  if (transfer) {
    // Chunked only splits the body: every byte still counts against the cap, so nothing inflates.
    return transfer.length === 1 && transfer[0]!.toLowerCase() === 'chunked' && !length ? { kind: 'chunked' } : null;
  }
  return length?.length === 1 && DECIMAL.test(length[0]!) ? { kind: 'length', length: Number(length[0]) } : null;
}

const latin1 = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

/** The whole body once it has arrived, 'incomplete' before, or null when it can't be right. */
type BodyRead = Uint8Array | 'incomplete' | null;

/**
 * Strict chunked decoding as the body arrives: hex sizes with no extensions, no trailers, nothing
 * after the last chunk. It keeps its place between reads, so each read costs only its new bytes
 * (and at most one partial size line again), never the body from its start.
 */
export class ChunkedDecoder {
  private readonly parts: Uint8Array[] = [];
  /** Where the next chunk-size line starts. */
  private at = 0;

  /**
   * `body` is every body byte so far, the same bytes as last time plus the new ones; the parts kept
   * point into it, so the caller must not overwrite what it passed before.
   */
  read(body: Uint8Array): BodyRead {
    for (;;) {
      const line = CHUNK_SIZE_LINE.exec(latin1(body.subarray(this.at, this.at + CHUNK_SIZE_LINE_MAX)));
      if (!line) return this.partialSizeLine(body) ? 'incomplete' : null;
      const size = parseInt(line[1]!, 16);
      const dataAt = this.at + line[0].length;
      if (body.length < dataAt + size + 2) return 'incomplete';
      if (body[dataAt + size] !== 13 || body[dataAt + size + 1] !== 10) return null;
      if (size === 0) return dataAt + 2 === body.length ? joined(this.parts) : null;
      this.parts.push(body.subarray(dataAt, dataAt + size));
      this.at = dataAt + size + 2;
    }
  }

  /** True while what follows the last chunk could still become a size line. */
  private partialSizeLine(body: Uint8Array): boolean {
    const tail = body.subarray(this.at);
    return tail.length < CHUNK_SIZE_LINE_MAX && /^[0-9a-fA-F]*\r?$/.test(latin1(tail));
  }
}

function joined(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Reads a body of either framing as it arrives; `read` gets every body byte so far each time. */
function bodyReader(framing: BodyFraming): (body: Uint8Array) => BodyRead {
  if (framing.kind === 'chunked') {
    const decoder = new ChunkedDecoder();
    return (body) => decoder.read(body);
  }
  return (body) => {
    if (body.length > framing.length) return null;
    return body.length < framing.length ? 'incomplete' : body;
  };
}

/**
 * The body of `GET path` as text, or null for anything else: no answer within `timeoutMs`, a
 * response past `maxBytes` in all or past MAX_HELLO_READS reads, another status, an encoding, or a
 * body that isn't UTF-8.
 */
export function getTextOverTcp(transport: TcpTransport, host: string, port: number, path: string, timeoutMs: number, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    let stream: ByteStream | null = null;
    let settled = false;
    const received = new Uint8Array(maxBytes);
    let fill = 0;
    let reads = 0;
    /** How much of the head has been looked at already, so a trickled head is scanned once. */
    let headScanned = 0;
    let readBody: ((body: Uint8Array) => BodyRead) | null = null;
    let bodyStart = 0;

    const settle = (text: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      stream?.close();
      resolve(text);
    };
    const deadline = setTimeout(() => settle(null), timeoutMs);

    /** Reads the head once it is in; false when the answer was refused. */
    const startBody = (): boolean => {
      const read = readResponseHead(received.subarray(0, fill), maxBytes, headScanned);
      headScanned = fill;
      if (read.kind !== 'head') return read.kind === 'incomplete';
      const framing = bodyFraming(read.head);
      if (framing === null) return false;
      readBody = bodyReader(framing);
      bodyStart = fill - read.head.rest.length;
      return true;
    };

    const onData = (bytes: Uint8Array) => {
      if (fill + bytes.length > maxBytes || ++reads > MAX_HELLO_READS) return settle(null);
      received.set(bytes, fill);
      fill += bytes.length;
      stream?.ack(bytes.length);
      if (readBody === null && !startBody()) return settle(null);
      if (readBody === null) return;
      const body = readBody(received.subarray(bodyStart, fill));
      if (body === 'incomplete') return;
      if (body === null) return settle(null);
      try {
        settle(utf8Decode(body));
      } catch {
        settle(null);
      }
    };

    transport.connect(host, port, timeoutMs).then(
      (connected) => {
        if (settled) {
          connected.close();
          return;
        }
        stream = connected;
        connected.onData = onData;
        connected.onError = () => settle(null);
        connected.onClose = () => settle(null);
        connected.write(utf8Encode(helloRequest(host, port, path)));
      },
      () => settle(null),
    );
  });
}
