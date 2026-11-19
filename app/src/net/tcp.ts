/**
 * Raw TCP byte streams for the link and /hello on native platforms. React Native's own WebSocket
 * and fetch inflate and buffer whole messages in native code with no size limit, so on a phone
 * AuthDeck reads bytes itself (linkSocket.ts, helloOverTcp.ts) and checks every size before it
 * keeps anything. The native side is modules/authdeck-socket; tests inject a Node transport.
 */
import { AuthdeckSocket, type AuthdeckSocketNative } from '../../modules/authdeck-socket';
export { MAX_UNACKED_BYTES } from '../../modules/authdeck-socket';
import { fromBase64, toBase64 } from '../vault/bytes';

/**
 * One TCP connection. After `close()` (or after `onClose`) no callback fires again. `onData` hands
 * over bytes in order; the reader acks them as it uses them, and the transport stops reading while
 * MAX_UNACKED_BYTES are delivered and not acked.
 */
export interface ByteStream {
  write(bytes: Uint8Array): void;
  /** The reader has used `bytes` more of what onData delivered. */
  ack(bytes: number): void;
  close(): void;
  onData: ((bytes: Uint8Array) => void) | null;
  /** The peer or the network ended the connection. Fires at most once. */
  onClose: (() => void) | null;
  /** Fires before `onClose` when the connection failed. */
  onError: ((message: string) => void) | null;
}

export interface TcpTransport {
  /** Resolves once connected; rejects when the host can't be reached within `timeoutMs`. */
  connect(host: string, port: number, timeoutMs: number): Promise<ByteStream>;
}

/** How long a close waits for bytes already written (a close or pong reply) to go out. */
const CLOSE_FLUSH_MS = 1000;
/**
 * The largest request the agent accepts (its MAX_MESSAGE_BYTES), 1 MiB of plaintext. Sealed, that
 * is 17 transport frames with about 33 bytes of framing each.
 */
const LARGEST_REQUEST_BYTES = 1024 * 1024;
/**
 * Bytes written and not yet taken by native. Native queues writes without a cap, so a peer that
 * stops reading while it sends pings (each answered with a pong) would grow that queue: past this,
 * the connection ends. Room for three of the largest requests at once, framing included, so an
 * honest request never trips it.
 */
export const MAX_PENDING_WRITE_BYTES = 4 * LARGEST_REQUEST_BYTES;
/**
 * Writes not yet taken by native, whatever their size. Each one is a native call and a promise, so
 * many tiny ones (pongs) cost far more than their bytes. A large request is 17 writes.
 */
export const MAX_PENDING_WRITES = 256;

