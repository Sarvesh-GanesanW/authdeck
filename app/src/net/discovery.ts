/**
 * Finding agents: the pairing link from the QR code, and a scan of the local /24 network.
 */
import * as Network from 'expo-network';
import { Platform } from 'react-native';

import { parseLinkPublicKey } from '../link/keys';
import { connectCanary } from '../state/connectCanary';
import { HELLO_PATH, type HelloResponse, PAIR_URL_PREFIX } from '../protocol';
import { defaultPort, testOverrides } from './testOverrides';
import { isLocalNetworkHost } from './addresses';
import { getTextOverTcp } from './helloTcp';
import { isHelloResponse } from './messages';
import { tcpTransport } from './tcp';
import { cleanName } from './trust';

export interface PairLink {
  name: string;
  port: number;
  hosts: string[];
  /** The computer's link key, base64url. Read by the camera, so it authenticates the computer. */
  agentKey: string;
  /** The QR code's one-time pairing secret. */
  secret: string;
  /** Addresses the link named that are outside the local network; never contacted. */
  refusedHosts: string[];
  /** Opened from another app (a deep link), not read by this app's own camera. */
  fromOtherApp?: boolean;
}

/**
 * Whether AuthDeck may contact `host`. Loopback only on the web, where the agent may share the
 * machine; a development build under the test switch also allows its listed test hosts.
 */
export function isAllowedHost(host: string): boolean {
  if (testOverrides?.hosts.includes(host)) return true;
  return isLocalNetworkHost(host, { allowLoopback: Platform.OS === 'web' });
}

const PAIR_SECRET = /^[A-Za-z0-9_-]{16,64}$/;
/** A pairing link names at most this many addresses; the rest are ignored. The agent lists a few. */
export const MAX_LINK_HOSTS = 8;
/** A real /hello answer is a few hundred bytes; anything past this is not read. */
export const MAX_HELLO_BYTES = 4096;

function pairLinkParams(text: string): Map<string, string> | null {
  const raw = text.trim();
  if (!raw.toLowerCase().startsWith(PAIR_URL_PREFIX)) return null;
  const q = raw.indexOf('?');
  if (q < 0) return null;
  const params = new Map<string, string>();
  for (const part of raw.slice(q + 1).split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    try {
      params.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')));
    } catch {
      return null;
    }
  }
  return params;
}

/**
 * Parses authdeck://pair?v=2&n=<name>&p=<port>&h=<ip1>,<ip2>&k=<key>&s=<secret>. Returns null if it
 * isn't one. Addresses outside the local network go to `refusedHosts`, so `hosts` may be empty.
 * Only the first MAX_LINK_HOSTS addresses count: each one is shown and may be tried with the secret.
 */
