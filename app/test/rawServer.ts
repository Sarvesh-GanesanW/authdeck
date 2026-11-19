/// <reference types="node" />
/**
 * A scripted server on raw TCP for the LinkSocket and /hello tests: it answers each connection's
 * request head however a test says, and can send any bytes, well-formed frames or not.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import { WS_PATH } from '../src/protocol';
import { LinkSocket, type SocketCloseEvent, type SocketErrorEvent } from '../src/net/linkSocket';
import { nodeTcp } from './native';

export const LOOPBACK = '127.0.0.1';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const acceptFor = (key: string): string => crypto.createHash('sha1').update(key + GUID).digest('base64');

/** A standard 101 for the request's key, with `extra` header lines added. */
export function upgradeResponse(key: string, extra: string[] = [], accept = acceptFor(key)): string {
  return ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, ...extra, '', ''].join('\r\n');
}

export interface FrameOptions {
  fin?: boolean;
  /** Reserved bits, 0 to 7. */
  rsv?: number;
  mask?: boolean;
  /** A declared length other than the payload's (the payload is sent as given). */
  declared?: bigint;
  /** Force the 16- or 64-bit length form. */
  form?: 7 | 16 | 64;
}

/** One frame as a server could send it, including ones RFC 6455 forbids. */
export function frame(opcode: number, payload: Uint8Array | string = new Uint8Array(0), options: FrameOptions = {}): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload);
  const length = options.declared ?? BigInt(body.length);
  const form = options.form ?? (length < 126n ? 7 : length <= 0xffffn ? 16 : 64);
  const first = ((options.fin ?? true) ? 0x80 : 0) | ((options.rsv ?? 0) << 4) | opcode;
  const maskBit = options.mask ? 0x80 : 0;
  let header: Buffer;
  if (form === 7) header = Buffer.from([first, maskBit | Number(length)]);
  else if (form === 16) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = maskBit | 126;
    header.writeUInt16BE(Number(length), 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(length, 2);
  }
  if (!options.mask) return Buffer.concat([header, body]);
  const key = crypto.randomBytes(4);
  return Buffer.concat([header, key, Buffer.from(body.map((b, i) => b ^ key[i & 3]!))]);
}

export interface ClientFrame {
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

/** Splits what the client sent after its upgrade request into frames, unmasked. */
export function clientFrames(bytes: Buffer): ClientFrame[] {
  const frames: ClientFrame[] = [];
  let at = 0;
  while (at + 2 <= bytes.length) {
    const opcode = bytes[at]! & 0x0f;
    const masked = (bytes[at + 1]! & 0x80) !== 0;
    let length = bytes[at + 1]! & 0x7f;
    at += 2;
    if (length === 126) {
      length = bytes.readUInt16BE(at);
      at += 2;
    } else if (length === 127) {
      length = Number(bytes.readBigUInt64BE(at));
      at += 8;
    }
    const key = masked ? bytes.subarray(at, at + 4) : null;
    if (masked) at += 4;
    const payload = Buffer.from(bytes.subarray(at, at + length));
    if (key) for (let i = 0; i < payload.length; i++) payload[i]! ^= key[i & 3]!;
    frames.push({ opcode, masked, payload });
    at += length;
  }
  return frames;
}

export interface Conversation {
  socket: net.Socket;
  /** The request head the client sent. */
  head: string;
  key: string;
  /** Everything the client sent after its head, so far. */
  received: () => Buffer;
}

export interface RawServer {
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}

/** Calls `script` once each connection's request head has arrived. */
export function rawServer(script: (talk: Conversation) => void): Promise<RawServer> {
  return new Promise((resolve) => {
    let connections = 0;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
      let buffered = Buffer.alloc(0);
      let after: Buffer[] | null = null;
      socket.on('data', (chunk: Buffer) => {
        if (after) {
          after.push(chunk);
          return;
        }
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffered.subarray(0, end).toString('latin1');
        after = [buffered.subarray(end + 4)];
        const received = after;
        const key = /^sec-websocket-key: (.+)$/im.exec(head)?.[1]?.trim() ?? '';
        script({ socket, head, key, received: () => Buffer.concat(received) });
      });
    });
    server.listen(0, LOOPBACK, () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        connections: () => connections,
        close: () =>
          new Promise<void>((done) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => done());
          }),
      }),
    );
  });
}

export interface SocketRun {
  opened: boolean;
  messages: (string | Uint8Array)[];
  errors: SocketErrorEvent[];
  close: SocketCloseEvent;
}

/** Opens a LinkSocket to `port` and records everything until it closes (or fails the test after `timeoutMs`). */
export function runSocket(port: number, maxMessageBytes: number, onOpen?: (socket: LinkSocket) => void, timeoutMs = 4000): Promise<SocketRun> {
  return new Promise((resolve, reject) => {
    const random = (n: number) => new Uint8Array(crypto.randomBytes(n));
    const socket = new LinkSocket({ transport: nodeTcp, host: LOOPBACK, port, path: WS_PATH, random, maxMessageBytes, connectTimeoutMs: 2000 });
    const run: Omit<SocketRun, 'close'> = { opened: false, messages: [], errors: [] };
    const timer = setTimeout(() => reject(new Error('the socket never closed')), timeoutMs);
    socket.onopen = () => {
      run.opened = true;
      onOpen?.(socket);
    };
    socket.onmessage = (ev) => run.messages.push(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
    socket.onerror = (ev) => run.errors.push(ev);
    socket.onclose = (close) => {
      clearTimeout(timer);
      resolve({ ...run, close });
    };
  });
}

/** Resolves once `check` holds, polling. */
export async function until(what: string, check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