/** A stream over the native module. Events reach it through NativeDispatch, by socket id. */
class NativeStream implements ByteStream {
  onData: ((bytes: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((message: string) => void) | null = null;
  private lastWrite: Promise<void> = Promise.resolve();
  private pendingWriteBytes = 0;
  private pendingWrites = 0;

  constructor(
    private readonly native: AuthdeckSocketNative,
    private readonly dispatch: NativeDispatch,
    readonly id: number,
  ) {}

  write(bytes: Uint8Array): void {
    if (!this.dispatch.isOpen(this.id)) return;
    if (this.pendingWriteBytes + bytes.length > MAX_PENDING_WRITE_BYTES || this.pendingWrites >= MAX_PENDING_WRITES) {
      this.fail('The computer stopped reading what AuthDeck sends.');
      return;
    }
    this.pendingWriteBytes += bytes.length;
    this.pendingWrites++;
    // A failed write resolves too; the failure arrives as onError then onClose, which end the stream.
    this.lastWrite = this.native
      .write(this.id, toBase64(bytes))
      .catch(() => undefined)
      .then(() => {
        this.pendingWriteBytes -= bytes.length;
        this.pendingWrites--;
      });
  }

  /** Ends the stream from this side for a reason the caller hears about, like a native failure. */
  private fail(message: string): void {
    if (!this.dispatch.forget(this.id)) return;
    this.native.close(this.id);
    this.onError?.(message);
    this.onClose?.();
  }

  close(): void {
    if (!this.dispatch.forget(this.id)) return;
    // Lets a close or pong frame written just before go out, but never waits on a stalled peer.
    const flushed = new Promise<void>((resolve) => setTimeout(resolve, CLOSE_FLUSH_MS));
    void Promise.race([this.lastWrite, flushed]).then(() => this.native.close(this.id));
  }

  ack(bytes: number): void {
    if (this.dispatch.isOpen(this.id)) this.native.ack(this.id, bytes);
  }

  deliver(base64: string): void {
    this.onData?.(fromBase64(base64, 'Received data'));
  }
}

type EarlyEvent = { kind: 'data'; data: string } | { kind: 'error'; message: string } | { kind: 'close' };

/**
 * Early events kept for sockets whose connect is in flight, across all of them. An agent never
 * speaks before it is asked, and nothing is asked before connect resolves, so an honest socket has
 * at most an error and a close here; these bound what a peer that talks first can make JS hold.
 */
export const MAX_EARLY_SOCKETS = 64;
/** Base64 characters, about 768 KiB of data. */
export const MAX_EARLY_DATA_CHARS = 1024 * 1024;
/** Sockets JS has ended whose native onClose has not arrived yet; past this the oldest is forgotten. */
const MAX_CLOSING_SOCKETS = 1024;
const SPOKE_FIRST_MESSAGE = 'The computer sent more than AuthDeck reads before it asked anything.';

/**
 * One set of native event subscriptions for every socket, dispatching by id. Events for an id that
 * is not open do nothing, except while a connect is in flight: its socket's first events may
 * arrive before `connect` resolves with the id, so they wait for it, within MAX_EARLY_SOCKETS and
 * MAX_EARLY_DATA_CHARS. A socket over those is closed, and its connect resolves to a stream that
 * fails at once. Events for a socket JS has ended are dropped until its native onClose, which
 * every socket sends exactly once, so the late bytes of closed sockets are never kept.
 */
class NativeDispatch implements TcpTransport {
  private readonly open = new Map<number, NativeStream>();
  private readonly early = new Map<number, EarlyEvent[]>();
  private earlyDataChars = 0;
  /** Sockets whose early events went over the limits; their connect resolves to a failed stream. */
  private readonly refusedEarly = new Set<number>();
  /** Sockets JS has ended, until native reports their close. Kept in the order they ended. */
  private readonly closing = new Set<number>();
  /** Early events waiting to be handed over, with any that arrive meanwhile behind them in order. */
  private readonly replaying = new Map<number, EarlyEvent[]>();
  private connecting = 0;
  private subscribed = false;

  constructor(private readonly native: AuthdeckSocketNative) {}

  async connect(host: string, port: number, timeoutMs: number): Promise<ByteStream> {
    this.subscribe();
    this.connecting++;
    try {
      const id = await this.native.connect(host, port, timeoutMs);
      const stream = new NativeStream(this.native, this, id);
      this.open.set(id, stream);
      const waiting = this.refusedEarly.delete(id) ? spokeFirst() : this.takeEarly(id);
      if (waiting) this.replayLater(id, waiting);
      return stream;
    } finally {
      this.connecting--;
      if (this.connecting === 0) this.dropEarly();
    }
  }

  private takeEarly(id: number): EarlyEvent[] | undefined {
    const waiting = this.early.get(id);
    if (!waiting) return undefined;
    this.early.delete(id);
    this.earlyDataChars -= dataChars(waiting);
    return waiting;
  }

  private dropEarly(): void {
    this.early.clear();
    this.earlyDataChars = 0;
    this.refusedEarly.clear();
  }

  /** Hands over early events in a later task, once the caller has set its handlers. */
  private replayLater(id: number, waiting: EarlyEvent[]): void {
    this.replaying.set(id, waiting);
    setTimeout(() => {
      const events = this.replaying.get(id) ?? [];
      this.replaying.delete(id);
      for (const event of events) {
        const stream = this.open.get(id);
        if (stream) this.deliver(stream, id, event);
      }
    }, 0);
  }

  isOpen(id: number): boolean {
    return this.open.has(id);
  }

  /** Stops delivering events for `id`; false if it was not open. */
  forget(id: number): boolean {
    const queued = this.replaying.get(id);
    this.replaying.delete(id);
    if (!this.open.delete(id)) return false;
    // A close already queued for replay means native has reported it: nothing more will come.
    if (!queued?.some((event) => event.kind === 'close')) this.markClosing(id);
    return true;
  }

  private markClosing(id: number): void {
    this.closing.add(id);
    if (this.closing.size > MAX_CLOSING_SOCKETS) this.closing.delete(this.closing.values().next().value!);
  }

  private subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.native.addListener('onData', ({ id, data }) => this.route(id, { kind: 'data', data }));
    this.native.addListener('onError', ({ id, message }) => this.route(id, { kind: 'error', message }));
    this.native.addListener('onClose', ({ id }) => this.route(id, { kind: 'close' }));
  }

  private route(id: number, event: EarlyEvent): void {
    if (this.closing.has(id)) {
      if (event.kind === 'close') this.closing.delete(id);
      return;
    }
    const queued = this.replaying.get(id);
    if (queued) {
      queued.push(event);
      return;
    }
    const stream = this.open.get(id);
    if (stream) this.deliver(stream, id, event);
    else if (this.connecting > 0) this.keepEarly(id, event);
  }

  /** Holds an event for a connect in flight, or refuses the socket once it passes the limits. */
  private keepEarly(id: number, event: EarlyEvent): void {
    if (this.refusedEarly.has(id)) return;
    const waiting = this.early.get(id);
    const chars = event.kind === 'data' ? event.data.length : 0;
    if ((!waiting && this.early.size >= MAX_EARLY_SOCKETS) || this.earlyDataChars + chars > MAX_EARLY_DATA_CHARS) {
      this.refuseEarly(id);
      return;
    }
    if (waiting) waiting.push(event);
    else this.early.set(id, [event]);
    this.earlyDataChars += chars;
  }

  private refuseEarly(id: number): void {
    this.takeEarly(id);
    this.refusedEarly.add(id);
    this.markClosing(id);
    this.native.close(id);
  }

  private deliver(stream: NativeStream, id: number, event: EarlyEvent): void {
    try {
      if (event.kind === 'data') stream.deliver(event.data);
      else if (event.kind === 'error') stream.onError?.(event.message);
      else {
        this.open.delete(id);
        stream.onClose?.();
      }
    } catch (err) {
      // A native event handler must never throw: an error here ends this one connection.
      if (this.forget(id)) this.native.close(id);
      stream.onError?.(err instanceof Error ? err.message : String(err));
      stream.onClose?.();
    }
  }
}

const dataChars = (events: EarlyEvent[]): number => events.reduce((sum, event) => sum + (event.kind === 'data' ? event.data.length : 0), 0);

/** What a socket refused for its early events hears once its connect resolves. */
const spokeFirst = (): EarlyEvent[] => [{ kind: 'error', message: SPOKE_FIRST_MESSAGE }, { kind: 'close' }];

let injected: TcpTransport | null = null;
/** A transport over a native socket module; exported for tests with a stand-in module. */
export function nativeTransport(module: AuthdeckSocketNative): TcpTransport {
  return new NativeDispatch(module);
}

const native: TcpTransport | null = AuthdeckSocket ? nativeTransport(AuthdeckSocket) : null;

/** Replaces the transport; tests pass a Node one, and null to go back to the native module. */
export function setTcpTransport(transport: TcpTransport | null): void {
  injected = transport;
}

/** The transport in use, or null where none is built in (web, or a build without the module). */
export function tcpTransport(): TcpTransport | null {
  return injected ?? native;
}

/** Said when a native build lacks the socket module; never falls back to React Native's own. */
export const NO_TCP_MESSAGE = 'This build of AuthDeck is missing its network module.';
export const NO_TCP_HINT = 'Install the latest AuthDeck from the App Store or Play Store.';
