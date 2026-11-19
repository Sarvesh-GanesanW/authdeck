/** Round 3, app side: stored data is checked again on load, and History never throws on an odd author id. */
import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildHistory } from '../src/auth/engine/history';
import { loadForks, loadLogs, loadPendingRestore, loadPrefs, saveForks, savePendingRestore, saveLogs } from '../src/auth/engine/localCopy';
import type { PendingRestore } from '../src/auth/engine/sync';
import { buildDeviceAdd, buildDeviceHello } from '../src/vault/build';
import { openVault } from '../src/vault/open';
import { MemoryVault, device, seededRandom } from './helpers';

const random = seededRandom('vault-round3-storage-tests');
const ID = 'A'.repeat(22);
const OTHER_ID = 'B'.repeat(22);

describe('the local copy is checked on load', () => {
  it('saves only logs keyed by a device id, "__proto__" and "constructor" included', async () => {
    const stored = JSON.parse(`{"__proto__":["x"],"constructor":["y"],"short":["z"],"${OTHER_ID}":["line"]}`) as Record<string, string[]>;
    await saveLogs(ID, stored);
    const logs = await loadLogs(ID);
    assert.deepEqual(Object.keys(logs), [OTHER_ID]);
    assert.equal(Object.getPrototypeOf(logs), Object.prototype);
  });

  it('never builds a storage path from something that is not an id', async () => {
    await assert.rejects(loadLogs('__proto__'), /malformed/);
    await assert.rejects(saveLogs('../prefs', {}), /malformed/);
  });

  it('refuses settings whose vault or device id is not an id, and ignores unknown settings', async () => {
    await AsyncStorage.setItem('authdeck-vault-prefs-v2', JSON.stringify({ vaultId: 'constructor' }));
    await assert.rejects(loadPrefs(), /damaged/);
    await AsyncStorage.setItem('authdeck-vault-prefs-v2', JSON.stringify({ vaultId: ID, deviceId: OTHER_ID, extra: 1 }));
    const prefs = await loadPrefs();
    assert.equal(prefs.vaultId, ID);
    assert.equal(prefs.deviceId, OTHER_ID);
    assert.equal(Object.hasOwn(prefs, 'extra'), false);
  });

  it('keeps only stored fork proofs shaped like one', async () => {
    const good = { deviceId: OTHER_ID, seq: 2, lines: ['a', 'b'] as [string, string] };
    const bad = [{ deviceId: '__proto__', seq: 1, lines: ['a', 'b'] }, { deviceId: OTHER_ID, seq: -1, lines: ['a', 'b'] }, null];
    await saveForks(ID, [good, ...(bad as never[])]);
    assert.deepEqual(await loadForks(ID), [good]);
  });

  it('keeps a pending restore per vault and recovery identity, and refuses a damaged one', async () => {
    const pending: PendingRestore = { recoveryId: OTHER_ID, deviceId: ID, seq: 1, lines: ['add', 'hello'], superseded: false };
    await savePendingRestore(ID, pending);
    assert.deepEqual(await loadPendingRestore(ID, OTHER_ID), pending);
    assert.equal(await loadPendingRestore(OTHER_ID, OTHER_ID), null);
    await AsyncStorage.setItem(`authdeck-vault-restore-v1:${ID}:${OTHER_ID}`, JSON.stringify({ ...pending, seq: 'one' }));
    await assert.rejects(loadPendingRestore(ID, OTHER_ID), /damaged/);
  });
});

describe('History bylines', () => {
  function vaultWithTablet(name: string) {
    const vault = new MemoryVault(device(random), random);
    const tablet = device(random);
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: tablet, role: 'admin', name, currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), tablet, vault.now()));
    return vault;
  }

  it("doesn't throw for an author id that is an Object.prototype name or a member whose key can't be read", () => {
    const vault = vaultWithTablet('Tablet');
    const state = vault.state();
    const open = openVault(state, vault.founder);
    const odd = [{ deviceId: 'constructor', seq: 0, reason: 'bad' }, { deviceId: '__proto__', seq: 0, reason: 'bad' }];
    const broken = { ...state, members: { ...state.members, [vault.founder.deviceId]: { ...state.members[vault.founder.deviceId]!, ed: '***' } } };
    const items = buildHistory({ state: broken, keys: open.keys, deviceNames: open.deviceNames, folderRejections: odd, unreadable: [], readAt: 1 });
    for (const item of items) assert.equal(typeof item.by, 'string');
    assert.equal(items.find((i) => i.id === 'folder:constructor:0')?.by, 'Unknown device');
  });

  it('counts names that read the same (a Cyrillic "о") as one shared name', () => {
    const vault = vaultWithTablet('Phоne'); // the founder is "Phone"; this "о" is Cyrillic
    const state = vault.state();
    const open = openVault(state, vault.founder);
    const items = buildHistory({ state, keys: open.keys, deviceNames: open.deviceNames, folderRejections: [], unreadable: [], readAt: 1 });
    assert.ok(items.every((i) => i.byNameShared === 2));
  });
});
