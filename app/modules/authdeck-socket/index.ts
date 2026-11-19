/**
 * AuthDeck's own TCP socket, for the link to AuthDeck Agent on native platforms.
 *
 * Why: React Native's WebSocket (OkHttp on Android, SocketRocket on iOS) buffers and inflates a
 * whole message in native code before JavaScript sees it, with no size limit, so a hostile computer
 * could crash the app natively on every launch. This module carries raw bytes only; the WebSocket
 * framing, with its size limits checked from each frame header, is done in JavaScript
 * (src/net/linkSocket.ts), and no compression is ever offered.
 *
 * Contract (both platforms):
 * - `connect` resolves with a socket id once TCP is connected, or rejects (unreachable, refused,
 *   timed out after `timeoutMs`). Nothing else ever throws.
 * - `write` sends bytes in order; a failed write ends in an `onError` then `onClose` event.
 * - Received bytes arrive as `onData` events, base64-encoded, in order. Native stops reading while
 *   more than MAX_UNACKED_BYTES have been delivered and not yet acknowledged with `ack`, so a
 *   computer that sends without end can't grow native memory.
 * - `close` is safe to call any number of times, on any id.
 * - Every socket ends with exactly one `onClose` (after an `onError` if it failed). Errors on
 *   background threads become events; none is thrown.
 */
import { requireOptionalNativeModule, type EventSubscription } from 'expo';

/** Native pauses reading while JS holds this many delivered, unacknowledged bytes. */
export const MAX_UNACKED_BYTES = 256 * 1024;

export type SocketDataEvent = { id: number; data: string };
export type SocketCloseEvent = { id: number };
export type SocketErrorEvent = { id: number; message: string };

type Events = {
  onData: (event: SocketDataEvent) => void;
  onClose: (event: SocketCloseEvent) => void;
  onError: (event: SocketErrorEvent) => void;
};

export interface AuthdeckSocketNative {
  connect(host: string, port: number, timeoutMs: number): Promise<number>;
  /** `data` is base64. */
  write(id: number, data: string): Promise<void>;
  /** JS has consumed `bytes` of what onData delivered. */
  ack(id: number, bytes: number): void;
  close(id: number): void;
  addListener<E extends keyof Events>(event: E, listener: Events[E]): EventSubscription;
}

/** The native module, or null where it isn't built in (web, tests, an older build). */
export const AuthdeckSocket = requireOptionalNativeModule<AuthdeckSocketNative>('AuthdeckSocket');
