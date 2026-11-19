/**
 * A set's authority: who may sign its headers, proven by the file alone.
 *
 * The set id is the hash of a birth certificate the first owner signs, so nobody else can make a
 * file under that id. Each later change of owner (a take-over, signed by the recovery identity of
 * the authority before) or of recovery identity (signed by the owner) links to the certificate
 * before by hash. Every header carries the whole chain, so a reader checks a file without any
 * other version of it: git history may skip versions, and a forged one never verifies.
 *
 *   signed bytes of a certificate:  lengthPrefixed(utf8(domain), utf8(canonicalJson(certificate without sig)))
 *   a certificate's hash:           base64url SHA-256 of its signed bytes
 *   set id:                         base64url of the birth's SHA-256, cut to 16 bytes
 */
import { fromBase64Url, lengthPrefixed, takeRandom, toBase64Url, utf8Encode, type RandomBytes } from '../vault/bytes';
import { canonicalJson } from '../vault/canonical';
import { sha256Bytes, sign, verifySignature, type DeviceKeys } from '../vault/crypto';
import type { EnvAuthority, EnvAuthorityChange, EnvBirth, EnvHeader, EnvPublicKeys, EnvSetId } from './types';

export const ENV_BIRTH_DOMAIN = 'authdeck/env/birth/v1';
export const ENV_TAKEOVER_DOMAIN = 'authdeck/env/takeover/v1';
export const ENV_RECOVERY_CHANGE_DOMAIN = 'authdeck/env/recovery/v1';
export const ENV_BIRTH_NONCE_BYTES = 16;
const SET_ID_BYTES = 16;

export type EnvUnsignedBirth = Omit<EnvBirth, 'sig'>;
export type EnvUnsignedAuthorityChange = Omit<EnvAuthorityChange, 'sig'>;

/** Who the authority names last: the owner device and the recovery identity. */
export interface EnvAuthorityHolders {
  owner: EnvPublicKeys;
  recovery: EnvPublicKeys | null;
}

/** The bytes the first owner signs, and whose hash is the set id. */
export function envBirthSignedBytes(birth: EnvUnsignedBirth): Uint8Array {
  return framed(ENV_BIRTH_DOMAIN, { owner: keysJson(birth.owner), recovery: keysJson(birth.recovery), time: birth.time, nonce: birth.nonce });
}

/** The bytes a change's signer signs. The set id is in them, so a change can't be moved to another set. */
export function envAuthorityChangeSignedBytes(set: EnvSetId, change: EnvUnsignedAuthorityChange): Uint8Array {
  const { kind, n, prev, time } = change;
  const domain = kind === 'takeover' ? ENV_TAKEOVER_DOMAIN : ENV_RECOVERY_CHANGE_DOMAIN;
  return framed(domain, { set, kind, n, prev, owner: keysJson(change.owner), recovery: keysJson(change.recovery), time });
}

/** The set id a birth certificate makes. */
export function envSetIdOf(birth: EnvUnsignedBirth): EnvSetId {
  return toBase64Url(sha256Bytes(envBirthSignedBytes(birth)).subarray(0, SET_ID_BYTES));
}

/** A signed birth certificate: the start of a new set's authority. Its set id is envSetIdOf(it). */
export function newEnvBirth(owner: Pick<DeviceKeys, 'edPublic' | 'xPublic' | 'edSecret'>, recovery: Pick<DeviceKeys, 'edPublic' | 'xPublic'> | null, time: number, random: RandomBytes): EnvBirth {
  const unsigned: EnvUnsignedBirth = {
    owner: publicKeysOf(owner),
    recovery: recovery ? publicKeysOf(recovery) : null,
    time,
    nonce: toBase64Url(takeRandom(random, ENV_BIRTH_NONCE_BYTES)),
  };
  return { ...unsigned, sig: toBase64Url(sign(envBirthSignedBytes(unsigned), owner.edSecret)) };
}

/** The owner and recovery identity the authority names last. Doesn't check anything: see envAuthorityValid. */
export function envAuthorityHolders(authority: EnvAuthority): EnvAuthorityHolders {
  const last = authority.changes[authority.changes.length - 1] ?? authority.birth;
  return { owner: last.owner, recovery: last.recovery };
}

