import { utf8Decode, utf8Encode, type RandomBytes } from './bytes';
import { canonicalJson } from './canonical';
import { decryptBox, encryptBox, keyMatchesCheck, openSealedKey, type Box, type DeviceKeys } from './crypto';
import type { Rejection } from './chain';
import { OTP_ALGORITHMS, STEAM_CODE_LENGTH, validateOtpParams, type OtpAlgorithm, type OtpType } from './otp';
import type { VaultState } from './replay';

/** What `account.put` encrypts. A change always rewrites the whole record. */
export interface AccountRecord {
  issuer: string;
  label: string;
  /** Base32, as sites show it. */
  secret: string;
  type: OtpType;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
  counter: number;
  icon?: string;
  /** Position on the deck. */
  position?: number;
}

export interface OpenAccount {
  id: string;
  record: AccountRecord;
  /** Device and time of the change that wrote this record. */
  author: string;
  time: number;
}

export interface OpenVault {
  /** Epoch keys this identity can read, newest last. */
  keys: Record<number, Uint8Array>;
  /** The key of `epoch`: the vault's current key, or while `readOnly` the newest one this identity holds. */
  currentKey: Uint8Array;
  epoch: number;
  /**
   * Set (the reason) when this identity can't open the vault's current key but holds an older
   * one: its codes show as of that key, and it can only write a key change built on it (a removal,
   * a fresh key or a new phrase), never a change made under the current epoch.
   */
  readOnly: string | null;
  name: string | null;
  deviceNames: Record<string, string | null>;
  accounts: Record<string, OpenAccount>;
  /** Account changes that passed the rules but could not be decrypted or read. */
  rejected: Rejection[];
  /** Older epochs whose key this identity could not open or check, with the reason. */
  keyProblems: { epoch: number; reason: string }[];
}

const MAX_TEXT = 256;
const ACCOUNT_TYPES: readonly OtpType[] = ['totp', 'hotp', 'steam'];
const BASE32_SECRET = /^[A-Z2-7]+$/;
const MAX_POSITION = 10_000;

/** Where an account record is written: the vault, the epoch and the device that writes it. */
export interface AccountBoxPlace {
  vault: string;
  epoch: number;
  author: string;
}

/**
 * AAD contexts. One home for each, so writers and readers can't drift apart. An account box names
 * its author too, so a device can't re-post another device's old record as its own.
 */
export const boxContexts = {
  account: (place: AccountBoxPlace, account: string) => ({ kind: 'account', vault: place.vault, epoch: place.epoch, author: place.author, account }),
  vaultName: (vault: string, epoch: number) => ({ kind: 'vault.name', vault, epoch }),
  deviceName: (vault: string, epoch: number, device: string) => ({ kind: 'device.name', vault, epoch, device }),
  prevKey: (vault: string, epoch: number) => ({ kind: 'prevKey', vault, epoch }),
};

function textField(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw new Error(`the ${what} is not valid text`);
  return value;
}

function intField(value: unknown, what: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`the ${what} is out of range`);
  return value as number;
}

/** Checks a decrypted (or about to be encrypted) account record. Throws with the reason. */
export function validateAccountRecord(value: unknown): AccountRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('the account record is not an object');
  const raw = value as Record<string, unknown>;
  const type = raw.type as OtpType;
  if (!ACCOUNT_TYPES.includes(type)) throw new Error('the account type is not known');
  const algorithm = raw.algorithm as OtpAlgorithm;
  if (!OTP_ALGORITHMS.includes(algorithm)) throw new Error('the algorithm is not supported');
  const secret = textField(raw.secret, 'secret');
  if (!BASE32_SECRET.test(secret)) throw new Error('the secret must be upper-case base32 without padding');
  const record: AccountRecord = {
    issuer: textField(raw.issuer, 'issuer'),
    label: textField(raw.label, 'label'),
    secret,
    type,
    algorithm,
    digits: type === 'steam' ? intField(raw.digits, 'digits', STEAM_CODE_LENGTH, STEAM_CODE_LENGTH) : intField(raw.digits, 'digits', 0, Number.MAX_SAFE_INTEGER),
    period: intField(raw.period, 'period', 0, Number.MAX_SAFE_INTEGER),
    counter: intField(raw.counter, 'counter', 0, Number.MAX_SAFE_INTEGER),
  };
  // One home for the limits on secrets, digits and periods: the same check as codes and imports.
  validateOtpParams(record);
  if (raw.icon !== undefined) record.icon = textField(raw.icon, 'icon');
  if (raw.position !== undefined) record.position = intField(raw.position, 'position', 0, MAX_POSITION);
  return record;
}

