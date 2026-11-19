/**
 * One encrypted session with an AuthDeck agent: the link handshake, then request/response with
 * ids, plus events, all inside the channel. Reconnection lives in connection.ts; this file only
 * knows about a single socket. Pairing (QR or PIN) also happens here, each on its own socket.
 */
import { Platform } from 'react-native';

import type { SecureChannel } from '../link/channel';
import { LinkError, LinkRefusal } from '../link/errors';
import { PinPairingClient, SessionClient, type PairRequest } from '../link/handshakes';
import type { LinkKeyPair } from '../link/keys';
import { MAX_NOISE_MESSAGE } from '../link/noise';
import { type AgentInfo, type EnvEventMessage, type EnvMethod, type EnvMethods, type ErrorCode, type EventMessage, type Method, type Methods, WS_PATH } from '../protocol';
import { connectCanary, HeldHostError } from '../state/connectCanary';
import { BrowserSocket } from './browserSocket';
import { linkRandom } from './linkIdentity';
import { type FrameSocket, LinkSocket, SOCKET_STATE, type SocketErrorEvent } from './linkSocket';
import { agentFeatures, isAgentInfo, isMethodResult, isProtocolError, readSessionMessage } from './messages';
import { NO_TCP_HINT, NO_TCP_MESSAGE, tcpTransport } from './tcp';
import { cleanName } from './trust';
import { CLOSE_CODE } from './wsFrames';

/** Responses can be large (icons, vault pages); the agent caps its own at well under this. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const OPEN_TIMEOUT_MS = 3500;
const HANDSHAKE_STEP_TIMEOUT_MS = 8000;
/** Handshake messages are a few hundred bytes; anything far bigger is not from an agent. */
export const MAX_HANDSHAKE_FRAME_BYTES = 8 * 1024;
/** One transport frame: the two-byte frame header and one Noise message. */
export const MAX_TRANSPORT_FRAME_BYTES = MAX_NOISE_MESSAGE + 2;
/** A handshake takes one frame at a time; a peer that queues more than this is flooding. */
const MAX_QUEUED_HANDSHAKE_FRAMES = 4;

/** The next step the computer suggested with a failure, such as which macOS permission to turn on. */
export function failureHint(error: unknown): string | undefined {
  return error instanceof RequestError ? error.hint : undefined;
}

export class RequestError extends Error {
  code: ErrorCode | 'offline';
  hint?: string;
  /**
   * True only for what the computer said inside the encrypted link, which its key proves. Anything
   * before the handshake finishes (plain-text refusals, junk, closed sockets) could come from
   * anyone on the network, so it is only a hint.
   */
  readonly fromComputer: boolean;
  constructor(code: ErrorCode | 'offline', message: string, hint?: string, fromComputer = false) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.fromComputer = fromComputer;
  }
  /**
   * An error the computer sent inside the encrypted link: its own words may be shown. Anything
   * that is not a well-formed error becomes a generic failure in the app's words.
   */
  static fromComputer(e: unknown): RequestError {
    if (!isProtocolError(e)) return new RequestError('failed', NOT_UNDERSTOOD.message, NOT_UNDERSTOOD.hint, true);
    return new RequestError(e.code, e.message, e.hint, true);
  }
}

/**
 * The app's own words for refusals that arrive in plain text. The sender is unproven, so its text
 * is never shown: only the code is read, and only to pick one of these.
 */
const PLAIN_REFUSALS: Partial<Record<ErrorCode, { message: string; hint: string }>> = {
  unauthorized: {
    message: 'The computer did not accept this device.',
    hint: 'If AuthDeck Agent was reset on it, open its pairing screen and pair again.',
  },
  bad_pin: {
    message: "That PIN didn't work.",
    hint: 'Type the 6-digit PIN the computer shows now.',
  },
  locked: {
    message: "The computer isn't taking a PIN right now.",
    hint: 'Open the pairing screen in AuthDeck Agent (or run "authdeck-agent pair"). If it says pairing is paused, wait, then type the new PIN.',
  },
  version: {
    message: 'This computer runs a different version of AuthDeck Agent.',
    hint: 'Update AuthDeck Agent on the computer and this app, then try again.',
  },
  rate_limited: {
    message: 'The computer is busy.',
    hint: 'Wait a moment, then try again.',
  },
};

