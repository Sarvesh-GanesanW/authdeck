import { fromBase64Url } from './bytes';
import { canonicalJson } from './canonical';
import { COMMIT_BYTES, deviceIdFor, isUsableEd25519Key, isUsableSealingKey, KEY_BYTES, NONCE_BYTES, SEALED_CT_BYTES, type Box, type SealedKey } from './crypto';
import { isHash, isId, MAX_IDENTITIES, type EntryKind, type SignedEntry } from './entry';

/**
 * `solo`: one device and the recovery phrase (0.3.0). Only the recovery identity adds a device,
 * by restore, and that cuts every earlier device; a device writes only its hello and its own
 * lines. `personal` and `team` are multi-device vaults (0.4).
 */
export type VaultKind = 'personal' | 'team' | 'solo';
export type Role = 'admin' | 'member';

export interface VaultCreateBody {
  kind: VaultKind;
  /** 16 random bytes; the vault id is derived from it and the founder's key. */
  salt: string;
  ed: string;
  x: string;
  name: Box;
  /** The founding device's own name. */
  deviceName: Box;
  /** Epoch 0 key sealed to the founder. */
  key: SealedKey;
  /** Commitment to the epoch 0 key (crypto.ts keyCheck). */
  keyCheck: string;
}

export interface DeviceAddBody {
  device: string;
  ed: string;
  x: string;
  role: Role;
  name: Box;
  epoch: number;
  key: SealedKey;
}

/** What a key rotation carries: `device.remove` and `recovery.set` both rotate. */
export interface RotationFields {
  /** The new epoch: the vault's epoch plus one. */
  epoch: number;
  /** The new epoch key sealed to every device staying in the vault and the recovery identity. */
  keys: Record<string, SealedKey>;
  /** The previous epoch's key encrypted under the new one, so new devices can read older accounts. */
  prevKey: Box;
  /** Commitment to the new epoch key. */
  keyCheck: string;
}

export interface DeviceRemoveBody extends RotationFields {
  device: string;
}

export interface DeviceRenameBody {
  device: string;
  name: Box;
}

/** Replaces the recovery identity and rotates the key, so an older phrase reads nothing new. */
export interface RecoverySetBody extends RotationFields {
  ed: string;
  x: string;
}

/**
 * A rotation that changes nobody: made after removals made at the same time, so the vault's key
 * is again one that only the devices still in it hold (docs/authenticator.md, rule 3).
 */
export type KeyRotateBody = RotationFields;

/** A device's entry 0: binds the sealing key it was approved with to its own signature (rule 4). */
export interface DeviceHelloBody {
  x: string;
  /** Hash of the device.add this hello confirms. */
  approval: string;
}

export interface AccountPutBody {
  account: string;
  box: Box;
}

export interface AccountDeleteBody {
  account: string;
}

export interface BodyByKind {
  'vault.create': VaultCreateBody;
  'device.add': DeviceAddBody;
  'device.hello': DeviceHelloBody;
  'device.remove': DeviceRemoveBody;
  'device.rename': DeviceRenameBody;
  'recovery.set': RecoverySetBody;
  'key.rotate': KeyRotateBody;
  'account.put': AccountPutBody;
  'account.delete': AccountDeleteBody;
}

/** Kinds that change who is in the vault or which key it uses (replay.ts decides them from what each had seen). */
export const MEMBERSHIP_KINDS: readonly EntryKind[] = ['vault.create', 'device.add', 'device.hello', 'device.remove', 'recovery.set', 'key.rotate'];

type Fields = Record<string, unknown>;

class BodyError extends Error {}

const SALT_BYTES = 16;
const GCM_TAG_BYTES = 16;
/**
 * The longest name (vault or device) a box may hold, in UTF-8 bytes. Names are typed or come from
 * the OS (a join shows at most 64 characters), so a kilobyte is far more than any real one.
 */
export const MAX_NAME_BYTES = 1024;
/**
 * The longest account record (open.ts validateAccountRecord, canonical JSON) a box may hold. The
 * worst record that check takes (issuer, label and icon of 256 characters, each escaped to six
 * bytes, a 128-byte secret and every number at its widest) is about 5 KB.
 */
export const MAX_ACCOUNT_RECORD_BYTES = 6 * 1024;
/** A `prevKey` box holds exactly one epoch key. */
const PREV_KEY_CT_BYTES = KEY_BYTES + GCM_TAG_BYTES;

