/**
 * What the device keeps that holds no secret: its full copy of the vault's logs (every line is
 * signed and its contents encrypted) and the vault settings. What grows with the vault (logs,
 * fork proofs, handled caught changes) is kept in files (localFiles.ts); the small, fixed-size
 * records (settings, a pending restore) stay in AsyncStorage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { LIMITS } from '../../net/messages';
import { isHash, isId, isPlainObject } from '../../vault/entry';
import {
  forgetVaultFiles,
  readCaughtFile,
  readForksFile,
  readLogFiles,
  readSealsFile,
  writeCaughtFile,
  writeForksFile,
  writeLogFiles,
  writeSealsFile,
} from './localFiles';
import { sealProofShapeProblem, type SealProof } from '../../vault/sealProof';
import { MAX_LINE_BYTES, type LocalLogs, type PendingRestore } from './sync';
import type { VaultReplacement } from './replaceVault';

export interface VaultPrefs {
  vaultId: string | null;
  /** This device's id in the vault (public), so the vault can sync while locked. */
  deviceId: string | null;
  appLock: boolean;
  autoLockMs: number;
  recoverySavedAt: number | null;
  /** Where the folder was last seen, for the storage line in Settings. */
  location: 'personal' | 'team' | null;
  /** The vault folder's path on the computer, as the computer reports it (vault.list). */
  folderPath: string | null;
}

/** Two entries a device signed at one seq, kept as proof it showed two histories. */
export interface StoredFork {
  deviceId: string;
  seq: number;
  lines: [string, string];
}

export const DEFAULT_AUTO_LOCK_MS = 5 * 60_000;

export const DEFAULT_PREFS: VaultPrefs = {
  vaultId: null,
  deviceId: null,
  appLock: true,
  autoLockMs: DEFAULT_AUTO_LOCK_MS,
  recoverySavedAt: null,
  location: null,
  folderPath: null,
};

const PREFS_KEY = 'authdeck-vault-prefs-v2';
/**
 * The most the vault prefs may hold, in UTF-16 units of their JSON. Android can't read back an
 * AsyncStorage value over about 2 MB ("Row too big"), and an unreadable prefs value hides the
 * vault at every launch; within the field caps they are a few KB, so this leaves a wide margin.
 */
export const MAX_PREFS_CHARS = 32 * 1024;
const DAMAGED_PREFS = "This device's vault settings are damaged. Reinstall AuthDeck, then restore the vault with your recovery phrase.";
const DAMAGED_RESTORE =
  "This device's record of a restore it started is damaged. Restore the vault from another device, or ask an admin device to add this one.";

/** Storage keys carry ids; anything else (a path, "__proto__") never names a key. */
function checkedId(id: string): string {
  if (!isId(id)) throw new Error('A vault or device id is malformed, so AuthDeck will not use it to find stored vault data.');
  return id;
}

const restoreKey = (vaultId: string, recoveryId: string) => `authdeck-vault-restore-v1:${checkedId(vaultId)}:${checkedId(recoveryId)}`;

async function readJson(key: string, damaged: string): Promise<unknown> {
  const raw = await AsyncStorage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(damaged, { cause: err });
  }
}

const isIdOrNull = (value: unknown) => value === null || isId(value);
const isTimeOrNull = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
const isLines = (value: unknown): value is string[] => Array.isArray(value) && value.every((line) => typeof line === 'string');

