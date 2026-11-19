/**
 * Byte helpers for the vault core. Pure TypeScript with no Node or browser APIs, so the app can
 * copy this folder as-is (Hermes has no Buffer and no reliable TextDecoder).
 */

/** Fills a new array with secure random bytes. The app passes crypto.getRandomValues; tests pass a seeded stream. */
export type RandomBytes = (length: number) => Uint8Array;

/**
 * Takes `length` bytes from `random` as a fresh copy, so a source that reuses its buffer can't
 * change a key after the fact, and refuses a source that returns the wrong length.
 */
export function takeRandom(random: RandomBytes, length: number): Uint8Array {
  const bytes = Uint8Array.from(random(length));
  if (bytes.length !== length) throw new Error(`The random source returned ${bytes.length} bytes instead of ${length}.`);
  return bytes;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function decodeTable(alphabet: string): Int16Array {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
  return table;
}

const BASE64_TABLE = decodeTable(BASE64_ALPHABET);
const BASE64URL_TABLE = decodeTable(BASE64URL_ALPHABET);

function encode64(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + (pad ? '==' : '');
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + (pad ? '=' : '');
  }
  return out;
}

function decode64(text: string, table: Int16Array, what: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error(`${what} has an impossible length.`);
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const digit = code < 128 ? table[code]! : -1;
    if (digit < 0) throw new Error(`${what} contains a character that is not allowed.`);
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, so each byte string has exactly one encoding (signatures depend on it).
  if ((value & ((1 << bits) - 1)) !== 0) throw new Error(`${what} is not in canonical form.`);
  return out.subarray(0, index);
}

/** Unpadded base64url, the only byte encoding used inside log entries. */
export function toBase64Url(bytes: Uint8Array): string {
  return encode64(bytes, BASE64URL_ALPHABET, false);
}

/** Strict: unpadded base64url only, with zero trailing bits. */
export function fromBase64Url(text: string, what = 'The value'): Uint8Array {
  return decode64(text, BASE64URL_TABLE, what);
}

/** Standard base64 with padding, as Google Authenticator exports use. */
export function toBase64(bytes: Uint8Array): string {
  return encode64(bytes, BASE64_ALPHABET, true);
}

/** Accepts standard base64 with or without padding. Lenient about trailing bits, unlike fromBase64Url. */
export function fromBase64(text: string, what = 'The value'): Uint8Array {
  const trimmed = text.replace(/=+$/, '');
  if (trimmed.length % 4 === 1) throw new Error(`${what} has an impossible length.`);
  const out = new Uint8Array(Math.floor((trimmed.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    const digit = code < 128 ? BASE64_TABLE[code]! : -1;
    if (digit < 0) throw new Error(`${what} contains a character that is not allowed.`);
    value = ((value << 6) | digit) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}

/** UTF-8 encoding; lone surrogates become U+FFFD like TextEncoder. */
// The platform encoder when there is one: same bytes (lone surrogates become U+FFFD), far faster.
const nativeEncoder: { encode(text: string): Uint8Array } | null = typeof TextEncoder === 'function' ? new TextEncoder() : null;

export function utf8Encode(text: string): Uint8Array {
  if (nativeEncoder) return nativeEncoder.encode(text);
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else code = 0xfffd;
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

/** Strict UTF-8 decoding: throws on malformed or overlong sequences. */
export function utf8Decode(bytes: Uint8Array, what = 'The text'): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const first = bytes[i]!;
    let code: number;
    let extra: number;
    let min: number;
    if (first < 0x80) [code, extra, min] = [first, 0, 0];
    else if ((first & 0xe0) === 0xc0) [code, extra, min] = [first & 0x1f, 1, 0x80];
    else if ((first & 0xf0) === 0xe0) [code, extra, min] = [first & 0x0f, 2, 0x800];
    else if ((first & 0xf8) === 0xf0) [code, extra, min] = [first & 0x07, 3, 0x10000];
    else throw new Error(`${what} is not valid UTF-8.`);
    for (let k = 1; k <= extra; k++) {
      const next = bytes[i + k];
      if (next === undefined || (next & 0xc0) !== 0x80) throw new Error(`${what} is not valid UTF-8.`);
      code = (code << 6) | (next & 63);
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error(`${what} is not valid UTF-8.`);
    out += String.fromCodePoint(code);
    i += extra + 1;
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Each part prefixed by its length (4 bytes, big-endian), so no two lists of parts encode the same. */
export function lengthPrefixed(...parts: Uint8Array[]): Uint8Array {
  const framed: Uint8Array[] = [];
  for (const part of parts) {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, part.length);
    framed.push(length, part);
  }
  return concatBytes(...framed);
}

/** Constant-time comparison for equal-length secrets. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
