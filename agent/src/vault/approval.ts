/**
 * Check-code (SAS) approval of a new device. The new device N commits to its keys and nonce
 * before it sees A's, so a relay in the middle can't grind keys until the codes match, and the
 * code covers every key and name either side acts on, so a relay that changes any of them
 * (N's sealing key included) shows a different code on each screen.
 *
 *   N → A  request   { ed_N, x_N, name_N, commit = H("authdeck/commit/v2" ‖ ed_N ‖ x_N ‖ name_N ‖ nonce_N) }
 *   A → N  challenge { ed_A, x_A, vault, vaultName, name_A, nonce_A }
 *   N → A  reveal    { nonce_N }        A checks it against commit
 *   both   code = H("authdeck/check/v2" ‖ ed_N ‖ x_N ‖ name_N ‖ ed_A ‖ x_A ‖ vault ‖ vaultName ‖ name_A ‖ nonce_A ‖ nonce_N)
 *
 * Every part is length-prefixed. A then writes `device.add` from the exact request it checked,
 * and N refuses the result unless the vault shows its own keys, added by A, with a key that opens.
 */
import { bytesEqual, fromBase64Url, lengthPrefixed, takeRandom, toBase64Url, utf8Encode, type RandomBytes } from './bytes';
import { deviceIdFor, isUsableEd25519Key, isUsableSealingKey, sha256Bytes, type DeviceKeys } from './crypto';
import type { DevicePublicKeys } from './build';
import { isId } from './entry';
import { openVault } from './open';
import type { VaultState } from './replay';

export const JOIN_NONCE_BYTES = 16;
const COMMIT_DOMAIN = utf8Encode('authdeck/commit/v2');
const CHECK_DOMAIN = utf8Encode('authdeck/check/v2');
const CODE_DIGITS = 6;
const COMMIT_BYTES = 32;
/** Characters of a name shown on the other device during a join. */
export const MAX_JOIN_NAME_LENGTH = 64;
/**
 * Characters a name must not hold, dropped: controls (Cc), format characters (Cf,
 * which include the bidi controls), the object replacement character, the blank-looking letters
 * (U+2800, U+3164, U+115F, U+1160, U+FFA0) and the default-ignorable code points, so two names
 * that look alike are the same text. Written as ranges: not every JavaScript engine the app runs
 * on has Unicode property escapes.
 */
const UNSAFE_NAME_CHARS = new RegExp(
  '[' +
    [
      '\\u0000-\\u001f\\u007f-\\u009f', // Cc
      '\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u3164\\ufe00-\\ufe0f\\uffa0\\ufff0-\\ufff8\\ufffc\\u2800', // ignorables and blanks
      '\\u0600-\\u0605\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb', // Cf
      '\\u{110bd}\\u{110cd}\\u{13430}-\\u{1343f}\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e0fff}', // Cf and ignorables beyond the BMP
    ].join('') +
    ']',
  'gu',
);

/** What N sends first. Every byte field is base64url. */
export interface JoinRequest {
  ed: string;
  x: string;
  name: string;
  commit: string;
}

/** What A answers with: its keys, the vault it offers and the names N will show. */
export interface JoinChallenge {
  ed: string;
  x: string;
  vault: string;
  vaultName: string;
  name: string;
  nonce: string;
}

export interface JoinReveal {
  nonce: string;
}

/**
 * Names travel in plain text during a join, because no key exists yet, and are covered by the
 * code. Both devices clean them the same way before sending: controls removed, whitespace
 * collapsed, capped by characters. A relay that changes a name changes the code.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanJoinName(value: string): string {
  // A lone surrogate encodes as U+FFFD, so two different names could give one code: drop them.
  // Whitespace first (tabs and line breaks become spaces), then invisible characters go entirely.
  const cleaned = value.replace(LONE_SURROGATE, '').replace(/\s+/g, ' ').replace(UNSAFE_NAME_CHARS, '').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, MAX_JOIN_NAME_LENGTH).join('').trim();
}

/** The vault name as a join shows it; both sides derive it the same way. */
function joinVaultName(name: string): string {
  return cleanJoinName(name) || 'Vault';
}