/** Each stored setting is checked again on load: ids must be ids, so they can't key anything else. */
const PREF_CHECKS: { [K in keyof VaultPrefs]: (value: unknown) => boolean } = {
  vaultId: isIdOrNull,
  deviceId: isIdOrNull,
  appLock: (value) => typeof value === 'boolean',
  autoLockMs: (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  recoverySavedAt: isTimeOrNull,
  location: (value) => value === null || value === 'personal' || value === 'team',
  folderPath: (value) => value === null || (typeof value === 'string' && value.length <= LIMITS.fsPath),
};

/** Settings only shows the path, so one saved before paths were capped is forgotten rather than calling the prefs damaged. */
const isOversizedPath = (value: unknown) => typeof value === 'string' && value.length > LIMITS.fsPath;

export async function loadPrefs(): Promise<VaultPrefs> {
  const stored = await readJson(PREFS_KEY, DAMAGED_PREFS);
  if (stored === null) return DEFAULT_PREFS;
  if (!isPlainObject(stored)) throw new Error(DAMAGED_PREFS);
  const prefs: VaultPrefs = { ...DEFAULT_PREFS };
  for (const name of Object.keys(PREF_CHECKS) as (keyof VaultPrefs)[]) {
    if (!Object.hasOwn(stored, name)) continue;
    if (name === 'folderPath' && isOversizedPath(stored[name])) continue;
    if (!PREF_CHECKS[name](stored[name])) throw new Error(DAMAGED_PREFS);
    (prefs as unknown as Record<string, unknown>)[name] = stored[name];
  }
  return prefs;
}

/** Saves the prefs, or refuses (nothing written) any that would not load again: a bad field or too large a value. */
export async function savePrefs(prefs: VaultPrefs): Promise<void> {
  const bad = (Object.keys(PREF_CHECKS) as (keyof VaultPrefs)[]).find((name) => !PREF_CHECKS[name](prefs[name]));
  if (bad) throw new Error(`AuthDeck did not save the vault settings: their ${bad} is malformed or too long. Check the vault folder on the computer, then sync again.`);
  const json = JSON.stringify(prefs);
  if (json.length > MAX_PREFS_CHARS) throw new Error('AuthDeck did not save the vault settings: they are larger than this device can keep. Check the vault folder on the computer, then sync again.');
  await AsyncStorage.setItem(PREFS_KEY, json);
}

/**
 * The stored logs, each under a device id. A damaged or partly written file gives the lines it
 * holds before the damage; the next sync reads the rest from the computer, checked against the
 * heads this device remembers, so damage never leaves the vault unusable.
 */
export async function loadLogs(vaultId: string): Promise<LocalLogs> {
  return readLogFiles(checkedId(vaultId));
}

/** Saves the logs; only ids name a log, so anything else (say "__proto__") is not saved. */
export async function saveLogs(vaultId: string, logs: LocalLogs): Promise<void> {
  return writeLogFiles(checkedId(vaultId), logs);
}

export async function forgetLogs(vaultId: string): Promise<void> {
  return forgetVaultFiles(checkedId(vaultId));
}

/**
 * Caught changes (caught.ts) this device re-applied or dismissed, by entry hash. Only what is
 * shown depends on it, so a damaged record just shows them again; anything that isn't a hash is dropped.
 */
export async function loadHandledCaught(vaultId: string): Promise<Set<string>> {
  const stored = await readCaughtFile(checkedId(vaultId));
  return new Set(Array.isArray(stored) ? stored.filter(isHash) : []);
}

export async function saveHandledCaught(vaultId: string, hashes: ReadonlySet<string>): Promise<void> {
  return writeCaughtFile(checkedId(vaultId), [...hashes].filter(isHash));
}

function isStoredFork(value: unknown): value is StoredFork {
  if (!isPlainObject(value) || !isId(value.deviceId)) return false;
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) return false;
  return isLines(value.lines) && value.lines.length === 2;
}

/**
 * Fork proofs found so far. Public data: both lines are signed entries from the folder. A stored
 * proof that isn't shaped like one is dropped, and a damaged file is none (the next sync finds the
 * proofs again in the folder); the engine checks the signatures again.
 */
export async function loadForks(vaultId: string): Promise<StoredFork[]> {
  const stored = await readForksFile(checkedId(vaultId));
  return Array.isArray(stored) ? stored.filter(isStoredFork) : [];
}

export async function saveForks(vaultId: string, forks: StoredFork[]): Promise<void> {
  return writeForksFile(checkedId(vaultId), forks);
}

/** At most this many seal proofs are kept: one per key-bearing entry and recipient is far fewer. */
const MAX_SEAL_PROOFS = 4096;

/**
 * Bad-seal proofs found so far (sealProof.ts), kept so a replay before the next sync still
 * applies them. Public data; anything not shaped like a proof is dropped, and every replay
 * checks them again.
 */
export async function loadSealProofs(vaultId: string): Promise<SealProof[]> {
  const stored = await readSealsFile(checkedId(vaultId));
  return Array.isArray(stored) ? (stored.filter((p) => sealProofShapeProblem(p) === null) as SealProof[]).slice(0, MAX_SEAL_PROOFS) : [];
}