/** How long a box's ciphertext may be: the plaintext bounds plus the GCM tag. */
interface CiphertextBounds {
  min: number;
  max: number;
}

const NAME_CT: CiphertextBounds = { min: GCM_TAG_BYTES, max: MAX_NAME_BYTES + GCM_TAG_BYTES };
const ACCOUNT_CT: CiphertextBounds = { min: GCM_TAG_BYTES, max: MAX_ACCOUNT_RECORD_BYTES + GCM_TAG_BYTES };
const PREV_KEY_CT: CiphertextBounds = { min: PREV_KEY_CT_BYTES, max: PREV_KEY_CT_BYTES };

function exactFields(value: unknown, fields: string[], what: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BodyError(`${what} is not an object`);
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== [...fields].sort().join(',')) throw new BodyError(`${what} has missing or extra fields`);
  return value as Fields;
}

function decoded(value: unknown, what: string): Uint8Array {
  if (typeof value !== 'string') throw new BodyError(`${what} is missing`);
  try {
    return fromBase64Url(value);
  } catch {
    throw new BodyError(`${what} is not base64url`);
  }
}

function bytesField(value: unknown, length: number, what: string): string {
  if (decoded(value, what).length !== length) throw new BodyError(`${what} has the wrong length`);
  return value as string;
}

function boundedBytesField(value: unknown, bounds: CiphertextBounds, what: string): string {
  const length = decoded(value, what).length;
  if (length < bounds.min) throw new BodyError(`${what} is too short`);
  if (length > bounds.max) throw new BodyError(`${what} is too long`);
  return value as string;
}

function signingKeyField(value: unknown): string {
  if (!isUsableEd25519Key(decoded(value, 'the signing key'))) throw new BodyError('the signing key is not a valid Ed25519 key');
  return value as string;
}

function sealingKeyField(value: unknown): string {
  if (!isUsableSealingKey(decoded(value, 'the sealing key'))) throw new BodyError('the sealing key is not a usable ristretto255 key (it is the identity or not canonical)');
  return value as string;
}

function idField(value: unknown, what: string): string {
  if (!isId(value)) throw new BodyError(`${what} is not a valid id`);
  return value;
}

function hashField(value: unknown, what: string): string {
  if (!isHash(value)) throw new BodyError(`${what} is not a valid entry hash`);
  return value;
}

function epochField(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new BodyError(`${what} is not a valid epoch`);
  return value as number;
}

function boxField(value: unknown, ciphertext: CiphertextBounds, what: string): Box {
  const box = exactFields(value, ['epoch', 'n', 'ct', 'c'], what);
  return {
    epoch: epochField(box.epoch, `${what} epoch`),
    n: bytesField(box.n, NONCE_BYTES, `${what} nonce`),
    ct: boundedBytesField(box.ct, ciphertext, `${what} ciphertext`),
    c: bytesField(box.c, COMMIT_BYTES, `${what} commitment`),
  };
}

/**
 * Lengths only: decoding every seal's points would dominate a cold replay, and nothing the rules
 * decide depends on them. Whoever opens a seal, or proves it bad, decodes its points then.
 */
function sealedField(value: unknown, what: string): SealedKey {
  const sealed = exactFields(value, ['e', 'r', 'ct'], what);
  return {
    e: bytesField(sealed.e, KEY_BYTES, `${what}'s ephemeral key`),
    r: bytesField(sealed.r, KEY_BYTES, `${what}'s recipient key`),
    ct: bytesField(sealed.ct, SEALED_CT_BYTES, `${what} ciphertext`),
  };
}

/** A seal names the key it was sealed to; where the body names the recipient's key too, they must agree. */
function sealedToField(value: unknown, x: string, what: string): SealedKey {
  const sealed = sealedField(value, what);
  if (sealed.r !== x) throw new BodyError(`${what} is sealed to a key other than the one the entry names`);
  return sealed;
}

function keyCheckField(value: unknown): string {
  return bytesField(value, KEY_BYTES, 'the key check');
}

function roleField(value: unknown): Role {
  if (value !== 'admin' && value !== 'member') throw new BodyError('the role must be admin or member');
  return value;
}

