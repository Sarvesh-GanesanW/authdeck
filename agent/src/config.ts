import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT, type DeviceForm } from './protocol';
import { toBase64Url, fromBase64Url } from './vault/bytes';
import { generateLinkKey, linkKeyFromSecret, LINK_KEY_BYTES, type LinkKeyPair } from './link/keys';

export interface PairedDevice {
  deviceId: string;
  deviceName: string;
  /** Sent by apps from protocol 1 with `form`; older pairings have none. */
  form?: DeviceForm;
  /** The app's static X25519 link key (base64url). Missing on pairings made before protocol 2,
   *  which can no longer connect until the device pairs again. */
  linkKey?: string;
  /** Protocol 1 only: the hash of the device's bearer token. Kept so the device stays listed. */
  tokenSha256?: string;
  pairedAt: string;
  lastSeenAt: string;
}

export type TerminalPreference = 'Terminal' | 'iTerm';
export type ShellPreference = 'cmd' | 'powershell' | 'pwsh';

/** PIN guessing, kept on disk so a restart forgets nothing. */
export interface PinGuard {
  /** Wrong PINs since the PIN last changed. */
  failuresOnPin: number;
  /** PINs replaced after too many wrong guesses since the last successful pairing. */
  replacements: number;
  /** PIN pairing is paused until then (ms since the epoch). */
  lockedUntil: number;
}

export interface AgentConfig {
  agentId: string;
  name: string;
  port: number;
  /** The pairing PIN. Valid only while the pairing window is open; replaced whenever it opens or closes. */
  pin: string;
  /** The QR code's one-time pairing secret (base64url). Same lifetime as the PIN, and also replaced after each pairing. */
  pairSecret: string;
  /** When the pairing window closes (ms since the epoch); 0 or missing while it is closed. */
  pairingOpenUntil?: number;
  pinGuard?: PinGuard;
  devices: PairedDevice[];
  /** macOS only: which terminal app opens `command` actions in terminal mode. */
  terminal: TerminalPreference;
  /** Windows only: shell for `command` actions. Posix always uses $SHELL. */
  shell?: ShellPreference;
  /** Shared folder (Dropbox, iCloud, Syncthing, Git…) that holds team vaults, one folder per vault. */
  teamFolder?: string;
}

const PIN_DIGITS = 6;
const PAIR_SECRET_BYTES = 16;
const LINK_KEY_FILE = 'link-key';
const LOCK_FILE = 'agent.json.lock';
/** How long a command-line writer waits for another to finish before giving up. */
const LOCK_WAIT_MS = 3000;
/**
 * The running agent waits at most this long, so a stuck lock never freezes it for seconds; the
 * change then fails and the caller says so. A live writer holds the lock for milliseconds.
 */
export const AGENT_LOCK_WAIT_MS = 400;
/**
 * A lock older than this was left by a writer that died or hung, even if its pid now belongs to
 * another process. Shorter than LOCK_WAIT_MS, so a waiting command can always take it over.
 */
const LOCK_STALE_MS = 1500;
const LOCK_RETRY_MS = 5;
/** Bursts of file events from one write are handled once. */
const WATCH_DEBOUNCE_MS = 50;
/** How often agent.json is checked when the folder can't be watched. */
const WATCH_POLL_MS = 2000;

const HOME_DIR_NAME = '.authdeck';
/** Where the agent kept its files before the rename to AuthDeck. */
const LEGACY_HOME_DIR_NAME = '.devdeck';

/** Folder for config, icon cache and helper scripts. AUTHDECK_HOME overrides it (used by tests). */
export function authdeckHome(env: NodeJS.ProcessEnv = process.env, userHome: string = os.homedir()): string {
  return env.AUTHDECK_HOME ? path.resolve(env.AUTHDECK_HOME) : path.join(userHome, HOME_DIR_NAME);
}

/**
 * Copies the pre-rename folder (~/.devdeck) to ~/.authdeck the first time, so pairings carry over.
 * The old folder is never moved or deleted: an older install of the agent may still be using it.
 * Does nothing when AUTHDECK_HOME is set. Returns the folder it copied from, or null.
 */
export function carryOverLegacyHome(env: NodeJS.ProcessEnv = process.env, userHome: string = os.homedir()): string | null {
  if (env.AUTHDECK_HOME) return null;
  const home = authdeckHome(env, userHome);
  const legacyHome = path.join(userHome, LEGACY_HOME_DIR_NAME);
  if (fs.existsSync(home) || !fs.existsSync(legacyHome)) return null;
  // Copy beside the target and rename, so an interrupted copy never looks like a finished one.
  const staging = `${home}.${process.pid}.copying`;
  try {
    fs.cpSync(legacyHome, staging, { recursive: true, preserveTimestamps: true });
    fs.chmodSync(staging, 0o700);
    fs.renameSync(staging, home);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`Could not copy your settings from ${legacyHome} to ${home} (${(err as Error).message}). Copy the folder yourself, or pair your devices again.`, { cause: err });
  }
  return legacyHome;
}

