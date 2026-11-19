/**
 * Joining a set.
 *
 * Own devices: the vault's check-code approval (vault/approval.ts), relayed by the computer both
 * are paired with. Request, challenge and reveal are vault/approval's createJoinRequest,
 * createJoinChallenge (vaultId = set id, vaultName = set name), createJoinReveal and
 * revealMatchesCommit, unchanged. Only the code differs: envCheckCode hashes the same transcript
 * under ENV_CHECK_DOMAIN instead of "authdeck/check/v2", so an env join's code never equals a
 * vault join's for the same messages.
 *
 * Teammates: a signed request file in the repo (EnvJoinRequestFile), approved after comparing six
 * key words: SHA-256(ENV_KEY_WORDS_DOMAIN ‖ lengthPrefixed(ed, x)), its first 66 bits read as six
 * 11-bit big-endian indices into the BIP-39 English list.
 */
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { cleanJoinName, JOIN_NONCE_BYTES, readJoinChallenge, revealMatchesCommit, type JoinChallenge, type JoinRequest, type JoinReveal } from '../vault/approval';
import { fromBase64Url, lengthPrefixed, toBase64Url, utf8Encode } from '../vault/bytes';
import { canonicalJson } from '../vault/canonical';
import { deviceIdFor, isUsableEd25519Key, isUsableSealingKey, KEY_BYTES, sha256Bytes, sign, verifySignature, type DeviceKeys } from '../vault/crypto';
import { isId } from '../vault/entry';
import { cleanEnvLabel, openEnvDataKey, type EnvNewMember } from './keys';
import { envJoinRequestSignedBytes } from './signing';
import { ENV_FORMAT, ENV_KEY_WORD_COUNT, ENV_REQUESTS_FOLDER, type EnvJoinRequestFile, type EnvMemberId, type EnvSetFile, type EnvSetId } from './types';

/** The env join's check-code domain (the vault's is "authdeck/check/v2"). */
export const ENV_CHECK_DOMAIN = 'authdeck/env-check/v1';
/** The key words' domain (the vault's three-word keyWords use "authdeck/keywords/v1"). */
export const ENV_KEY_WORDS_DOMAIN = 'authdeck/env-keywords/v1';
/** Bytes a request file may take: a few hundred in practice, so this only stops a planted giant. */
export const ENV_JOIN_REQUEST_MAX_BYTES = 4096;
const CODE_DIGITS = 6;
const BITS_PER_WORD = 11;
const WORD_MASK = 0x7ff;
const SIGNATURE_BYTES = 64;
const REQUEST_FIELDS = ['ed', 'form', 'format', 'label', 'member', 'set', 'sig', 'time', 'x'];

function key32(text: string, what: string): Uint8Array {
  const bytes = fromBase64Url(text, what);
  if (bytes.length !== KEY_BYTES) throw new Error(`${what} has the wrong length.`);
  return bytes;
}

function nonce16(text: string, what: string): Uint8Array {
  const bytes = fromBase64Url(text, what);
  if (bytes.length !== JOIN_NONCE_BYTES) throw new Error(`${what} has the wrong length.`);
  return bytes;
}

/**
 * The six digits both screens show in an own-device env join: vault/approval's checkCode
 * transcript (both devices' keys and names, the set id and name, both nonces, length-prefixed)
 * under ENV_CHECK_DOMAIN. Throws (plain Error) for malformed keys or nonces.
 */
