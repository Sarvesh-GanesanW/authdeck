import crypto from 'node:crypto';
import type { AgentConfig, PairedDevice, PinGuard } from './config';
import { AgentError } from './errors';
import type { PairRequest, PinRunEnd } from './link/handshakes';
import { toBase64Url } from './vault/bytes';

/** Wrong PINs before the PIN is replaced. Each PIN pairing run is at most one guess. */
export const MAX_PIN_FAILURES = 3;
/** PIN pairing pauses after each replacement: this long the first time, doubling up to the cap. */
export const FIRST_PIN_LOCKOUT_MS = 30_000;
export const MAX_PIN_LOCKOUT_MS = 60 * 60_000;
/** How long pairing stays open once the desktop app's pairing view or `authdeck-agent pair` opens it. */
export const PAIRING_WINDOW_MS = 10 * 60_000;
/** A device's lastSeenAt is written at most this often. */
export const LAST_SEEN_WRITE_MS = 60_000;
const DEFAULT_DEVICE_NAME = 'Tablet';
const MAX_DEVICE_NAME_LENGTH = 80;
const NO_GUESSES: PinGuard = { failuresOnPin: 0, replacements: 0, lockedUntil: 0 };

/** Constant-time string comparison (compares digests so differing lengths leak nothing). */
function constantTimeEquals(a: string, b: string): boolean {
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
}

/**
 * A device name with no control or format characters (ESC, bidi overrides...), so printing it to a
 * terminal or a log can't move the cursor, recolour the text or reorder what follows.
 */
export function printableName(name: string): string {
  return name.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
}

function cleanDeviceName(name: string): string {
  return printableName(name).slice(0, MAX_DEVICE_NAME_LENGTH) || DEFAULT_DEVICE_NAME;
}

function pairingClosed(): AgentError {
  return new AgentError(
    'locked',
    'Pairing is not open on this computer.',
    'On the computer, open pairing: click Pair a device in AuthDeck Agent, or run "authdeck-agent pair". Then use the PIN or QR code it shows.',
  );
}

export interface PairingDeps {
  /** Reads the config fresh, so changes made by the command line apply to a running agent. */
  load: () => AgentConfig;
  /** Read, change and write the config with no other writer in between (config.ts updateConfig). */
  update: (change: (config: AgentConfig) => void) => AgentConfig;
  /**
   * The config as last read or written, kept current by the agent's watch of agent.json (or its
   * 2-second check when the folder can't be watched). Checked on every request, so it must not
   * read the file; without it, `load` is used.
   */
  cached?: () => AgentConfig;
  /** Reads agent.json into that cache again; the keepalive does it, in case the watch missed a change. */
  refresh?: () => void;
  newPin: () => string;
  newPairSecret: () => string;
  /** The pairing window, the PIN or the QR secret changed. */
  onPairingChanged?: () => void;
  now?: () => number;
}

/** An open pairing window and the secrets that work in it. */
export interface PairingWindow {
  pin: string;
  pairSecret: string;
  /** When it closes (ms since the epoch). */
  closesAt: number;
}

/** The window open in this config at `now`, or null while pairing is closed. */
export function openPairingWindow(config: AgentConfig, now: number): PairingWindow | null {
  const closesAt = config.pairingOpenUntil ?? 0;
  if (closesAt <= now || !config.pin || !config.pairSecret) return null;
  return { pin: config.pin, pairSecret: config.pairSecret, closesAt };
}

/**
 * Who may pair and who is paired. The link handshake (link/handshakes.ts) proves keys; this
 * decides what those keys may do:
 * - the PIN and the QR secret work only while the pairing window is open, and both are replaced
 *   whenever it opens or closes; a pairing closes it;
 * - one PIN run at a time, each run at most one guess (CPace), and only a tested guess counts;
 * - after MAX_PIN_FAILURES wrong guesses the PIN is replaced, so guesses never add up on one PIN;
 * - each replacement pauses PIN pairing, for longer each time, until a pairing succeeds.
 * Guess counts and the pause live in agent.json, so a restart forgets nothing.
 */