function sealedKeysField(value: unknown): Record<string, SealedKey> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BodyError('the keys are not an object');
  const entries = Object.entries(value);
  if (entries.length > MAX_IDENTITIES) throw new BodyError('the new key is sealed to more devices than a vault can hold');
  const keys: Record<string, SealedKey> = {};
  for (const [to, sealed] of entries) keys[idField(to, 'a key recipient')] = sealedField(sealed, 'a sealed key');
  return keys;
}

function rotationFields(body: Fields): RotationFields {
  return { epoch: epochField(body.epoch, 'the epoch'), keys: sealedKeysField(body.keys), prevKey: boxField(body.prevKey, PREV_KEY_CT, 'the previous key'), keyCheck: keyCheckField(body.keyCheck) };
}

const PARSERS: { [K in EntryKind]: (body: unknown) => BodyByKind[K] } = {
  'vault.create': (raw) => {
    const body = exactFields(raw, ['kind', 'salt', 'ed', 'x', 'name', 'deviceName', 'key', 'keyCheck'], 'the body');
    if (body.kind !== 'personal' && body.kind !== 'team' && body.kind !== 'solo') throw new BodyError('the vault kind must be solo, personal or team');
    return {
      kind: body.kind,
      salt: bytesField(body.salt, SALT_BYTES, 'the salt'),
      ed: signingKeyField(body.ed),
      x: sealingKeyField(body.x),
      name: boxField(body.name, NAME_CT, 'the name'),
      deviceName: boxField(body.deviceName, NAME_CT, 'the device name'),
      key: sealedToField(body.key, body.x as string, 'the sealed key'),
      keyCheck: keyCheckField(body.keyCheck),
    };
  },
  'device.add': (raw) => {
    const body = exactFields(raw, ['device', 'ed', 'x', 'role', 'name', 'epoch', 'key'], 'the body');
    return {
      device: idField(body.device, 'the device'),
      ed: signingKeyField(body.ed),
      x: sealingKeyField(body.x),
      role: roleField(body.role),
      name: boxField(body.name, NAME_CT, 'the name'),
      epoch: epochField(body.epoch, 'the epoch'),
      key: sealedToField(body.key, body.x as string, 'the sealed key'),
    };
  },
  'device.hello': (raw) => {
    const body = exactFields(raw, ['x', 'approval'], 'the body');
    return { x: sealingKeyField(body.x), approval: hashField(body.approval, 'the approval') };
  },
  'device.remove': (raw) => {
    const body = exactFields(raw, ['device', 'epoch', 'keys', 'prevKey', 'keyCheck'], 'the body');
    return { device: idField(body.device, 'the device'), ...rotationFields(body) };
  },
  'device.rename': (raw) => {
    const body = exactFields(raw, ['device', 'name'], 'the body');
    return { device: idField(body.device, 'the device'), name: boxField(body.name, NAME_CT, 'the name') };
  },
  'recovery.set': (raw) => {
    const body = exactFields(raw, ['ed', 'x', 'epoch', 'keys', 'prevKey', 'keyCheck'], 'the body');
    const parsed = { ed: signingKeyField(body.ed), x: sealingKeyField(body.x), ...rotationFields(body) };
    const toRecovery = parsed.keys[deviceIdFor(fromBase64Url(parsed.ed))];
    if (toRecovery && toRecovery.r !== parsed.x) throw new BodyError('the key for the new recovery identity is sealed to a key other than its own');
    return parsed;
  },
  'key.rotate': (raw) => rotationFields(exactFields(raw, ['epoch', 'keys', 'prevKey', 'keyCheck'], 'the body')),
  'account.put': (raw) => {
    const body = exactFields(raw, ['account', 'box'], 'the body');
    return { account: idField(body.account, 'the account'), box: boxField(body.box, ACCOUNT_CT, 'the account record') };
  },
  'account.delete': (raw) => {
    const body = exactFields(raw, ['account'], 'the body');
    return { account: idField(body.account, 'the account') };
  },
};

export type ParsedBody = BodyByKind[EntryKind];

/** Kinds that carry a new epoch key sealed to every recipient (RotationFields). */
export type RotationKind = 'device.remove' | 'recovery.set' | 'key.rotate';
const ROTATION_KINDS: readonly EntryKind[] = ['device.remove', 'recovery.set', 'key.rotate'];