export function envCheckCode(request: JoinRequest, challenge: JoinChallenge, newDeviceNonce: Uint8Array): string {
  if (newDeviceNonce.length !== JOIN_NONCE_BYTES) throw new Error("The new device's nonce has the wrong length.");
  // The transcript of vault/approval checkCode, field for field; only the domain differs.
  const transcript = lengthPrefixed(
    key32(request.ed, 'The signing key'),
    key32(request.x, 'The sealing key'),
    utf8Encode(request.name),
    key32(challenge.ed, 'The approver key'),
    key32(challenge.x, 'The approver sealing key'),
    utf8Encode(challenge.vault),
    utf8Encode(challenge.vaultName),
    utf8Encode(challenge.name),
    nonce16(challenge.nonce, 'The challenge'),
    newDeviceNonce,
  );
  const digest = sha256Bytes(utf8Encode(ENV_CHECK_DOMAIN), transcript);
  const value = ((digest[0]! << 24) >>> 0) + (digest[1]! << 16) + (digest[2]! << 8) + digest[3]!;
  return String(value % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
}

/** The new device's code: checks the challenge (vault/approval readJoinChallenge), then envCheckCode. */
export function envNewDeviceCheckCode(request: JoinRequest, nonce: Uint8Array, challenge: JoinChallenge): string {
  readJoinChallenge(challenge);
  return envCheckCode(request, challenge, nonce);
}

/** The owner's code. Throws when the reveal doesn't match the commitment: never show a code then. */
export function envApproverCheckCode(request: JoinRequest, challenge: JoinChallenge, reveal: JoinReveal): string {
  if (!revealMatchesCommit(request, reveal)) throw new Error('The new device revealed a different number than it committed to. Cancel and start again.');
  return envCheckCode(request, challenge, nonce16(reveal.nonce, 'The revealed nonce'));
}

/** The new device's verdict once the owner says it finished. */
export type EnvJoinedCheck = { status: 'ok'; dataKey: Uint8Array } | { status: 'not-yet' } | { status: 'intercepted'; reason: string };

/**
 * The new device's check of the set after an own-device join: the file is the set in the
 * challenge (id), signed by the device it compared codes with (the owner, whose ed and x match the
 * challenge), and lists this device with its own ed and x and a wrap that opens. `not-yet` when
 * the device isn't listed yet. Call on a file verifyEnvFile accepted.
 */
export function checkEnvJoined(file: EnvSetFile, device: DeviceKeys, challenge: JoinChallenge): EnvJoinedCheck {
  const { header } = file;
  if (header.set !== challenge.vault) return { status: 'intercepted', reason: 'the file is not the set the other device offered' };
  const member = header.members.find((candidate) => candidate.id === device.deviceId);
  if (!member) return { status: 'not-yet' };
  if (member.ed !== toBase64Url(device.edPublic) || member.x !== toBase64Url(device.xPublic)) {
    return { status: 'intercepted', reason: 'the set lists this device with keys it did not send' };
  }
  const owner = header.members.find((candidate) => candidate.role === 'owner')!;
  if (owner.ed !== challenge.ed || owner.x !== challenge.x || header.signer !== owner.id) {
    return { status: 'intercepted', reason: 'this device was added by a device other than the one it compared codes with' };
  }
  if (header.name !== challenge.vaultName) return { status: 'intercepted', reason: "the set's name is not the one the other device showed" };
  try {
    return { status: 'ok', dataKey: openEnvDataKey(header, device) };
  } catch {
    return { status: 'intercepted', reason: 'the key given to this device does not open the set' };
  }
}

/** The six words a teammate reads out: from their device's Ed25519 and sealing public keys (66 bits). */
export function envKeyWords(edPublic: Uint8Array, xPublic: Uint8Array): string[] {
  const digest = sha256Bytes(utf8Encode(ENV_KEY_WORDS_DOMAIN), lengthPrefixed(edPublic, xPublic));
  const words: string[] = [];
  for (let i = 0; i < ENV_KEY_WORD_COUNT; i++) {
    const bitOffset = i * BITS_PER_WORD;
    const byte = bitOffset >> 3;
    const window = (digest[byte]! << 16) | (digest[byte + 1]! << 8) | digest[byte + 2]!;
    words.push(english[(window >> (24 - BITS_PER_WORD - (bitOffset & 7))) & WORD_MASK]!);
  }
  return words;
}

/** Where a request file goes: `.authdeck/requests/<member id>.json`. */
export function envJoinRequestPath(member: EnvMemberId): string {
  if (!isId(member)) throw new Error('A member id is 16 bytes in base64url.');
  return `${ENV_REQUESTS_FOLDER}/${member}.json`;
}

/**
 * A teammate's device makes and signs its request (protocol answer `join-keys`). The label is
 * cleaned with cleanJoinName; throws (plain Error) when nothing is left of it.
 */
export function createEnvJoinRequest(input: { set: EnvSetId; device: DeviceKeys; label: string; form: 'phone' | 'tablet' | null; time: number }): EnvJoinRequestFile {
  if (!isId(input.set)) throw new Error('The set id is malformed.');
  const unsigned: Omit<EnvJoinRequestFile, 'sig'> = {
    format: ENV_FORMAT,
    set: input.set,
    member: input.device.deviceId,
    label: cleanEnvLabel(input.label),
    form: input.form,
    ed: toBase64Url(input.device.edPublic),
    x: toBase64Url(input.device.xPublic),
    time: input.time,
  };
  return { ...unsigned, sig: toBase64Url(sign(envJoinRequestSignedBytes(unsigned), input.device.edSecret)) };
}

/** The request file's text: canonical JSON (vault/canonical) and "\n". */
export function writeEnvJoinRequest(request: EnvJoinRequestFile): string {
  return `${canonicalJson(request)}\n`;
}

export type EnvJoinRequestRead =
  | { ok: true; request: EnvJoinRequestFile; member: EnvNewMember; keyWords: string[] }
  | { ok: false; reason: string };

/**
 * Parses and checks a request file from the repo: canonical JSON within a size cap, ENV_FORMAT
 * (newer is refused), the expected set id, `member` = deviceIdFor(ed), usable keys, a cleaned
 * non-empty label, a valid signature by `ed`, and, given `path`, that the file name is
 * envJoinRequestPath(member). `reason` is a short phrase for the owner's screen. Never throws.
 */
export function readEnvJoinRequest(text: string, expected: { set: EnvSetId; path?: string }): EnvJoinRequestRead {
  try {
    const request = joinRequestFrom(text, expected.set);
    if (expected.path !== undefined && expected.path !== envJoinRequestPath(request.member)) return { ok: false, reason: "the file's name doesn't match the device in it" };
    const edPublic = fromBase64Url(request.ed);
    const xPublic = fromBase64Url(request.x);
    return { ok: true, request, member: { edPublic, xPublic, label: request.label, form: request.form }, keyWords: envKeyWords(edPublic, xPublic) };
  } catch (err) {
    if (err instanceof JoinRequestRefused) return { ok: false, reason: err.message };
    throw err;
  }
}

class JoinRequestRefused extends Error {}

function refuseRequest(reason: string): never {
  throw new JoinRequestRefused(reason);
}

function requestKey(value: unknown, what: string, usable: (bytes: Uint8Array) => boolean): Uint8Array {
  let bytes: Uint8Array | null = null;
  try {
    if (typeof value === 'string') bytes = fromBase64Url(value);
  } catch {
    bytes = null;
  }
  if (!bytes || bytes.length !== KEY_BYTES || !usable(bytes)) refuseRequest(`its ${what} isn't a usable key`);
  return bytes;
}

/** The request in `text`, every field checked, or JoinRequestRefused with a short reason. */
function joinRequestFrom(text: string, set: EnvSetId): EnvJoinRequestFile {
  if (utf8Encode(text).length > ENV_JOIN_REQUEST_MAX_BYTES) refuseRequest('the file is too large');
  // Requests aren't covered by the eol=lf rule, so a Windows checkout may end lines in \r\n.
  const body = text.replace(/\s+$/, '');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    refuseRequest("the file isn't JSON");
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refuseRequest("the file isn't a join request");
  const fields = value as Record<string, unknown>;
  if (typeof fields.format === 'number' && fields.format > ENV_FORMAT) refuseRequest('it was made by a newer AuthDeck');
  if (Object.keys(fields).sort().join() !== REQUEST_FIELDS.join() || fields.format !== ENV_FORMAT) refuseRequest("the file isn't a join request");
  if (canonicalJson(value) !== body) refuseRequest("the file isn't written the way AuthDeck writes it");
  if (fields.set !== set) refuseRequest('it asks to join another set');
  const edPublic = requestKey(fields.ed, 'signing key', isUsableEd25519Key);
  requestKey(fields.x, 'sealing key', isUsableSealingKey);
  if (fields.member !== deviceIdFor(edPublic)) refuseRequest("its device id doesn't match its key");
  const { label, form, time, sig } = fields;
  if (typeof label !== 'string' || label === '' || cleanJoinName(label) !== label) refuseRequest('its name has characters that are not allowed');
  if (form !== 'phone' && form !== 'tablet' && form !== null) refuseRequest('its device kind is unknown');
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0) refuseRequest('its time is malformed');
  const request = value as EnvJoinRequestFile;
  let signature: Uint8Array | null = null;
  try {
    if (typeof sig === 'string') signature = fromBase64Url(sig);
  } catch {
    signature = null;
  }
  if (!signature || signature.length !== SIGNATURE_BYTES || !verifySignature(signature, envJoinRequestSignedBytes(request), edPublic)) {
    refuseRequest("it isn't signed by the device it names");
  }
  return request;
}