export function parsePairLink(text: string): PairLink | null {
  const params = pairLinkParams(text);
  if (!params) return null;
  const named = (params.get('h') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .slice(0, MAX_LINK_HOSTS);
  const port = Number(params.get('p') ?? defaultPort());
  const agentKey = params.get('k') ?? '';
  const secret = params.get('s') ?? '';
  if (named.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535 || !PAIR_SECRET.test(secret)) return null;
  try {
    parseLinkPublicKey(agentKey);
  } catch {
    return null;
  }
  const hosts = named.filter(isAllowedHost);
  const refusedHosts = named.filter((h) => !isAllowedHost(h));
  return { name: cleanName(params.get('n') ?? '') || hosts[0] || 'Computer', port, hosts, agentKey, secret, refusedHosts };
}

/** A pairing QR code from a protocol 1 agent (it carries a PIN and no key). */
export function isOlderPairLink(text: string): boolean {
  const params = pairLinkParams(text);
  return params !== null && params.has('c') && !params.has('k');
}

/** Accepts "192.168.1.5", "192.168.1.5:47474" or "my-pc.local". */
export function parseAddress(text: string): { host: string; port: number } | null {
  const t = text.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  if (!t) return null;
  // Split at the last colon by index, not with a regex whose quantifiers overlap.
  const colon = t.lastIndexOf(':');
  const portText = colon > 0 ? t.slice(colon + 1) : '';
  const hasPort = /^\d{1,5}$/.test(portText);
  const host = hasPort ? t.slice(0, colon) : t;
  const port = hasPort ? Number(portText) : defaultPort();
  if (!/^[a-z0-9.\-_]+$/i.test(host) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * A response body as text, or null past `maxBytes`. Streams where the platform can (browsers,
 * Node) and stops reading at the limit; React Native's fetch has no stream, so there a declared
 * length past the limit is refused unread and the text is checked once read (the caller's timeout
 * bounds how long that read can go on).
 */
export async function readCappedText(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return null;
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    return text.length > maxBytes ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Reads an address's /hello, or null. Anything on the network can answer, so the size and every
 * field are checked before the list shows it. On a phone this read is under the connection crash
 * canary (it asks one named address, like a session does); a sweep's reads are not, see probeHello.
 */
export function fetchHello(host: string, port: number, timeoutMs: number): Promise<HelloResponse | null> {
  return readHello(host, port, timeoutMs, 'marked');
}

/** A sweep's /hello read: a held address is skipped quietly, and the address is never marked. */
function probeHello(host: string, port: number): Promise<HelloResponse | null> {
  return readHello(host, port, SWEEP_PROBE_TIMEOUT_MS, 'swept');
}

type HelloRead = 'marked' | 'swept';

async function readHello(host: string, port: number, timeoutMs: number, read: HelloRead): Promise<HelloResponse | null> {
  try {
    const text = Platform.OS === 'web' ? await fetchHelloText(host, port, timeoutMs) : await helloTextOverTcp(host, port, timeoutMs, read);
    if (text === null) return null;
    const body: unknown = JSON.parse(text);
    return isHelloResponse(body) ? { ...body, name: cleanName(body.name) || host } : null;
  } catch {
    return null;
  }
}

async function fetchHelloText(host: string, port: number, timeoutMs: number): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}${HELLO_PATH}`, { signal: ctrl.signal });
    return res.ok ? await readCappedText(res, MAX_HELLO_BYTES) : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * On a phone, /hello is read over AuthDeck's own TCP (React Native's fetch inflates bodies natively
 * with no limit). A held address is skipped; a marked read goes under the canary's mark.
 */
async function helloTextOverTcp(host: string, port: number, timeoutMs: number, read: HelloRead): Promise<string | null> {
  const transport = tcpTransport();
  if (!transport) return null;
  const deadline = Date.now() + timeoutMs;
  const readText = async () => {
    const left = deadline - Date.now();
    return left > 0 ? getTextOverTcp(transport, host, port, HELLO_PATH, left, MAX_HELLO_BYTES) : null;
  };
  // A held address is skipped quietly: a /hello read is no reason to show the notice again.
  await connectCanary.check();
  if (connectCanary.isHeld(host)) return null;
  return read === 'swept' ? readText() : connectCanary.guard(host, readText);
}

export interface Found {
  host: string;
  hello: HelloResponse;
}

export const canScanNetwork = Platform.OS !== 'web';

/**
 * /hello reads a sweep runs at once. The native socket module allows 64 open sockets in all, and
 * at most one sweep runs at a time (see scanNetwork), so sweeps never hold more than 32. The other
 * 32 are kept for everything else: the session (1), a pairing (1, its addresses are tried one at a
 * time), a /hello read for a typed address or a version check (1 each), and sockets a sweep closed
 * that native code has not let go of yet. 254 addresses at 32 at a time take at most 8 rounds of
 * SWEEP_PROBE_TIMEOUT_MS, about 11 s, when nothing answers or refuses.
 */
export const SWEEP_CONCURRENCY = 32;
const SWEEP_PROBE_TIMEOUT_MS = 1400;

type FoundListener = (found: Found) => void;

/** One sweep of the network for /hello answers on one port, shared by everyone looking. */
interface Sweep {
  port: number;
  /** Answers so far, given to anyone who joins late. */
  found: Found[];
  listeners: Set<FoundListener>;
  /** Everyone looking left: no more addresses are asked. */
  stopped: boolean;
  /** Settles once the sweep's last read has. */
  done: Promise<void>;
}

/** The sweep under way, if any. One at a time, so the socket budget above holds. */
let current: Sweep | null = null;

/**
 * Probes every address on this device's /24 for an agent. Calls onFound as agents answer; resolves
 * when the sweep finishes or `signal` aborts. Everyone looking on the same port shares one sweep
 * (the pairing screen and the search for a moved computer); one on another port waits for it to
 * end. The sweep stops once everyone looking has aborted.
 */
export async function scanNetwork(onFound: FoundListener, signal: AbortSignal, port = defaultPort()): Promise<void> {
  for (;;) {
    if (signal.aborted) return;
    if (current === null) current = startSweep(port);
    const sweep = current;
    if (sweep.port === port && !sweep.stopped) return follow(sweep, onFound, signal);
    await settledOrAborted(sweep.done, signal);
  }
}

function startSweep(port: number): Sweep {
  const sweep: Sweep = { port, found: [], listeners: new Set(), stopped: false, done: Promise.resolve() };
  sweep.done = runSweep(sweep);
  // Followers see the outcome; this keeps a sweep nobody follows any more from going unhandled.
  sweep.done.catch(() => undefined);
  return sweep;
}

async function runSweep(sweep: Sweep): Promise<void> {
  try {
    // Under the test switch nothing is swept: only the listed test hosts are asked.
    const targets = testOverrides ? [...testOverrides.hosts] : await sweepTargets();
    await connectCanary.duringSweep(async () => {
      let next = 0;
      const worker = async () => {
        while (!sweep.stopped && next < targets.length) {
          const host = targets[next++]!;
          const hello = await probeHello(host, sweep.port);
          if (!hello || sweep.stopped) continue;
          const found = { host, hello };
          sweep.found.push(found);
          for (const listener of sweep.listeners) listener(found);
        }
      };
      await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, targets.length) }, worker));
    });
  } finally {
    // Before `done` settles, so whoever waited on it starts the next sweep.
    if (current === sweep) current = null;
  }
}

/** Joins a sweep: answers so far first, then new ones, until it ends or `signal` aborts. */
function follow(sweep: Sweep, onFound: FoundListener, signal: AbortSignal): Promise<void> {
  // A wrapper of its own, so two followers passing the same function both count.
  const listener: FoundListener = (found) => onFound(found);
  for (const found of sweep.found) onFound(found);
  sweep.listeners.add(listener);
  return new Promise<void>((resolve, reject) => {
    const leave = () => {
      sweep.listeners.delete(listener);
      if (sweep.listeners.size === 0) sweep.stopped = true;
      resolve();
    };
    signal.addEventListener('abort', leave, { once: true });
    sweep.done.then(
      () => {
        signal.removeEventListener('abort', leave);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener('abort', leave);
        reject(err);
      },
    );
  });
}

function settledOrAborted(done: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    done.then(finish, finish);
  });
}

/** Every other address on this device's /24. */
async function sweepTargets(): Promise<string[]> {
  const ip = await Network.getIpAddressAsync();
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip ?? '');
  // Only a local network is swept; on a public address the "neighbours" are strangers' machines.
  if (!m || ip === '0.0.0.0' || !isAllowedHost(ip!)) throw new Error('no-network');
  const prefix = `${m[1]}.${m[2]}.${m[3]}.`;
  const own = Number(m[4]);
  const targets: string[] = [];
  for (let i = 1; i < 255; i++) if (i !== own) targets.push(prefix + i);
  return targets;
}

/**
 * Looks for one specific agent whose address changed, and returns every address that answers as
 * it. Discovery is not authenticated: anything on the network can answer with this id and
 * fingerprint (both are public), so the fingerprint only skips other agents early, and the sweep
 * never stops at the first answer, which a squatter could give. Callers keep an address only after
 * a handshake there succeeds. `signal` stops looking (the addresses found so far are returned).
 */
export async function findAgent(agentId: string, port: number, fingerprint: string | null, signal?: AbortSignal): Promise<string[]> {
  if (!canScanNetwork) return [];
  const found: string[] = [];
  try {
    await scanNetwork(
      (f) => {
        if (f.hello.agentId === agentId && (fingerprint === null || f.hello.fingerprint === fingerprint)) found.push(f.host);
      },
      signal ?? new AbortController().signal,
      port,
    );
  } catch {
    return [];
  }
  return found;
}

export function localSubnetLabel(ip: string | null): string | null {
  const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(ip ?? '');
  return m ? `${m[1]}.x` : null;
}
