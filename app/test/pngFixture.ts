/** Real PNG files for icon tests: a plain grey square of any size, as the agent would send it. */
import zlib from 'node:zlib';

export function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** A 1-bit greyscale PNG of width x height pixels, as base64, with `extra` chunks before IDAT. Large sizes stay small on disk. */
export function pngBase64(width: number, height: number, extra: Buffer[] = []): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // greyscale
  const rows = Buffer.alloc((1 + Math.ceil(width / 8)) * height);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    ...extra,
    pngChunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    pngChunk('IEND'),
  ]);
  return png.toString('base64');
}
