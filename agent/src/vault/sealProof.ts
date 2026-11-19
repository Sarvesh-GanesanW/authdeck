/**
 * Bad seals, shown to everyone. Seals are deterministic (crypto.ts sealKey), so a device holding
 * an epoch key rebuilds every seal of it and sees one that differs (findBadSeals). A recipient
 * whose seal doesn't open to the entry's key check publishes the shared point S = s·E with a
 * Chaum-Pedersen proof that log_G(R) = log_E(S), R being the sealing key the seal names
 * (makeSealProof). Anyone checks the proof, opens the seal with S and sees it fail
 * (sealProofValid). The author's good seal can never be shown bad: the only S that passes the
 * proof is the real one, and with it a good seal opens. Pure.
 */
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { parseBody, type BodyByKind } from './bodies';
import { concatBytes, fromBase64Url, lengthPrefixed, toBase64Url, utf8Encode } from './bytes';
import type { VaultLogs } from './chain';
import {
  decodeSealPoint,
  deviceIdFor,
  keyMatchesCheck,
  openSealWithShared,
  sealKey,
  SealPoint,
  sealScalar,
  sealsEqual,
  type DeviceKeys,
  type SealedKey,
  type SealContext,
} from './crypto';
import { entryHash, isHash, isId, type EntryKind, type SignedEntry } from './entry';
import type { VaultState } from './replay';

/** Proof that the seal `entry` gives `to` doesn't open to that entry's key. JSON-serialisable. */
export interface SealProof {
  /** Hash of the key-bearing entry holding the seal. */
  entry: string;
  /** The recipient the seal is addressed to (who made the proof). */
  to: string;
  /** base64url of S ‖ c ‖ z (32 bytes each): the shared point and the proof's challenge and response. */
  proof: string;
}

/** A seal that differs from the one its entry's key gives, found by a device holding that key. */
export interface BadSeal {
  /** The entry holding the seal, and its author. */
  hash: string;
  author: string;
  seq: number;
  to: string;
  epoch: number;
}

/** Kinds whose entries seal a key to someone other than their author. */
export const SEAL_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>(['device.add', 'device.remove', 'recovery.set', 'key.rotate']);

const POINT_BYTES = 32;
const SCALAR_BYTES = 32;
const PROOF_BYTES = POINT_BYTES + 2 * SCALAR_BYTES;
const PROOF_DOMAIN = utf8Encode('authdeck/seal-proof/v1');
const PROOF_NONCE_DOMAIN = utf8Encode('authdeck/seal-proof-nonce/v1');
const PROOF_FIELDS = 'entry,proof,to';
/** base64url of PROOF_BYTES. */
const PROOF_PATTERN = /^[A-Za-z0-9_-]{128}$/;

const { Fn } = SealPoint;

/** One seal of an entry: who it is for, the epoch, and the key check the key it holds must pass. */
interface EntrySeal {
  to: string;
  epoch: number;
  sealed: SealedKey;
  /** Null when the entry's epoch has no published key check (an approval off the key chain). */
  keyCheck: string | null;
}

/**
 * The seals of a key-bearing entry to anyone but its author (a seal to oneself harms only
 * oneself). An approval's key must pass its epoch's key check, `keyChecks` (VaultState.keyChecks);
 * a key change carries its own.
 */
function sealsOf(entry: SignedEntry, keyChecks: Readonly<Record<number, string>>): EntrySeal[] {
  if (!SEAL_KINDS.has(entry.kind)) return [];
  const parsed = parseBody(entry);
  if (!parsed.ok) return [];
  if (entry.kind === 'device.add') {
    const body = parsed.body as BodyByKind['device.add'];
    const keyCheck = Object.hasOwn(keyChecks, body.epoch) ? keyChecks[body.epoch]! : null;
    return body.device === entry.author ? [] : [{ to: body.device, epoch: body.epoch, sealed: body.key, keyCheck }];
  }
  const body = parsed.body as BodyByKind['key.rotate'];
  return Object.entries(body.keys)
    .filter(([to]) => to !== entry.author)
    .map(([to, sealed]) => ({ to, epoch: body.epoch, sealed, keyCheck: body.keyCheck }));
}

