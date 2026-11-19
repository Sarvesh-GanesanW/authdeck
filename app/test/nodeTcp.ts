/// <reference types="node" />
/**
 * A TcpTransport on node:net, for tests only: it behaves like the native module (modules/
 * authdeck-socket), pausing reads while MAX_UNACKED_BYTES are delivered and not acked, and
 * delivering nothing after close.
 */
import net from 'node:net';
import { type ByteStream, MAX_UNACKED_BYTES, type TcpTransport } from '../src/net/tcp';

class NodeStream implements ByteStream {
  onData: ((bytes: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((message: string) => void) | null = null;
  private unacked = 0;
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      this.unacked += chunk.length;
      if (this.unacked > MAX_UNACKED_BYTES) socket.pause();
      this.onData?.(new Uint8Array(chunk));
    });
    socket.on('error', (err) => {
      if (!this.closed) this.onError?.(err.message);
    });
    socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.onClose?.();
    });
  }

  /** Bytes delivered and not acked: what the reader still holds or hasn't looked at. */
  get unackedBytes(): number {
    return this.unacked;
  }

  write(bytes: Uint8Array): void {
    if (!this.closed) this.socket.write(bytes);
  }

  ack(bytes: number): void {
    this.unacked -= bytes;
    if (this.unacked <= MAX_UNACKED_BYTES && this.socket.isPaused()) this.socket.resume();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Lets a close frame written just before go out, as the native side does.
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
}

export class NodeTcpTransport implements TcpTransport {
  /** Every stream opened, for tests that look at what the reader holds. */
  readonly streams: NodeStream[] = [];

  connect(host: string, port: number, timeoutMs: number): Promise<ByteStream> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('timed out'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        const stream = new NodeStream(socket);
        this.streams.push(stream);
        resolve(stream);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
