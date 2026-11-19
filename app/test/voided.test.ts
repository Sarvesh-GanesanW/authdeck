/**
 * Membership changes voided because their author was removed by a change it had not seen
 * (rule 1): told in neutral words, never redone and never offered as a button (round 5, N5),
 * hidden once handled.
 */
import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listVoidedChanges } from '../src/auth/engine/voided';
import { buildDeviceAdd, buildDeviceHello, buildDeviceRemove } from '../src/vault/build';
import type { DeviceKeys } from '../src/vault/crypto';
import { openVault } from '../src/vault/open';
import { MemoryVault, device, seededRandom } from './helpers';

const random = seededRandom('voided-changes-tests');

function addDevice(vault: MemoryVault, who: DeviceKeys): void {
  vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: who, role: 'admin', name: 'x', currentKey: vault.key, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), who, vault.now()));
}

/** Phone founds; Tablet removes Laptop; Laptop, not having seen it, removes Watch. */
function scenario() {
  const vault = new MemoryVault(device(random), random);
  const [tablet, laptop, watch] = [device(random), device(random), device(random)];
  addDevice(vault, tablet);
  addDevice(vault, laptop);
  addDevice(vault, watch);
  const stale = vault.state();
  vault.write(buildDeviceRemove(vault.state(), tablet, { device: laptop.deviceId, currentKey: openVault(vault.state(), tablet).currentKey, random, time: vault.now() }).entry);
  const late = buildDeviceRemove(stale, laptop, { device: watch.deviceId, currentKey: openVault(stale, laptop).currentKey, random, time: vault.now() }).entry;
  vault.write(late);
  const deviceNames = { [vault.founder.deviceId]: 'Phone', [tablet.deviceId]: 'Tablet', [laptop.deviceId]: 'Laptop', [watch.deviceId]: 'Watch' };
  return { vault, tablet, laptop, watch, deviceNames };
}

describe('voided membership changes', () => {
  it('says the removed device tried to remove another, and that nothing changed', () => {
    const { vault, watch, deviceNames } = scenario();
    const state = vault.state();
    assert.equal(state.members[watch.deviceId]!.removed, false);
    const list = listVoidedChanges({ state, logs: vault.logs, deviceNames, me: vault.founder.deviceId, handled: new Set() });
    assert.equal(list.length, 1);
    assert.equal(list[0]!.text, 'Laptop, which was removed, also tried to remove Watch. Nothing changed.');
    assert.equal(list[0]!.hint, 'If you want Watch removed, remove it from its page.');
    assert.equal('redo' in list[0]!, false);
  });

  it('gives the target itself no hint, and hides handled ones', () => {
    const { vault, watch, deviceNames } = scenario();
    const state = vault.state();
    const asWatch = listVoidedChanges({ state, logs: vault.logs, deviceNames, me: watch.deviceId, handled: new Set() });
    assert.equal(asWatch.length, 1);
    assert.equal(asWatch[0]!.hint, undefined);
    const handled = listVoidedChanges({ state, logs: vault.logs, deviceNames, me: vault.founder.deviceId, handled: new Set([asWatch[0]!.id]) });
    assert.deepEqual(handled, []);
  });

  it('gives no hint once the target is out anyway', () => {
    const { vault, watch, deviceNames } = scenario();
    vault.write(buildDeviceRemove(vault.state(), vault.founder, { device: watch.deviceId, currentKey: openVault(vault.state(), vault.founder).currentKey, random, time: vault.now() }).entry);
    const list = listVoidedChanges({ state: vault.state(), logs: vault.logs, deviceNames, me: vault.founder.deviceId, handled: new Set() });
    assert.equal(list.length, 1);
    assert.equal(list[0]!.hint, undefined);
  });
});