function contextOf(entry: SignedEntry, seal: EntrySeal): SealContext {
  return { vault: entry.vault, epoch: seal.epoch, to: seal.to };
}

/** True when `key` is the seal's epoch key and the seal is exactly what that key gives. */
function sealIsExact(entry: SignedEntry, seal: EntrySeal, key: Uint8Array): boolean {
  try {
    return sealsEqual(seal.sealed, sealKey(key, fromBase64Url(seal.sealed.r), contextOf(entry, seal)));
  } catch {
    // A seal naming no usable key: no honest author makes one.
    return false;
  }
}

/** True when the seal opened with `shared` gives the key its key check names. */
function opensWith(entry: SignedEntry, seal: EntrySeal, shared: Uint8Array): boolean {
  if (seal.keyCheck === null) return false;
  try {
    return keyMatchesCheck(openSealWithShared(seal.sealed, shared, contextOf(entry, seal)), entry.vault, seal.epoch, seal.keyCheck);
  } catch {
    return false;
  }
}

function scalarBytes(value: bigint): Uint8Array {
  return numberToBytesLE(value, SCALAR_BYTES);
}

function hashToScalar(...parts: Uint8Array[]): bigint {
  return Fn.create(bytesToNumberLE(sha512(concatBytes(...parts))));
}

/** The Fiat-Shamir challenge: binds the entry, the recipient and every point of the statement. */
function challenge(entry: string, to: string, points: Uint8Array[]): bigint {
  return hashToScalar(PROOF_DOMAIN, lengthPrefixed(utf8Encode(entry), utf8Encode(to), ...points));
}

/**
 * The recipient's proof that its seal in `entry` is bad, or null when there is nothing to prove:
 * no seal to it, a seal naming another sealing key, an approval whose epoch has no key check, or
 * a seal that opens to the right key. Deterministic (its nonce is derived from the secret and the
 * statement), so a retry sends the same proof.
 */
export function makeSealProof(entry: SignedEntry, recipient: Pick<DeviceKeys, 'deviceId' | 'xSecret' | 'xPublic'>, keyChecks: Readonly<Record<number, string>>): SealProof | null {
  const seal = sealsOf(entry, keyChecks).find((s) => s.to === recipient.deviceId);
  if (!seal || seal.keyCheck === null || seal.sealed.r !== toBase64Url(recipient.xPublic)) return null;
  const ephemeral = decodeSealPoint(fromBase64Url(seal.sealed.e));
  if (!ephemeral || ephemeral.is0()) return null;
  const secret = sealScalar(recipient.xSecret);
  const shared = ephemeral.multiply(secret).toBytes();
  if (opensWith(entry, seal, shared)) return null;
  const hash = entryHash(entry);
  const nonce = hashToScalar(PROOF_NONCE_DOMAIN, lengthPrefixed(scalarBytes(secret), utf8Encode(hash), utf8Encode(seal.to), fromBase64Url(seal.sealed.e)));
  const commitBase = SealPoint.BASE.multiply(nonce).toBytes();
  const commitEphemeral = ephemeral.multiply(nonce).toBytes();
  const c = challenge(hash, seal.to, [recipient.xPublic, fromBase64Url(seal.sealed.e), shared, commitBase, commitEphemeral]);
  const z = Fn.add(nonce, Fn.mul(c, secret));
  return { entry: hash, to: seal.to, proof: toBase64Url(concatBytes(shared, scalarBytes(c), scalarBytes(z))) };
}

/** A canonical scalar (below the group order) from 32 little-endian bytes, or null. */
function canonicalScalar(bytes: Uint8Array): bigint | null {
  const value = bytesToNumberLE(bytes);
  return value < Fn.ORDER ? value : null;
}

