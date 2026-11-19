import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openRemovedVault, removedSentence } from '../src/auth/engine/removed';
import { buildSnapshot } from '../src/auth/engine/snapshot';
import { buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, newAccountId } from '../src/vault/build';
import { openVault } from '../src/vault/open';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers';

const random = seededRandom('removed-tests');

function threeDevices() {
  const vault = new MemoryVault(device(random), random);
  const [second, third] = [device(random), device(random)];
  for (const d of [second, third]) {
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: d, role: 'admin', name: d === second ? 'Pixel 8' : 'iPad', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), d, vault.now()));
  }
  return { vault, second, third };
}

const names = (id: string, vault: MemoryVault) => openVault(vault.state(), vault.founder).deviceNames[id] ?? null;

describe('a removed device', () => {
  it('keeps its codes read-only as of its last key, says who removed it, and wipes nothing by itself', () => {
    const { vault, second } = threeDevices();
    const before = newAccountId(random);
    vault.write(buildAccountPut(vault.state(), vault.founder, { account: before, record: totpRecord({ issuer: 'Bank' }), currentKey: vault.key, random, time: vault.now() }));
    const removal = buildDeviceRemove(vault.state(), vault.founder, { device: second.deviceId, currentKey: vault.key, random, time: vault.now() });
    vault.write(removal.entry);
    const after = newAccountId(random);
    vault.write(buildAccountPut(vault.state(), vault.founder, { account: after, record: totpRecord({ issuer: 'New' }), currentKey: removal.newKey, random, time: vault.now() }));
    const state = vault.state();

    const readOnly = openRemovedVault(state, second);
    assert.equal(readOnly.accounts[before]?.record.issuer, 'Bank');
    assert.equal(readOnly.accounts[after], undefined, 'a secret written after the removal stays unreadable');

    const text = removedSentence(state, second.deviceId, (id) => names(id, vault));
    assert.match(text!, /^Phone removed this device from the vault\. Its codes still show here, read-only\./);
    assert.equal(removedSentence(state, vault.founder.deviceId, () => null), null);

    const snapshot = buildSnapshot({
      loaded: true,
      prefs: { vaultId: vault.vaultId, deviceId: second.deviceId, appLock: false, autoLockMs: 60_000, recoverySavedAt: null, location: null, folderPath: null },
      state,
      open: readOnly,
      thisDevice: second.deviceId,
      folderRejections: [],
      readAt: 0,
      rollbackWarning: null,
      lockAt: null,
      computerName: null,
      computerOnline: true,
      heardAt: {},
      forked: new Set(),
      warnings: [],
      secretsPaused: false,
      removed: text,
      heldRemoval: false,
      logs: vault.logs,
      handledCaught: new Set(),
    });
    assert.equal(snapshot.status, 'open');
    assert.deepEqual(snapshot.accounts.map((a) => a.issuer), ['Bank']);
    assert.equal(snapshot.removed, text);
    assert.equal(snapshot.secretsPaused, true, 'nothing can be written');
  });

  it('says so when two devices removed each other at the same time, and points to the recovery phrase', () => {
    const { vault, second } = threeDevices();
    const shared = vault.state();
    vault.write(buildDeviceRemove(shared, vault.founder, { device: second.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    vault.write(buildDeviceRemove(shared, second, { device: vault.founder.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    const state = vault.state();
    assert.equal(state.members[vault.founder.deviceId]?.removed, true);
    assert.equal(state.members[second.deviceId]?.removed, true);
    const text = removedSentence(state, vault.founder.deviceId, (id) => (id === second.deviceId ? 'Pixel 8' : null));
    assert.match(text!, /^Pixel 8 removed this device at the same time it was removed itself/);
    assert.match(text!, /recovery phrase to take the vault back/);
    assert.match(removedSentence(state, second.deviceId, () => null)!, /^Another device removed this device at the same time/);
  });
});
