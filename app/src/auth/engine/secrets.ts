/**
 * The device's secrets in platform secure storage (iOS Keychain; Android Keystore-encrypted
 * preferences), and the app-lock prompt.
 *
 * Why the lock is a LocalAuthentication prompt rather than secure-store's requireAuthentication:
 * that option binds items to the current biometric set with no passcode fallback (iOS
 * .biometryCurrentSet; Android BIOMETRIC_STRONG with keys invalidated on enrolment), so adding a
 * fingerprint or a new face would destroy the device's vault keys, and devices with only a
 * passcode could not use app lock at all. Items are instead stored "when unlocked, this device
 * only" (never in backups or on another device), and the app asks for Face ID, a fingerprint or
 * the device passcode before it reads them into memory.
 */
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { fromBase64Url, toBase64Url } from '../../vault/bytes';
import { keysFromSecrets, type DeviceKeys } from '../../vault/crypto';
import { isHash, isId, MAX_IDENTITIES } from '../../vault/entry';
import type { RememberedHeads } from '../../vault/rollback';
import { canAuthenticate, type DeviceAuth } from './appLock';
import { deviceUnlockSetupWords, deviceUnlockWords } from './lockWords';
import type { OwnHead } from './sync';

const STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const DEVICE_KEYS = 'authdeck_device_v1';
const epochKeysName = (vaultId: string) => `authdeck_keys_${vaultId}`;
const headsName = (vaultId: string) => `authdeck_heads_${vaultId}`;
const highestEpochName = (vaultId: string) => `authdeck_epoch_${vaultId}`;
const ownHeadName = (vaultId: string) => `authdeck_own_head_${vaultId}`;

export const SECURE_READ_FAILED =
  "AuthDeck couldn't read its keys from this device's secure storage. Unlock the device, close and reopen AuthDeck, then try again. If it keeps happening, restore the vault with your recovery phrase.";
export const SECURE_WRITE_FAILED =
  "AuthDeck couldn't save to this device's secure storage, so nothing was changed. Unlock the device, close and reopen AuthDeck, then try again.";

/**
 * A secure-storage call whose native failure ("Calling the 'getValueWithKeyAsync' function has
 * failed → Caused by…") becomes a plain message; the raw text goes to the log only.
 */
async function guarded<T>(call: () => Promise<T>, message: string): Promise<T> {
  try {
    return await call();
  } catch (err) {
    console.warn('secure storage:', err instanceof Error ? err.message : String(err));
    throw new Error(message, { cause: err });
  }
}

async function readJson(name: string): Promise<unknown> {
  const raw = await guarded(() => SecureStore.getItemAsync(name, STORE_OPTIONS), SECURE_READ_FAILED);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error("This device's secure storage holds damaged vault data. Restore the vault with your recovery phrase.", { cause: err });
  }
}

function writeJson(name: string, value: unknown): Promise<void> {
  return guarded(() => SecureStore.setItemAsync(name, JSON.stringify(value), STORE_OPTIONS), SECURE_WRITE_FAILED);
}

/** This device's Ed25519 and X25519 secrets, or null before the first vault or join. */
export async function loadDeviceKeys(): Promise<DeviceKeys | null> {
  const stored = (await readJson(DEVICE_KEYS)) as { ed?: unknown; x?: unknown } | null;
  if (stored === null) return null;
  if (typeof stored.ed !== 'string' || typeof stored.x !== 'string') {
    throw new Error("This device's keys in secure storage are damaged. Restore the vault with your recovery phrase.");
  }
  return keysFromSecrets(fromBase64Url(stored.ed), fromBase64Url(stored.x));
}

export function saveDeviceKeys(keys: DeviceKeys): Promise<void> {
  return writeJson(DEVICE_KEYS, { ed: toBase64Url(keys.edSecret), x: toBase64Url(keys.xSecret) });
}

/** The vault's epoch keys this device has opened, epoch -> key. */
export function saveEpochKeys(vaultId: string, keys: Record<number, Uint8Array>): Promise<void> {
  const encoded: Record<string, string> = {};
  for (const [epoch, key] of Object.entries(keys)) encoded[epoch] = toBase64Url(key);
  return writeJson(epochKeysName(vaultId), encoded);
}

