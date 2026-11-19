/**
 * What the agent will send as an app icon: a PNG of at most 256×256 pixels and 256 KB, holding
 * only the chunks a still image needs. The app checks the same before it stores or draws one;
 * anything else (an SVG, a PNG that decodes to a huge bitmap) is sent as no icon, and the app
 * shows its placeholder.
 */
export const MAX_ICON_PIXELS = 256;
export const MAX_ICON_PNG_BYTES = 256 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Signature, then the IHDR chunk: length (4), "IHDR" (4), width (4), height (4). */
const IHDR_END = 8 + 4 + 4 + 8;
/** Length (4), type (4), then the data, then the CRC (4). */
const CHUNK_OVERHEAD = 12;
/**
 * The most chunks a source PNG may have before it is cleaned. A 256 KB file could hold 20,000
 * empty chunks; real icons have under ten (macOS splits IDAT every 16 KB, so a 256 KB one has 17).
 */
const MAX_SOURCE_CHUNKS = 256;
/**
 * The chunks an icon keeps. Everything else is dropped: colour profiles (iCCP), text and XMP
 * (tEXt, zTXt, iTXt), Exif, and animation (acTL, fcTL, fdAT; the IDAT image stays). The app
 * refuses some of those outright, so a real icon that carries them (sips writes iTXt, macOS writes
 * eXIf) is cleaned here rather than sent as no icon.
 */
const KEPT_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'IDAT', 'IEND']);

/** The width and height IHDR declares, or null when this is not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < IHDR_END || PNG_SIGNATURE.some((byte, i) => png[i] !== byte)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(8) !== 13 || String.fromCharCode(...png.subarray(12, 16)) !== 'IHDR') return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Whether the icon is a PNG the app will accept. */
export function isServableIcon(png: Uint8Array): boolean {
  const size = pngSize(png);
  return size !== null && png.length <= MAX_ICON_PNG_BYTES && size.width > 0 && size.height > 0 && size.width <= MAX_ICON_PIXELS && size.height <= MAX_ICON_PIXELS;
}

interface Chunk {
  type: string;
  data: Uint8Array;
}

/** The chunks after the signature, or null when they overrun the file, don't end with IEND, or are too many. */
function readChunks(png: Uint8Array): Chunk[] | null {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  let at = PNG_SIGNATURE.length;
  while (at < png.length) {
    if (chunks.length === MAX_SOURCE_CHUNKS || at + CHUNK_OVERHEAD > png.length) return null;
    const length = view.getUint32(at);
    const end = at + CHUNK_OVERHEAD + length;
    if (end > png.length) return null;
    chunks.push({ type: String.fromCharCode(...png.subarray(at + 4, at + 8)), data: png.subarray(at + 8, at + 8 + length) });
    at = end;
    if (chunks[chunks.length - 1]!.type === 'IEND') break;
  }
  return chunks.at(-1)?.type === 'IEND' ? chunks : null;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeChunk({ type, data }: Chunk): Buffer {
  const out = Buffer.alloc(CHUNK_OVERHEAD + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * KEPT_CHUNKS, each but IDAT only once: the first IHDR is the one isServableIcon checked (a later
 * one could declare another size), and one of each lets the app cap the chunks an icon has.
 */
function keptChunks(chunks: Chunk[]): Chunk[] {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    if (!KEPT_CHUNKS.has(chunk.type)) return false;
    if (chunk.type === 'IDAT') return true;
    if (seen.has(chunk.type)) return false;
    seen.add(chunk.type);
    return true;
  });
}

/**
 * The icon as the agent sends it: the same image with only keptChunks, its IDAT chunks joined into
 * one, or null when it is not a servable icon (see isServableIcon) or its chunks are broken.
 */
export function cleanIcon(png: Uint8Array): Buffer | null {
  if (!isServableIcon(png)) return null;
  const chunks = readChunks(png);
  if (!chunks) return null;
  const kept = keptChunks(chunks);
  const idat = kept.filter((chunk) => chunk.type === 'IDAT');
  if (idat.length === 0) return null;
  const image: Chunk = { type: 'IDAT', data: Buffer.concat(idat.map((chunk) => chunk.data)) };
  const beforeImage = kept.slice(0, kept.indexOf(idat[0]!));
  return Buffer.concat([Buffer.from(PNG_SIGNATURE), ...[...beforeImage, image, { type: 'IEND', data: new Uint8Array(0) }].map(encodeChunk)]);
}