/*
 * The widest canonical form of every part of a rotation entry, built once from samples whose
 * fields all have their exact lengths and whose numbers are at their widest. Every byte field is
 * exact (or, for names and records, bounded), so these sums are tight: only the recipient count
 * and the `seen` map vary.
 */
const base64UrlLength = (bytes: number) => Math.ceil((bytes * 4) / 3);
const widestId = (index: number) => String(index).padStart(base64UrlLength(16), 'A');
const widest = (bytes: number) => 'A'.repeat(base64UrlLength(bytes));
const ED25519_PUBLIC_BYTES = 32;
const SIGNATURE_BYTES = 64;
const HASH_BYTES = 32;

function widestEnvelopeBytes(kind: RotationKind): number {
  const seen = Object.fromEntries(Array.from({ length: MAX_IDENTITIES }, (_, i) => [widestId(i), { hash: widest(HASH_BYTES), seq: Number.MAX_SAFE_INTEGER }]));
  const envelope = { v: 2, vault: widestId(0), author: widestId(0), seq: Number.MAX_SAFE_INTEGER, prev: widest(HASH_BYTES), seen, time: Number.MAX_SAFE_INTEGER, kind, body: {}, sig: widest(SIGNATURE_BYTES) };
  return canonicalJson(envelope).length - canonicalJson({}).length;
}

function widestRotationBodyBytes(kind: RotationKind): number {
  const rotation = {
    epoch: Number.MAX_SAFE_INTEGER,
    keys: {},
    prevKey: { epoch: Number.MAX_SAFE_INTEGER, n: widest(NONCE_BYTES), ct: widest(PREV_KEY_CT_BYTES), c: widest(COMMIT_BYTES) },
    keyCheck: widest(KEY_BYTES),
  };
  const extra = kind === 'device.remove' ? { device: widestId(0) } : kind === 'recovery.set' ? { ed: widest(ED25519_PUBLIC_BYTES), x: widest(KEY_BYTES) } : {};
  return canonicalJson({ ...rotation, ...extra }).length;
}

/** One recipient in `keys`: its quoted id, the sealed key and a separating comma. */
const SEALED_KEY_ENTRY_BYTES =
  canonicalJson({ [widestId(0)]: { e: widest(KEY_BYTES), r: widest(KEY_BYTES), ct: widest(SEALED_CT_BYTES) } }).length - canonicalJson({}).length + ','.length;

const ROTATION_BASE_BYTES: Record<RotationKind, number> = {
  'device.remove': widestEnvelopeBytes('device.remove') + widestRotationBodyBytes('device.remove'),
  'recovery.set': widestEnvelopeBytes('recovery.set') + widestRotationBodyBytes('recovery.set'),
  'key.rotate': widestEnvelopeBytes('key.rotate') + widestRotationBodyBytes('key.rotate'),
};

/**
 * The most bytes (canonical form, without the line break) a rotation entry sealing the new key to
 * `recipients` identities can take: a fixed part (envelope with a full `seen`, body fields at
 * their widest) plus one sealed key per recipient.
 */
export function rotationEntryMaxBytes(kind: RotationKind, recipients: number): number {
  return ROTATION_BASE_BYTES[kind] + recipients * SEALED_KEY_ENTRY_BYTES;
}

function checkRotationSize(entry: SignedEntry, recipients: number): void {
  const bound = rotationEntryMaxBytes(entry.kind as RotationKind, recipients);
  // Every field of a parsed rotation entry is ASCII, so JSON.stringify (native, far cheaper on a
  // cold replay) gives the canonical length: only key order differs.
  if (JSON.stringify(entry).length > bound) throw new BodyError(`the entry is larger than a key change sealed to ${recipients} devices can be`);
}

/** Parses an entry's body for its kind, or returns the reason it is malformed. */
export function parseBody<K extends EntryKind>(entry: SignedEntry & { kind: K }): { ok: true; body: BodyByKind[K] } | { ok: false; reason: string } {
  try {
    const body = PARSERS[entry.kind](entry.body) as BodyByKind[K];
    if (ROTATION_KINDS.includes(entry.kind)) checkRotationSize(entry, Object.keys((body as RotationFields).keys).length);
    return { ok: true, body };
  } catch (err) {
    if (err instanceof BodyError) return { ok: false, reason: `malformed body: ${err.message}` };
    throw err;
  }
}