/** The shared point a proof establishes for R and E, or null when the proof doesn't hold. */
function provenShared(proof: SealProof, recipient: Uint8Array, ephemeralPublic: Uint8Array): Uint8Array | null {
  if (!PROOF_PATTERN.test(proof.proof)) return null;
  const bytes = fromBase64Url(proof.proof);
  if (bytes.length !== PROOF_BYTES) return null;
  const sharedBytes = bytes.subarray(0, POINT_BYTES);
  const shared = decodeSealPoint(sharedBytes);
  const c = canonicalScalar(bytes.subarray(POINT_BYTES, POINT_BYTES + SCALAR_BYTES));
  const z = canonicalScalar(bytes.subarray(POINT_BYTES + SCALAR_BYTES));
  const R = decodeSealPoint(recipient);
  const E = decodeSealPoint(ephemeralPublic);
  if (!shared || c === null || z === null || !R || R.is0() || !E || E.is0()) return null;
  const commitBase = SealPoint.BASE.multiplyUnsafe(z).subtract(R.multiplyUnsafe(c)).toBytes();
  const commitEphemeral = E.multiplyUnsafe(z).subtract(shared.multiplyUnsafe(c)).toBytes();
  const expected = challenge(proof.entry, proof.to, [recipient, ephemeralPublic, sharedBytes, commitBase, commitEphemeral]);
  return expected === c ? shared.toBytes() : null;
}

/**
 * True when `proof` is a valid proof about `entry` AND shows its seal to `proof.to` is bad: the
 * shared point is proven for `recipientSealPublic` (base64url, the sealing key of `proof.to` the
 * caller holds for it, which must be the key the seal names) and the seal's ephemeral key, and
 * opening the seal with it fails or gives a key that fails the key check. `keyChecks`
 * (VaultState.keyChecks) gives an approval's; a key change carries its own. A proof about the
 * author's own seal never counts.
 */
export function sealProofValid(proof: SealProof, entry: SignedEntry, recipientSealPublic: string, keyChecks: Readonly<Record<number, string>>): boolean {
  if (proof.entry !== entryHash(entry) || proof.to === entry.author) return false;
  const seal = sealsOf(entry, keyChecks).find((s) => s.to === proof.to);
  if (!seal || seal.keyCheck === null || seal.sealed.r !== recipientSealPublic) return false;
  const shared = provenShared(proof, fromBase64Url(recipientSealPublic), fromBase64Url(seal.sealed.e));
  return shared !== null && !opensWith(entry, seal, shared);
}

/** Why `value` is not a seal proof's shape, or null. Says nothing about whether it holds. */
export function sealProofShapeProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'it is not an object';
  if (Object.keys(value).sort().join(',') !== PROOF_FIELDS) return 'it has missing or extra fields';
  const raw = value as Record<string, unknown>;
  if (!isHash(raw.entry)) return 'it names no valid entry';
  if (!isId(raw.to)) return 'it names no valid recipient';
  if (typeof raw.proof !== 'string' || !PROOF_PATTERN.test(raw.proof)) return 'the proof is not 96 bytes of base64url';
  return null;
}

/** The entry a history item names, read from the logs and checked against its hash, or null. */
function entryAt(logs: VaultLogs, author: string, seq: number, hash: string): SignedEntry | null {
  const line = Object.hasOwn(logs, author) ? logs[author]![seq] : undefined;
  if (line === undefined) return null;
  try {
    const entry = JSON.parse(line) as SignedEntry;
    return entryHash(entry) === hash ? entry : null;
  } catch {
    return null;
  }
}

