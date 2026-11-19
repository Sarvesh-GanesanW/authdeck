/**
 * A set's keys: the set id, the data key and its wraps, the recovery identity, and the box each
 * value sits in. All crypto is the vault's (vault/crypto.ts): wraps are sealKey (deterministic, so
 * a member holding the key can rebuild and check every wrap), values are encryptBox/decryptBox.
 *
 *   wrap of epoch e's key for member m:  sealKey(K_e, m.x, { vault: set, epoch: e, to: m.id })
 *   wrap for the recovery identity r:    sealKey(K_e, r.x, { vault: set, epoch: e, to: r.id })
 *   value box:                           encryptBox(K_e, utf8(value), { vault: set, epoch: e, kind: ENV_VALUE_BOX_KIND, name, version })
 *
 * encryptBox takes its AES-256-GCM key from K_e with the subkey "authdeck/subkey/v2/box/env-value",
 * and binds the set, epoch, name and version as associated data.
 */
import { cleanJoinName } from '../vault/approval';
import { fromBase64Url, takeRandom, toBase64Url, utf8Decode, utf8Encode, type RandomBytes } from '../vault/bytes';
import { decryptBox, deviceIdFor, encryptBox, openSealedKey, sealKey, sealsEqual, type Box, type BoxContext, type DeviceKeys, type SealedKey } from '../vault/crypto';
import { recoveryKeysFromPhrase } from '../vault/recovery';
import { envSetIdOf, newEnvBirth } from './authority';
import { EnvFileRefused } from './errors';
import { checkEnvPlainValues, writeEnvFile } from './format';
import { signEnvHeader, signEnvValueLine } from './signing';
import { ENV_FORMAT, ENV_SET_NAME_PATTERN, type EnvHeader, type EnvMember, type EnvPlainValue, type EnvRecovery, type EnvSetFile, type EnvSetId, type EnvValueLine } from './types';

/** BoxContext.kind of a value box. */
export const ENV_VALUE_BOX_KIND = 'env-value';
/**
 * No longer used: a set's recovery identity is now the owner's vault recovery identity (see
 * envRecoveryKeys). Kept because it was exported.
 * @deprecated
 */
export const ENV_RECOVERY_SCOPE = 'env/';

/** Bytes of a data key. */
export const ENV_DATA_KEY_BYTES = 32;

/** A device to put in the member list: its public keys and how it is shown. */
export interface EnvNewMember {
  edPublic: Uint8Array;
  xPublic: Uint8Array;
  /** Cleaned with vault/approval cleanJoinName; ENV_LIMITS.memberLabelLength characters at most. */
  label: string;
  form: 'phone' | 'tablet' | null;
}

/** What a value's box is bound to. */
export interface EnvValueScope {
  set: EnvSetId;
  epoch: number;
  name: string;
  version: number;
}

export interface CreateEnvSetInput {
  /** ENV_SET_NAME_PATTERN. */
  name: string;
  /** The device creating the set; it becomes the owner and signs the header and every value line. */
  owner: DeviceKeys;
  ownerLabel: string;
  ownerForm: 'phone' | 'tablet' | null;
  /** The owner's vault recovery identity (public keys from vault state); null when the vault has none. */
  recovery: Pick<DeviceKeys, 'edPublic' | 'xPublic' | 'deviceId'> | null;
  /** Imported variables, in order; each gets version 1. */
  values: readonly EnvPlainValue[];
  time: number;
  random: RandomBytes;
}

export interface CreatedEnvSet {
  file: EnvSetFile;
  /** writeEnvFile(file): what the agent writes (protocol answer `created`). */
  text: string;
  /** The epoch-1 data key. The owner keeps it with its local copy. */
  dataKey: Uint8Array;
}

/**
 * A set's recovery identity is the owner's vault recovery identity: the phone never holds the
 * phrase, so it wraps each set to the recovery public keys already in its vault state. This
 * returns those keys from the phrase: recoveryKeysFromPhrase(phrase, vaultId), unchanged.
 *
 * The second argument is the owner's VAULT id. It was a set id in 0.4's first API; a set id gives
 * a different identity that opens nothing. The type is unchanged (both are base64url ids).
 * Sets and vaults stay apart without a separate identity: env signatures use their own domains
 * (signing.ts), and every wrap's sealKey context names the set id as its `vault`.
 * Throws for an invalid phrase, as recoveryKeysFromPhrase does.
 */
