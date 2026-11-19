/**
 * A minimal RFC 6455 WebSocket client over AuthDeck's own TCP (tcp.ts), for the link on native
 * platforms. It offers no extensions (so nothing is ever compressed) and refuses a server that
 * names one, and it checks every frame's length from its header against `maxMessageBytes` before
 * keeping any of it. Shaped like the part of the browser WebSocket that client.ts uses.
 */
import { sha1 } from '@noble/hashes/legacy.js';

import type { RandomBytes } from '../vault/bytes';
import { bytesEqual, toBase64, utf8Encode } from '../vault/bytes';
import { headerTokens, readResponseHead, singleHeader } from './httpHead';
import type { ByteStream, TcpTransport } from './tcp';
import { CLOSE_CODE, FrameParser, OPCODE, type FrameEvent, type Opcode, closePayload, encodeClientFrame } from './wsFrames';

export const SOCKET_STATE = { connecting: 0, open: 1, closing: 2, closed: 3 } as const;

/** The upgrade response's head, blank line included, may be at most this long. */
export const MAX_UPGRADE_HEAD_BYTES = 8 * 1024;
/**
 * Received bytes not yet parsed. Native stops reading at MAX_UNACKED_BYTES (256 KiB) until JS acks;
 * a transport that ignored that would hit this and be dropped.
 */
export const MAX_UNPARSED_BYTES = 1024 * 1024;
/**
 * Frames the pump reads in one task when none reaches the consumer (pings, pongs, fragments), so a
 * stream of them can't hold the JS thread. The parser stops after every frame, so each counts.
 */
export const MAX_FRAMES_PER_TASK = 64;
/**
 * Pings and pongs allowed between the upgrade and the end of the link handshake. The agent pings
 * every 15 s and a handshake step times out after 8 s, so an honest computer sends two or three.
 */
export const MAX_HANDSHAKE_CONTROL_FRAMES = 4;
/**
 * Inside a session, pings may come at 10 a second, with bursts of up to 20: one past that is a
 * flood. The agent pings every 15 s.
 */
export const SESSION_PINGS_PER_SECOND = 10;
export const SESSION_PING_BURST = 2 * SESSION_PINGS_PER_SECOND;
/**
 * Pongs a session takes in all. AuthDeck never pings, so every pong answers nothing; the agent
 * sends none, and a peer sending them without end is only making the phone parse.
 */
export const MAX_SESSION_PONGS = 60;
/** Milliseconds from a clock that never jumps, so a wall-clock change can't refill the ping budget. */
const monotonicNow = (): number => performance.now();
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const KEY_BYTES = 16;

export interface SocketMessageEvent {
  data: ArrayBuffer | string;
}
export interface SocketCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}
/** `code` says why: 1006 the network, 1002 a protocol or upgrade problem, 1009 a size limit. */
export interface SocketErrorEvent {
  code: number;
  message: string;
}

/**
 * The part of a WebSocket the link uses: LinkSocket on native platforms, the browser's WebSocket
 * (browserSocket.ts) on the web.
 */
export interface FrameSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: SocketMessageEvent) => void) | null;
  onclose: ((ev: SocketCloseEvent) => void) | null;
  onerror: ((ev: SocketErrorEvent) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
  /**
   * The largest message accepted from here on. Checked from frame headers where the socket can.
   * The session calls it once the link handshake has finished, and LinkSocket takes that call as
   * the end of the handshake: its control-frame rules change from then on.
   */
  setMessageLimit(bytes: number): void;
}

export interface LinkSocketOptions {
  transport: TcpTransport;
  host: string;
  port: number;
  path: string;
  /** For the WebSocket key and the frame masks. */
  random: RandomBytes;
  /** The largest message accepted; can change later through `setMessageLimit`. */
  maxMessageBytes: number;
  /** How long the TCP connect and the WebSocket upgrade may take together. */
  connectTimeoutMs: number;
}