/** The app's own words for a refusal code, when it has some. */
export function plainRefusalWords(code: ErrorCode | 'offline'): { message: string; hint: string } | undefined {
  return code === 'offline' ? undefined : PLAIN_REFUSALS[code];
}

const NOT_UNDERSTOOD = { message: 'The computer sent something AuthDeck does not understand.', hint: 'Update the AuthDeck app and agent.' };
const OLDER_AGENT = { message: 'This computer runs an older AuthDeck agent.', hint: 'Update the AuthDeck agent on the computer, then try again.' };

/** Names a computer gives that hold nothing visible are shown as this. */
export const UNNAMED_COMPUTER = 'Computer';

/**
 * The computer's description of itself; a missing or damaged field fails this attempt. Its name
 * loses characters that draw nothing before anything stores or shows it.
 */
function checkedAgent(agent: unknown): AgentInfo {
  if (!isAgentInfo(agent)) throw new RequestError('failed', NOT_UNDERSTOOD.message, NOT_UNDERSTOOD.hint);
  const { features, ...info } = agent;
  const known = agentFeatures(features);
  return { ...info, name: cleanName(agent.name) || UNNAMED_COMPUTER, ...(known.length > 0 ? { features: known } : {}) };
}

function unverifiedRefusal(code: ErrorCode, words: { message: string; hint: string }): RequestError {
  return new RequestError(code, words.message, words.hint);
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * Reads a plain-text answer from before the channel was up. A protocol 2 agent sends
 * `{ ok: false, error }`; a protocol 1 agent answers the binary frame as a request, with an `id`.
 * Only the error code is used, to pick the app's own words.
 */
function plainRefusal(text: string): RequestError {
  if (text.length > MAX_HANDSHAKE_FRAME_BYTES) return unverifiedRefusal('failed', NOT_UNDERSTOOD);
  try {
    const reply = JSON.parse(text) as { id?: unknown; error?: { code?: unknown } };
    if (reply.id !== undefined) return unverifiedRefusal('version', OLDER_AGENT);
    const code = reply.error?.code;
    const words = typeof code === 'string' ? PLAIN_REFUSALS[code as ErrorCode] : undefined;
    if (words) return unverifiedRefusal(code as ErrorCode, words);
  } catch {
    // Falls through to the generic error.
  }
  return unverifiedRefusal('failed', NOT_UNDERSTOOD);
}

/**
 * Link failures, in words. Only a refusal inside the encrypted handshake is the computer's own;
 * an answer that fails the link checks may be anything on the network, so it is a failed attempt.
 */
function linkFailure(err: unknown, host: string): unknown {
  if (err instanceof LinkRefusal) return RequestError.fromComputer(err.error);
  if (err instanceof LinkError) {
    return new RequestError(
      'failed',
      `The answer from ${host} did not come from the computer this device expects.`,
      'AuthDeck keeps trying its other addresses. If AuthDeck Agent was reinstalled on it, pair again.',
    );
  }
  return err;
}

function wsUrl(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `ws://${h}:${port}${WS_PATH}`;
}

/**
 * On a phone the link runs over AuthDeck's own TCP (linkSocket.ts): React Native's WebSocket
 * inflates and buffers whole messages natively with no limit. A build without that module never
 * falls back to it.
 */
const usesOwnSocket = (): boolean => Platform.OS !== 'web';

function newSocket(host: string, port: number): FrameSocket {
  if (!usesOwnSocket()) return new BrowserSocket(wsUrl(host, port));
  const transport = tcpTransport();
  if (!transport) throw new RequestError('failed', NO_TCP_MESSAGE, NO_TCP_HINT);
  return new LinkSocket({ transport, host, port, path: WS_PATH, random: linkRandom, maxMessageBytes: MAX_HANDSHAKE_FRAME_BYTES, connectTimeoutMs: OPEN_TIMEOUT_MS });
}

/**
 * Runs a connection (TCP connect and handshake) under the crash canary (state/connectCanary.ts) on
 * a phone. An address held since AuthDeck closed while connecting to it is not contacted.
 */
async function underCanary<T>(host: string, connect: () => Promise<T>): Promise<T> {
  if (!usesOwnSocket()) return connect();
  try {
    return await connectCanary.guard(host, connect);
  } catch (err) {
    if (err instanceof HeldHostError) throw new RequestError('offline', err.message, 'Choose Connect on the notice to try this address again.');
    throw err;
  }
}

/** A socket that failed before or while opening, in words. */
function openFailure(host: string, ev: SocketErrorEvent): RequestError {
  if (ev.code === CLOSE_CODE.abnormal) return new RequestError('offline', `Could not reach ${host}.`);
  return new RequestError('failed', `${host} did not answer like AuthDeck Agent.`, NOT_UNDERSTOOD.hint);
}

/** Opens a socket for binary frames, or rejects when it can't connect in time. */
function openSocket(host: string, port: number): Promise<FrameSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws: FrameSocket;
    try {
      ws = newSocket(host, port);
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // Closing a socket that never opened can throw; it is being dropped either way.
      }
      reject(new RequestError('offline', `No answer from ${host}.`));
    }, OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(openFailure(host, ev));
    };
  });
}