export function envRecoveryKeys(phrase: string, vaultId: string): DeviceKeys {
  return recoveryKeysFromPhrase(phrase, vaultId);
}

/**
 * Makes a new set at rev 1, epoch 1: a birth certificate signed by the owner, whose hash is the
 * set id (file.header.set); a random data key; the owner as the only member; the key wrapped for
 * the owner and the recovery identity; every value boxed and signed by the owner at version 1; and
 * the header signed by the owner. Throws EnvFileRefused for values that
 * fail checkEnvPlainValues (`bad-name`, `duplicate-name`, `too-large`), and a plain Error for a
 * set name outside ENV_SET_NAME_PATTERN or an unusable key.
 */
export function createEnvSet(input: CreateEnvSetInput): CreatedEnvSet {
  if (!ENV_SET_NAME_PATTERN.test(input.name)) throw new Error(`"${input.name}" can't be a set name: use lower-case letters, digits, ".", "_" and "-".`);
  const problem = checkEnvPlainValues(input.values);
  if (problem) throw new EnvFileRefused(problem);
  const { owner, time, random } = input;
  const birth = newEnvBirth(owner, input.recovery, time, random);
  const set = envSetIdOf(birth);
  const epoch = 1;
  const dataKey = takeRandom(random, ENV_DATA_KEY_BYTES);
  const ownerMember = envMemberRecord(dataKey, { set, epoch }, { ...publicHalf(owner), label: input.ownerLabel, form: input.ownerForm }, 'owner', time);
  const recovery = input.recovery ? envRecoveryRecord(dataKey, { set, epoch }, input.recovery) : null;
  const header = signEnvHeader(
    { format: ENV_FORMAT, set, name: input.name, rev: 1, epoch, authority: { birth, changes: [] }, members: [ownerMember], recovery, time, signer: owner.deviceId },
    owner,
  );
  const values = input.values.map(({ name, value }) => {
    const box = sealEnvValue(dataKey, { set, epoch, name, version: 1 }, value, random);
    return signEnvValueLine({ name, version: 1, author: owner.deviceId, time, box }, { set, epoch }, owner);
  });
  const file = { header, values };
  return { file, text: writeEnvFile(file), dataKey };
}

/**
 * Opens the header's data key (its epoch) with this device's wrap: the member whose id is
 * `device.deviceId`, or the recovery identity when that is the device. Checks the wrap names the
 * device's sealing key. Throws (plain Error, "not a member of this set, or its key was changed")
 * when the device isn't listed or the wrap doesn't open.
 */
export function openEnvDataKey(header: EnvHeader, device: Pick<DeviceKeys, 'deviceId' | 'xSecret' | 'xPublic'>): Uint8Array {
  const holder = keyHolder(header, device.deviceId);
  if (!holder) throw new Error('This device is not a member of this set.');
  try {
    return openSealedKey(holder.key, device, { vault: header.set, epoch: header.epoch, to: holder.id });
  } catch (err) {
    throw new Error("This set's key was not sealed to this device, or it was changed.", { cause: err });
  }
}

/**
 * Rebuilds every wrap in the header from `dataKey` (wraps are deterministic) and returns the ids
 * (members and recovery) whose wrap differs: a bad wrap the owner gave someone. Empty when all match.
 */
export function findBadEnvWraps(header: EnvHeader, dataKey: Uint8Array): string[] {
  const holders: { id: string; x: string; key: SealedKey }[] = [...header.members, ...(header.recovery ? [header.recovery] : [])];
  return holders.filter((holder) => !wrapMatches(dataKey, { set: header.set, epoch: header.epoch }, holder)).map((holder) => holder.id);
}

/** Boxes one plain value under `dataKey`, bound to the scope (see the file comment). */
export function sealEnvValue(dataKey: Uint8Array, scope: EnvValueScope, value: string, random: RandomBytes): Box {
  return encryptBox(dataKey, utf8Encode(value), valueBoxContext(scope), random);
}