function key32(text: string, what: string): Uint8Array {
  const bytes = fromBase64Url(text, what);
  if (bytes.length !== 32) throw new Error(`${what} has the wrong length.`);
  return bytes;
}

function nonce16(text: string, what: string): Uint8Array {
  const bytes = fromBase64Url(text, what);
  if (bytes.length !== JOIN_NONCE_BYTES) throw new Error(`${what} has the wrong length.`);
  return bytes;
}

function cleanName(value: string, what: string): string {
  if (typeof value !== 'string' || cleanJoinName(value) !== value || value === '') throw new Error(`${what} is missing or not cleaned.`);
  return value;
}

function commitment(edN: Uint8Array, xN: Uint8Array, name: string, nonce: Uint8Array): Uint8Array {
  return sha256Bytes(COMMIT_DOMAIN, lengthPrefixed(edN, xN, utf8Encode(name), nonce));
}

/** N's side: the request to send and the nonce to keep until A's challenge arrives. */
export function createJoinRequest(device: DeviceKeys, name: string, random: RandomBytes): { request: JoinRequest; nonce: Uint8Array } {
  const nonce = takeRandom(random, JOIN_NONCE_BYTES);
  const cleaned = cleanJoinName(name) || 'New device';
  return {
    request: { ed: toBase64Url(device.edPublic), x: toBase64Url(device.xPublic), name: cleaned, commit: toBase64Url(commitment(device.edPublic, device.xPublic, cleaned, nonce)) },
    nonce,
  };
}

/** A's side: checks a request's shape and keys and returns the new device's public keys. */
export function readJoinRequest(request: JoinRequest): DevicePublicKeys {
  const edPublic = key32(request.ed, 'The signing key');
  const xPublic = key32(request.x, 'The sealing key');
  if (!isUsableEd25519Key(edPublic) || !isUsableSealingKey(xPublic)) throw new Error('The new device sent keys that can\'t be used.');
  cleanName(request.name, 'The device name');
  if (fromBase64Url(request.commit, 'The commitment').length !== COMMIT_BYTES) throw new Error('The commitment has the wrong length.');
  return { edPublic, xPublic, deviceId: deviceIdFor(edPublic) };
}

/** N's side: checks a challenge's shape and keys. */
export function readJoinChallenge(challenge: JoinChallenge): { approverId: string } {
  const ed = key32(challenge.ed, 'The approver key');
  const x = key32(challenge.x, 'The approver sealing key');
  if (!isUsableEd25519Key(ed) || !isUsableSealingKey(x)) throw new Error('The other device sent keys that can\'t be used.');
  if (!isId(challenge.vault)) throw new Error('The vault id is malformed.');
  cleanName(challenge.vaultName, 'The vault name');
  cleanName(challenge.name, 'The approver name');
  nonce16(challenge.nonce, 'The challenge');
  return { approverId: deviceIdFor(ed) };
}

/** A's side: answers a request with its keys, the vault and a fresh nonce. Only after the commitment arrived. */
export function createJoinChallenge(
  approver: DeviceKeys,
  offer: { vaultId: string; vaultName: string; deviceName: string },
  random: RandomBytes,
): { challenge: JoinChallenge; nonce: Uint8Array } {
  const nonce = takeRandom(random, JOIN_NONCE_BYTES);
  return {
    challenge: {
      ed: toBase64Url(approver.edPublic),
      x: toBase64Url(approver.xPublic),
      vault: offer.vaultId,
      vaultName: joinVaultName(offer.vaultName),
      name: cleanJoinName(offer.deviceName) || 'Device',
      nonce: toBase64Url(nonce),
    },
    nonce,
  };
}

/** N's side: only reveal after the challenge arrived. */
export function createJoinReveal(nonce: Uint8Array): JoinReveal {
  return { nonce: toBase64Url(nonce) };
}

/** A's side: true when the revealed nonce, with the request's keys and name, is what N committed to. */
export function revealMatchesCommit(request: JoinRequest, reveal: JoinReveal): boolean {
  try {
    const expected = commitment(key32(request.ed, 'The signing key'), key32(request.x, 'The sealing key'), request.name, nonce16(reveal.nonce, 'The revealed nonce'));
    return bytesEqual(expected, fromBase64Url(request.commit));
  } catch {
    return false;
  }
}