export class Pairing {
  private pinRunActive = false;
  /** Wrong guesses not yet written to agent.json (the write failed); PIN pairing waits for them. */
  private unrecordedWrongPins = 0;
  private readonly lastSeenWrites = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: PairingDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The open window, or null while pairing is closed. */
  window(): PairingWindow | null {
    return this.openWindowOf(this.deps.load());
  }

  /** Opens pairing for `durationMs` with a new PIN and QR secret. */
  openWindow(durationMs: number = PAIRING_WINDOW_MS): PairingWindow {
    const config = this.change((latest) => {
      this.replaceSecrets(latest);
      latest.pairingOpenUntil = this.now() + durationMs;
    });
    return this.openWindowOf(config)!;
  }

  /** Closes pairing and replaces the PIN and QR secret, so what was shown no longer works. */
  closeWindow(): void {
    this.change((latest) => {
      this.replaceSecrets(latest);
      latest.pairingOpenUntil = 0;
    });
  }

  /** The window that was to close at `closesAt` ran out: closes it, unless it was opened again since. */
  expireWindow(closesAt: number): void {
    if (this.deps.load().pairingOpenUntil !== closesAt) return;
    this.change((latest) => {
      if (latest.pairingOpenUntil !== closesAt) return;
      this.replaceSecrets(latest);
      latest.pairingOpenUntil = 0;
    });
  }

  /** Starts one PIN run and returns the PIN to run CPace with. */
  beginPin(): string {
    const config = this.deps.load();
    const window = this.openWindowOf(config);
    if (!window) throw pairingClosed();
    const { lockedUntil } = config.pinGuard ?? NO_GUESSES;
    if (this.now() < lockedUntil) {
      const seconds = Math.ceil((lockedUntil - this.now()) / 1000);
      throw new AgentError('locked', `Too many wrong PINs, so pairing by PIN is paused for ${seconds} more seconds.`, 'Wait, then type the new PIN shown on the computer, or scan its QR code.');
    }
    if (this.pinRunActive) throw new AgentError('locked', 'Another device is pairing with the PIN right now.', 'Wait a moment and try again.');
    if (this.unrecordedWrongPins > 0) {
      // A wrong guess could not be saved: no further guess until it is, so none goes uncounted.
      try {
        this.recordWrongPins();
      } catch {
        throw new AgentError('locked', 'Pairing by PIN is busy on this computer.', 'Wait a moment and try again.');
      }
      return this.beginPin();
    }
    this.pinRunActive = true;
    return window.pin;
  }

  /**
   * Ends the PIN run, however it ended. Only a wrong guess counts toward replacing the PIN. If the
   * guess can't be saved it is kept here, and no PIN run starts until it is (beginPin).
   */
  endPin(end: PinRunEnd): void {
    this.pinRunActive = false;
    if (end !== 'wrong-pin') return;
    this.unrecordedWrongPins += 1;
    this.recordWrongPins();
  }

  private recordWrongPins(): void {
    let replaced = false;
    const wrong = this.unrecordedWrongPins;
    this.deps.update((latest) => {
      const guard = { ...NO_GUESSES, ...latest.pinGuard };
      guard.failuresOnPin += wrong;
      if (guard.failuresOnPin >= MAX_PIN_FAILURES) {
        guard.failuresOnPin = 0;
        guard.replacements += 1;
        guard.lockedUntil = this.now() + Math.min(MAX_PIN_LOCKOUT_MS, FIRST_PIN_LOCKOUT_MS * 2 ** (guard.replacements - 1));
        latest.pin = this.deps.newPin();
        replaced = true;
      }
      latest.pinGuard = guard;
    });
    this.unrecordedWrongPins -= wrong;
    if (replaced) this.deps.onPairingChanged?.();
  }

  /** The PIN was right: pairs the device and clears the guess count. */
  pairWithPin(linkKey: Uint8Array, request: PairRequest): PairedDevice {
    return this.pairIf(linkKey, request, (latest) => {
      if (!this.openWindowOf(latest)) throw pairingClosed();
      latest.pinGuard = { ...NO_GUESSES };
    });
  }

