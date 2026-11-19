import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { ActionRunner } from './actions/runner';
import { describeActivity } from './activity';
import { summarizeAction } from './actions/summary';
import type { AppCatalog } from './apps/catalog';
import type { PairedDevice } from './config';
import type { ActionFailure, AgentEventListener } from './events';
import type { EnvLinkHandler } from './env/envAgent';
import type { EnvPeer } from './env/peers';
import { AgentError, badRequest, rateLimited, toProtocolError } from './errors';
import { sendableApps, sendableFocus, sendableForks, sendableListing } from './resultLimits';
import type { FocusTracker } from './focus';
import { listFolder } from './fsList';
import { JoinRelay } from './joinRelay';
import type { IconService } from './icons/service';
import type { SecureChannel } from './link/channel';
import { LinkError, LinkRefusal } from './link/errors';
import { LinkResponder, type ResponderHost } from './link/handshakes';
import { linkFingerprint, type LinkKeyPair } from './link/keys';
import { MAX_NOISE_MESSAGE } from './link/noise';
import { printableName, type Pairing } from './pairing';
import {
  HELLO_PATH,
  PROTOCOL_VERSION,
  WS_PATH,
  type AgentInfo,
  type EnvEventMessage,
  type EnvEventName,
  type EnvEvents,
  type EnvResponse,
  type EventMessage,
  type EventName,
  type Events,
  type HelloResponse,
  type Method,
  type Platform,
  type ProtocolError,
  type Response,
  type VaultEntry,
  type VaultRemoval,
} from './protocol';
import { RateLimiter, type RateLimit } from './rateLimit';
import { toBase64Url, type RandomBytes } from './vault/bytes';
import { vaultFeatures } from './vault/features';
import type { VaultAuthors } from './vaultAuthors';
import type { VaultStore } from './vaultStore';

const KEEPALIVE_MS = 15_000;
const JOIN_SWEEP_MS = 30_000;
const MAX_ICON_IDS = 48;
/** The longest request a device may send, after joining its encrypted chunks. */
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** A frame holds one Noise message plus its 2-byte header. */
const MAX_FRAME_BYTES = MAX_NOISE_MESSAGE + 2;
/**
 * A connection must finish its handshake (including a PIN run) and send its first encrypted frame
 * within this long, or it is dropped. A replayed hello can never send that frame.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/**
 * Connections not yet signed in (still sending HTTP headers, or in their handshake), from anywhere
 * and from one address. More are turned away. The last RESERVED_FOR_KNOWN of the overall slots
 * are kept for addresses a device signed in from lately, so strangers can't fill them all.
 */
export const MAX_PENDING_CONNECTIONS = 64;
export const MAX_PENDING_PER_ADDRESS = 8;
export const RESERVED_FOR_KNOWN = 16;
/**
 * Connections that proved a paired key (IK message 1 opened) but haven't signed in yet, per key.
 * They don't count against the limits above, so a stranger on the owner's address can't keep the
 * owner's phone out; a replayed hello proves a key too, so each key gets only this many.
 */
export const MAX_UNSIGNED_PER_KEY = 2;
/**
 * Signed-in connections of one device, and of all devices. A device's newest connection wins and
 * its oldest is closed; past the overall cap a new sign-in is refused, so one paired device can't
 * use up the computer's file handles.
 */
export const MAX_SESSIONS_PER_DEVICE = 4;
export const MAX_SIGNED_IN = 64;
/** First handshake messages remembered, so each recorded hello can be replayed at most once. */
const REMEMBERED_HELLOS = 4096;
/** An address counts as known this long after a device last signed in from it. */
const KNOWN_ADDRESS_MS = 24 * 60 * 60_000;
const MAX_KNOWN_ADDRESSES = 256;
/** Request headers (the WebSocket upgrade, or GET /hello) must arrive within these; a connection not upgraded by then is closed. */
export const HEADERS_TIMEOUT_MS = 5000;
export const REQUEST_TIMEOUT_MS = 8000;
/** How often Node checks those two timeouts. */
const CONNECTIONS_CHECK_MS = 1000;
/**
 * After pinStart, the app has this long to send its guess (pinHello). A phone does one CPace step
 * and one round trip in that time; a peer that only wants to hold the one PIN run is cut off.
 */
export const PIN_GUESS_TIMEOUT_MS = 3000;
/** This many PIN runs left without a guess from one address within ABANDONED_PIN_SPAN_MS pause PIN pairing from it. */
export const MAX_ABANDONED_PIN_RUNS = 3;
const ABANDONED_PIN_SPAN_MS = 60_000;
export const ABANDONED_PIN_PAUSE_MS = 60_000;
/** A peer that ignores the close frame is cut off after this long. */
const CLOSE_GRACE_MS = 1000;
const MAX_LABEL_LENGTH = 80;
/** The device is not (or no longer) allowed in; the reason went out first. */
export const CLOSE_UNAUTHORIZED = 4001;
/** The link broke: a frame was altered, replayed, out of order, in plain text, or late. */
export const CLOSE_LINK_BROKEN = 4002;

/** Sent in plain text to a protocol 1 app, which only understands JSON responses. */
const PLAINTEXT_CLIENT_REFUSAL: ProtocolError = {
  code: 'unauthorized',
  message: 'AuthDeck now encrypts the connection to this computer, so this device must pair again.',
  hint: 'Update the AuthDeck app, then pair again with the QR code or the PIN. Your keys and pages stay.',
};

const nodeRandom: RandomBytes = (length) => new Uint8Array(crypto.randomBytes(length));
/** Per paired device, across its connections. A device syncing a large vault sends batches back to back; this allows that, not a flood. */
export const VAULT_APPEND_RATE: RateLimit = { burst: 30, refillMs: 500 };
/** Per paired device. Each request is shown on every other device, so only a few may come at once. */
export const VAULT_JOIN_REQUEST_RATE: RateLimit = { burst: 4, refillMs: 15_000 };
/** vault.read, vault.list and the beacon and fork reads: a whole folder is at most about 25 pages. */
export const VAULT_READ_RATE: RateLimit = { burst: 120, refillMs: 250 };