/**
 * The key sealed to this identity for `epoch`, checked. An approval may have given it a key that
 * doesn't open (another admin's, or garbage); every applied approval of it at that epoch is tried.
 */
function openCheckedKey(state: VaultState, identity: DeviceKeys, epoch: number): Uint8Array {
  const id = identity.deviceId;
  const member = Object.hasOwn(state.members, id) ? state.members[id] : undefined;
  const sealed = state.sealedKeys[epoch]?.[id];
  const candidates = [...(sealed ? [sealed] : []), ...(member?.approvals ?? []).filter((a) => a.epoch === epoch).map((a) => a.key)];
  if (candidates.length === 0) throw new Error(`this device holds no key for epoch ${epoch}`);
  for (const candidate of candidates) {
    try {
      const key = openSealedKey(candidate, identity, { vault: state.vaultId, epoch, to: id });
      if (checkedKey(state, key, epoch)) return key;
    } catch {
      // Try the next approval's key.
    }
  }
  throw new Error(`the key sealed to this device for epoch ${epoch} is not the vault's key for that epoch`);
}

function checkedKey(state: VaultState, key: Uint8Array, epoch: number): boolean {
  const check = state.keyChecks[epoch];
  return check !== undefined && keyMatchesCheck(key, state.vaultId, epoch, check);
}

/** The previous key a key change carries, opened with its own key, or null. */
function openPrevKey(state: VaultState, newer: Uint8Array, epoch: number): Uint8Array | null {
  const box = state.prevKeys[epoch];
  if (!box) return null;
  try {
    return decryptBox(newer, box, boxContexts.prevKey(state.vaultId, epoch));
  } catch {
    return null;
  }
}

/**
 * The key of `epoch`, checked: a previous key carried down from a newer epoch (usually the one
 * just above; one built on an older key while a newer one was bad skips epochs), else one sealed
 * to this identity for that epoch.
 */
function olderKey(state: VaultState, identity: DeviceKeys, carried: Uint8Array[], epoch: number): Uint8Array {
  const match = carried.findIndex((key) => checkedKey(state, key, epoch));
  // A matched key leaves `carried`, which so holds only the rare keys that skipped epochs.
  if (match !== -1) return carried.splice(match, 1)[0]!;
  if (state.sealedKeys[epoch]?.[identity.deviceId]) return openCheckedKey(state, identity, epoch);
  throw new Error(`no readable key for epoch ${epoch} matches the vault's`);
}

/** The newest epoch below `below` whose key this identity opens from its own seals, or null. */
function newestOwnKey(state: VaultState, identity: DeviceKeys, below: number): { epoch: number; key: Uint8Array } | null {
  for (let epoch = below - 1; epoch >= 0; epoch--) {
    try {
      return { epoch, key: openCheckedKey(state, identity, epoch) };
    } catch {
      // Not sealed to it, or a bad seal: look further back.
    }
  }
  return null;
}

const MAX_CARRIED_KEYS = 8;
const BAD_SEAL_READ_ONLY = 'The vault key this device was given for the latest key change does not open, so it shows codes as of the last key it could open and can\'t make changes under the current key.';
const UNKEYED_READ_ONLY = 'This device has not been given the current vault key yet, so it shows codes as of the last key it holds.';

function isJoinedMember(state: VaultState, id: string): boolean {
  const member = Object.hasOwn(state.members, id) ? state.members[id] : undefined;
  return !!member && member.joined && !member.removed;
}

/**
 * The newest key this identity holds and where the walk back starts. The current key when it
 * opens and matches its key check. Otherwise, so that one bad seal can't lock a device out, the
 * newest older key it holds, read-only: when its seal for the current epoch is bad, or when it is
 * a joined device not given the current key yet. Removed devices and replaced phrases have no
 * seal for the current epoch and aren't joined devices, so they never fall back.
 */
function topKey(state: VaultState, identity: DeviceKeys): { epoch: number; key: Uint8Array; readOnly: string | null } {
  const id = identity.deviceId;
  const hasCurrentSeal = !!state.sealedKeys[state.epoch]?.[id];
  if (!hasCurrentSeal) {
    const fallback = isJoinedMember(state, id) ? newestOwnKey(state, identity, state.epoch) : null;
    if (fallback) return { ...fallback, readOnly: UNKEYED_READ_ONLY };
    const anyKey = Object.values(state.sealedKeys).some((byRecipient) => byRecipient[id]);
    throw new Error(anyKey ? 'This device does not have the current vault key yet. Ask an admin device to approve it again.' : 'This device holds no key for this vault. Approve it from a device that is already in the vault.');
  }
  try {
    return { epoch: state.epoch, key: openCheckedKey(state, identity, state.epoch), readOnly: null };
  } catch (err) {
    const fallback = newestOwnKey(state, identity, state.epoch);
    if (fallback) return { ...fallback, readOnly: BAD_SEAL_READ_ONLY };
    throw new Error('The vault key given to this device does not match the vault. Someone may be tampering with it; ask an admin device to approve this device again.', { cause: err });
  }
}