/** The latest (seq, hash) per device the folder has shown, for the rollback check. */
function parseHead(head: { seq?: unknown; hash?: unknown }): { seq: number; hash: string } {
  if (!Number.isSafeInteger(head.seq) || !isHash(head.hash)) throw new Error('The remembered vault history in secure storage is damaged.');
  return { seq: head.seq as number, hash: head.hash };
}

/**
 * The most remembered heads kept: one per log a vault can hold (the agent's MAX_LOG_FILES, also
 * the bound for a solo vault, whose phrase changes and restores each add an identity), plus headroom.
 */
export const MAX_REMEMBERED_HEADS = MAX_IDENTITIES + 64;

/**
 * Remembered heads read back from secure storage, keeping only well-formed ones: a device id as
 * the key (so never `__proto__` or another inherited name) and a (seq, hash) head, at most
 * MAX_REMEMBERED_HEADS of them. What is dropped is counted, never thrown: a head lost here only
 * weakens the rollback check for that one log until the next sync remembers it again.
 */
export function parseRememberedHeads(stored: unknown): { heads: RememberedHeads; dropped: number } {
  const heads: RememberedHeads = {};
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return { heads, dropped: stored === null ? 0 : 1 };
  let kept = 0;
  let dropped = 0;
  for (const [deviceId, head] of Object.entries(stored)) {
    const seq = head !== null && typeof head === 'object' ? (head as { seq?: unknown }).seq : undefined;
    const hash = head !== null && typeof head === 'object' ? (head as { hash?: unknown }).hash : undefined;
    if (!isId(deviceId) || !Number.isSafeInteger(seq) || (seq as number) < 0 || !isHash(hash) || kept >= MAX_REMEMBERED_HEADS) {
      dropped++;
      continue;
    }
    heads[deviceId] = { seq: seq as number, hash };
    kept++;
  }
  return { heads, dropped };
}

export async function loadRememberedHeads(vaultId: string): Promise<RememberedHeads> {
  const { heads, dropped } = parseRememberedHeads(await readJson(headsName(vaultId)));
  // Counts only: the ids and hashes are not logged.
  if (dropped > 0) console.warn(`Dropped ${dropped} damaged or excess remembered vault head(s) from secure storage.`);
  return heads;
}

export function saveRememberedHeads(vaultId: string, heads: RememberedHeads): Promise<void> {
  return writeJson(headsName(vaultId), heads);
}

/**
 * The highest of this device's own entries the folder has accepted. Never lowered by what a
 * folder later shows, so this device never signs a second entry at a seq it already sent.
 */
export async function loadOwnHead(vaultId: string): Promise<OwnHead | null> {
  const stored = await readJson(ownHeadName(vaultId));
  return stored === null ? null : parseHead(stored as { seq?: unknown; hash?: unknown });
}

export function saveOwnHead(vaultId: string, head: OwnHead): Promise<void> {
  return writeJson(ownHeadName(vaultId), head);
}

/**
 * The highest key epoch this device's own replay has reached. A folder at a lower epoch is
 * missing a key rotation, so new secrets wait until it arrives. Never raised by another device's
 * claim (a beacon), which could otherwise pause changes for good.
 */
export async function loadHighestEpoch(vaultId: string): Promise<number> {
  const stored = await readJson(highestEpochName(vaultId));
  if (stored === null) return 0;
  if (!Number.isSafeInteger(stored) || (stored as number) < 0) throw new Error('The remembered vault key epoch in secure storage is damaged.');
  return stored as number;
}

export function saveHighestEpoch(vaultId: string, epoch: number): Promise<void> {
  return writeJson(highestEpochName(vaultId), epoch);
}

/**
 * Forgets a vault this device was removed from. The device keys go too: a removed device can only
 * rejoin with new ones. `keepDeviceKeys` keeps them, for a vault this device replaced with a new
 * one it is in with the same keys.
 */
const restoreAttemptsName = (vaultId: string) => `authdeck_restore_keys_${vaultId}`;
/** As many as a restore ever signs (localCopy.ts keeps as many attempt records); older ones are dropped. */
const MAX_RESTORE_ATTEMPT_KEYS = 8;

/**
 * The device keys of this phone's earlier restore attempts into a vault, kept until one attempt
 * is settled: a computer may later count any of them, and then this phone adopts that attempt
 * with its keys instead of being locked out (Q2). Malformed entries are dropped.
 */
