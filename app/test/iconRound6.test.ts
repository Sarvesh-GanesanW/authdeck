/**
 * Link review 6, icons: the PNG check walks every chunk (only the chunks the agent keeps, one IHDR,
 * and a capped chunk count), and all computers' saved icons share one budget, the
 * computers used longest ago losing theirs first.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAppIcon } from '../src/net/messages';
import { MAX_ICON_CHUNKS, isIconSizedPng } from '../src/net/pngIcon';
import {
  ICON_CACHE_INDEX_KEY,
  MAX_TOTAL_ICON_CACHE_CHARS,
  iconCacheKey,
  readIconCache,
  removeIconCache,
  sweepOrphanedIconCaches,
  writeIconCache,
} from '../src/net/iconCacheStorage';
import { pngBase64, pngChunk } from './pngFixture';

describe('round 6: the chunks of an icon', () => {
  const withChunk = (type: string) => pngBase64(128, 128, [pngChunk(type, Buffer.from('payload'))]);

  for (const type of ['iCCP', 'zTXt', 'iTXt', 'acTL', 'fcTL', 'fdAT', 'cHRM', 'pHYs', 'tEXt', 'eXIf', 'sBIT', 'bKGD', 'abcd']) {
    it(`refuses an icon with ${type}: only the chunks the agent keeps pass`, () => {
      assert.equal(isIconSizedPng(withChunk(type)), false);
      assert.equal(isAppIcon({ mime: 'image/png', data: withChunk(type) }), false);
    });
  }

  it('accepts the chunks the agent keeps: PLTE, tRNS, sRGB, gAMA', () => {
    for (const type of ['PLTE', 'tRNS', 'sRGB', 'gAMA']) assert.equal(isIconSizedPng(withChunk(type)), true, type);
  });

  it('L-C: refuses a second IHDR, wherever it is', () => {
    const header = Buffer.from(pngBase64(16, 16), 'base64').subarray(8, 33);
    assert.equal(isIconSizedPng(pngBase64(16, 16, [header])), false);
    const real = Buffer.from(pngBase64(16, 16), 'base64');
    const iend = real.subarray(real.length - 12);
    assert.equal(isIconSizedPng(Buffer.concat([real.subarray(0, real.length - 12), header, iend]).toString('base64')), false);
  });

  it(`caps the chunk count at ${MAX_ICON_CHUNKS}`, () => {
    // IHDR, IDAT and IEND, plus the extras.
    const filler = (n: number) => Array.from({ length: n }, () => pngChunk('IDAT'));
    assert.equal(isIconSizedPng(pngBase64(16, 16, filler(MAX_ICON_CHUNKS - 3))), true);
    assert.equal(isIconSizedPng(pngBase64(16, 16, filler(MAX_ICON_CHUNKS - 2))), false);
  });

  it('refuses a chunk that runs past the end, a missing IEND, and bytes after IEND', () => {
    const real = Buffer.from(pngBase64(16, 16), 'base64');
    const overrun = Buffer.from(real);
    overrun.writeUInt32BE(1 << 20, 33); // IDAT's length
    for (const bytes of [overrun, real.subarray(0, real.length - 12), Buffer.concat([real, Buffer.from('trailing')])]) {
      assert.equal(isIconSizedPng(bytes.toString('base64')), false);
    }
  });
});

/** An in-memory AsyncStorage, with the size of each value. */
function memoryStorage() {
  const disk = new Map<string, string>();
  return {
    disk,
    getAllKeys: async () => [...disk.keys()],
    getItem: async (key: string) => disk.get(key) ?? null,
    setItem: async (key: string, value: string) => void disk.set(key, value),
    removeItem: async (key: string) => void disk.delete(key),
    multiRemove: async (keys: readonly string[]) => keys.forEach((key) => disk.delete(key)),
  };
}

const cacheTotal = (disk: Map<string, string>) => [...disk].filter(([key]) => key.startsWith('authdeck-icons-v1:')).reduce((sum, [, v]) => sum + v.length, 0);
const MB = 'x'.repeat(1_000_000);

