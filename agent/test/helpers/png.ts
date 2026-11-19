/** Real PNG files for icon tests: a plain grey square, with any extra chunks a platform might add. */
import zlib from 'node:zlib';

export function pngChunk(type: string, data: Uint8Array = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

export interface PngParts {
  /** Chunks between IHDR and IDAT, e.g. pngChunk('iCCP', ...). */
  before?: Buffer[];
  /** How many IDAT chunks the image data is split over. */
  idatChunks?: number;
}

/** A 1-bit greyscale PNG of width x height pixels. */
export function grayPng(width: number, height: number, { before = [], idatChunks = 1 }: PngParts = {}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // greyscale
  const image = zlib.deflateSync(Buffer.alloc((1 + Math.ceil(width / 8)) * height), { level: 9 });
  const step = Math.ceil(image.length / idatChunks);
  const idat = Array.from({ length: idatChunks }, (_, i) => pngChunk('IDAT', image.subarray(i * step, (i + 1) * step)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), ...before, ...idat, pngChunk('IEND')]);
}

/** The chunk types of a PNG, in order. */
export function chunkTypes(png: Uint8Array): string[] {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const types: string[] = [];
  for (let at = 8; at + 8 <= bytes.length; at += 12 + bytes.readUInt32BE(at)) types.push(bytes.toString('latin1', at + 4, at + 8));
  return types;
}
