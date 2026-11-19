import { gcm } from '@noble/ciphers/aes.js';
import { eddsa } from '@noble/curves/abstract/edwards.js';
import { ed25519, ristretto255 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { canonicalJson, type JsonValue } from './canonical';
import { bytesEqual, concatBytes, fromBase64Url, takeRandom, toBase64Url, utf8Encode, type RandomBytes } from './bytes';

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const COMMIT_BYTES = 32;
const ID_BYTES = 16;
const SEAL_INFO = 'authdeck/seal/v3';
const SEAL_EPHEMERAL_INFO = 'authdeck/seal-ephemeral/v3';
const SEAL_SCALAR_INFO = 'authdeck/seal-scalar/v3';
/** Bytes reduced to a scalar: 64, so the result is uniform modulo the group order. */
const WIDE_SCALAR_BYTES = 64;
const GCM_TAG_BYTES = 16;
const SUBKEY_INFO = 'authdeck/subkey/v2/';
const KEYCHECK_PURPOSE = 'keycheck';
const KEYWORDS_DOMAIN = utf8Encode('authdeck/keywords/v1');
const KEYWORD_COUNT = 3;
const BITS_PER_WORD = 11;
/** The group sealing keys live in: ristretto255 (prime order, so no cofactor cases). */
export const SealPoint = ristretto255.Point;
export type SealPoint = InstanceType<typeof SealPoint>;

/** A device's (or the recovery identity's) key pairs. Secrets stay on the device. */
export interface DeviceKeys {
  /** Ed25519 seed (32 bytes). */
  edSecret: Uint8Array;
  edPublic: Uint8Array;
  /** Sealing secret (32 bytes); its ristretto255 scalar comes from sealScalar. */
  xSecret: Uint8Array;
  /** Sealing public key: a ristretto255 point (32 bytes). */
  xPublic: Uint8Array;
  deviceId: string;
}

/**
 * A key encrypted to one sealing public key. All fields base64url. Every byte is derived from the
 * key, the recipient and the context (sealKey), so anyone holding the key can rebuild it exactly.
 */
export interface SealedKey {
  /** Ephemeral ristretto255 public key E = e·G, e derived from the sealed key. */
  e: string;
  /** The recipient's sealing public key R the key was sealed to. */
  r: string;
  ct: string;
}

/**
 * Data encrypted with a vault epoch key. `c` commits to the key and the context, so a box opens
 * under exactly one key (AES-GCM alone does not promise that).
 */
export interface Box {
  epoch: number;
  n: string;
  ct: string;
  c: string;
}

/**
 * SHA-256 and SHA-512 over large inputs (every log line is hashed, and every signature check
 * hashes its line again). Under Node (the agent) the built-in hashes are used, which are many
 * times faster; elsewhere (the app) the pure-JS ones. Both give the same bytes, so the choice can
 * never change what a replay decides.
 */
type Digest = (message: Uint8Array) => Uint8Array;
const hashes: { sha256: Digest; sha512: Digest } = nativeHashes() ?? { sha256: (m) => sha256(m), sha512: (m) => sha512(m) };

function nativeHashes(): { sha256: Digest; sha512: Digest } | null {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const node = proc?.getBuiltinModule?.('node:crypto') as { createHash(algorithm: string): { update(data: Uint8Array): { digest(): Uint8Array } } } | undefined;
    if (!node?.createHash) return null;
    const digest = (algorithm: string): Digest => (m) => new Uint8Array(node.createHash(algorithm).update(m).digest());
    return { sha256: digest('sha256'), sha512: digest('sha512') };
  } catch {
    return null;
  }
}

/** Ed25519 verification with the hash above; the curve and its checks are noble's, unchanged. */
const verifier = eddsa(ed25519.Point, Object.assign((m: Uint8Array) => hashes.sha512(m), { outputLen: 64, blockLen: 128 }));

export function sha256Bytes(...parts: Uint8Array[]): Uint8Array {
  return hashes.sha256(concatBytes(...parts));
}

/** First 16 bytes of SHA-256(ed25519 public key), base64url. */
export function deviceIdFor(edPublic: Uint8Array): string {
  return toBase64Url(sha256(edPublic).subarray(0, ID_BYTES));
}