export function configPath(home: string): string {
  return path.join(home, 'agent.json');
}

export function generatePin(): string {
  return String(crypto.randomInt(0, 10 ** PIN_DIGITS)).padStart(PIN_DIGITS, '0');
}

/** A fresh QR pairing secret: 128 random bits, base64url. */
export function generatePairSecret(): string {
  return toBase64Url(crypto.randomBytes(PAIR_SECRET_BYTES));
}

/** The longest computer name, in characters. The app trims longer names the same way. */
export const MAX_COMPUTER_NAME_CHARS = 64;

/** Hostname as people say it: "Adas-MacBook.local" -> "Adas-MacBook", at most 64 characters. */
export function friendlyHostname(hostname: string = os.hostname()): string {
  const name = hostname.replace(/\.local(domain)?$/i, '').replace(/\.lan$/i, '') || 'Computer';
  return Array.from(name).slice(0, MAX_COMPUTER_NAME_CHARS).join('');
}

/** A name from agent.json the agent will give out: text, not blank, at most 64 characters. */
export function isUsableComputerName(name: unknown): name is string {
  return typeof name === 'string' && name.trim() !== '' && Array.from(name).length <= MAX_COMPUTER_NAME_CHARS;
}

function defaults(): AgentConfig {
  return {
    agentId: crypto.randomUUID(),
    name: friendlyHostname(),
    port: DEFAULT_PORT,
    pin: generatePin(),
    pairSecret: generatePairSecret(),
    devices: [],
    terminal: 'Terminal',
  };
}

function readStored(file: string): Partial<AgentConfig> | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text) as Partial<AgentConfig>;
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Fix it or delete it to start over (you will need to pair again).`);
  }
}

function isComplete(stored: Partial<AgentConfig>): boolean {
  return stored.agentId !== undefined && stored.pin !== undefined && stored.pairSecret !== undefined;
}

function withDefaults(stored: Partial<AgentConfig>): AgentConfig {
  const config = { ...defaults(), ...stored, devices: stored.devices ?? [] };
  // A name typed into agent.json that is too long or blank is not given out: the host name is.
  if (!isUsableComputerName(config.name)) config.name = friendlyHostname();
  return config;
}

/** Reads the config, creating it with fresh ids and PIN on first run. */
export function loadConfig(home: string): AgentConfig {
  const stored = readStored(configPath(home));
  if (stored && isComplete(stored)) return withDefaults(stored);
  // First run, or a file missing its ids: fill it in under the lock, so two processes starting
  // together agree on one agent id.
  return withConfigLock(home, () => {
    const latest = readStored(configPath(home));
    if (latest && isComplete(latest)) return withDefaults(latest);
    const filled = withDefaults(latest ?? {});
    saveConfig(home, filled);
    return filled;
  });
}

/**
 * Writes atomically with owner-only permissions; the file holds the PIN and the QR secret. Use
 * updateConfig to change a config read from disk, so a change made meanwhile by another process
 * (the command line, the desktop app) is not lost.
 */
export function saveConfig(home: string, config: AgentConfig): void {
  writeOwnerOnly(home, configPath(home), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Reads the config, applies `change` and writes it back, all while holding agent.json.lock, so
 * every process that writes through here sees the others' changes. Returns what was written.
 * Waits up to `waitMs` for another writer; the running agent passes AGENT_LOCK_WAIT_MS.
 */
export function updateConfig(home: string, change: (config: AgentConfig) => void, waitMs: number = LOCK_WAIT_MS): AgentConfig {
  return withConfigLock(
    home,
    () => {
      const config = withDefaults(readStored(configPath(home)) ?? {});
      change(config);
      saveConfig(home, config);
      return config;
    },
    waitMs,
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** What a lock file says: who holds it, and a nonce only that holder knows. */
interface LockOwner {
  /** The file's exact text: a takeover or release acts only on the very lock it looked at. */
  text: string;
  pid: number | null;
  ageMs: number;
}

function readLock(file: string): LockOwner | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const ageMs = Date.now() - fs.statSync(file).mtimeMs;
    let pid: number | null = null;
    try {
      const parsed = JSON.parse(text) as { pid?: unknown };
      const value = typeof parsed === 'number' ? parsed : parsed?.pid;
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) pid = value;
    } catch {
      // Not JSON: only its age can show it is stale.
    }
    return { text, pid, ageMs };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Left by a writer that is gone (its pid is dead), or held far longer than any write takes. */
function isStale(owner: LockOwner): boolean {
  return owner.ageMs > LOCK_STALE_MS || (owner.pid !== null && owner.pid !== process.pid && !processAlive(owner.pid));
}

/**
 * Moves `lock` aside if it is still exactly `expected`, and returns true; if the move caught a
 * different lock (taken meanwhile by someone else), puts that one back. Renaming is atomic, so
 * only one process can take over or release any one lock.
 */
function removeLockIf(lock: string, expected: string): boolean {
  const aside = `${lock}.${crypto.randomUUID()}.old`;
  try {
    fs.renameSync(lock, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  let moved = '';
  try {
    moved = fs.readFileSync(aside, 'utf8');
  } catch {
    // Unreadable: treated as someone else's.
  }
  try {
    if (moved === expected) return true;
    try {
      fs.linkSync(aside, lock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return false;
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/**
 * Runs `critical` while holding agent.json.lock. The lock file is created whole (written beside
 * it, then hard-linked into place, which fails if it exists) and names this process plus a
 * nonce; a stale lock is taken over atomically, and the lock is released only if it is still ours.
 */
function withConfigLock<T>(home: string, critical: () => T, waitMs: number = LOCK_WAIT_MS): T {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, LOCK_FILE);
  const mine = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const temp = writeOwnerOnlyTemp(home, lock, mine);
    let taken = false;
    try {
      fs.linkSync(temp, lock);
      taken = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      fs.rmSync(temp, { force: true });
    }
    if (taken) break;
    const owner = readLock(lock);
    if (owner && isStale(owner)) {
      removeLockIf(lock, owner.text);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Another AuthDeck process is changing ${configPath(home)} right now. Try again in a moment.`);
    }
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    return critical();
  } finally {
    removeLockIf(lock, mine);
  }
}