/** Hands over handshake frames one at a time. A text frame is a refusal; so is a close. */
class HandshakeReader {
  private readonly queue: (Uint8Array | RequestError)[] = [];
  private waiter: (() => void) | null = null;
  private queuedFrames = 0;

  constructor(
    private readonly ws: FrameSocket,
    private readonly host: string,
  ) {
    ws.onmessage = (ev) => this.receive(ev.data);
    ws.onclose = () => this.push(new RequestError('offline', `${host} closed the connection.`));
    ws.onerror = (ev) => this.push(this.socketFailure(ev));
  }

  send(frame: Uint8Array): void {
    this.ws.send(frame);
  }

  async next(): Promise<Uint8Array> {
    const deadline = Date.now() + HANDSHAKE_STEP_TIMEOUT_MS;
    for (;;) {
      const item = this.queue.shift();
      if (item instanceof RequestError) throw item;
      if (item) {
        this.queuedFrames--;
        return item;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new RequestError('timeout', `${this.host} took too long to answer.`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.waiter = null;
    }
  }

  private receive(data: unknown): void {
    if (this.queuedFrames >= MAX_QUEUED_HANDSHAKE_FRAMES) {
      closeQuietly(this.ws);
      return;
    }
    this.queuedFrames++;
    this.push(this.read(data));
  }

  private read(data: unknown): Uint8Array | RequestError {
    const frame = toBytes(data);
    if (!frame) return plainRefusal(String(data));
    if (frame.length <= MAX_HANDSHAKE_FRAME_BYTES) return frame;
    closeQuietly(this.ws);
    return this.tooLarge();
  }

  private tooLarge(): RequestError {
    return new RequestError('failed', `${this.host} sent a handshake message far larger than AuthDeck Agent sends.`, NOT_UNDERSTOOD.hint);
  }

  /** The socket ended itself: the network, a size limit, or a broken WebSocket protocol. */
  private socketFailure(ev: SocketErrorEvent): RequestError {
    if (ev.code === CLOSE_CODE.tooBig) return this.tooLarge();
    if (ev.code === CLOSE_CODE.abnormal) return new RequestError('offline', `The connection to ${this.host} dropped.`);
    return new RequestError('failed', `${this.host} sent something AuthDeck Agent never sends.`, NOT_UNDERSTOOD.hint);
  }

  private push(item: Uint8Array | RequestError): void {
    this.queue.push(item);
    this.waiter?.();
  }
}

function closeQuietly(ws: FrameSocket): void {
  try {
    ws.close();
  } catch {
    // Already closed.
  }
}

/** Every method a session sends: protocol 2's, and the env sets extension's (only to an agent listing ENV_FEATURE). */
export type SessionMethods = Methods & EnvMethods;
export type SessionMethod = Method | EnvMethod;

/**
 * Env events from every session, for the env engine. connection.ts forwards only protocol 2
 * events, and an agent sends env events only to the session that called env.watch, which the
 * env engine makes on the active computer's session.
 */
type EnvEventListener = (msg: EnvEventMessage, session: AgentSession) => void;
const envEventListeners = new Set<EnvEventListener>();

/** Subscribes to env events; returns the unsubscribe function. */
export function onEnvEvent(listener: EnvEventListener): () => void {
  envEventListeners.add(listener);
  return () => {
    envEventListeners.delete(listener);
  };
}

interface Pending {
  method: SessionMethod;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AgentSession {
  readonly host: string;
  private ws: FrameSocket;
  private channel: SecureChannel;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private closed = false;
  /** Why the session was ended by this app, when the computer sent something it could not read. */
  private failure: RequestError | null = null;
  onEvent: ((msg: EventMessage) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(ws: FrameSocket, host: string, channel: SecureChannel) {
    this.ws = ws;
    this.host = host;
    this.channel = channel;
    ws.setMessageLimit(MAX_TRANSPORT_FRAME_BYTES);
    ws.onmessage = (ev) => this.receive(ev.data);
    ws.onclose = () => this.shutdown();
    ws.onerror = () => this.shutdown();
  }

  /** Set when the session ended because the computer sent something malformed. */
  get failed(): RequestError | null {
    return this.failure;
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === SOCKET_STATE.open;
  }

  request<M extends SessionMethod>(method: M, params: SessionMethods[M]['params'], timeoutMs = 15000): Promise<SessionMethods[M]['result']> {
    if (!this.isOpen) {
      return Promise.reject(new RequestError('offline', 'The computer is not connected.'));
    }
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestError('timeout', 'The computer took too long to answer.'));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        for (const frame of this.channel.seal(JSON.stringify({ id, method, params }))) this.ws.send(frame);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RequestError('offline', 'The computer is not connected.'));
      }
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
    this.shutdown();
  }

  /** Every frame must open in the channel; anything else (plain text, altered, replayed) ends the session. */
  private receive(data: unknown): void {
    const frame = toBytes(data);
    let text: string | null;
    try {
      if (!frame) throw new LinkError('malformed', 'The computer sent plain text inside the encrypted session.');
      if (frame.length > MAX_TRANSPORT_FRAME_BYTES) throw new LinkError('malformed', 'The computer sent a frame longer than the link allows.');
      text = this.channel.open(frame);
    } catch {
      this.close();
      return;
    }
    if (text === null) return;
    // Runs inside the socket's message handler, where an exception is fatal in a release build:
    // anything unexpected, from the message or from a listener, ends the session instead.
    try {
      this.handle(text);
    } catch (err) {
      this.fail(`AuthDeck could not handle a message from the computer (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  private handle(text: string): void {
    const read = readSessionMessage(text);
    switch (read.kind) {
      case 'malformed':
        this.fail(`The computer sent ${read.reason}.`);
        return;
      case 'unknown-event':
        return;
      case 'event':
        this.onEvent?.(read.message);
        return;
      case 'env-event':
        envEventListeners.forEach((listener) => listener(read.message, this));
        return;
      case 'response': {
        const msg = read.message;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (!msg.ok) p.reject(RequestError.fromComputer(msg.error));
        // A result of the wrong shape fails this request only; screens never see it.
        else if (isMethodResult(p.method, msg.result)) p.resolve(msg.result);
        else p.reject(new RequestError('failed', NOT_UNDERSTOOD.message, NOT_UNDERSTOOD.hint, true));
      }
    }
  }

  /** Ends the session because the computer sent something unreadable; waiting requests fail with why. */
  private fail(message: string): void {
    if (this.closed) return;
    this.failure = new RequestError('failed', message, NOT_UNDERSTOOD.hint, true);
    this.close();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    const reason = this.failure ?? new RequestError('offline', 'The connection to the computer dropped.');
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
    this.onClose?.();
  }
}

/** Opens an encrypted session with a paired computer (Noise IK to the key stored at pairing). */
export function openSession(host: string, port: number, device: LinkKeyPair, agentKey: Uint8Array): Promise<{ session: AgentSession; agent: AgentInfo }> {
  return underCanary(host, async () => {
    const ws = await openSocket(host, port);
    try {
      const reader = new HandshakeReader(ws, host);
      const client = new SessionClient(device, agentKey, linkRandom);
      reader.send(client.hello());
      const accepted = client.accept(await reader.next(), MAX_MESSAGE_BYTES);
      const agent = checkedAgent(accepted.agent);
      return { session: new AgentSession(ws, host, accepted.channel), agent };
    } catch (err) {
      closeQuietly(ws);
      throw linkFailure(err, host);
    }
  });
}

/** By default only a refusal from the computer itself (inside the encrypted link) ends a search. */
const refusedByComputer = (e: RequestError): boolean => e.fromComputer;

/**
 * A wrong PIN is always refused in plain text (the agent can't encrypt before the PIN is proven),
 * and every agent that sees it counts a guess. The addresses usually belong to one computer, so
 * the search stops there: one typo costs one guess, not one per address.
 */
const endsPinSearch = (e: RequestError): boolean => e.fromComputer || e.code === 'bad_pin' || e.code === 'locked';

/** The person left the pairing: no further address is tried, and nothing more is sent. */
export class PairingCancelled extends Error {
  constructor() {
    super('Pairing was cancelled.');
    this.name = 'PairingCancelled';
  }
}

function stopIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PairingCancelled();
}

/**
 * Tries each address until one answers. A failure that `isFinal` accepts stops the search; anything
 * else at one address may be another machine there. When every address fails, the most telling
 * failure is reported (a refusal over "no answer"). `signal` stops the search between addresses.
 */
async function onFirstHost<T>(
  hosts: string[],
  attempt: (host: string) => Promise<T>,
  isFinal: (e: RequestError) => boolean = refusedByComputer,
  signal?: AbortSignal,
): Promise<T & { host: string }> {
  let reported = new RequestError('offline', 'Could not reach the computer.');
  for (const host of hosts) {
    stopIfCancelled(signal);
    try {
      return { ...(await attempt(host)), host };
    } catch (e) {
      if (!(e instanceof RequestError) || isFinal(e)) throw e;
      if (e.code !== 'offline' || reported.code === 'offline') reported = e;
    }
  }
  throw reported;
}

/**
 * Runs one pairing on its own socket, then closes it; the session that follows reconnects. Nothing
 * is sent once `signal` is aborted, also when it aborts while the socket opens.
 */
function pairOnSocket<T>(host: string, port: number, run: (reader: HandshakeReader) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return underCanary(host, async () => {
    const ws = await openSocket(host, port);
    try {
      stopIfCancelled(signal);
      return await run(new HandshakeReader(ws, host));
    } catch (err) {
      throw err instanceof PairingCancelled ? err : linkFailure(err, host);
    } finally {
      closeQuietly(ws);
    }
  });
}

/** QR pairing: the QR code gave the computer's key and a one-time secret. */
export function pairWithQr(
  hosts: string[],
  port: number,
  agentKey: Uint8Array,
  secret: string,
  device: LinkKeyPair,
  request: PairRequest,
  signal?: AbortSignal,
): Promise<{ agent: AgentInfo; host: string }> {
  return onFirstHost(
    hosts,
    (host) =>
      pairOnSocket(
        host,
        port,
        async (reader) => {
          const client = new SessionClient(device, agentKey, linkRandom, { ...request, secret });
          reader.send(client.hello());
          return { agent: checkedAgent(client.accept(await reader.next(), MAX_MESSAGE_BYTES).agent) };
        },
        signal,
      ),
    refusedByComputer,
    signal,
  );
}

/**
 * PIN pairing: CPace with the PIN, then the PIN-keyed handshake that swaps both keys. `signal`
 * stops the sweep when the person leaves, so the PIN is not tried at the remaining addresses.
 */
export function pairWithPin(
  hosts: string[],
  port: number,
  pin: string,
  device: LinkKeyPair,
  request: PairRequest,
  signal?: AbortSignal,
): Promise<{ agent: AgentInfo; agentKey: Uint8Array; host: string }> {
  return onFirstHost(
    hosts,
    (host) =>
      pairOnSocket(
        host,
        port,
        async (reader) => {
          const client = new PinPairingClient(device, pin, request, linkRandom);
          reader.send(client.start());
          reader.send(client.hello(await reader.next()));
          reader.send(client.finish(await reader.next(), MAX_MESSAGE_BYTES));
          const { agent, agentKey } = client.confirm(await reader.next());
          return { agent: checkedAgent(agent), agentKey };
        },
        signal,
      ),
    endsPinSearch,
    signal,
  );
}