/** The applied key-bearing entries of a replay, read from its logs. */
function sealingEntries(state: VaultState, logs: VaultLogs): SignedEntry[] {
  const entries: SignedEntry[] = [];
  for (const item of state.history) {
    if (item.status !== 'applied' || !SEAL_KINDS.has(item.kind)) continue;
    const entry = entryAt(logs, item.author, item.seq, item.hash);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Remembered verdicts per seal (`hash:to`), so a sync judges only seals it hasn't before. */
export type SealVerdicts = Map<string, boolean>;

/**
 * Seals this identity can judge and finds wrong: for every applied key-bearing entry whose epoch
 * key it holds (`keys`, OpenVault.keys, each already checked), each seal to someone else that is
 * not byte for byte what that key gives. A key change whose key check its key doesn't pass (one
 * that lost to another at its epoch) is skipped: that key isn't the one it sealed.
 */
export function findBadSeals(state: VaultState, logs: VaultLogs, keys: Readonly<Record<number, Uint8Array>>, verdicts: SealVerdicts = new Map()): BadSeal[] {
  const bad: BadSeal[] = [];
  for (const entry of sealingEntries(state, logs)) {
    const hash = entryHash(entry);
    for (const seal of sealsOf(entry, state.keyChecks)) {
      const key = keys[seal.epoch];
      if (!key || seal.keyCheck === null || !keyMatchesCheck(key, entry.vault, seal.epoch, seal.keyCheck)) continue;
      const id = `${hash}:${seal.to}`;
      let exact = verdicts.get(id);
      if (exact === undefined) {
        exact = sealIsExact(entry, seal, key);
        verdicts.set(id, exact);
      }
      if (!exact) bad.push({ hash, author: entry.author, seq: entry.seq, to: seal.to, epoch: seal.epoch });
    }
  }
  return bad;
}

/**
 * Proofs of every bad seal the vault's applied entries give `identity` (a device or the recovery
 * identity). `checked` (kept by the caller) holds entries already found fine, so a sync opens
 * only seals it hasn't before.
 */
export function ownSealProofs(state: VaultState, logs: VaultLogs, identity: Pick<DeviceKeys, 'deviceId' | 'xSecret' | 'xPublic'>, checked: Set<string> = new Set()): SealProof[] {
  const proofs: SealProof[] = [];
  for (const entry of sealingEntries(state, logs)) {
    // An approval's key check comes from the key chain, which a later read may extend, so only
    // key changes (which carry their own) are remembered as checked.
    const hash = entryHash(entry);
    if (checked.has(hash)) continue;
    const proof = makeSealProof(entry, identity, state.keyChecks);
    if (proof) proofs.push(proof);
    else if (entry.kind !== 'device.add') checked.add(hash);
  }
  return proofs;
}

/** Every sealing key each identity was given in an applied entry: its founding, approvals, hello or phrase. */
function sealingKeysOf(state: VaultState, logs: VaultLogs): Map<string, Set<string>> {
  const keys = new Map<string, Set<string>>();
  const add = (id: string, x: string) => {
    const known = keys.get(id);
    if (known) known.add(x);
    else keys.set(id, new Set([x]));
  };
  for (const item of state.history) {
    if (item.status !== 'applied') continue;
    if (item.kind !== 'vault.create' && item.kind !== 'device.add' && item.kind !== 'device.hello' && item.kind !== 'recovery.set') continue;
    const entry = entryAt(logs, item.author, item.seq, item.hash);
    const body = entry?.body as { device?: unknown; ed?: unknown; x?: unknown } | undefined;
    if (!entry || typeof body?.x !== 'string') continue;
    if (item.kind === 'device.add' && typeof body.device === 'string') add(body.device, body.x);
    else if (item.kind === 'recovery.set' && typeof body.ed === 'string') add(deviceIdFor(fromBase64Url(body.ed)), body.x);
    else add(entry.author, body.x);
  }
  return keys;
}

/**
 * Judges a proof against a replayed folder: the entry must be a key-bearing entry the rules judged, the
 * seal's key one its recipient was given, and the proof must show the seal bad. Says whose entry
 * it is, so a store can keep the earliest proof per author.
 */
export function judgeSealProof(state: VaultState, logs: VaultLogs, proof: SealProof): ({ ok: true } & BadSeal) | { ok: false; reason: string } {
  // A rejected entry counts too: a proof that voided it (replay.ts) leaves it rejected, and its
  // seal stays as bad as it was.
  const item = state.history.find((h) => h.hash === proof.entry);
  if (!item || item.status === 'waiting' || !SEAL_KINDS.has(item.kind)) return { ok: false, reason: 'it names no key change or approval of this vault' };
  const entry = entryAt(logs, item.author, item.seq, item.hash);
  if (!entry) return { ok: false, reason: 'the entry it names is not in the folder' };
  const seal = sealsOf(entry, state.keyChecks).find((s) => s.to === proof.to);
  if (!seal) return { ok: false, reason: 'that entry seals no key to that recipient' };
  if (!sealingKeysOf(state, logs).get(proof.to)?.has(seal.sealed.r)) return { ok: false, reason: 'the seal names a key its recipient was never given' };
  if (!sealProofValid(proof, entry, seal.sealed.r, state.keyChecks)) return { ok: false, reason: 'it does not prove that the seal is bad' };
  return { ok: true, hash: proof.entry, author: entry.author, seq: entry.seq, to: proof.to, epoch: seal.epoch };
}
