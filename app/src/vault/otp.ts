/**
 * One-time code generation: HOTP (RFC 4226), TOTP (RFC 6238) and Steam Guard. Pure TypeScript so
 * the app can copy this folder as-is.
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { base32Decode } from './base32';

export type OtpType = 'totp' | 'hotp' | 'steam';
export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface OtpParams {
  type: OtpType;
  /** Base32, as shown to and typed by people. */
  secret: string;
  algorithm: OtpAlgorithm;
  /** Code length for TOTP and HOTP; Steam codes are always five characters. */
  digits: number;
  /** Seconds per TOTP step; Steam always uses 30. */
  period: number;
  /** Next HOTP counter value; unused by TOTP and Steam. */
  counter: number;
}

export const OTP_ALGORITHMS: readonly OtpAlgorithm[] = ['SHA1', 'SHA256', 'SHA512'];
export const MIN_DIGITS = 6;
export const MAX_DIGITS = 8;
export const DEFAULT_DIGITS = 6;
export const DEFAULT_PERIOD = 30;
export const STEAM_CODE_LENGTH = 5;
export const STEAM_PERIOD = 30;
/** RFC 4226 asks for at least 128 bits; 80 bits (16 base32 characters) is the shortest sites use. */
export const MIN_SECRET_BYTES = 10;
export const MAX_SECRET_BYTES = 128;
export const MAX_PERIOD = 24 * 60 * 60;
const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';
const MS_PER_SECOND = 1000;
const TWO_POW_32 = 0x1_0000_0000;

const HASHES = { SHA1: sha1, SHA256: sha256, SHA512: sha512 } as const;

function counterBytes(counter: number): Uint8Array {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('The counter must be a whole number of zero or more.');
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(counter / TWO_POW_32));
  view.setUint32(4, counter % TWO_POW_32);
  return bytes;
}

/** RFC 4226 dynamic truncation: a 31-bit number taken from the HMAC at the offset its last nibble names. */
function truncatedHmac(secret: Uint8Array, counter: number, algorithm: OtpAlgorithm): number {
  const mac = hmac(HASHES[algorithm], secret, counterBytes(counter));
  const offset = mac[mac.length - 1]! & 0x0f;
  return ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
}

function timeStep(timeMs: number, period: number): number {
  return Math.floor(timeMs / MS_PER_SECOND / period);
}

/** RFC 4226 HOTP code for `counter` (0 to 2^53-1), zero-padded to `digits`. */
export function hotp(secret: Uint8Array, counter: number, digits: number, algorithm: OtpAlgorithm): string {
  const code = truncatedHmac(secret, counter, algorithm) % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

/** RFC 6238 TOTP code at `timeMs` (Unix milliseconds). */
export function totp(
  secret: Uint8Array,
  timeMs: number,
  options: { period: number; digits: number; algorithm: OtpAlgorithm },
): string {
  return hotp(secret, timeStep(timeMs, options.period), options.digits, options.algorithm);
}

/** Steam Guard code: HMAC-SHA1 over 30-second steps, written as five characters of Steam's alphabet. */
export function steamGuard(secret: Uint8Array, timeMs: number): string {
  let value = truncatedHmac(secret, timeStep(timeMs, STEAM_PERIOD), 'SHA1');
  let code = '';
  for (let i = 0; i < STEAM_CODE_LENGTH; i++) {
    code += STEAM_ALPHABET[value % STEAM_ALPHABET.length]!;
    value = Math.floor(value / STEAM_ALPHABET.length);
  }
  return code;
}

/** The code `params` shows at `timeMs`. HOTP ignores the time and uses `params.counter`. */
export function generateCode(params: OtpParams, timeMs: number): string {
  const secret = base32Decode(params.secret);
  switch (params.type) {
    case 'totp':
      return totp(secret, timeMs, params);
    case 'hotp':
      return hotp(secret, params.counter, params.digits, params.algorithm);
    case 'steam':
      return steamGuard(secret, timeMs);
  }
}

/** Whole seconds until the current code of a `period`-second TOTP changes (1 to `period`). */
export function secondsRemaining(period: number, timeMs: number): number {
  return period - (Math.floor(timeMs / MS_PER_SECOND) % period);
}

/** Throws a message a person can act on when `params` cannot produce codes. */
export function validateOtpParams(params: OtpParams): void {
  if (!['totp', 'hotp', 'steam'].includes(params.type)) {
    throw new Error(`Unknown code type "${params.type}". Use TOTP, HOTP or Steam.`);
  }
  if (!OTP_ALGORITHMS.includes(params.algorithm)) {
    throw new Error(`The algorithm "${params.algorithm}" is not supported. Use SHA1, SHA256 or SHA512.`);
  }
  const secretBytes = base32Decode(params.secret).length;
  if (secretBytes === 0) throw new Error('The secret is empty. Copy the full setup key from the website.');
  if (secretBytes < MIN_SECRET_BYTES) throw new Error('The secret is too short to be safe. Copy the full setup key from the website; it is usually 16 or 32 characters.');
  if (secretBytes > MAX_SECRET_BYTES) throw new Error('The secret is longer than any site uses. Check that you copied only the setup key.');
  if (!Number.isSafeInteger(params.period) || params.period <= 0 || params.period > MAX_PERIOD) {
    throw new Error(`The period must be a whole number of seconds from 1 to ${MAX_PERIOD}, not ${String(params.period)}.`);
  }
  if (params.type === 'steam') return;
  if (!Number.isInteger(params.digits) || params.digits < MIN_DIGITS || params.digits > MAX_DIGITS) {
    throw new Error(`Codes must have ${MIN_DIGITS} to ${MAX_DIGITS} digits, not ${String(params.digits)}.`);
  }
  if (!Number.isSafeInteger(params.counter) || params.counter < 0) {
    throw new Error(`The counter must be a whole number of zero or more, not ${String(params.counter)}.`);
  }
}