/** Three BIP-39 words people compare by eye. Not used for any security decision. */
export function keyWords(edPublic: Uint8Array): string[] {
  const digest = sha256Bytes(KEYWORDS_DOMAIN, edPublic);
  const words: string[] = [];
  for (let i = 0; i < KEYWORD_COUNT; i++) {
    const bitOffset = i * BITS_PER_WORD;
    const byte = bitOffset >> 3;
    const window = (digest[byte]! << 16) | (digest[byte + 1]! << 8) | digest[byte + 2]!;
    const index = (window >> (24 - BITS_PER_WORD - (bitOffset & 7))) & 0x7ff;
    words.push(english[index]!);
  }
  return words;
}

/** A nonzero scalar from `bytes` under `info`: HKDF to 64 bytes, reduced modulo the group order. */
function scalarFrom(bytes: Uint8Array, salt: Uint8Array | undefined, info: Uint8Array): bigint {
  const scalar = SealPoint.Fn.create(bytesToNumberLE(hkdf(sha256, bytes, salt, info, WIDE_SCALAR_BYTES)));
  // Probability 2^-252: only a broken hash gets here.
  if (scalar === 0n) throw new Error('The sealing scalar came out as zero.');
  return scalar;
}

/** The ristretto255 scalar of a sealing secret. */
export function sealScalar(xSecret: Uint8Array): bigint {
  return scalarFrom(xSecret, undefined, utf8Encode(SEAL_SCALAR_INFO));
}

export function keysFromSecrets(edSecret: Uint8Array, xSecret: Uint8Array): DeviceKeys {
  const edPublic = ed25519.getPublicKey(edSecret);
  const xPublic = SealPoint.BASE.multiply(sealScalar(xSecret)).toBytes();
  return { edSecret, edPublic, xSecret, xPublic, deviceId: deviceIdFor(edPublic) };
}

/** Makes a new device identity from secure random bytes. */
export function generateDeviceKeys(random: RandomBytes): DeviceKeys {
  return keysFromSecrets(takeRandom(random, KEY_BYTES), takeRandom(random, KEY_BYTES));
}

/** The ristretto255 point a canonical encoding names, or null for any other bytes. */
export function decodeSealPoint(bytes: Uint8Array): SealPoint | null {
  if (bytes.length !== KEY_BYTES) return null;
  try {
    return SealPoint.fromBytes(bytes);
  } catch {
    return null;
  }
}

/**
 * True for a canonical ristretto255 encoding of a point other than the identity. The identity
 * makes every shared secret the same, so a key sealed to it is readable by anyone.
 */
export function isUsableSealingKey(bytes: Uint8Array): boolean {
  const point = decodeSealPoint(bytes);
  return point !== null && !point.is0();
}

/** True for a canonical Ed25519 public key in the prime-order subgroup. */
export function isUsableEd25519Key(bytes: Uint8Array): boolean {
  if (bytes.length !== KEY_BYTES) return false;
  try {
    const point = ed25519.Point.fromBytes(bytes, false);
    return !point.isSmallOrder() && point.isTorsionFree();
  } catch {
    return false;
  }
}

export function sign(message: Uint8Array, edSecret: Uint8Array): Uint8Array {
  return ed25519.sign(message, edSecret);
}

/** Strict RFC 8032 verification (no ZIP-215 leniency), so a signature has one valid encoding. */
export function verifySignature(signature: Uint8Array, message: Uint8Array, edPublic: Uint8Array): boolean {
  try {
    return verifier.verify(signature, message, edPublic, { zip215: false });
  } catch {
    return false;
  }
}

/** A signature check bound to one public key: (signature, message) -> valid. */
export type SignatureCheck = (signature: Uint8Array, message: Uint8Array) => boolean;

const ED_SIGNATURE_BYTES = 64;
/** Precomputed multiples of a key: checks about 2.5x faster, for roughly 60 KB per key kept. */
const KEY_PRECOMPUTE_WINDOW = 4;

/**
 * verifySignature for many messages under one key. The key is decoded, refused if small-order,
 * and its multiples precomputed once; each check then does exactly what noble's strict verify
 * does (RFC 8032 decoding with no ZIP-215 leniency, s below the group order, the cofactored
 * equation), so it accepts exactly the signatures verifySignature accepts. A replay checks every
 * line of a log under one key, so this keeps a cold replay of a full vault within budget.
 */