export interface ServerDeps {
  agentInfo: AgentInfo;
  port: number;
  home: string;
  platform: Platform;
  pairing: Pairing;
  /** The computer's static link key. */
  linkKey: LinkKeyPair;
  catalog: AppCatalog;
  icons: IconService;
  runner: ActionRunner;
  focus: FocusTracker;
  vaults: VaultStore;
  /** Which paired device sent each vault identity's lines; without it a removal unpairs nobody. */
  vaultAuthors?: VaultAuthors;
  /**
   * Unpairs a paired device and cuts off its connections at once (agent.ts revokeDevice). Returns
   * its name, or null when it was not paired. Called when a removal through this agent takes that
   * device out of a vault.
   */
  unpairDevice?: (deviceId: string) => { deviceName: string } | null;
  /** Told when a device retired a vault on this computer (vault.retire), so its user hears of it: the desktop app shows a notification. */
  onVaultRetired?: (info: { deviceName: string | null; keptUntil: number }) => void;
  log: (line: string) => void;
  emit: AgentEventListener;
  /** Defaults to HANDSHAKE_TIMEOUT_MS (tests pass a short one). */
  handshakeTimeoutMs?: number;
  /** Defaults to PIN_GUESS_TIMEOUT_MS (tests pass a short one). */
  pinGuessTimeoutMs?: number;
  /** Clock for join-request expiry (tests pass a fake one). */
  now?: () => number;
  /**
   * Env sets (0.4). Without it env.* methods are unknown, as on a 0.3 agent; agent.ts lists
   * ENV_FEATURE only when it passes one.
   */
  env?: EnvLinkHandler;
  random?: RandomBytes;
}

interface Session {
  socket: WebSocket;
  /** The peer's IP address, for the per-address limit on unfinished handshakes. */
  address: string;
  /** Runs the handshake; null once the channel is up or the link failed. */
  responder: LinkResponder<PairedDevice> | null;
  /** Set when the handshake finishes; every frame after it goes through here. */
  channel: SecureChannel | null;
  handshakeTimer: NodeJS.Timeout | null;
  /** Runs from pinStart until the app's guess arrives. */
  pinGuessTimer: NodeJS.Timeout | null;
  /** The paired device the handshake proved, waiting for its first encrypted frame. */
  device: PairedDevice | null;
  /**
   * Both null until the device's first encrypted frame opens: only then is it signed in (a
   * replayed hello gets this far without the keys to send one).
   */
  deviceId: string | null;
  deviceName: string | null;
  alive: boolean;
  /** Cut off (unpaired, or the link broke): nothing more it sends is read. */
  dead: boolean;
  /** When it connected: the oldest unproven connection from a full address makes room for a new one. */
  since: number;
  /** The paired key its IK message 1 proved; it no longer counts against the connection limits. */
  provenKey: string | null;
  /** A digest of its first handshake frame (a replay repeats it byte for byte). */
  firstFrame: string | null;
  /** The session as env sets see it, from sign-in; it gets env events only after env.watch. */
  envPeer: EnvPeer | null;
}

