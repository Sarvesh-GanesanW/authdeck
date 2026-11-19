/**
 * RFC 4648 base32, the encoding authenticator secrets are shared in. Pure TypeScript so the app
 * can copy this folder as-is.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BITS_PER_CHAR = 5;

/**
 * Decodes base32 the way people type and paste it: any case, with spaces, dashes and trailing
 * `=` padding allowed. Throws on any other character.
 */
export function base32Decode(text: string, what = 'The secret'): Uint8Array {
  const cleaned = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  const out = new Uint8Array(Math.floor((cleaned.length * BITS_PER_CHAR) / 8));
  let value = 0;
  let bits = 0;
  let index = 0;
  for (const char of cleaned) {
    const digit = BASE32_ALPHABET.indexOf(char);
    if (digit < 0) {
      // The character is left out of the message because it is part of a secret.
      throw new Error(`${what} is not valid base32. Use only the letters A–Z and the digits 2–7.`);
    }
    value = ((value << BITS_PER_CHAR) | digit) & 0xffff;
    bits += BITS_PER_CHAR;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}

/** Upper-case base32 without padding, the form otpauth URIs carry. */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= BITS_PER_CHAR) {
      bits -= BITS_PER_CHAR;
      out += BASE32_ALPHABET[(value >> bits) & 31]!;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (BITS_PER_CHAR - bits)) & 31]!;
  return out;
}