export async function loadRestoreAttemptKeys(vaultId: string): Promise<DeviceKeys[]> {
  let stored: unknown;
  try {
    stored = await readJson(restoreAttemptsName(vaultId));
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  const keys: DeviceKeys[] = [];
  for (const item of stored.slice(-MAX_RESTORE_ATTEMPT_KEYS)) {
    if (item === null || typeof item !== 'object' || typeof item.ed !== 'string' || typeof item.x !== 'string') continue;
    try {
      keys.push(keysFromSecrets(fromBase64Url(item.ed), fromBase64Url(item.x)));
    } catch {
      // A damaged entry is only one attempt this phone can no longer adopt.
    }
  }
  return keys;
}

/** Adds `keys` to the kept restore attempts of `vaultId` (once per device id). */
export async function keepRestoreAttemptKeys(vaultId: string, keys: DeviceKeys): Promise<void> {
  const kept = (await loadRestoreAttemptKeys(vaultId)).filter((k) => k.deviceId !== keys.deviceId);
  const all = [...kept, keys].slice(-MAX_RESTORE_ATTEMPT_KEYS);
  await writeJson(restoreAttemptsName(vaultId), all.map((k) => ({ ed: toBase64Url(k.edSecret), x: toBase64Url(k.xSecret) })));
}

/** Forgets the kept restore attempts once one is settled. */
export function forgetRestoreAttemptKeys(vaultId: string): Promise<void> {
  return guarded(() => SecureStore.deleteItemAsync(restoreAttemptsName(vaultId), STORE_OPTIONS), SECURE_WRITE_FAILED);
}

export async function forgetVaultSecrets(vaultId: string, { keepDeviceKeys = false }: { keepDeviceKeys?: boolean } = {}): Promise<void> {
  const names = [epochKeysName(vaultId), headsName(vaultId), highestEpochName(vaultId), ownHeadName(vaultId), ...(keepDeviceKeys ? [] : [DEVICE_KEYS])];
  await Promise.all(names.map((name) => guarded(() => SecureStore.deleteItemAsync(name, STORE_OPTIONS), SECURE_WRITE_FAILED)));
}

const PROMPT_FAILURES: Partial<Record<LocalAuthentication.LocalAuthenticationError, string>> = {
  user_cancel: 'Unlock was cancelled.',
  system_cancel: 'Unlock was interrupted. Try again.',
  app_cancel: 'Unlock was interrupted. Try again.',
  lockout: `Too many failed attempts. Unlock your device with its ${Platform.OS === 'ios' ? 'passcode' : 'screen lock'}, then try again.`,
  not_enrolled: `Set up ${deviceUnlockSetupWords(Platform.OS)} in your device settings to use app lock.`,
  passcode_not_set: `Set ${Platform.OS === 'ios' ? 'a passcode' : 'a screen lock'} in your device settings to use app lock.`,
  not_available: `This device can't check ${deviceUnlockWords(Platform.OS)} right now.`,
  authentication_failed: "That didn't match. Try again.",
};

/** What this device can authenticate with now (appLock.ts decides what that allows). Never throws. */
export async function deviceAuth(): Promise<DeviceAuth> {
  try {
    const [hardware, enrolled, level] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.getEnrolledLevelAsync(),
    ]);
    return { hardware, enrolled, passcode: level !== LocalAuthentication.SecurityLevel.NONE, platform: Platform.OS };
  } catch {
    return { hardware: false, enrolled: false, passcode: false, platform: Platform.OS };
  }
}

/** True when the device has a screen lock (passcode, PIN, pattern or biometrics) app lock can use. */
export async function canUseAppLock(): Promise<boolean> {
  return canAuthenticate(await deviceAuth());
}

/** The device's own unlock (lockWords.ts). Resolves when the person passed; rejects with a plain message. */
export async function confirmOwner(promptMessage: string): Promise<void> {
  if (!(await canUseAppLock())) throw new Error(PROMPT_FAILURES.not_enrolled);
  const result = await LocalAuthentication.authenticateAsync({ promptMessage, cancelLabel: 'Cancel', disableDeviceFallback: false });
  if (result.success) return;
  throw new Error(PROMPT_FAILURES[result.error] ?? "Couldn't confirm it's you. Try again.");
}