/** A connection whose HTTP request (the upgrade, or GET /hello) hasn't finished. */
interface UnfinishedRequest {
  address: string;
  since: number;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Rate limits of one paired device, shared by all its connections, so reconnecting doesn't reset them. */
interface DeviceLimits {
  /** vault.append and vault.beacons.write: both replay the vault. */
  append: RateLimiter;
  joinRequest: RateLimiter;
  /** Reads: each replays or reads the folder. */
  read: RateLimiter;
}

type Params = Record<string, unknown>;

export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is already in use. Another AuthDeck agent may be running; stop it or start this one with --port <number>.`);
    this.name = 'PortInUseError';
  }
}

/** The key's label from the app, if it sent one. */
function keyLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = printableName(value).slice(0, MAX_LABEL_LENGTH);
  return label || undefined;
}

/** `line` without control or format characters (ESC, line breaks, bidi overrides), each shown as a space. */
export function logSafe(line: string): string {
  return line.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function frameBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Pairing throws AgentError; the handshake sends it to the app as a refusal. */
function asRefusal<T>(decide: () => T): T {
  try {
    return decide();
  } catch (err) {
    if (err instanceof AgentError) throw new LinkRefusal(err.toProtocol());
    throw err;
  }
}

/**
 * A browser page on localhost: the web build of the app while developing. Any other page is a
 * stranger; native apps send no Origin at all.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname;
    return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

/** PIN runs one address left without a guess, and the pause they earned. */
interface AbandonedRuns {
  at: number[];
  pausedUntil: number;
}

/** HTTP discovery endpoint plus the WebSocket session server. */
export class AgentServer {
  private readonly http: http.Server;
  // Never compressed: the link's frames are encrypted (so they don't compress), and the app's own
  // WebSocket client offers no extension and refuses any in the answer.
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  private readonly sessions = new Set<Session>();
  private keepalive: NodeJS.Timeout | null = null;
  private joinSweep: NodeJS.Timeout | null = null;
  private nextActionId = 1;
  private readonly joins: JoinRelay;
  private readonly deviceLimits = new Map<string, DeviceLimits>();
  private readonly random: RandomBytes;
  private readonly now: () => number;
  /** Connections whose HTTP request (upgrade or hello) has not finished, by peer address. */
  private readonly unfinishedRequests = new Map<Socket, UnfinishedRequest>();
  /** When a device last signed in from each address. */
  private readonly knownAddresses = new Map<string, number>();
  private readonly abandonedPinRuns = new Map<string, AbandonedRuns>();
  /** Digests of IK hellos that proved a paired key. A fresh hello is never byte-identical to an old one. */
  private readonly seenHellos = new Set<string>();

  private readonly deps: ServerDeps;

  constructor(deps: ServerDeps) {
    // Every line this server logs can quote what a device sent (its name, a command, a path): it
    // goes out with no control or format characters, so it can't drive the terminal or forge lines.
    this.deps = {
      ...deps,
      log: (line) => deps.log(logSafe(line)),
      // An unpaired device's grants end however the unpairing was noticed.
      emit: (event) => {
        if (event.type === 'device.revoked') this.guarded('ending an unpaired device\'s grants', () => {}, () => deps.env?.deviceUnpaired(event.deviceId));
        deps.emit(event);
      },
    };
    deps.env?.bind({ peers: () => [...this.sessions].filter((s) => !s.dead && s.envPeer !== null).map((s) => s.envPeer!) });
    this.random = deps.random ?? nodeRandom;
    this.now = deps.now ?? Date.now;
    this.joins = new JoinRelay({
      now: deps.now ?? Date.now,
      sendTo: (deviceId, event, data) => this.sendTo(deviceId, event, data),
      connected: () => this.connectedDeviceIds(),
      deviceName: (deviceId) => [...this.sessions].find((s) => s.deviceId === deviceId)?.deviceName ?? 'A device',
    });
    // A peer that opens connections and never finishes its request is dropped within seconds.
    this.http = http.createServer(
      { headersTimeout: HEADERS_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS, connectionsCheckingInterval: CONNECTIONS_CHECK_MS },
      (req, res) =>
        this.guarded('an HTTP request', () => {
          if (!res.headersSent) res.writeHead(500).end();
          else res.destroy();
        }, () => this.handleHttp(req, res)),
    );
    this.http.on('connection', (socket: Socket) => {
      // First, before anything can write to it: Node drops its own error listener from a socket
      // it hands to 'upgrade', and a peer that resets mid-write would otherwise stop the agent.
      socket.on('error', () => socket.destroy());
      this.guarded('a new connection', () => socket.destroy(), () => this.admit(socket));
    });
    this.http.on('error', (err) => this.guarded('the HTTP server', () => {}, () => this.deps.log(`[${timestamp()}] the HTTP server reported ${errorName(err)}`)));
    this.wss.on('error', (err) => this.guarded('the WebSocket server', () => {}, () => this.deps.log(`[${timestamp()}] the WebSocket server reported ${errorName(err)}`)));
    this.http.on('upgrade', (req, socket, head) => this.guarded('a WebSocket upgrade', () => socket.destroy(), () => this.upgrade(req, socket as Socket, head)));
    this.http.on('clientError', (_err, socket) => socket.destroy());
  }

  /** Resolves with the bound port (useful when listening on port 0). */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => reject(err.code === 'EADDRINUSE' ? new PortInUseError(this.deps.port) : err);
      this.http.once('error', onError);
      this.http.listen(this.deps.port, '0.0.0.0', () => {
        this.http.off('error', onError);
        this.keepalive = setInterval(() => this.guarded('the keepalive check', () => {}, () => this.checkAlive()), KEEPALIVE_MS);
        this.joinSweep = setInterval(() => this.guarded('expiring join requests', () => {}, () => this.joins.expire()), JOIN_SWEEP_MS);
        this.joinSweep.unref();
        resolve((this.http.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.joinSweep) clearInterval(this.joinSweep);
    for (const session of this.sessions) session.socket.terminate();
    for (const socket of this.unfinishedRequests.keys()) socket.destroy();
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  /** Cuts off every connection of the device at once, e.g. after it was unpaired. */
  disconnectDevice(deviceId: string): void {
    for (const session of this.sessions) if (session.device?.deviceId === deviceId) this.cutOff(session);
  }

  /** Cuts off every connection whose device is no longer paired with its key. Returns those devices. */
  dropUnpaired(): Set<string> {
    const dropped = new Set<string>();
    for (const session of this.sessions) {
      if (!session.device || session.dead || this.stillPaired(session)) continue;
      dropped.add(session.device.deviceId);
      this.cutOff(session);
    }
    return dropped;
  }

  connectedDeviceIds(): Set<string> {
    const ids = new Set<string>();
    for (const session of this.sessions) if (session.deviceId !== null && !session.dead) ids.add(session.deviceId);
    return ids;
  }

  /** Sends an event to every paired, authenticated device. */
  broadcast<E extends EventName>(event: E, data: Events[E]): void {
    const message: EventMessage<E> = { event, data };
    for (const session of this.sessions) if (session.deviceId !== null) this.sendEvent(session, message);
  }

  /** Sends an event to every connection of one paired device. */
  private sendTo<E extends EventName>(deviceId: string, event: E, data: Events[E]): void {
    const message: EventMessage<E> = { event, data };
    for (const session of this.sessions) if (session.deviceId === deviceId) this.sendEvent(session, message);
  }

  /** Env events go only to sessions that called env.watch; a 0.3 app never does, so never gets one. */
  private sendEnvEvent<E extends EnvEventName>(session: Session, event: E, data: EnvEvents[E]): void {
    if (session.envPeer === null || session.envPeer.members === null) return;
    this.sendEvent(session, { event, data });
  }

  /** Events go only to a device still paired with its key, even if no one told this process it was unpaired. */
  private sendEvent(session: Session, message: EventMessage | EnvEventMessage): void {
    this.guarded('sending an event', () => this.cutOff(session), () => {
      if (session.dead) return;
      if (!this.pairedOrCutOff(session)) return;
      this.send(session, message);
    });
  }

  /** Whether the session's device is still paired; if not, cuts it off and says it was revoked. */
  private pairedOrCutOff(session: Session): boolean {
    let paired: boolean;
    try {
      paired = this.stillPaired(session);
    } catch (err) {
      // agent.json unreadable for a moment: nothing goes out, the connection stays.
      this.deps.log(`[${timestamp()}] could not check a device's pairing: ${(err as Error).message}`);
      return false;
    }
    if (paired) return true;
    const deviceId = session.device?.deviceId;
    this.cutOff(session);
    if (deviceId !== undefined) this.deps.emit({ type: 'device.revoked', deviceId });
    return false;
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://agent').pathname;
    if (pathname !== HELLO_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    // The native app reads this without CORS; only the web build on localhost gets CORS headers,
    // so a page from any other site can't read the computer's name and key.
    const origin = req.headers.origin;
    const cors: Record<string, string> =
      origin !== undefined && isLoopbackOrigin(origin)
        ? {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '600',
            Vary: 'Origin',
          }
        : { Vary: 'Origin' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { ...cors, Allow: 'GET, OPTIONS' }).end();
      return;
    }
    const hello: HelloResponse = { ...this.deps.agentInfo, app: 'authdeck-agent', port: this.deps.port, fingerprint: linkFingerprint(this.deps.linkKey.public) };
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(hello));
  }

  /**
   * Runs a handler reached by something from outside (a peer's bytes, a timer, a file event). An
   * unexpected error ends only what it was handling (`fail`) and is logged by name, never with its
   * message (which may quote what the peer sent); it never reaches Node and stops the agent.
   */
  private guarded(what: string, fail: () => void, handle: () => void): void {
    try {
      handle();
    } catch (err) {
      try {
        this.deps.log(`[${timestamp()}] ${what} failed unexpectedly (${errorName(err)}); dropped it`);
      } catch {
        // Logging failed too: nothing more to do.
      }
      try {
        fail();
      } catch {
        // Already closing.
      }
    }
  }

  /** Refuses an HTTP connection: the answer goes out, then the socket is destroyed, whatever the peer does. */
  private refuseHttp(socket: Socket, status: string, extra = ''): void {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n${extra}\r\n`, () => socket.destroy());
    setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
  }

  /**
   * Counts every new connection from its first byte, until it is accepted as a WebSocket or closes.
   * From an address at its limit, the oldest connection that hasn't proved a paired key makes room;
   * past the overall limit the new one gets a 503.
   */
  private admit(socket: Socket): void {
    const address = socket.remoteAddress ?? '';
    if (!this.makeRoomForConnection(address)) {
      this.refuseHttp(socket, '503 Service Unavailable', 'Retry-After: 10\r\n');
      return;
    }
    this.unfinishedRequests.set(socket, { address, since: this.now() });
    // Node's own timeouts miss a peer that sends nothing, or stops halfway through its headers.
    const deadline = setTimeout(() => {
      if (this.unfinishedRequests.has(socket)) socket.destroy();
    }, REQUEST_TIMEOUT_MS);
    deadline.unref();
    socket.once('close', () => {
      clearTimeout(deadline);
      this.unfinishedRequests.delete(socket);
    });
  }

  private upgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    if (new URL(req.url ?? '/', 'http://agent').pathname !== WS_PATH) {
      this.refuseHttp(socket, '404 Not Found');
      return;
    }
    // Native apps send no Origin; the web build in development runs on localhost. A page from
    // any other site, open in a browser on this network, may not reach the link at all.
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      this.refuseHttp(socket, '403 Forbidden');
      return;
    }
    const address = socket.remoteAddress ?? '';
    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.guarded('a new WebSocket', () => ws.terminate(), () => {
        // Counted from here on as a session.
        this.unfinishedRequests.delete(socket);
        this.accept(ws, address);
      }),
    );
  }

  /** Connections that count against the limits: not signed in, and no paired key proved. */
  private unproven(): { since: number; address: string; close: () => void }[] {
    const pending: { since: number; address: string; close: () => void }[] = [];
    for (const [socket, request] of this.unfinishedRequests) {
      pending.push({
        ...request,
        close: () => {
          this.unfinishedRequests.delete(socket);
          socket.destroy();
        },
      });
    }
    for (const session of this.sessions) {
      if (session.deviceId !== null || session.dead || session.provenKey !== null) continue;
      pending.push({ since: session.since, address: session.address, close: () => this.breakLink(session, 'made room for a newer connection') });
    }
    return pending;
  }

  private makeRoomForConnection(address: string): boolean {
    const pending = this.unproven();
    const fromAddress = pending.filter((p) => p.address === address);
    let count = pending.length;
    if (fromAddress.length >= MAX_PENDING_PER_ADDRESS) {
      // Someone else on this address (a shared network, or an attacker on it) can't keep a paired
      // phone out by holding connections open: the oldest of theirs goes.
      fromAddress.reduce((oldest, p) => (p.since < oldest.since ? p : oldest)).close();
      count -= 1;
    }
    const limit = this.isKnownAddress(address) ? MAX_PENDING_CONNECTIONS : MAX_PENDING_CONNECTIONS - RESERVED_FOR_KNOWN;
    return count < limit;
  }

  /** A connection proved a paired key: it stops counting, but each key may have only a few such. */
  private keyProven(session: Session, key: string): void {
    // A hello the agent has already answered is a replay: it may not take a slot from the owner.
    const hello = session.firstFrame;
    if (hello !== null) {
      if (this.seenHellos.has(hello)) throw new AgentError('unauthorized', 'This connection attempt was already used.', 'Connect again.');
      this.seenHellos.add(hello);
      if (this.seenHellos.size > REMEMBERED_HELLOS) this.seenHellos.delete(this.seenHellos.values().next().value!);
    }
    session.provenKey = key;
    const waiting = [...this.sessions].filter((s) => s.provenKey === key && s.deviceId === null && !s.dead);
    for (const extra of waiting.slice(0, Math.max(0, waiting.length - MAX_UNSIGNED_PER_KEY))) this.breakLink(extra, 'too many connections for one key');
  }

  private isKnownAddress(address: string): boolean {
    const last = this.knownAddresses.get(address);
    return last !== undefined && this.now() - last < KNOWN_ADDRESS_MS;
  }

  private rememberAddress(address: string): void {
    this.knownAddresses.delete(address);
    this.knownAddresses.set(address, this.now());
    if (this.knownAddresses.size > MAX_KNOWN_ADDRESSES) this.knownAddresses.delete(this.knownAddresses.keys().next().value!);
  }

  /** The link host for one connection: Pairing's rules plus the limits that depend on where it comes from. */
  private linkHostFor(session: Session): ResponderHost<PairedDevice> {
    const { pairing, log } = this.deps;
    return {
      agentInfo: () => this.deps.agentInfo,
      session: (linkKey) =>
        asRefusal(() => {
          const device = pairing.session(linkKey);
          this.keyProven(session, toBase64Url(linkKey));
          return device;
        }),
      pairWithSecret: (linkKey, request, secret) => asRefusal(() => pairing.pairWithSecret(linkKey, request, secret)),
      beginPin: () =>
        asRefusal(() => {
          this.checkPinPause(session.address);
          const pin = pairing.beginPin();
          session.pinGuessTimer = setTimeout(
            () => this.guarded('the PIN guess deadline', () => session.socket.terminate(), () => this.breakLink(session, 'no PIN guess in time')),
            this.deps.pinGuessTimeoutMs ?? PIN_GUESS_TIMEOUT_MS,
          );
          return pin;
        }),
      pairWithPin: (linkKey, request) => asRefusal(() => pairing.pairWithPin(linkKey, request)),
      endPin: (end) => {
        this.clearPinGuessTimer(session);
        if (end === 'wrong-pin') log(`[${timestamp()}] a device tried a wrong PIN`);
        if (end === 'no-guess') this.noteAbandonedPinRun(session.address);
        try {
          pairing.endPin(end);
        } catch (err) {
          // Runs from socket close handlers too, where a throw would stop the agent.
          log(`[${timestamp()}] could not record the end of a PIN run: ${(err as Error).message}`);
        }
      },
    };
  }

  private checkPinPause(address: string): void {
    const runs = this.abandonedPinRuns.get(address);
    const now = this.now();
    if (!runs || now >= runs.pausedUntil) return;
    const seconds = Math.ceil((runs.pausedUntil - now) / 1000);
    throw new AgentError('locked', `PIN pairing from this device is paused for ${seconds} more seconds, after several attempts that never tried a PIN.`, 'Wait, then type the PIN shown on the computer, or scan its QR code.');
  }

  /** A PIN run ended with no guess: costs nothing on the PIN, but enough of them pause this address. */
  private noteAbandonedPinRun(address: string): void {
    const now = this.now();
    for (const [peer, runs] of this.abandonedPinRuns) {
      if (now >= runs.pausedUntil && runs.at.every((at) => now - at >= ABANDONED_PIN_SPAN_MS)) this.abandonedPinRuns.delete(peer);
    }
    const runs = this.abandonedPinRuns.get(address) ?? { at: [], pausedUntil: 0 };
    runs.at = [...runs.at.filter((at) => now - at < ABANDONED_PIN_SPAN_MS), now];
    if (runs.at.length >= MAX_ABANDONED_PIN_RUNS) {
      runs.at = [];
      runs.pausedUntil = now + ABANDONED_PIN_PAUSE_MS;
      this.deps.log(`[${timestamp()}] paused PIN pairing from ${address} for a minute: it kept starting PIN runs without a guess`);
    }
    this.abandonedPinRuns.set(address, runs);
  }

  private clearPinGuessTimer(session: Session): void {
    if (session.pinGuessTimer) clearTimeout(session.pinGuessTimer);
    session.pinGuessTimer = null;
  }

  private accept(socket: WebSocket, address: string): void {
    const session: Session = {
      socket,
      address,
      responder: null,
      channel: null,
      handshakeTimer: setTimeout(() => this.guarded('the handshake deadline', () => socket.terminate(), () => this.breakLink(session, 'handshake timed out')), this.deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS),
      pinGuessTimer: null,
      device: null,
      deviceId: null,
      deviceName: null,
      alive: true,
      dead: false,
      since: this.now(),
      provenKey: null,
      firstFrame: null,
      envPeer: null,
    };
    session.responder = new LinkResponder(this.linkHostFor(session), this.deps.linkKey, this.random, MAX_MESSAGE_BYTES);
    this.sessions.add(session);
    socket.on('pong', () => {
      session.alive = true;
    });
    const dropSession = () => this.cutOff(session);
    socket.on('message', (data, isBinary) =>
      this.guarded('a message from a device', dropSession, () => {
        if (isBinary) this.receiveFrame(session, frameBytes(data));
        else this.receiveText(session, data.toString());
      }),
    );
    socket.on('close', () =>
      this.guarded('closing a connection', () => {}, () => {
        this.sessions.delete(session);
        this.endHandshake(session);
        if (session.deviceId === null) return;
        if (session.envPeer) this.deps.env?.peerGone(session.envPeer);
        this.deps.focus.clientDisconnected();
        this.deps.emit({ type: 'device.disconnected', deviceId: session.deviceId });
        if (!this.connectedDeviceIds().has(session.deviceId)) this.joins.deviceGone(session.deviceId);
      }),
    );
    socket.on('error', () => socket.terminate());
  }

  private checkAlive(): void {
    // Catches an unpairing whose file change this process was never told about: the pairing check
    // reads a cached agent.json, so read the file again first.
    try {
      this.deps.pairing.refresh();
      for (const deviceId of this.dropUnpaired()) this.deps.emit({ type: 'device.revoked', deviceId });
    } catch (err) {
      this.deps.log(`[${timestamp()}] could not check paired devices: ${(err as Error).message}`);
    }
    for (const session of this.sessions) {
      if (!session.alive) {
        session.socket.terminate();
        continue;
      }
      session.alive = false;
      session.socket.ping();
    }
  }

  /** Encrypts and sends; nothing is ever sent in the clear once a device is in. */
  private send(session: Session, message: Response | EventMessage | EnvResponse | EnvEventMessage): void {
    if (!session.channel || session.socket.readyState !== session.socket.OPEN) return;
    for (const frame of session.channel.seal(JSON.stringify(message))) session.socket.send(frame);
  }

  /** The one kind of plain-text frame the agent sends: a refusal before any key is agreed, then close. */
  private refuseInClear(session: Session, error: ProtocolError, id?: string): void {
    if (session.socket.readyState === session.socket.OPEN) session.socket.send(JSON.stringify({ ...(id !== undefined ? { id } : {}), ok: false, error }));
    this.closeSession(session, CLOSE_UNAUTHORIZED, error.code);
  }

  private breakLink(session: Session, reason: string): void {
    this.endHandshake(session);
    this.closeSession(session, CLOSE_LINK_BROKEN, reason);
  }

  /** Stops reading the session and closes it; a peer that won't finish the close is cut off soon after. */
  private closeSession(session: Session, code: number, reason: string): void {
    session.dead = true;
    this.clearHandshakeTimer(session);
    session.socket.close(code, reason);
    setTimeout(() => session.socket.terminate(), CLOSE_GRACE_MS).unref(); // terminate() doesn't throw
  }

  /** Revoked: marked dead before anything else, so no frame already on its way is handled, then dropped. */
  private cutOff(session: Session): void {
    session.dead = true;
    this.endHandshake(session);
    session.socket.terminate();
  }

  private stillPaired(session: Session): boolean {
    return session.device !== null && session.channel !== null && this.deps.pairing.isPaired(session.device.deviceId, toBase64Url(session.channel.remoteStatic));
  }

  private clearHandshakeTimer(session: Session): void {
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    session.handshakeTimer = null;
    this.clearPinGuessTimer(session);
  }

  private endHandshake(session: Session): void {
    this.clearHandshakeTimer(session);
    session.responder?.abandon();
    session.responder = null;
  }

  /**
   * Text frames are never part of the link. Before the handshake one comes from a protocol 1 app,
   * which gets a refusal it can read; after it, a plain-text call is refused outright.
   */
  private receiveText(session: Session, raw: string): void {
    if (session.dead) return;
    if (session.channel || !session.responder) {
      this.breakLink(session, 'plain text refused');
      return;
    }
    let id: string | undefined;
    try {
      const request = JSON.parse(raw) as { id?: unknown };
      if (typeof request?.id === 'string') id = request.id;
    } catch {
      // Not even JSON: the refusal goes out without an id.
    }
    this.deps.log(`[${timestamp()}] refused an unencrypted connection from an older AuthDeck app`);
    this.endHandshake(session);
    this.refuseInClear(session, PLAINTEXT_CLIENT_REFUSAL, id);
  }

  private receiveFrame(session: Session, frame: Uint8Array): void {
    if (session.dead) return;
    if (session.channel) {
      this.receiveTransport(session, session.channel, frame);
      return;
    }
    const responder = session.responder;
    if (!responder) return;
    session.firstFrame ??= crypto.createHash('sha256').update(frame).digest('base64');
    // After pinStart the only frame that may come is the guess: it arrived in time.
    this.clearPinGuessTimer(session);
    if (frame[0] !== PROTOCOL_VERSION) {
      this.endHandshake(session);
      this.refuseInClear(session, LinkResponder.versionRefusal(frame));
      return;
    }
    try {
      const step = responder.receive(frame);
      for (const reply of step.send) session.socket.send(reply);
      if (step.refused) {
        this.deps.log(`[${timestamp()}] refused a device: ${step.refused.message}`);
        this.endHandshake(session);
        this.closeSession(session, CLOSE_UNAUTHORIZED, step.refused.code);
        return;
      }
      if (step.opened) this.opened(session, step.opened);
    } catch (err) {
      this.endHandshake(session);
      if (err instanceof LinkRefusal) {
        this.refuseInClear(session, err.error);
        return;
      }
      const detail = err instanceof LinkError ? err.message : `internal error: ${(err as Error)?.stack ?? String(err)}`;
      this.deps.log(`[${timestamp()}] dropped a connection: ${detail}`);
      this.refuseInClear(session, { code: 'bad_request', message: 'The connection could not be secured.', hint: 'Try again. If it keeps failing, update the AuthDeck app and agent.' });
    }
  }

  /** The handshake proved a paired device; it signs in with its first encrypted frame. The handshake deadline still runs. */
  private opened(session: Session, opened: { channel: SecureChannel; device: PairedDevice; paired: boolean }): void {
    const { device } = opened;
    session.responder = null;
    session.channel = opened.channel;
    session.device = device;
    if (opened.paired) {
      this.deps.emit({ type: 'device.paired', deviceId: device.deviceId, deviceName: device.deviceName });
      this.deps.log(`[${timestamp()}] paired ${printableName(device.deviceName)}`);
    }
  }

  /** Any frame that fails to open (altered, replayed, reordered, cut) ends the connection. */
  private receiveTransport(session: Session, channel: SecureChannel, frame: Uint8Array): void {
    let message: string | null;
    try {
      message = channel.open(frame);
    } catch (err) {
      // LinkError messages are the link's own words; anything else is logged by name only.
      this.deps.log(`[${timestamp()}] dropped ${session.device?.deviceName ?? 'a device'}: ${err instanceof LinkError ? err.message : `unexpected ${errorName(err)}`}`);
      this.breakLink(session, 'frame rejected');
      return;
    }
    if (session.deviceId === null && !this.signIn(session)) return;
    if (message !== null) {
      this.handleMessage(session, message).catch((err: unknown) => this.guarded('a request', () => this.cutOff(session), () => {
        throw err;
      }));
    }
  }

  /** The device's first encrypted frame opened: it holds the keys, so it is signed in now. */
  private signIn(session: Session): boolean {
    const device = session.device!;
    if (!this.stillPaired(session)) {
      this.cutOff(session);
      return false;
    }
    const signedIn = [...this.sessions].filter((s) => s.deviceId !== null && !s.dead);
    if (signedIn.length >= MAX_SIGNED_IN) {
      this.deps.log(`[${timestamp()}] refused a sign-in from ${printableName(device.deviceName)}: ${MAX_SIGNED_IN} connections are already open`);
      this.breakLink(session, 'too many connections');
      return false;
    }
    const own = signedIn.filter((s) => s.deviceId === device.deviceId);
    for (const old of own.slice(0, Math.max(0, own.length - MAX_SESSIONS_PER_DEVICE + 1))) this.closeSession(old, CLOSE_LINK_BROKEN, 'replaced by a newer connection');
    this.clearHandshakeTimer(session);
    this.rememberAddress(session.address);
    try {
      this.deps.pairing.touch(device.deviceId);
    } catch (err) {
      this.deps.log(`[${timestamp()}] could not note when ${printableName(device.deviceName)} was last seen: ${(err as Error).message}`);
    }
    this.authenticated(session, device.deviceId, device.deviceName);
    return true;
  }

  private async handleMessage(session: Session, raw: string): Promise<void> {
    let id = '';
    let method: Method | undefined;
    try {
      let request: unknown;
      try {
        request = JSON.parse(raw);
      } catch {
        throw badRequest('The message is not valid JSON.');
      }
      if (typeof request !== 'object' || request === null) throw badRequest('The message is not a request.');
      const fields = request as Record<string, unknown>;
      if (typeof fields.id === 'string') id = fields.id;
      if (typeof fields.id !== 'string' || typeof fields.method !== 'string') throw badRequest('The request needs an id and a method.');
      method = fields.method as Method;
      const params = (typeof fields.params === 'object' && fields.params !== null ? fields.params : {}) as Params;
      // Unpairing, from any process, takes effect on the next request even if no one told this one.
      if (!this.stillPaired(session)) {
        this.cutOff(session);
        return;
      }
      const result = await this.dispatch(session, method, params);
      this.send(session, { id, ok: true, result } as Response);
    } catch (err) {
      this.send(session, { id, ok: false, error: toProtocolError(err) });
      if (!(err instanceof AgentError)) this.deps.log(`[${timestamp()}] internal error in ${method ?? 'request'}: ${(err as Error)?.stack ?? String(err)}`);
    }
  }

  private async dispatch(session: Session, method: Method, params: Params): Promise<unknown> {
    switch (method) {
      case 'ping':
        return { time: Date.now() };
      case 'apps.list':
        return { apps: sendableApps(await this.deps.catalog.list(params.refresh === true)) };
      case 'apps.icons':
        return { icons: await this.icons(params.ids) };
      case 'fs.list':
        return sendableListing(
          await listFolder(
            { path: typeof params.path === 'string' ? params.path : undefined, includeFiles: params.includeFiles === true },
            this.deps.home,
            this.deps.platform,
          ),
        );
      case 'focus.get':
        return sendableFocus(await this.deps.focus.current());
      case 'run':
        return this.run(session, params);
      case 'vault.list':
        this.takeVaultRead(session);
        return { vaults: this.deps.vaults.list(), teamFolder: this.deps.vaults.watchRoots().find((r) => r.location === 'team')?.root ?? null };
      case 'vault.read':
        this.takeVaultRead(session);
        return this.deps.vaults.read(params.vaultId, params.since);
      case 'vault.append':
        return this.appendToVault(session, params);
      case 'vault.beacons.read':
        this.takeVaultRead(session);
        return this.deps.vaults.readBeacons(params.vaultId);
      case 'vault.forks.read':
        this.takeVaultRead(session);
        return sendableForks(this.deps.vaults.readForks(params.vaultId));
      case 'vault.forks.write':
        if (!this.limitsFor(session.deviceId!).append.tryTake()) throw rateLimited('This device is sending vault changes too fast. Wait a moment and try again.');
        if (params.sealProof !== undefined) return this.deps.vaults.writeSealProof(params.vaultId, params.sealProof);
        return this.deps.vaults.writeFork(params.vaultId, params.proof);
      case 'vault.beacons.write':
        if (!this.limitsFor(session.deviceId!).append.tryTake()) throw rateLimited('This device is sending vault changes too fast. Wait a moment and try again.');
        return this.deps.vaults.writeBeacon(params.vaultId, params.beacon);
      case 'vault.retire': {
        // A solo vault's active device, signing for this computer (the store checks): the vault it replaced is set aside, not deleted.
        if (!this.limitsFor(session.deviceId!).append.tryTake()) throw rateLimited('This device is sending vault changes too fast. Wait a moment and try again.');
        const deviceName = session.deviceName === null ? null : printableName(session.deviceName);
        const { keptUntil, retiredNow } = this.deps.vaults.retire(params.vaultId, params.request, this.deps.agentInfo.agentId, deviceName);
        if (retiredNow) {
          this.deps.log(`[${timestamp()}] ${deviceName ?? '?'} replaced a vault with a new one; the old one is kept for 30 days`);
          this.guarded('telling the user about a retired vault', () => {}, () => this.deps.onVaultRetired?.({ deviceName, keptUntil }));
        }
        return { keptUntil };
      }
      case 'vault.join.request':
        // Joining is multi-device (0.4): 0.3.0 adds a device only by restoring with the phrase.
        if (!vaultFeatures.multiDevice) throw badRequest('This version of AuthDeck keeps solo vaults only, so a device joins only by restoring the vault with its recovery phrase.');
        if (!this.limitsFor(session.deviceId!).joinRequest.tryTake()) throw rateLimited('This device sent too many join requests. Wait a minute and try again.');
        return this.joins.request(session.deviceId!, params);
      case 'vault.join.challenge':
        return this.joins.challenge(session.deviceId!, params);
      case 'vault.join.reveal':
        return this.joins.reveal(session.deviceId!, params);
      case 'vault.join.finish':
        return this.joins.finish(session.deviceId!, params);
      case 'vault.join.cancel':
        return this.joins.cancel(session.deviceId!, params);
      default:
        if (this.deps.env && session.envPeer && String(method).startsWith('env.')) return this.deps.env.handleLink(session.envPeer, method, params);
        throw badRequest(`"${String(method)}" is not a method this agent knows. Update the AuthDeck agent on the computer.`);
    }
  }

  private appendToVault(session: Session, params: Params): unknown {
    if (!this.limitsFor(session.deviceId!).append.tryTake()) throw rateLimited('This device is sending vault changes too fast. Wait a moment and try again.');
    const repair = params.repair === true;
    const { lengths, takenOut, wrote, restored } = this.deps.vaults.append(params.vaultId, params.entries, repair, params.proof);
    // The store checked both: the vault id is an id, and every entry is a signed entry.
    const vaultId = params.vaultId as string;
    const entries = params.entries as VaultEntry[];
    // A repair rewrites lines other devices may have written, so it is noted; never the lines themselves.
    if (repair) {
      const count = entries.length;
      this.deps.log(`[${timestamp()}] ${session.deviceName ?? '?'} repaired a vault log: wrote back ${count} line${count === 1 ? '' : 's'}`);
    } else if (wrote.length === 1) {
      // A plain append carries the sender's own lines, and only lines that changed the folder say
      // who sent them: anyone can send another device's stored lines again. One device's new lines
      // are the sender's own; a restore adds the recovery identity's, which is no device. A repair,
      // or new lines of several devices, says nothing about who is who.
      this.deps.vaultAuthors?.record(vaultId, wrote, session.deviceId!);
    }
    if (takenOut.length === 0) return { lengths };
    return { lengths, removals: this.unpairTakenOut(session, vaultId, takenOut, restored) };
  }

  /**
   * Unpairs the paired devices that are the identities an append took out of a vault: removed
   * means cut off from this computer too. The sender itself (out in a symmetric conflict) is
   * unpaired just after its answer goes out, so it still learns what happened. A restore (a solo
   * vault's phrase adding a device) never unpairs its sender: the same phone restoring after a
   * reinstall takes out its own old identity, and holding the phrase proves it is the owner.
   */
  private unpairTakenOut(session: Session, vaultId: string, takenOut: string[], restored: boolean): VaultRemoval[] {
    const sender = session.deviceId!;
    const computer = this.deps.agentInfo.name;
    // Two identities can be one paired device; it is unpaired once and both say so.
    const outcomes = new Map<string, boolean>();
    let senderIsOut = false;
    const unpaired = (linkDevice: string): boolean => {
      if (linkDevice === sender) return restored ? false : (senderIsOut = true);
      if (!outcomes.has(linkDevice)) outcomes.set(linkDevice, this.unpairRemovedDevice(linkDevice));
      return outcomes.get(linkDevice)!;
    };
    const removals = takenOut.map((identity): VaultRemoval => {
      const linkDevice = this.deps.unpairDevice ? this.deps.vaultAuthors?.linkDeviceOf(vaultId, identity) : undefined;
      return { device: identity, unpairedFrom: linkDevice !== undefined && unpaired(linkDevice) ? computer : null };
    });
    if (senderIsOut) setImmediate(() => this.guarded('unpairing a removed device', () => {}, () => void this.unpairRemovedDevice(sender)));
    return removals;
  }

  /** True when the device was paired and is now unpaired and cut off. Logs its name only. */
  private unpairRemovedDevice(linkDevice: string): boolean {
    try {
      const device = this.deps.unpairDevice?.(linkDevice) ?? null;
      if (device) this.deps.log(`[${timestamp()}] ${printableName(device.deviceName)} was removed from a vault, so it is unpaired from this computer`);
      return device !== null;
    } catch (err) {
      // revokeDevice cuts the device off before it writes agent.json, so it is out until it reconnects.
      this.deps.log(`[${timestamp()}] Could not unpair a device removed from a vault: ${(err as Error).message}. Unpair it in AuthDeck Agent.`);
      return false;
    }
  }

  private takeVaultRead(session: Session): void {
    if (!this.limitsFor(session.deviceId!).read.tryTake()) throw rateLimited('This device is reading the vault too fast. Wait a moment and try again.');
  }

  private limitsFor(deviceId: string): DeviceLimits {
    let limits = this.deviceLimits.get(deviceId);
    if (!limits) {
      const now = this.deps.now ?? Date.now;
      limits = { append: new RateLimiter(VAULT_APPEND_RATE, now), joinRequest: new RateLimiter(VAULT_JOIN_REQUEST_RATE, now), read: new RateLimiter(VAULT_READ_RATE, now) };
      this.deviceLimits.set(deviceId, limits);
    }
    return limits;
  }

  private authenticated(session: Session, deviceId: string, deviceName: string): void {
    session.deviceId = deviceId;
    session.deviceName = deviceName;
    if (this.deps.env) {
      session.envPeer = { deviceId, deviceName, members: null, send: (event, data) => this.sendEnvEvent(session, event, data) };
    }
    this.deps.focus.clientConnected();
    this.deps.emit({ type: 'device.connected', deviceId, deviceName });
    // Sent after the handshake's last message goes out.
    setImmediate(() => {
      // The same rule as every other event: only to a device still paired, and a focus lookup that
      // fails is just not sent.
      this.deps.focus.current().then(
        (info) => {
          if (this.pairedOrCutOff(session)) this.send(session, { event: 'focus', data: sendableFocus(info) });
        },
        (err: unknown) => this.deps.log(`Could not read the focused window: ${errorName(err)}`),
      );
    });
  }

  private async icons(ids: unknown): Promise<Record<string, unknown>> {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw badRequest('"ids" must be a list of app ids.');
    if (ids.length > MAX_ICON_IDS) throw badRequest(`Ask for at most ${MAX_ICON_IDS} icons at a time.`);
    const apps = new Map(await Promise.all((ids as string[]).map(async (id) => [id, await this.deps.catalog.get(id)] as const)));
    return this.deps.icons.icons(apps);
  }

  private async run(session: Session, params: Params): Promise<unknown> {
    const started = Date.now();
    const actionId = this.nextActionId++;
    const summary = summarizeAction(params.action);
    const device = session.deviceName ?? '?';
    const appName = (id: string) => this.deps.catalog.snapshot().find((app) => app.entry.id === id)?.entry.name;
    const activity = describeActivity(params.action, this.deps.platform, appName);
    const title = keyLabel(params.label) ?? activity.title;
    this.deps.emit({ type: 'action.started', actionId, deviceName: device, at: started, ...activity, title });
    try {
      const result = await this.deps.runner.run(params);
      const durationMs = Date.now() - started;
      this.deps.log(`[${timestamp()}] ${device}  ${summary}  ok  ${durationMs} ms`);
      this.deps.emit({ type: 'action.finished', actionId, ok: true, durationMs, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) });
      return result;
    } catch (err) {
      const durationMs = Date.now() - started;
      const error = toProtocolError(err);
      this.deps.log(`[${timestamp()}] ${device}  ${summary}  error ${error.code}: ${error.message}  ${durationMs} ms`);
      const failure: ActionFailure = err instanceof AgentError && err.permission ? { ...error, permission: err.permission } : error;
      this.deps.emit({ type: 'action.finished', actionId, ok: false, durationMs, failure });
      throw err;
    }
  }
}
