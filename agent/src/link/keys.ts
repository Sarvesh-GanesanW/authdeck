import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { fromBase64Url, takeRandom, toBase64Url, utf8Encode, type RandomBytes } from '../vault/bytes';

export const LINK_KEY_BYTES = 32;
const FINGERPRINT_BYTES = 16;

/** A static X25519 key pair: one per computer, one per app install. */
export interface LinkKeyPair {
  secret: Uint8Array;
  public: Uint8Array;
}

export function linkKeyFromSecret(secret: Uint8Array): LinkKeyPair {
  if (secret.length !== LINK_KEY_BYTES) throw new Error(`A link key is ${LINK_KEY_BYTES} bytes, not ${secret.length}.`);
  return { secret, public: x25519.getPublicKey(secret) };
}

export function generateLinkKey(random: RandomBytes): LinkKeyPair {
  return linkKeyFromSecret(takeRandom(random, LINK_KEY_BYTES));
}

/** Strict decoding of a base64url public key from a QR code, a store or a config file. */
export function parseLinkPublicKey(text: string): Uint8Array {
  const bytes = fromBase64Url(text, 'The link key');
  if (bytes.length !== LINK_KEY_BYTES) throw new Error(`The link key is ${bytes.length} bytes instead of ${LINK_KEY_BYTES}.`);
  return bytes;
}

/** First 16 bytes of SHA-256(public key), base64url. Shown in discovery; reveals nothing secret. */
export function linkFingerprint(publicKey: Uint8Array): string {
  return toBase64Url(sha256(publicKey).subarray(0, FINGERPRINT_BYTES));
}

/** Six BIP-39 words of 11 bits each: 66 bits, beyond reach of grinding a look-alike key. */
export const LINK_KEY_WORD_COUNT = 6;
const BITS_PER_WORD = 11;
// The same domain the earlier three words used, so a computer's first three words don't change.
const KEY_WORDS_DOMAIN = utf8Encode('authdeck/keywords/v1');

/**
 * Six words for a person to compare between the computer's screen and the app. A check for the
 * careful: pairing itself is authenticated by the QR code or the PIN, not by these words.
 */
export function linkKeyWords(publicKey: Uint8Array): string[] {
  const digest = sha256(new Uint8Array([...KEY_WORDS_DOMAIN, ...publicKey]));
  const words: string[] = [];
  for (let i = 0; i < LINK_KEY_WORD_COUNT; i++) {
    const bitOffset = i * BITS_PER_WORD;
    const byte = bitOffset >> 3;
    const window = (digest[byte]! << 16) | (digest[byte + 1]! << 8) | digest[byte + 2]!;
    words.push(english[(window >> (24 - BITS_PER_WORD - (bitOffset & 7))) & 0x7ff]!);
  }
  return words;
}