describe('round 6: all computers’ saved icons share one budget', () => {
  it('saving past the total removes the least recently used computers’ caches, never the one saved', async () => {
    const storage = memoryStorage();
    for (const id of ['a', 'b', 'c', 'd']) assert.deepEqual(await writeIconCache(id, MB, storage), []);
    assert.equal(cacheTotal(storage.disk), 4_000_000);
    // "a" is used again, so "b" is now the oldest.
    assert.equal(await readIconCache('a', storage), MB);
    assert.deepEqual(await writeIconCache('e', MB, storage), ['b']);
    assert.deepEqual(await writeIconCache('f', MB, storage), ['c']);
    assert.ok(cacheTotal(storage.disk) <= MAX_TOTAL_ICON_CACHE_CHARS);
    assert.deepEqual([...storage.disk.keys()].filter((key) => key.startsWith('authdeck-icons-v1:')).sort(), ['a', 'd', 'e', 'f'].map(iconCacheKey));
    assert.deepEqual(JSON.parse(storage.disk.get(ICON_CACHE_INDEX_KEY)!).map(([id]: [string]) => id), ['d', 'a', 'e', 'f']);
  });

  it('a save that grows a cache evicts others; removing a cache frees its share', async () => {
    const storage = memoryStorage();
    for (const id of ['a', 'b', 'c']) await writeIconCache(id, MB, storage);
    await writeIconCache('d', 'x'.repeat(500_000), storage);
    assert.deepEqual(await writeIconCache('d', MB + 'y', storage), ['a']);
    await removeIconCache('b', storage);
    assert.equal(storage.disk.has(iconCacheKey('b')), false);
    assert.deepEqual(await writeIconCache('e', MB, storage), []);
  });

  it('concurrent saves keep one consistent index', async () => {
    const storage = memoryStorage();
    await Promise.all(Array.from({ length: 10 }, (_, n) => writeIconCache(`c${n}`, MB, storage)));
    assert.ok(cacheTotal(storage.disk) <= MAX_TOTAL_ICON_CACHE_CHARS);
    const index = JSON.parse(storage.disk.get(ICON_CACHE_INDEX_KEY)!) as [string, number][];
    assert.deepEqual(index.map(([id]) => iconCacheKey(id)).sort(), [...storage.disk.keys()].filter((key) => key.startsWith('authdeck-icons-v1:')).sort());
  });

  it('the launch sweep brings caches an older build saved (not in the index) within the total, oldest first', async () => {
    const storage = memoryStorage();
    for (const id of ['old1', 'old2', 'old3']) storage.disk.set(iconCacheKey(id), MB);
    await writeIconCache('recent1', MB, storage);
    await writeIconCache('recent2', MB, storage);
    const removed = await sweepOrphanedIconCaches(() => new Set(['old1', 'old2', 'old3', 'recent1', 'recent2']), storage);
    assert.deepEqual(removed, [iconCacheKey('old1')]);
    assert.ok(cacheTotal(storage.disk) <= MAX_TOTAL_ICON_CACHE_CHARS);
    assert.equal(storage.disk.has(iconCacheKey('recent1')), true);
  });

  it('the sweep removes a cache it can’t read and drops index entries whose caches are gone', async () => {
    const storage = memoryStorage();
    await writeIconCache('kept', '{}', storage);
    await writeIconCache('gone', '{}', storage);
    storage.disk.delete(iconCacheKey('gone'));
    storage.disk.set(iconCacheKey('huge'), 'unreadable');
    const getItem = storage.getItem;
    storage.getItem = async (key: string) => {
      if (key === iconCacheKey('huge')) throw new Error('Row too big to fit into CursorWindow');
      return getItem(key);
    };
    const removed = await sweepOrphanedIconCaches(() => new Set(['kept', 'gone', 'huge']), storage);
    assert.deepEqual(removed, [iconCacheKey('huge')]);
    assert.deepEqual(JSON.parse(storage.disk.get(ICON_CACHE_INDEX_KEY)!), [['kept', 2]]);
  });
});
