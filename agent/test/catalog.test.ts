import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppCatalog } from '../src/apps/catalog';
import type { InstalledApp } from '../src/apps/types';

const app = (id: string, name: string): InstalledApp => ({ platform: 'macos', entry: { id, name, hasIcon: true }, bundlePath: id, bundleId: null });

describe('AppCatalog', () => {
  it('sorts by name case-insensitively and shares one scan between callers', async () => {
    let scans = 0;
    const catalog = new AppCatalog(async () => {
      scans += 1;
      return [app('2', 'zed'), app('1', 'Alacritty'), app('3', 'brave')];
    });
    const [a, b] = await Promise.all([catalog.list(), catalog.list()]);
    assert.deepEqual(a.map((x) => x.name), ['Alacritty', 'brave', 'zed']);
    assert.deepEqual(a, b);
    assert.equal(scans, 1);
    await catalog.list();
    assert.equal(scans, 1, 'cached');
    await catalog.list(true);
    assert.equal(scans, 2, 'refresh rescans');
  });

  it('calls onChange only when a rescan finds a different list', async () => {
    let result = [app('1', 'A')];
    let changes = 0;
    const catalog = new AppCatalog(async () => result, () => (changes += 1));
    await catalog.rescan();
    await catalog.rescan();
    assert.equal(changes, 0);
    result = [app('1', 'A'), app('2', 'B')];
    await catalog.rescan();
    assert.equal(changes, 1);
    assert.equal((await catalog.get('2'))?.entry.name, 'B');
  });
});
