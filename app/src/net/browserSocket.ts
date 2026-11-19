/**
 * The browser's WebSocket as a FrameSocket, for the web build. Browsers cap and inflate messages
 * themselves, so the message limit is checked by client.ts after a message arrives.
 */
import { CLOSE_CODE } from './wsFrames';
import type { FrameSocket, SocketCloseEvent, SocketErrorEvent, SocketMessageEvent } from './linkSocket';

export class BrowserSocket implements FrameSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: SocketMessageEvent) => void) | null = null;
  onclose: ((ev: SocketCloseEvent) => void) | null = null;
  onerror: ((ev: SocketErrorEvent) => void) | null = null;
  private readonly ws: WebSocket;

  /** Throws like `new WebSocket` for a URL it can't use. */
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.onopen?.();
    this.ws.onmessage = (ev) => this.onmessage?.({ data: ev.data as ArrayBuffer | string });
    this.ws.onclose = (ev) => this.onclose?.({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
    this.ws.onerror = () => this.onerror?.({ code: CLOSE_CODE.abnormal, message: 'The WebSocket failed.' });
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  send(data: Uint8Array): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }

  setMessageLimit(): void {
    // The browser offers no limit; client.ts checks each message's length once it arrives.
  }
}