export function signatureCheckFor(edPublic: Uint8Array): SignatureCheck {
  const key = Uint8Array.from(edPublic);
  let point: ReturnType<typeof ed25519.Point.fromBytes>;
  try {
    if (key.length !== KEY_BYTES) return () => false;
    point = ed25519.Point.fromBytes(key, false);
  } catch {
    return () => false;
  }
  if (point.isSmallOrder()) return () => false;
  point.precompute(KEY_PRECOMPUTE_WINDOW, false);
  const { Point } = ed25519;
  return (signature, message) => {
    if (signature.length !== ED_SIGNATURE_BYTES) return false;
    try {
      const r = signature.subarray(0, KEY_BYTES);
      const R = Point.fromBytes(r, false);
      const SB = Point.BASE.multiplyUnsafe(bytesToNumberLE(signature.subarray(KEY_BYTES)));
      const k = Point.Fn.create(bytesToNumberLE(hashes.sha512(concatBytes(r, key, message))));
      return R.add(point.multiplyUnsafe(k)).subtract(SB).clearCofactor().is0();
    } catch {
      return false;
    }
  };
}

function aad(context: JsonValue): Uint8Array {
  return utf8Encode(canonicalJson(context));
}

/** A key for one purpose only, derived from an epoch key, so no key is used for two things. */
function subkey(key: Uint8Array, purpose: string): Uint8Array {
  return hkdf(sha256, key, undefined, utf8Encode(`${SUBKEY_INFO}${purpose}`), KEY_BYTES);
}

/**
 * The published commitment to an epoch key: HMAC under a key-check subkey over the vault and the
 * epoch. Every device refuses an epoch key that doesn't match it, so an admin can't hand two
 * devices different keys for the same epoch.
 */
export function keyCheck(key: Uint8Array, vault: string, epoch: number): string {
  return toBase64Url(hmac(sha256, subkey(key, KEYCHECK_PURPOSE), aad({ kind: 'keycheck', vault, epoch })));
}

export function keyMatchesCheck(key: Uint8Array, vault: string, epoch: number, check: string): boolean {
  return bytesEqual(utf8Encode(keyCheck(key, vault, epoch)), utf8Encode(check));
}

/** What a sealed key is bound to, so it can't be moved to another vault, epoch or recipient. */
export interface SealContext {
  vault: string;
  epoch: number;
  to: string;
}

function sealAad(context: SealContext): Uint8Array {
  return aad({ kind: 'seal', vault: context.vault, epoch: context.epoch, to: context.to });
}

/** The seal's AES-GCM key and nonce, both from the shared point and everything the seal names. */
function sealCipher(shared: Uint8Array, ephemeralPublic: Uint8Array, recipientPublic: Uint8Array, context: SealContext): { key: Uint8Array; nonce: Uint8Array } {
  const okm = hkdf(sha256, shared, concatBytes(ephemeralPublic, recipientPublic), concatBytes(utf8Encode(SEAL_INFO), sealAad(context)), KEY_BYTES + NONCE_BYTES);
  return { key: okm.subarray(0, KEY_BYTES), nonce: okm.subarray(KEY_BYTES) };
}

/**
 * The seal's ephemeral scalar: derived from the sealed key, the recipient's public key and the
 * context, so the whole seal is a function of them. A device holding the key rebuilds every seal
 * of it and sees one that differs; nobody without the key learns anything from E.
 */
function ephemeralScalar(key: Uint8Array, recipientPublic: Uint8Array, context: SealContext): bigint {
  return scalarFrom(key, recipientPublic, concatBytes(utf8Encode(SEAL_EPHEMERAL_INFO), sealAad(context)));
}

/**
 * Encrypts `key` so only the holder of `recipient`'s sealing secret can read it. Deterministic:
 * the same key, recipient and context always give the same bytes. Throws for an unusable recipient key.
 */