/**
 * Opens one value line: null for a deletion, else the UTF-8 value. The scope comes from the line
 * (name, version, box.epoch) and `set`. Throws (plain Error) when the box doesn't open under
 * `dataKey`: a wrong key, a moved line or changed bytes.
 */
export function openEnvValue(dataKey: Uint8Array, set: EnvSetId, line: EnvValueLine): string | null {
  if (!line.box) return null;
  const plain = decryptBox(dataKey, line.box, valueBoxContext({ set, epoch: line.box.epoch, name: line.name, version: line.version }));
  return utf8Decode(plain, `The value of ${line.name}`);
}

/**
 * Every variable that isn't deleted, in file order: what a release seals. Call only on a file
 * verifyEnvFile accepted. Throws (plain Error) when a box doesn't open under `dataKey`.
 */
export function openEnvValues(file: EnvSetFile, dataKey: Uint8Array): EnvPlainValue[] {
  const values: EnvPlainValue[] = [];
  for (const line of file.values) {
    const value = openEnvValue(dataKey, file.header.set, line);
    if (value !== null) values.push({ name: line.name, value });
  }
  return values;
}


/** Where a wrap goes: the set and the epoch of the key it holds. */
export interface EnvKeyScope {
  set: EnvSetId;
  epoch: number;
}

/** The wrap of a data key for one holder (member or recovery identity): deterministic, see the file comment. */
export function envWrap(dataKey: Uint8Array, scope: EnvKeyScope, holder: { id: string; x: string }): SealedKey {
  return sealKey(dataKey, fromBase64Url(holder.x), { vault: scope.set, epoch: scope.epoch, to: holder.id });
}

/** True when `holder.key` is exactly the wrap of `dataKey`, so `dataKey` is the key the header gives them. */
export function wrapMatches(dataKey: Uint8Array, scope: EnvKeyScope, holder: { id: string; x: string; key: SealedKey }): boolean {
  try {
    return sealsEqual(envWrap(dataKey, scope, holder), holder.key);
  } catch {
    return false;
  }
}

/** A member label as the file holds it: cleaned like a join name. Throws when nothing is left. */
export function cleanEnvLabel(label: string): string {
  const cleaned = cleanJoinName(label);
  if (cleaned === '') throw new Error('A member needs a name: the label is empty once cleaned.');
  return cleaned;
}

export function publicHalf(device: Pick<DeviceKeys, 'edPublic' | 'xPublic'>): Pick<EnvNewMember, 'edPublic' | 'xPublic'> {
  return { edPublic: device.edPublic, xPublic: device.xPublic };
}

/** A member record with its wrap of `dataKey`. */
export function envMemberRecord(dataKey: Uint8Array, scope: EnvKeyScope, member: EnvNewMember, role: EnvMember['role'], since: number): EnvMember {
  const ed = toBase64Url(member.edPublic);
  const x = toBase64Url(member.xPublic);
  const id = deviceIdFor(member.edPublic);
  return { id, role, label: cleanEnvLabel(member.label), form: member.form, ed, x, key: envWrap(dataKey, scope, { id, x }), since };
}

/** The recovery record with its wrap of `dataKey`. */
export function envRecoveryRecord(dataKey: Uint8Array, scope: EnvKeyScope, recovery: Pick<DeviceKeys, 'edPublic' | 'xPublic' | 'deviceId'>): EnvRecovery {
  const x = toBase64Url(recovery.xPublic);
  return { id: recovery.deviceId, ed: toBase64Url(recovery.edPublic), x, key: envWrap(dataKey, scope, { id: recovery.deviceId, x }) };
}

/** The member or recovery identity with this id. */
export function keyHolder(header: EnvHeader, id: string): { id: string; ed: string; x: string; key: SealedKey } | null {
  const member = header.members.find((candidate) => candidate.id === id);
  if (member) return member;
  return header.recovery?.id === id ? header.recovery : null;
}

function valueBoxContext(scope: EnvValueScope): BoxContext {
  return { vault: scope.set, epoch: scope.epoch, kind: ENV_VALUE_BOX_KIND, name: scope.name, version: scope.version };
}
