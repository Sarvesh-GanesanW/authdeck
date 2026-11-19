/**
 * The size check for an app icon a computer sends, run before the icon is stored or drawn. The
 * native image decoder allocates width x height x 4 bytes before it draws anything, so a small
 * file that declares a huge canvas (a "PNG bomb") would close the app on every launch. The chunks
 * are walked too, so the decoder sees only the chunks a still image needs, and one IHDR.
 */

/** The agent renders icons at 128 px; anything over this is not an app icon. */
export const MAX_ICON_SIDE_PX = 256;
export const MAX_ICON_BYTES = 256 * 1024;
/** MAX_ICON_BYTES as base64 characters. */
export const MAX_ICON_BASE64_CHARS = 4 * Math.ceil(MAX_ICON_BYTES / 3);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_LENGTH = 13;
/** Signature (8), IHDR length (4), "IHDR" (4), width (4), height (4). */
const HEADER_BYTES = 24;
/** Length (4), type (4), then the data, then the CRC (4). */
const CHUNK_OVERHEAD = 12;
/**
 * The most chunks an icon may have. The agent sends at most seven (it joins IDAT into one); an
 * older agent's macOS icons split IDAT every 16 KB, so 17 at 256 KB. Thousands of empty chunks
 * would only make the native decoder work.
 */
export const MAX_ICON_CHUNKS = 64;
/**
 * The only chunks an icon may hold: the ones the agent keeps when it cleans an icon (KEPT_CHUNKS in
 * agent/src/icons/png.ts). Anything else (colour profiles, text, Exif, animation) makes the native
 * decoders run more code than a still image needs.
 */
const ALLOWED_CHUNKS: ReadonlySet<string> = new Set(['IHDR', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'IDAT', 'IEND']);
const HEADER_CHUNK = 'IHDR';
const PADDING = '=';

/** The decoded length of well-formed base64 (see isBase64), without decoding it. */
function decodedLength(base64: string): number {
  const padding = base64.endsWith(PADDING + PADDING) ? 2 : base64.endsWith(PADDING) ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** The bytes as a binary string (one char per byte), or null when atob refuses it. */
function decode(base64: string): string | null {
  try {
    return atob(base64);
  } catch {
    return null;
  }
}

const readUint32 = (bytes: string, at: number): number =>
  ((bytes.charCodeAt(at) << 24) | (bytes.charCodeAt(at + 1) << 16) | (bytes.charCodeAt(at + 2) << 8) | bytes.charCodeAt(at + 3)) >>> 0;

const isSide = (px: number): boolean => px >= 1 && px <= MAX_ICON_SIDE_PX;

function hasIconHeader(bytes: string): boolean {
  if (bytes.length < HEADER_BYTES || !PNG_SIGNATURE.every((byte, i) => bytes.charCodeAt(i) === byte)) return false;
  if (readUint32(bytes, 8) !== IHDR_LENGTH || bytes.slice(12, 16) !== 'IHDR') return false;
  return isSide(readUint32(bytes, 16)) && isSide(readUint32(bytes, 20));
}

/**
 * Whether the chunks after the signature fit the file exactly, end with IEND, number at most
 * MAX_ICON_CHUNKS, are all ALLOWED_CHUNKS, and hold IHDR only first: a second IHDR could declare
 * another size to a decoder that reads the last one.
 */
function hasIconChunks(bytes: string): boolean {
  let at = PNG_SIGNATURE.length;
  for (let count = 1; count <= MAX_ICON_CHUNKS; count++) {
    if (at + CHUNK_OVERHEAD > bytes.length) return false;
    const end = at + CHUNK_OVERHEAD + readUint32(bytes, at);
    const type = bytes.slice(at + 4, at + 8);
    if (end > bytes.length || !ALLOWED_CHUNKS.has(type) || (type === HEADER_CHUNK) !== (count === 1)) return false;
    if (type === 'IEND') return end === bytes.length;
    at = end;
  }
  return false;
}

/**
 * Whether well-formed base64 (checked by the caller) holds a PNG of at most MAX_ICON_BYTES whose
 * first chunk, IHDR, gives a width and height of at most MAX_ICON_SIDE_PX, and whose chunks are
 * fit for an icon (hasIconChunks).
 */
export function isIconSizedPng(base64: string): boolean {
  if (base64.length > MAX_ICON_BASE64_CHARS || decodedLength(base64) > MAX_ICON_BYTES) return false;
  const bytes = decode(base64);
  return bytes !== null && hasIconHeader(bytes) && hasIconChunks(bytes);
}