export function sealKey(key: Uint8Array, recipient: Uint8Array, context: SealContext): SealedKey {
  const recipientPoint = decodeSealPoint(recipient);
  if (!recipientPoint || recipientPoint.is0()) throw new Error('The recipient\'s sealing key is not a usable ristretto255 key.');
  const ephemeral = ephemeralScalar(key, recipient, context);
  const ephemeralPublic = SealPoint.BASE.multiply(ephemeral).toBytes();
  const shared = recipientPoint.multiply(ephemeral).toBytes();
  const cipher = sealCipher(shared, ephemeralPublic, recipient, context);
  const ct = gcm(cipher.key, cipher.nonce, sealAad(context)).encrypt(key);
  return { e: toBase64Url(ephemeralPublic), r: toBase64Url(recipient), ct: toBase64Url(ct) };
}

/** True when two seals are the same bytes. */
export function sealsEqual(a: SealedKey, b: SealedKey): boolean {
  return a.e === b.e && a.r === b.r && a.ct === b.ct;
}

/** The ECDH point s·E of a seal for the holder of sealing secret `xSecret`, encoded. Throws for a malformed E. */
export function sealSharedPoint(sealed: SealedKey, xSecret: Uint8Array): Uint8Array {
  const ephemeral = decodeSealPoint(fromBase64Url(sealed.e));
  if (!ephemeral) throw new Error('The seal\'s ephemeral key is not a ristretto255 point.');
  return ephemeral.multiply(sealScalar(xSecret)).toBytes();
}

/**
 * Opens a seal given its shared point. Anyone may do this with a shared point proven by the
 * recipient (sealProof.ts), which is how a bad seal is shown to everyone. Throws when it doesn't open.
 */
export function openSealWithShared(sealed: SealedKey, shared: Uint8Array, context: SealContext): Uint8Array {
  try {
    const cipher = sealCipher(shared, fromBase64Url(sealed.e), fromBase64Url(sealed.r), context);
    const key = gcm(cipher.key, cipher.nonce, sealAad(context)).decrypt(fromBase64Url(sealed.ct));
    if (key.length !== KEY_BYTES) throw new Error('wrong length');
    return key;
  } catch (err) {
    throw new Error('This sealed key does not open with that shared secret.', { cause: err });
  }
}

/** Opens a sealed key with the recipient's sealing secret. Throws when it was not sealed to it in this context. */
export function openSealedKey(sealed: SealedKey, recipient: Pick<DeviceKeys, 'xSecret' | 'xPublic'>, context: SealContext): Uint8Array {
  try {
    if (sealed.r !== toBase64Url(recipient.xPublic)) throw new Error('sealed to another key');
    return openSealWithShared(sealed, sealSharedPoint(sealed, recipient.xSecret), context);
  } catch (err) {
    throw new Error('This vault key was not sealed to this device, or it was changed.', { cause: err });
  }
}

/** Bytes of a sealed key's ciphertext: the key and the GCM tag. */
export const SEALED_CT_BYTES = KEY_BYTES + GCM_TAG_BYTES;

/**
 * The AAD of a box names the vault, the epoch and what the box is (an account, a device name…),
 * so a box copied from another vault or another field fails to open. Each kind of box has its
 * own encryption and commitment subkeys.
 */
export type BoxContext = { vault: string; epoch: number; kind: string } & Record<string, string | number>;

function boxCommitment(key: Uint8Array, nonce: Uint8Array, context: BoxContext): Uint8Array {
  return hmac(sha256, subkey(key, `commit/${context.kind}`), concatBytes(nonce, aad(context)));
}

export function encryptBox(key: Uint8Array, plaintext: Uint8Array, context: BoxContext, random: RandomBytes): Box {
  const nonce = takeRandom(random, NONCE_BYTES);
  const ct = gcm(subkey(key, `box/${context.kind}`), nonce, aad(context)).encrypt(plaintext);
  return { epoch: context.epoch, n: toBase64Url(nonce), ct: toBase64Url(ct), c: toBase64Url(boxCommitment(key, nonce, context)) };
}

export function decryptBox(key: Uint8Array, box: Box, context: BoxContext): Uint8Array {
  if (box.epoch !== context.epoch) throw new Error('The box is under a different key epoch.');
  try {
    const nonce = fromBase64Url(box.n);
    if (!bytesEqual(boxCommitment(key, nonce, context), fromBase64Url(box.c))) throw new Error('the commitment does not match');
    return gcm(subkey(key, `box/${context.kind}`), nonce, aad(context)).decrypt(fromBase64Url(box.ct));
  } catch (err) {
    throw new Error('Could not decrypt: wrong key, or the data was changed.', { cause: err });
  }
}