/** The six digits both screens show. Six digits from the first 32 bits; the modulo bias is below 2^-12. */
export function checkCode(request: JoinRequest, challenge: JoinChallenge, newDeviceNonce: Uint8Array): string {
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
  const digest = sha256Bytes(CHECK_DOMAIN, transcript);
  const value = ((digest[0]! << 24) >>> 0) + (digest[1]! << 16) + (digest[2]! << 8) + digest[3]!;
  return String(value % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
}

/** N's code, from the request it sent, the nonce it kept and the challenge it received. */
export function newDeviceCheckCode(request: JoinRequest, nonce: Uint8Array, challenge: JoinChallenge): string {
  readJoinChallenge(challenge);
  return checkCode(request, challenge, nonce);
}

/** A's code. Throws when the reveal doesn't match the commitment: never show a code then. */
export function approverCheckCode(request: JoinRequest, challenge: JoinChallenge, reveal: JoinReveal): string {
  if (!revealMatchesCommit(request, reveal)) throw new Error('The new device revealed a different number than it committed to. Cancel and start again.');
  return checkCode(request, challenge, nonce16(reveal.nonce, 'The revealed nonce'));
}

/** N's verdict on the vault after A said it finished. */
/** `approval` on ok: the hash of the approval checked, for the hello to name. */
export type JoinedVaultCheck = { status: 'ok'; approval: string } | { status: 'not-yet' } | { status: 'intercepted'; reason: string };

/**
 * N's side, after A finished: the vault must be the one in the challenge, hold N with its own
 * signing and sealing keys, added by the device it compared codes with (whose keys match the
 * challenge too), with a key that opens and matches the vault's key check. Anything else means
 * someone between the devices changed the join. `not-yet` means the approval isn't in the folder.
 */
export function checkJoinedVault(state: VaultState, device: DeviceKeys, challenge: JoinChallenge): JoinedVaultCheck {
  if (state.vaultId !== challenge.vault) return { status: 'intercepted', reason: 'the folder is not the vault the other device offered' };
  const member = Object.hasOwn(state.members, device.deviceId) ? state.members[device.deviceId] : undefined;
  if (!member) return { status: 'not-yet' };
  if (member.removed) return { status: 'intercepted', reason: 'the vault lists this device as removed; it must make new keys and ask again' };
  // Any applied approval by the device it compared codes with, carrying this device's own keys,
  // will do: another admin's approval with other keys can't hold the join up (S3).
  const approverId = deviceIdFor(key32(challenge.ed, 'The approver key'));
  const approver = Object.hasOwn(state.members, approverId) ? state.members[approverId] : undefined;
  const ed = toBase64Url(device.edPublic);
  const x = toBase64Url(device.xPublic);
  // Only approvals by the device it compared codes with, carrying this device's own keys; each is
  // checked on its own key (newest first), and the hello then names the one that holds.
  const mine = (member.approvals ?? []).filter((a) => a.by === approverId && a.ed === ed && a.x === x).reverse();
  if (mine.length === 0 || approver?.x !== challenge.x) {
    const ours = (member.approvals ?? []).some((a) => a.ed === ed && a.x === x);
    return { status: 'intercepted', reason: ours ? 'this device was added by a device other than the one it compared codes with' : 'the vault lists this device with keys it did not send' };
  }
  let problem = 'the key given to this device does not open the vault';
  for (const approval of mine) {
    let name: string | null;
    try {
      const sealed = { ...state.sealedKeys, [approval.epoch]: { ...state.sealedKeys[approval.epoch], [device.deviceId]: approval.key } };
      const only = { ...member, x, ed, role: approval.role, addedBy: approverId, approvals: [approval] };
      const opened = openVault({ ...state, sealedKeys: sealed, members: { ...state.members, [device.deviceId]: only } }, device);
      // Only a key that opens the vault's current epoch counts; an older one would leave it read-only.
      if (opened.readOnly !== null) continue;
      name = opened.name;
    } catch {
      continue;
    }
    if (name === null || joinVaultName(name) !== challenge.vaultName) {
      problem = 'the vault\'s name is not the one the other device showed';
      continue;
    }
    return { status: 'ok', approval: approval.hash };
  }
  return { status: 'intercepted', reason: problem };
}