/**
 * Calls `onChange` soon after agent.json changes on disk, whoever wrote it (this process, the
 * command line, another app). Returns a function that stops watching.
 */
export function watchConfig(home: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, WATCH_DEBOUNCE_MS);
  };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // The folder, not the file: every save replaces the file by renaming a new one over it.
  let watcher: fs.FSWatcher | null = null;
  let poll: NodeJS.Timeout | null = null;
  // fs.watch can't start (EMFILE, or Linux out of inotify watches: it throws) or stops later
  // ('error'): then agent.json is checked every few seconds instead.
  const startPolling = () => {
    watcher?.close();
    watcher = null;
    if (poll) return;
    let last = '';
    const check = () => {
      try {
        const stat = fs.statSync(configPath(home));
        const stamp = `${stat.mtimeMs}:${stat.ino}:${stat.size}`;
        if (last && stamp !== last) changed();
        last = stamp;
      } catch {
        // Missing for a moment while it is replaced.
      }
    };
    check();
    poll = setInterval(check, WATCH_POLL_MS);
    poll.unref();
  };
  try {
    watcher = fs.watch(home, (_event, name) => {
      if (name === null || name === path.basename(configPath(home))) changed();
    });
    watcher.on('error', startPolling);
    watcher.unref();
  } catch {
    startPolling();
  }
  return () => {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    watcher?.close();
  };
}

export function linkKeyPath(home: string): string {
  return path.join(home, LINK_KEY_FILE);
}

/**
 * The computer's static link key, made on first use. The secret lives in its own owner-only file
 * beside agent.json, so the config can be shown or shared without it.
 */
export function loadLinkKey(home: string): LinkKeyPair {
  const file = linkKeyPath(home);
  if (!fs.existsSync(file)) createLinkKeyOnce(home, file);
  const text = fs.readFileSync(file, 'utf8').trim();
  let secret: Uint8Array;
  try {
    secret = fromBase64Url(text, 'The link key');
    if (secret.length !== LINK_KEY_BYTES) throw new Error(`it is ${secret.length} bytes, not ${LINK_KEY_BYTES}`);
  } catch (err) {
    throw new Error(`${file} is damaged (${(err as Error).message}). Delete it to make a new key; every device must then pair again.`, { cause: err });
  }
  return linkKeyFromSecret(secret);
}

/**
 * Creates the key file only if no other process has: the new key is written beside it and then
 * hard-linked into place, which fails if the file exists. Whoever loses keeps the winner's key.
 */
function createLinkKeyOnce(home: string, file: string): void {
  const created = generateLinkKey((length) => new Uint8Array(crypto.randomBytes(length)));
  const temp = writeOwnerOnlyTemp(home, file, `${toBase64Url(created.secret)}\n`);
  try {
    fs.linkSync(temp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function writeOwnerOnlyTemp(home: string, file: string, text: string): string {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') fs.chmodSync(temp, 0o600);
  return temp;
}

/** Writes atomically with owner-only permissions. */
function writeOwnerOnly(home: string, file: string, text: string): void {
  fs.renameSync(writeOwnerOnlyTemp(home, file, text), file);
}