/** The header's authority epoch: how many changes its authority holds. The first half of a header's order. */
export function envAuthorityEpoch(header: EnvHeader): number {
  return header.authority.changes.length;
}

/**
 * The authority with one more change, signed by `signer`: the recovery identity it names last for
 * a take-over (which must name another owner), the owner it names last for a recovery change
 * (which keeps the owner and names another recovery identity). Throws a plain Error otherwise.
 */
export function signEnvAuthorityChange(
  set: EnvSetId,
  authority: EnvAuthority,
  change: Pick<EnvAuthorityChange, 'kind' | 'owner' | 'recovery' | 'time'>,
  signer: Pick<DeviceKeys, 'edPublic' | 'edSecret'>,
): EnvAuthority {
  const holders = envAuthorityHolders(authority);
  const unsigned: EnvUnsignedAuthorityChange = {
    kind: change.kind,
    n: authority.changes.length + 1,
    prev: tipHash(set, authority),
    owner: keysJson(change.owner)!,
    recovery: keysJson(change.recovery),
    time: change.time,
  };
  const problem = changeProblem(holders, unsigned);
  if (problem) throw new Error(problem);
  if (toBase64Url(signer.edPublic) !== signerOf(holders, unsigned.kind)!.ed) throw new Error(`Only ${unsigned.kind === 'takeover' ? "the set's recovery identity" : "the set's owner"} can sign this change.`);
  const signed = { ...unsigned, sig: toBase64Url(sign(envAuthorityChangeSignedBytes(set, unsigned), signer.edSecret)) };
  return { birth: authority.birth, changes: [...authority.changes, signed] };
}

/**
 * Does `authority` prove `set`? The set id is the birth's hash and the birth is signed by its
 * owner; each change is numbered in order, links to the certificate before by hash, is signed by
 * the holder before that may sign it, and changes what its kind changes. Never throws.
 */
export function envAuthorityValid(set: EnvSetId, authority: EnvAuthority): boolean {
  const { birth } = authority;
  if (envSetIdOf(birth) !== set || !signatureValid(birth.sig, envBirthSignedBytes(birth), birth.owner.ed)) return false;
  let holders: EnvAuthorityHolders = { owner: birth.owner, recovery: birth.recovery };
  let tip = certificateHash(envBirthSignedBytes(birth));
  for (const [index, change] of authority.changes.entries()) {
    if (change.n !== index + 1 || change.prev !== tip || changeProblem(holders, change)) return false;
    const bytes = envAuthorityChangeSignedBytes(set, change);
    if (!signatureValid(change.sig, bytes, signerOf(holders, change.kind)!.ed)) return false;
    holders = { owner: change.owner, recovery: change.recovery };
    tip = certificateHash(bytes);
  }
  return true;
}

/**
 * Does `higher`'s authority continue `lower`'s: the same set, at least as many changes, and the
 * same certificate at `lower`'s last change (each change names the one before by hash, so the
 * whole chain up to there is the same)? For two headers that already verified.
 */
export function envAuthorityExtends(lower: EnvHeader, higher: EnvHeader): boolean {
  if (lower.set !== higher.set) return false;
  const count = lower.authority.changes.length;
  if (higher.authority.changes.length < count) return false;
  if (count === 0) return true;
  const at = (header: EnvHeader) => certificateHash(envAuthorityChangeSignedBytes(header.set, header.authority.changes[count - 1]!));
  return at(lower) === at(higher);
}

/**
 * Where two authorities of one set went separate ways: the first change number at which they hold
 * different certificates, and the kind of each side's change there. Only holders of the set's
 * keys can make one (a retired owner device, or a replaced recovery phrase), so a fork means one of
 * those keys is in someone else's hands: no rule can pick the right side.
 */
export interface EnvAuthorityFork {
  change: number;
  ours: EnvAuthorityChange['kind'];
  theirs: EnvAuthorityChange['kind'];
}

/**
 * The fork between `ours` and `theirs`, two verified headers of one set; null when one authority
 * continues the other (or the headers are of different sets).
 */