/**
 * Opens this identity's newest key (topKey), refusing one that doesn't match its epoch's
 * published key check, then walks back through `prevKeys` (each checked too). An older epoch that
 * fails is skipped and reported, so one bad sealed key can't lock the whole vault.
 */
function openKeys(state: VaultState, identity: DeviceKeys): { top: number; readOnly: string | null; keys: Record<number, Uint8Array>; problems: { epoch: number; reason: string }[] } {
  const top = topKey(state, identity);
  const keys: Record<number, Uint8Array> = { [top.epoch]: top.key };
  const problems: { epoch: number; reason: string }[] = [];
  for (let epoch = state.epoch; epoch > top.epoch; epoch--) problems.push({ epoch, reason: 'this device holds no key for this epoch that opens' });
  // Previous keys opened so far that matched no epoch yet: a key change built on an older key
  // (while a newer one was bad) carries that older key.
  const carried: Uint8Array[] = [];
  for (let epoch = top.epoch - 1; epoch >= 0; epoch--) {
    const newer = keys[epoch + 1];
    const prev = newer ? openPrevKey(state, newer, epoch + 1) : null;
    if (prev) carried.unshift(prev);
    // Bounded, so key changes carrying junk can't make the walk quadratic. A key that skipped
    // epochs was carried across epochs this identity holds no key for, where nothing is added.
    carried.length = Math.min(carried.length, MAX_CARRIED_KEYS);
    try {
      keys[epoch] = olderKey(state, identity, carried, epoch);
    } catch (err) {
      problems.push({ epoch, reason: (err as Error).message });
    }
  }
  problems.sort((a, b) => b.epoch - a.epoch);
  return { top: top.epoch, readOnly: top.readOnly, keys, problems };
}

function openText(keys: Record<number, Uint8Array>, box: Box | null, context: Parameters<typeof decryptBox>[2]): string | null {
  const key = box ? keys[box.epoch] : undefined;
  if (!box || !key) return null;
  try {
    return utf8Decode(decryptBox(key, box, context));
  } catch {
    return null;
  }
}

/**
 * Opens the vault with a device's (or the recovery identity's) keys: every epoch key it can
 * reach, names, and the current account records. Concurrent edits follow the replay order;
 * an HOTP counter never goes backwards.
 */
export function openVault(state: VaultState, identity: DeviceKeys): OpenVault {
  const { top, readOnly, keys, problems } = openKeys(state, identity);
  const currentKey = keys[top]!;
  const accounts: Record<string, OpenAccount> = {};
  const rejected: Rejection[] = [];
  for (const change of state.accountChanges) {
    if (change.kind === 'account.delete') {
      delete accounts[change.account];
      continue;
    }
    const key = keys[change.box.epoch];
    try {
      if (!key) throw new Error(`this device has no key for epoch ${change.box.epoch}`);
      const plain = decryptBox(key, change.box, boxContexts.account({ vault: state.vaultId, epoch: change.box.epoch, author: change.author }, change.account));
      const record = validateAccountRecord(JSON.parse(utf8Decode(plain)));
      const previous = accounts[change.account]?.record;
      if (previous && previous.type === 'hotp' && record.type === 'hotp') record.counter = Math.max(previous.counter, record.counter);
      accounts[change.account] = { id: change.account, record, author: change.author, time: change.time };
    } catch (err) {
      rejected.push({ deviceId: change.author, seq: change.seq, hash: change.hash, kind: change.kind, reason: `the account could not be read: ${(err as Error).message}` });
    }
  }
  const deviceNames: Record<string, string | null> = {};
  for (const member of Object.values(state.members)) {
    deviceNames[member.deviceId] = openText(keys, member.name, boxContexts.deviceName(state.vaultId, member.name.epoch, member.deviceId));
  }
  return {
    keys,
    currentKey,
    epoch: top,
    readOnly,
    name: openText(keys, state.name, boxContexts.vaultName(state.vaultId, 0)),
    deviceNames,
    accounts,
    rejected,
    keyProblems: problems,
  };
}

/** Encrypts an account record for `account.put` under the current epoch, bound to the device writing it. */
export function sealAccountRecord(place: AccountBoxPlace, key: Uint8Array, account: string, record: AccountRecord, random: RandomBytes): Box {
  const checked = validateAccountRecord(record);
  return encryptBox(key, utf8Encode(canonicalJson(checked)), boxContexts.account(place, account), random);
}