export async function saveSealProofs(vaultId: string, proofs: readonly SealProof[]): Promise<void> {
  return writeSealsFile(checkedId(vaultId), proofs.filter((p) => sealProofShapeProblem(p) === null).slice(0, MAX_SEAL_PROOFS));
}

function isPendingRestore(value: unknown, recoveryId: string): value is PendingRestore {
  if (!isPlainObject(value) || value.recoveryId !== recoveryId || !isId(value.deviceId)) return false;
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0 || typeof value.superseded !== 'boolean') return false;
  return isLines(value.lines) && value.lines.length >= 1 && value.lines.length <= 3 && value.lines.every((line) => line.length <= MAX_LINE_BYTES);
}

/**
 * The restore this device signed with a recovery identity, or null. Public data (signed lines
 * whose keys are sealed), but losing it would let a retry sign a second entry at its seq, so a
 * damaged record stops the restore rather than being dropped.
 */
export async function loadPendingRestore(vaultId: string, recoveryId: string): Promise<PendingRestore | null> {
  const stored = await readJson(restoreKey(vaultId, recoveryId), DAMAGED_RESTORE);
  if (stored === null) return null;
  if (!isPendingRestore(stored, recoveryId)) throw new Error(DAMAGED_RESTORE);
  return stored;
}

/** Refuses (nothing written) a record that would not load again: lines past what a vault holds, or a malformed id or seq. */
export async function savePendingRestore(vaultId: string, pending: PendingRestore): Promise<void> {
  if (!isPendingRestore(pending, pending.recoveryId)) throw new Error('AuthDeck did not save the restore it signed: the record is malformed or too large. Nothing was sent; try the restore again.');
  return AsyncStorage.setItem(restoreKey(vaultId, pending.recoveryId), JSON.stringify(pending));
}

export async function forgetPendingRestore(vaultId: string, recoveryId: string): Promise<void> {
  return AsyncStorage.removeItem(restoreKey(vaultId, recoveryId));
}

const attemptsKey = (vaultId: string, recoveryId: string) => `authdeck-vault-restore-attempts-v1:${checkedId(vaultId)}:${checkedId(recoveryId)}`;
/** As many as a restore ever signs (secrets.ts keeps the same number of attempt keys). */
const MAX_RESTORE_ATTEMPTS_KEPT = 8;

/**
 * Every restore this device signed with a recovery identity and has not settled, oldest first
 * (Q2): a computer may count an earlier one, and this device then adopts it with its kept keys.
 * Malformed records are dropped; each is only an attempt this device can no longer adopt.
 */
export async function loadRestoreAttempts(vaultId: string, recoveryId: string): Promise<PendingRestore[]> {
  let stored: unknown;
  try {
    stored = await readJson(attemptsKey(vaultId, recoveryId), DAMAGED_RESTORE);
  } catch {
    return [];
  }
  return Array.isArray(stored) ? stored.slice(-MAX_RESTORE_ATTEMPTS_KEPT).filter((item) => isPendingRestore(item, recoveryId)) : [];
}

export async function keepRestoreAttempt(vaultId: string, pending: PendingRestore): Promise<void> {
  if (!isPendingRestore(pending, pending.recoveryId)) return;
  const kept = (await loadRestoreAttempts(vaultId, pending.recoveryId)).filter((item) => item.deviceId !== pending.deviceId);
  await AsyncStorage.setItem(attemptsKey(vaultId, pending.recoveryId), JSON.stringify([...kept, { ...pending, superseded: false }].slice(-MAX_RESTORE_ATTEMPTS_KEPT)));
}

export async function forgetRestoreAttempts(vaultId: string, recoveryId: string): Promise<void> {
  return AsyncStorage.removeItem(attemptsKey(vaultId, recoveryId));
}

const REPLACEMENT_KEY = 'authdeck-vault-replacement-v1';
const DAMAGED_REPLACEMENT = "This device's record of a vault it replaced is damaged. Both vaults are kept; delete the old one from the computer by hand if you no longer need it.";

