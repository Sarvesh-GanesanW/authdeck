import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it } from 'node:test';
import { cleanIcon } from '../src/icons/png';
import { renderMacIcons } from '../src/icons/mac';
import { isIconSizedPng } from '../../app/src/net/pngIcon';
import { chunkTypes, grayPng, pngChunk } from './helpers/png';

/** The image data of a PNG: its IDAT chunks joined and inflated. */
function pixels(png: Uint8Array): Buffer {
  const bytes = Buffer.from(png);
  const parts: Buffer[] = [];
  for (let at = 8; at + 8 <= bytes.length; at += 12 + bytes.readUInt32BE(at)) {
    if (bytes.toString('latin1', at + 4, at + 8) === 'IDAT') parts.push(bytes.subarray(at + 8, at + 8 + bytes.readUInt32BE(at)));
  }
  return zlib.inflateSync(Buffer.concat(parts));
}

const appAccepts = (png: Uint8Array): boolean => isIconSizedPng(Buffer.from(png).toString('base64'));

describe('icons the agent cleans before sending', () => {
  const extras = ['iCCP', 'zTXt', 'iTXt', 'tEXt', 'eXIf', 'acTL', 'fcTL', 'pHYs', 'cHRM'].map((type) => pngChunk(type, Buffer.from('extra')));

  it('drops profiles, text, Exif and animation, keeps sRGB, gAMA and tRNS, and joins IDAT; the image is unchanged', () => {
    const kept = [pngChunk('sRGB', Buffer.from([0])), pngChunk('gAMA', Buffer.alloc(4)), pngChunk('tRNS', Buffer.alloc(2))];
    const source = grayPng(128, 128, { before: [...extras, ...kept], idatChunks: 3 });
    assert.equal(appAccepts(source), false, 'the app refuses the source as it is');
    const cleaned = cleanIcon(source)!;
    assert.deepEqual(chunkTypes(cleaned), ['IHDR', 'sRGB', 'gAMA', 'tRNS', 'IDAT', 'IEND']);
    assert.deepEqual(pixels(cleaned), pixels(source));
    assert.equal(appAccepts(cleaned), true);
  });

  it('a plain PNG comes out byte for byte the same', () => {
    const plain = grayPng(48, 48);
    assert.deepEqual(cleanIcon(plain), plain);
  });

  it('refuses broken PNGs: a chunk past the end, no IEND, no IDAT, too many chunks, too big', () => {
    const plain = grayPng(48, 48);
    assert.equal(cleanIcon(plain.subarray(0, plain.length - 6)), null);
    assert.equal(cleanIcon(plain.subarray(0, plain.length - 12)), null, 'no IEND');
    const noImage = Buffer.concat([plain.subarray(0, 33), pngChunk('IEND')]);
    assert.equal(cleanIcon(noImage), null);
    assert.equal(cleanIcon(grayPng(48, 48, { before: Array.from({ length: 300 }, () => pngChunk('tEXt')) })), null);
    assert.notEqual(cleanIcon(grayPng(48, 48, { before: Array.from({ length: 200 }, () => pngChunk('tEXt')) })), null);
    assert.equal(cleanIcon(grayPng(20000, 20000)), null);
  });

  it('L-C: keeps only the first IHDR, and one of each kept chunk but IDAT', () => {
    const second = pngChunk('IHDR', Buffer.from(grayPng(60000, 60000).subarray(16, 29)));
    const repeats = Array.from({ length: 100 }, () => [pngChunk('gAMA', Buffer.alloc(4)), pngChunk('sRGB', Buffer.from([0]))]).flat();
    const source = grayPng(16, 16, { before: [second, ...repeats, second], idatChunks: 2 });
    const cleaned = cleanIcon(source)!;
    assert.deepEqual(chunkTypes(cleaned), ['IHDR', 'gAMA', 'sRGB', 'IDAT', 'IEND']);
    assert.equal(cleaned.readUInt32BE(16), 16, 'the first IHDR is the one kept');
    assert.equal(appAccepts(cleaned), true);
  });

  it('L-C: the app accepts everything cleanIcon produces, from crafted and mutated PNGs', () => {
    const kinds = ['IHDR', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'IDAT', 'iCCP', 'tEXt', 'eXIf', 'acTL', 'fdAT', 'pHYs'];
    let cleanedCount = 0;
    for (let i = 0; i < 3000; i++) {
      const before = Array.from({ length: i % 70 }, (_, k) => pngChunk(kinds[(i * 7 + k * 3) % kinds.length]!, crypto.randomBytes(k % 13)));
      const source = grayPng(1 + (i % 256), 1 + (i % 199), { before, idatChunks: 1 + (i % 4) });
      if (i % 3 === 0) for (let k = 0; k < 1 + (i % 5); k++) source[8 + crypto.randomInt(source.length - 8)] = crypto.randomInt(256);
      const cleaned = cleanIcon(source);
      if (!cleaned) continue;
      cleanedCount++;
      assert.equal(appAccepts(cleaned), true, `input ${i}: ${chunkTypes(cleaned).join(',')}`);
    }
    assert.ok(cleanedCount > 1000, `only ${cleanedCount} cleaned`);
  });

  it('real macOS icons come out clean and the app accepts them', { skip: process.platform !== 'darwin' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-icon-png-'));
    try {
      const dest = path.join(dir, 'calculator.png');
      const [ok] = await renderMacIcons([{ src: '/System/Applications/Calculator.app', dest }]);
      assert.equal(ok, true);
      const cleaned = cleanIcon(fs.readFileSync(dest))!;
      assert.deepEqual(chunkTypes(cleaned), ['IHDR', 'sRGB', 'IDAT', 'IEND']);
      assert.deepEqual(pixels(cleaned), pixels(fs.readFileSync(dest)));
      assert.equal(appAccepts(cleaned), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
