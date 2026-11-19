import { canonicalJson, type JsonValue } from './canonical';
import { fromBase64Url, toBase64Url, utf8Encode } from './bytes';
import { sha256Bytes, sign, verifySignature, type DeviceKeys, type SignatureCheck } from './crypto';

export const ENTRY_VERSION = 2;
/** Signatures cover this prefix too, so an entry signature can't be replayed as another signed object. */
const SIGNING_DOMAIN = 'authdeck/entry/v2\n';

export const ENTRY_KINDS = [
  'vault.create',
  'device.add',
  'device.hello',
  'device.remove',
  'device.rename',
  'recovery.set',
  'key.rotate',
  'account.put',
  'account.delete',
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** An entry of another device, named by its seq and hash. */
export interface EntryRef {
  seq: number;
  hash: string;
}

/** A log entry as written to `log/<deviceId>.jsonl`. Bodies are checked per kind in the chain check. */
export interface SignedEntry {
  v: 2;
  vault: string;
  author: string;
  seq: number;
  prev: string | null;
  /** The latest applied entry of each other device the author had read. */
  seen: Record<string, EntryRef>;
  time: number;
  kind: EntryKind;
  body: { [key: string]: JsonValue };
  sig: string;
}

export type UnsignedEntry = Omit<SignedEntry, 'sig'>;

/** Device logs a vault may hold, the recovery identities' included. */
export const MAX_IDENTITIES = 256;

const ENTRY_FIELDS = ['author', 'body', 'kind', 'prev', 'seen', 'seq', 'sig', 'time', 'v', 'vault'];
/** base64url of 16 bytes (ids) or 32 bytes (hashes). */
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEntryRef(value: unknown): value is EntryRef {
  if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== 'hash,seq') return false;
  return Number.isSafeInteger(value.seq) && (value.seq as number) >= 0 && isHash(value.hash);
}

/**
 * Checks that an unknown value has the shape of a signed entry (not that it is valid).
 * Returns a reason when it does not.
 */
export function entryShapeProblem(value: unknown, options: { skipCanonical?: boolean } = {}): string | null {
  if (!isPlainObject(value)) return 'it is not a JSON object';
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== ENTRY_FIELDS.join(',')) return 'it has missing or extra fields';
  if (value.v !== ENTRY_VERSION) return `version ${String(value.v)} is not supported`;
  if (!isId(value.vault)) return 'the vault id is malformed';
  if (!isId(value.author)) return 'the author id is malformed';
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) return 'seq is not a whole number';
  if (value.prev !== null && !isHash(value.prev)) return 'prev is malformed';
  if (!Number.isSafeInteger(value.time) || (value.time as number) < 0) return 'time is not a whole number';
  if (!(ENTRY_KINDS as readonly unknown[]).includes(value.kind)) return `"${String(value.kind)}" is not a known kind`;
  if (!isPlainObject(value.body)) return 'the body is not an object';
  if (typeof value.sig !== 'string' || !SIGNATURE_PATTERN.test(value.sig)) return 'the signature is malformed';
  if (!isPlainObject(value.seen)) return 'seen is not an object';
  if (Object.keys(value.seen).length > MAX_IDENTITIES) return 'seen names more devices than a vault can hold';
  for (const [deviceId, ref] of Object.entries(value.seen)) {
    if (!isId(deviceId) || !isEntryRef(ref)) return 'seen has a malformed device id, seq or hash';
    if (deviceId === value.author) return 'seen names its own author';
  }
  if (options.skipCanonical) return null;
  try {
    canonicalJson(value);
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

function signedBytes(entry: UnsignedEntry): Uint8Array {
  const { v, vault, author, seq, prev, seen, time, kind, body } = entry;
  return utf8Encode(SIGNING_DOMAIN + canonicalJson({ v, vault, author, seq, prev, seen, time, kind, body }));
}

/** An entry's hash, and a check of its signature that reuses the canonical form already written. */
export interface EntryDigest {
  hash: string;
  /** The entry's canonical form, the text its hash covers; a log line must be exactly this. */
  text: string;
  /** Runs `check` (bound to the author's key, see signatureCheckFor) on the entry's signature. */
  signatureValid(check: SignatureCheck): boolean;
}

/**
 * Hash of an entry, writing its canonical form once: the signed bytes are the canonical form
 * without `sig`, and the full form is the same text with `sig` put back in its sorted place (its
 * last five keys are seq, sig, time, v, vault, all plain values). The signature is checked only
 * when asked, so a caller that already knows the verdict for this hash pays nothing for it.
 * Throws when the entry can't be put in canonical form.
 */
export function digestEntry(entry: SignedEntry): EntryDigest {
  const { v, vault, author, seq, prev, seen, time, kind, body, sig } = entry;
  const unsigned = canonicalJson({ v, vault, author, seq, prev, seen, time, kind, body });
  const tail = canonicalJson({ seq, time, v, vault }).slice(1);
  if (!unsigned.endsWith(tail) || unsigned[unsigned.length - tail.length - 1] !== ',') throw new Error('the entry has an unexpected canonical form');
  const full = unsigned.slice(0, unsigned.length - tail.length) + canonicalJson({ seq, sig, time, v, vault }).slice(1);
  return {
    text: full,
    hash: toBase64Url(sha256Bytes(utf8Encode(full))),
    signatureValid(check) {
      let signature: Uint8Array;
      try {
        signature = fromBase64Url(sig);
      } catch {
        return false;
      }
      return check(signature, utf8Encode(SIGNING_DOMAIN + unsigned));
    },
  };
}

/** SHA-256 of the canonical form including `sig`, base64url. */
export function entryHash(entry: SignedEntry): string {
  return toBase64Url(sha256Bytes(utf8Encode(canonicalJson(entry))));
}

export function signEntry(entry: UnsignedEntry, author: Pick<DeviceKeys, 'edSecret'>): SignedEntry {
  return { ...entry, sig: toBase64Url(sign(signedBytes(entry), author.edSecret)) };
}

export function entrySignatureValid(entry: SignedEntry, edPublic: Uint8Array): boolean {
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(entry.sig);
  } catch {
    return false;
  }
  return verifySignature(signature, signedBytes(entry), edPublic);
}

/** One JSON entry per line. */
export function serializeEntry(entry: SignedEntry): string {
  return canonicalJson(entry);
}