export function envAuthorityFork(ours: EnvHeader, theirs: EnvHeader): EnvAuthorityFork | null {
  if (ours.set !== theirs.set) return null;
  const shared = Math.min(ours.authority.changes.length, theirs.authority.changes.length);
  const hashAt = (header: EnvHeader, index: number) => certificateHash(envAuthorityChangeSignedBytes(header.set, header.authority.changes[index]!));
  for (let index = 0; index < shared; index++) {
    if (hashAt(ours, index) === hashAt(theirs, index)) continue;
    return { change: index + 1, ours: ours.authority.changes[index]!.kind, theirs: theirs.authority.changes[index]!.kind };
  }
  return null;
}

/**
 * Does `file` cross an authority change that `trust` hasn't seen? A device that remembers the set
 * then has no memory of the line the change came from, so it reads the set's history and refuses
 * a fork there (createEnvFloorBuilder, checkEnvFloor) before accepting the file.
 */
export function envCrossesAuthority(trust: { head: { authority: number } }, file: EnvHeader): boolean {
  return envAuthorityEpoch(file) > trust.head.authority;
}

/** Orders two headers of one set by (authority epoch, rev): negative when `a` is older. */
export function compareEnvHeaders(a: EnvHeader, b: EnvHeader): number {
  return envAuthorityEpoch(a) - envAuthorityEpoch(b) || a.rev - b.rev;
}

/** The authority as a header's signature covers it: every field named, so nothing else on the objects is signed. */
export function envAuthorityJson(authority: EnvAuthority) {
  const { birth } = authority;
  return {
    birth: { owner: keysJson(birth.owner), recovery: keysJson(birth.recovery), time: birth.time, nonce: birth.nonce, sig: birth.sig },
    changes: authority.changes.map(({ kind, n, prev, owner, recovery, time, sig }) => ({ kind, n, prev, owner: keysJson(owner), recovery: keysJson(recovery), time, sig })),
  };
}

/** What may not be so about a change, given the holders before it; null when it may be made. */
function changeProblem(holders: EnvAuthorityHolders, change: EnvUnsignedAuthorityChange): string | null {
  if (change.kind === 'takeover') {
    if (!holders.recovery) return 'This set has no recovery identity, so it cannot be taken over.';
    if (sameEnvKeys(change.owner, holders.owner)) return 'A take-over must make another device the owner.';
    return null;
  }
  if (!sameEnvKeys(change.owner, holders.owner)) return 'A recovery change keeps the owner.';
  if (sameEnvKeys(change.recovery, holders.recovery)) return 'That is already the recovery identity of this set.';
  return null;
}

function signerOf(holders: EnvAuthorityHolders, kind: EnvAuthorityChange['kind']): EnvPublicKeys | null {
  return kind === 'takeover' ? holders.recovery : holders.owner;
}

function tipHash(set: EnvSetId, authority: EnvAuthority): string {
  const last = authority.changes[authority.changes.length - 1];
  return certificateHash(last ? envAuthorityChangeSignedBytes(set, last) : envBirthSignedBytes(authority.birth));
}

function certificateHash(signedBytes: Uint8Array): string {
  return toBase64Url(sha256Bytes(signedBytes));
}

/** The same two public keys, or both null. */
export function sameEnvKeys(a: EnvPublicKeys | null, b: EnvPublicKeys | null): boolean {
  return a === null || b === null ? a === b : a.ed === b.ed && a.x === b.x;
}

function keysJson(keys: EnvPublicKeys | null): EnvPublicKeys | null {
  return keys ? { ed: keys.ed, x: keys.x } : null;
}

function publicKeysOf(device: Pick<DeviceKeys, 'edPublic' | 'xPublic'>): EnvPublicKeys {
  return { ed: toBase64Url(device.edPublic), x: toBase64Url(device.xPublic) };
}

function framed(domain: string, json: unknown): Uint8Array {
  return lengthPrefixed(utf8Encode(domain), utf8Encode(canonicalJson(json)));
}

function signatureValid(sig: string, bytes: Uint8Array, ed: string): boolean {
  try {
    return verifySignature(fromBase64Url(sig), bytes, fromBase64Url(ed));
  } catch {
    return false;
  }
}