/** What the upgrade request's Host header names: IPv6 addresses in brackets. */
function hostHeader(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** The request line and headers of the upgrade. No Origin and no Sec-WebSocket-Extensions, ever. */
export function upgradeRequest(host: string, port: number, path: string, key: string): string {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${hostHeader(host, port)}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n');
}

export function expectedAccept(key: string): string {
  return toBase64(sha1(utf8Encode(key + WEBSOCKET_GUID)));
}

/** Why an upgrade response is refused, or null when it is a plain, extension-free 101. */
export function upgradeRefusal(head: Parameters<typeof headerTokens>[0], key: string): string | null {
  if (head.status !== 101) return `it answered with HTTP ${head.status}`;
  if (head.headers.has('sec-websocket-extensions')) return 'it asked for a WebSocket extension';
  if (head.headers.has('sec-websocket-protocol')) return 'it named a subprotocol';
  const upgrade = headerTokens(head, 'upgrade');
  if (upgrade.length !== 1 || upgrade[0] !== 'websocket') return 'its Upgrade header is wrong';
  if (!headerTokens(head, 'connection').includes('upgrade')) return 'its Connection header is wrong';
  const accept = singleHeader(head, 'sec-websocket-accept');
  if (accept === null || !bytesEqual(utf8Encode(accept), utf8Encode(expectedAccept(key)))) return 'its Sec-WebSocket-Accept is wrong';
  return null;
}

/** Bytes received and not yet parsed, acknowledged to the transport as they are used. */
class Inbox {
  /**
   * Chunks from `head` on are unused. A used chunk is passed over rather than shifted off: shift()
   * moves every chunk behind it on Hermes, and a peer sending a byte per read can queue thousands.
   */
  private chunks: Uint8Array[] = [];
  private head = 0;
  size = 0;

  constructor(private readonly ack: (bytes: number) => void) {}

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  first(): Uint8Array {
    return this.chunks[this.head]!;
  }

  use(bytes: number): void {
    let left = bytes;
    while (left > 0) {
      const chunk = this.chunks[this.head]!;
      if (chunk.length <= left) {
        this.head++;
        left -= chunk.length;
      } else {
        this.chunks[this.head] = chunk.subarray(left);
        left = 0;
      }
    }
    this.dropUsedChunks();
    this.size -= bytes;
    if (bytes > 0) this.ack(bytes);
  }

  /** Forgets used chunks once they are half the list, so dropping them costs O(1) per chunk overall. */
  private dropUsedChunks(): void {
    if (this.head === this.chunks.length) this.clearChunks();
    else if (this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  private clearChunks(): void {
    this.chunks.length = 0;
    this.head = 0;
  }

  clear(): void {
    this.clearChunks();
    this.size = 0;
  }
}

export class LinkSocket implements FrameSocket {
  readyState: number = SOCKET_STATE.connecting;
  onopen: (() => void) | null = null;
  onmessage: ((ev: SocketMessageEvent) => void) | null = null;
  onclose: ((ev: SocketCloseEvent) => void) | null = null;
  onerror: ((ev: SocketErrorEvent) => void) | null = null;

  private stream: ByteStream | null = null;
  private readonly random: RandomBytes;
  private readonly key: string;
  private readonly parser: FrameParser;
  private readonly inbox = new Inbox((bytes) => this.stream?.ack(bytes));
  private upgraded = false;
  /** The upgrade head so far, kept apart so each read copies and scans only the new bytes. */
  private readonly upgradeHead = new Uint8Array(MAX_UPGRADE_HEAD_BYTES);
  private upgradeHeadFill = 0;
  /** How much of the head the last look at it scanned. */
  private upgradeHeadScanned = 0;
  private upgradeTimer: ReturnType<typeof setTimeout> | null = null;
  /** A pump is waiting for the consumer to run before the next event is parsed. */
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The payload of the latest ping not yet answered; one pong per pump answers it (RFC 6455 5.5.3). */
  private unansweredPing: Uint8Array | null = null;
  /** The transport ended while bytes were still waiting: they are read before the close is reported. */
  private transportEnded = false;
  /** Set by the first setMessageLimit, which the session calls once the link handshake is done. */
  private inSession = false;
  private handshakeControlFrames = 0;
  private sessionPongs = 0;
  private pingBudget = SESSION_PING_BURST;
  private pingBudgetAt = 0;

  constructor(private readonly options: LinkSocketOptions) {
    this.random = options.random;
    this.key = toBase64(options.random(KEY_BYTES));
    this.parser = new FrameParser(options.maxMessageBytes);
    this.upgradeTimer = setTimeout(() => this.fail(CLOSE_CODE.abnormal, 'The computer did not finish the WebSocket upgrade in time.'), options.connectTimeoutMs);
    void this.start();
  }

  /**
   * Checked against each frame header from here on, before any of its payload is kept. Also ends
   * the handshake's control-frame rule; the session's rules apply from now on.
   */
  setMessageLimit(bytes: number): void {
    this.parser.maxMessageBytes = bytes;
    if (this.inSession) return;
    this.inSession = true;
    this.pingBudgetAt = monotonicNow();
  }

  /** Sends one binary message. Does nothing unless open, like the browser's once closed. */
  send(data: Uint8Array): void {
    if (this.readyState !== SOCKET_STATE.open) return;
    this.writeFrame(OPCODE.binary, data);
  }

  close(): void {
    if (this.readyState === SOCKET_STATE.closed) return;
    if (this.upgraded) this.writeFrame(OPCODE.close, closePayload(CLOSE_CODE.normal));
    this.end({ code: CLOSE_CODE.normal, reason: '', wasClean: this.upgraded }, null);
  }

  private async start(): Promise<void> {
    const { transport, host, port, path, connectTimeoutMs } = this.options;
    let stream: ByteStream;
    try {
      stream = await transport.connect(host, port, connectTimeoutMs);
    } catch (err) {
      this.fail(CLOSE_CODE.abnormal, `Could not connect: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (this.readyState === SOCKET_STATE.closed) {
      stream.close();
      return;
    }
    this.stream = stream;
    stream.onData = (bytes) => this.receive(bytes);
    stream.onError = (message) => this.fail(CLOSE_CODE.abnormal, message);
    stream.onClose = () => this.transportClosed();
    stream.write(utf8Encode(upgradeRequest(host, port, path, this.key)));
  }

  private receive(bytes: Uint8Array): void {
    if (this.readyState === SOCKET_STATE.closed) return;
    this.inbox.push(bytes);
    if (!this.upgraded) this.keepUpgradeHead(bytes);
    if (this.inbox.size > MAX_UNPARSED_BYTES) {
      this.fail(CLOSE_CODE.tooBig, 'More data arrived than AuthDeck reads at once.');
      return;
    }
    if (this.resumeTimer === null) this.pump();
  }

  /**
   * The peer or the network ended the connection. Frames already received (a close, say) still
   * count: they are read first, so a close that came just before the FIN stays a clean close.
   */
  private transportClosed(): void {
    if (!this.upgraded || this.inbox.size === 0) {
      this.fail(CLOSE_CODE.abnormal, 'The connection closed.');
      return;
    }
    this.transportEnded = true;
    this.stream = null;
  }

  /**
   * Parses until the bytes run out, an event reaches the consumer, or MAX_FRAMES_PER_TASK frames
   * have been read. Then the rest waits for a fresh task, so the consumer's own continuation
   * (setting the next limit) runs first, and a stream of control frames can't hold the thread.
   */
  private pump(): void {
    if (!this.upgraded) {
      this.readUpgrade();
      return;
    }
    for (let frames = 0; this.readyState !== SOCKET_STATE.closed && this.inbox.size > 0; frames++) {
      if (frames === MAX_FRAMES_PER_TASK) break;
      const { used, event } = this.parser.consume(this.inbox.first());
      this.inbox.use(used);
      if (event && this.handle(event)) break;
    }
    this.answerPing();
    this.resumeLater();
  }

  /** Continues in a fresh task while bytes wait; once none do, reports a transport that ended. */
  private resumeLater(): void {
    if (this.readyState === SOCKET_STATE.closed) return;
    if (this.inbox.size === 0) {
      if (this.transportEnded) this.fail(CLOSE_CODE.abnormal, 'The connection closed.');
      return;
    }
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.pump();
    }, 0);
  }

  /** Copies the new bytes of the upgrade head; past the head's limit nothing more is needed. */
  private keepUpgradeHead(bytes: Uint8Array): void {
    const take = bytes.subarray(0, MAX_UPGRADE_HEAD_BYTES - this.upgradeHeadFill);
    this.upgradeHead.set(take, this.upgradeHeadFill);
    this.upgradeHeadFill += take.length;
  }

  /** Reads the upgrade response once its head is in; opens, or fails on anything unexpected. */
  private readUpgrade(): void {
    const head = this.upgradeHead.subarray(0, this.upgradeHeadFill);
    const read = readResponseHead(head, MAX_UPGRADE_HEAD_BYTES, this.upgradeHeadScanned);
    this.upgradeHeadScanned = head.length;
    if (read.kind === 'incomplete') return;
    if (read.kind === 'refused') {
      this.fail(CLOSE_CODE.protocolError, `The computer's answer is not a WebSocket upgrade: ${read.reason}.`);
      return;
    }
    const refusal = upgradeRefusal(read.head, this.key);
    if (refusal) {
      this.fail(CLOSE_CODE.protocolError, `The computer's WebSocket upgrade was refused: ${refusal}.`);
      return;
    }
    this.inbox.use(head.length - read.head.rest.length);
    this.stopUpgradeTimer();
    this.upgraded = true;
    this.readyState = SOCKET_STATE.open;
    this.onopen?.();
    // Frames sent right behind the upgrade wait until the consumer has set its handlers.
    this.resumeLater();
  }

  /** Acts on one event; true when it reached the consumer. */
  private handle(event: FrameEvent): boolean {
    switch (event.kind) {
      case 'message':
        this.onmessage?.({ data: typeof event.data === 'string' ? event.data : copyToArrayBuffer(event.data) });
        return true;
      case 'ping':
      case 'pong':
        return this.controlFrame(event);
      case 'close':
        // A ping just before the close still gets its pong, ahead of the close frame.
        this.answerPing();
        this.writeFrame(OPCODE.close, closePayload(CLOSE_CODE.normal));
        this.end({ code: event.code, reason: event.reason, wasClean: true }, null);
        return true;
      case 'fail':
        this.fail(event.code, `The computer sent ${event.reason}.`);
        return true;
    }
  }

  /**
   * Notes a ping (answered later, by answerPing) or a pong; true when it broke a control-frame
   * rule and ended the socket.
   */
  private controlFrame(event: { kind: 'ping'; payload: Uint8Array } | { kind: 'pong' }): boolean {
    const refusal = this.inSession ? this.sessionControlRefusal(event.kind) : this.handshakeControlRefusal();
    if (refusal) {
      this.fail(CLOSE_CODE.policyViolation, `The computer sent ${refusal}.`);
      return true;
    }
    if (event.kind === 'ping') this.unansweredPing = event.payload;
    return false;
  }

  private handshakeControlRefusal(): string | null {
    this.handshakeControlFrames++;
    return this.handshakeControlFrames > MAX_HANDSHAKE_CONTROL_FRAMES ? 'more pings or pongs than a link handshake ever needs' : null;
  }

  private sessionControlRefusal(kind: 'ping' | 'pong'): string | null {
    if (kind === 'pong') {
      this.sessionPongs++;
      return this.sessionPongs > MAX_SESSION_PONGS ? 'more pongs than AuthDeck ever asked for' : null;
    }
    const now = monotonicNow();
    this.pingBudget = Math.min(SESSION_PING_BURST, this.pingBudget + ((now - this.pingBudgetAt) * SESSION_PINGS_PER_SECOND) / 1000);
    this.pingBudgetAt = now;
    if (this.pingBudget < 1) return 'pings far faster than AuthDeck Agent sends them';
    this.pingBudget -= 1;
    return null;
  }

  /** One pong for the latest ping since the last; RFC 6455 5.5.3 lets the earlier ones go unanswered. */
  private answerPing(): void {
    const payload = this.unansweredPing;
    this.unansweredPing = null;
    if (payload && this.readyState === SOCKET_STATE.open) this.writeFrame(OPCODE.pong, payload);
  }

  private stopUpgradeTimer(): void {
    if (this.upgradeTimer !== null) clearTimeout(this.upgradeTimer);
    this.upgradeTimer = null;
  }

  private writeFrame(opcode: Opcode, payload: Uint8Array): void {
    this.stream?.write(encodeClientFrame(opcode, payload, this.random(4)));
  }

  /** Ends the socket for a broken protocol, a limit or the network: a close frame first when open. */
  private fail(code: number, message: string): void {
    if (this.readyState === SOCKET_STATE.closed) return;
    if (this.upgraded && code !== CLOSE_CODE.abnormal) this.writeFrame(OPCODE.close, closePayload(code));
    this.end({ code, reason: message, wasClean: false }, { code, message });
  }

  private end(close: SocketCloseEvent, error: SocketErrorEvent | null): void {
    this.readyState = SOCKET_STATE.closed;
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.stopUpgradeTimer();
    this.unansweredPing = null;
    this.inbox.clear();
    const stream = this.stream;
    this.stream = null;
    stream?.close();
    if (error) this.onerror?.(error);
    this.onclose?.(close);
  }
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}