  /** QR pairing: the secret must be the one the open window shows. It is used up, and pairing closes. */
  pairWithSecret(linkKey: Uint8Array, request: PairRequest, secret: string): PairedDevice {
    return this.pairIf(linkKey, request, (latest) => {
      const window = this.openWindowOf(latest);
      if (!window || secret.length === 0 || !constantTimeEquals(secret, window.pairSecret)) {
        throw new AgentError('unauthorized', 'This QR code has expired or was already used.', 'Open pairing on the computer and scan the QR code it shows now.');
      }
    });
  }

  /** A paired device reconnecting, named by the link key it proved in the handshake. Reads only. */
  session(linkKey: Uint8Array): PairedDevice {
    const device = this.deviceWithKey(this.deps.load(), toBase64Url(linkKey));
    if (!device) {
      throw new AgentError('unauthorized', 'This device is not paired with the computer anymore.', 'Pair again with the QR code or the PIN shown on the computer.');
    }
    return device;
  }

  /** Rereads agent.json into the cache `isPaired` uses. */
  refresh(): void {
    this.deps.refresh?.();
  }

  /** Whether this device is still paired with this key (it may have been unpaired, or paired again with another). */
  isPaired(deviceId: string, linkKey: string): boolean {
    return this.deviceWithKey((this.deps.cached ?? this.deps.load)(), linkKey)?.deviceId === deviceId;
  }

  /** Notes that the device is in use: writes lastSeenAt, at most once a minute per device. */
  touch(deviceId: string): void {
    const now = this.now();
    const last = this.lastSeenWrites.get(deviceId);
    if (last !== undefined && now - last < LAST_SEEN_WRITE_MS) return;
    this.lastSeenWrites.set(deviceId, now);
    this.deps.update((latest) => {
      const device = latest.devices.find((d) => d.deviceId === deviceId);
      if (device) device.lastSeenAt = new Date(now).toISOString();
    });
  }

  /** Forgets one device; it can no longer connect. Returns false when it was not paired. */
  revoke(deviceId: string): boolean {
    let removed = false;
    this.deps.update((latest) => {
      const remaining = latest.devices.filter((d) => d.deviceId !== deviceId);
      removed = remaining.length !== latest.devices.length;
      latest.devices = remaining;
    });
    return removed;
  }

  private openWindowOf(config: AgentConfig): PairingWindow | null {
    return openPairingWindow(config, this.now());
  }

  private deviceWithKey(config: AgentConfig, encoded: string): PairedDevice | undefined {
    return config.devices.find((d) => d.linkKey !== undefined && constantTimeEquals(d.linkKey, encoded));
  }

  /** A new PIN starts with no wrong guesses against it; a pause already running stays. */
  private replaceSecrets(config: AgentConfig): void {
    config.pin = this.deps.newPin();
    config.pairSecret = this.deps.newPairSecret();
    config.pinGuard = { ...NO_GUESSES, ...config.pinGuard, failuresOnPin: 0 };
  }

  private change(change: (config: AgentConfig) => void): AgentConfig {
    const config = this.deps.update(change);
    this.deps.onPairingChanged?.();
    return config;
  }

  /**
   * Checks and pairs in one locked write, so two devices can't both use one QR secret. Pairing
   * closes and the secrets are replaced, so whatever the screen showed works no more.
   */
  private pairIf(linkKey: Uint8Array, request: PairRequest, check: (config: AgentConfig) => void): PairedDevice {
    const encoded = toBase64Url(linkKey);
    const stamp = new Date(this.now()).toISOString();
    const device: PairedDevice = {
      deviceId: request.deviceId,
      deviceName: cleanDeviceName(request.deviceName),
      ...(request.form ? { form: request.form } : {}),
      linkKey: encoded,
      pairedAt: stamp,
      lastSeenAt: stamp,
    };
    this.change((latest) => {
      check(latest);
      // Replaces an earlier pairing of the same device or the same key.
      latest.devices = [...latest.devices.filter((d) => d.deviceId !== device.deviceId && d.linkKey !== encoded), device];
      this.replaceSecrets(latest);
      // One pairing per window: pairing another device means opening it again.
      latest.pairingOpenUntil = 0;
    });
    this.lastSeenWrites.set(device.deviceId, this.now());
    return device;
  }
}
