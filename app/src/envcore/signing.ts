/**
 * The exact bytes env sets sign and hash. Like vault entries (vault/entry.ts), every signature is
 * Ed25519 (vault/crypto sign, strict verifySignature) over a domain line followed by canonical
 * JSON (vault/canonical.ts), and every hash is base64url SHA-256 over canonical JSON. The file's
 * text layout is never signed, so a reformatted file means the same thing.
 */
import { fromBase64Url, toBase64Url, utf8Encode } from '../vault/bytes';
import { canonicalJson } from '../vault/canonical';
import { sha256Bytes, sign, verifySignature, type DeviceKeys } from '../vault/crypto';
import { envAuthorityJson } from './authority';
import type { EnvHeader, EnvJoinRequestFile, EnvMember, EnvRecovery, EnvSetId, EnvValueLine } from './types';

/** Header signatures: domain, then canonicalJson of the header without `sig` (`signer` included). */
export const ENV_HEADER_SIGNING_DOMAIN = 'authdeck/env/header/v1\n';
/** Value line signatures: domain, then canonicalJson({ author, box, epoch, name, set, time, version }). */
export const ENV_VALUE_SIGNING_DOMAIN = 'authdeck/env/value/v1\n';
/** Join request signatures: domain, then canonicalJson of the request without `sig`. */
export const ENV_JOIN_REQUEST_SIGNING_DOMAIN = 'authdeck/env/join-request/v1\n';

/** A header before it is signed. `signer` is part of what is signed. */
export type EnvUnsignedHeader = Omit<EnvHeader, 'sig'>;
/** A value line before it is signed. */
export type EnvUnsignedValueLine = Omit<EnvValueLine, 'sig'>;

/** What a value line's signature binds besides the line itself: the set and the header's epoch. */
export interface EnvLineScope {
  set: EnvSetId;
  /** The epoch of the header the line is under; for a box it must equal `box.epoch`. */
  epoch: number;
}

/** The bytes a header's signature covers: ENV_HEADER_SIGNING_DOMAIN + canonicalJson(header without sig). */
export function envHeaderSignedBytes(header: EnvUnsignedHeader): Uint8Array {
  return utf8Encode(ENV_HEADER_SIGNING_DOMAIN + canonicalJson(unsignedHeaderJson(header)));
}

/**
 * The bytes a value line's signature covers: ENV_VALUE_SIGNING_DOMAIN + canonicalJson({ author,
 * box, epoch, name, set, time, version }), with `box` the whole Box ({ c, ct, epoch, n }) or null
 * for a deletion, and `epoch` from `scope` (so a tombstone is bound to its epoch too).
 */
export function envValueSignedBytes(line: EnvUnsignedValueLine, scope: EnvLineScope): Uint8Array {
  return utf8Encode(ENV_VALUE_SIGNING_DOMAIN + canonicalJson(valueJson(line, scope)));
}

/** The bytes a join request's signature covers: ENV_JOIN_REQUEST_SIGNING_DOMAIN + canonicalJson(request without sig). */
export function envJoinRequestSignedBytes(request: Omit<EnvJoinRequestFile, 'sig'>): Uint8Array {
  const { format, set, member, label, form, ed, x, time } = request;
  return utf8Encode(ENV_JOIN_REQUEST_SIGNING_DOMAIN + canonicalJson({ format, set, member, label, form, ed, x, time }));
}

/** A header's hash: base64url SHA-256 of canonicalJson(the whole header, `sig` included). What EnvAcceptedHead.headerHash holds. */
export function envHeaderHash(header: EnvHeader): string {
  return toBase64Url(sha256Bytes(utf8Encode(canonicalJson({ ...unsignedHeaderJson(header), sig: header.sig }))));
}

/**
 * A value line's hash: SHA-256 of canonicalJson({ ...line, epoch, set }) (`sig` included), as raw
 * bytes. The merge's last tiebreak keeps the line whose hash is lower, comparing these bytes
 * unsigned and in order (not their base64url text, whose alphabet doesn't sort the same).
 */
export function envValueLineHash(line: EnvValueLine, scope: EnvLineScope): Uint8Array {
  return sha256Bytes(utf8Encode(canonicalJson({ ...valueJson(line, scope), sig: line.sig })));
}

/**
 * Signs a header change. `header.signer` must be `signer.deviceId` (the owner's member id). Throws
 * (plain Error) when it isn't; whether the signer may sign is the verifier's question, not this one's.
 */
export function signEnvHeader(header: EnvUnsignedHeader, signer: Pick<DeviceKeys, 'edSecret' | 'deviceId'>): EnvHeader {
  if (header.signer !== signer.deviceId) throw new Error('The header names a different signer than the device signing it.');
  return { ...header, sig: toBase64Url(sign(envHeaderSignedBytes(header), signer.edSecret)) };
}

/** Signs one value line as its author. `line.author` must be `author.deviceId`; throws (plain Error) when it isn't. */
export function signEnvValueLine(line: EnvUnsignedValueLine, scope: EnvLineScope, author: Pick<DeviceKeys, 'edSecret' | 'deviceId'>): EnvValueLine {
  if (line.author !== author.deviceId) throw new Error('The value line names a different author than the device signing it.');
  return { ...line, sig: toBase64Url(sign(envValueSignedBytes(line, scope), author.edSecret)) };
}

/** True when `header.sig` is a valid signature by `edPublic` over envHeaderSignedBytes. Never throws. */
export function envHeaderSignatureValid(header: EnvHeader, edPublic: Uint8Array): boolean {
  return signatureValid(header.sig, () => envHeaderSignedBytes(header), edPublic);
}

/** True when `line.sig` is a valid signature by `edPublic` over envValueSignedBytes. Never throws. */
export function envValueSignatureValid(line: EnvValueLine, scope: EnvLineScope, edPublic: Uint8Array): boolean {
  return signatureValid(line.sig, () => envValueSignedBytes(line, scope), edPublic);
}

function memberJson(member: EnvMember) {
  const { id, role, label, form, ed, x, key, since } = member;
  return { id, role, label, form, ed, x, key: { e: key.e, r: key.r, ct: key.ct }, since };
}

function recoveryJson(recovery: EnvRecovery | null) {
  if (!recovery) return null;
  const { id, ed, x, key } = recovery;
  return { id, ed, x, key: { e: key.e, r: key.r, ct: key.ct } };
}

/** Every header field but `sig`, named one by one so nothing else on the object is ever signed. */
function unsignedHeaderJson(header: EnvUnsignedHeader) {
  const { format, set, name, rev, epoch, time, signer } = header;
  const authority = envAuthorityJson(header.authority);
  return { format, set, name, rev, epoch, authority, members: header.members.map(memberJson), recovery: recoveryJson(header.recovery), time, signer };
}

function valueJson(line: EnvUnsignedValueLine, scope: EnvLineScope) {
  const { author, box, name, time, version } = line;
  return { author, box: box ? { epoch: box.epoch, n: box.n, ct: box.ct, c: box.c } : null, epoch: scope.epoch, name, set: scope.set, time, version };
}

function signatureValid(sig: string, message: () => Uint8Array, edPublic: Uint8Array): boolean {
  let signature: Uint8Array;
  let bytes: Uint8Array;
  try {
    signature = fromBase64Url(sig);
    bytes = message();
  } catch {
    return false;
  }
  return verifySignature(signature, bytes, edPublic);
}