/** A vault replaced by a new one (replaceVault.ts), until the old one is retired; null when none is under way. */
export async function loadReplacement(): Promise<VaultReplacement | null> {
  const stored = await readJson(REPLACEMENT_KEY, DAMAGED_REPLACEMENT);
  if (stored === null) return null;
  if (!isPlainObject(stored) || !isId(stored.oldVaultId) || !isId(stored.newVaultId) || stored.oldVaultId === stored.newVaultId) throw new Error(DAMAGED_REPLACEMENT);
  if (typeof stored.agentId !== 'string' || !AGENT_ID.test(stored.agentId)) throw new Error(DAMAGED_REPLACEMENT);
  return { oldVaultId: stored.oldVaultId, newVaultId: stored.newVaultId, agentId: stored.agentId };
}

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function saveReplacement(record: VaultReplacement | null): Promise<void> {
  if (record === null) return AsyncStorage.removeItem(REPLACEMENT_KEY);
  if (!AGENT_ID.test(record.agentId)) throw new Error('The computer id is malformed, so AuthDeck will not record a vault replaced on it.');
  return AsyncStorage.setItem(REPLACEMENT_KEY, JSON.stringify({ oldVaultId: checkedId(record.oldVaultId), newVaultId: checkedId(record.newVaultId), agentId: record.agentId }));
}

const phraseLinesKey = (vaultId: string, recoveryId: string) => `authdeck-vault-phrase-change-lines-v1:${checkedId(vaultId)}:${checkedId(recoveryId)}`;

/**
 * A solo phrase change this device signed (its recovery.set lines), in a slot of its own: a
 * restore record under the same recovery identity never shares it (L1). Damaged: stops, as for a restore.
 */
export async function loadPendingPhraseChange(vaultId: string, recoveryId: string): Promise<PendingRestore | null> {
  const stored = await readJson(phraseLinesKey(vaultId, recoveryId), DAMAGED_RESTORE);
  if (stored === null) return null;
  if (!isPendingRestore(stored, recoveryId)) throw new Error(DAMAGED_RESTORE);
  return stored;
}

export async function savePendingPhraseChange(vaultId: string, pending: PendingRestore): Promise<void> {
  if (!isPendingRestore(pending, pending.recoveryId)) throw new Error('AuthDeck did not save the phrase change it signed: the record is malformed or too large. Nothing was sent; make the new phrase again.');
  return AsyncStorage.setItem(phraseLinesKey(vaultId, pending.recoveryId), JSON.stringify(pending));
}

export async function forgetPendingPhraseChange(vaultId: string, recoveryId: string): Promise<void> {
  return AsyncStorage.removeItem(phraseLinesKey(vaultId, recoveryId));
}

/** The recovery identities this device holds a restore record under, for `vaultId`. */
export async function pendingRestoreIds(vaultId: string): Promise<string[]> {
  const prefix = `authdeck-vault-restore-v1:${checkedId(vaultId)}:`;
  return (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).filter((id) => isId(id));
}

/** Every restore and phrase-change record of `vaultId` (forgetVault): none outlives the vault on this device. */
export async function forgetRecoveryRecords(vaultId: string): Promise<void> {
  const id = checkedId(vaultId);
  const keys = (await AsyncStorage.getAllKeys()).filter((key) =>
    [`authdeck-vault-restore-v1:${id}:`, `authdeck-vault-restore-attempts-v1:${id}:`, `authdeck-vault-phrase-change-lines-v1:${id}:`].some((prefix) => key.startsWith(prefix)),
  );
  await Promise.all([...keys.map((key) => AsyncStorage.removeItem(key)), AsyncStorage.removeItem(phraseChangeKey(id))]);
}

const phraseChangeKey = (vaultId: string) => `authdeck-vault-phrase-change-v1:${checkedId(vaultId)}`;

/**
 * Which recovery identity signed this vault's pending phrase change (its lines are the pending
 * restore record under that identity), so it is found again after the change applies and the
 * vault's current phrase is the new one. Null when none is pending.
 */
export async function loadPhraseChangeRef(vaultId: string): Promise<string | null> {
  const stored = await AsyncStorage.getItem(phraseChangeKey(vaultId));
  return stored !== null && isId(stored) ? stored : null;
}

export async function savePhraseChangeRef(vaultId: string, recoveryId: string | null): Promise<void> {
  if (recoveryId === null) return AsyncStorage.removeItem(phraseChangeKey(vaultId));
  return AsyncStorage.setItem(phraseChangeKey(vaultId), checkedId(recoveryId));
}
