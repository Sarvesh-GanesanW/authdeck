/**
 * A key change whose copy of the previous key doesn't open (round 5): a device that holds both
 * keys shows a banner naming the device that wrote it. Honest key changes show nothing.
 */
import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prevKeyWarnings } from '../src/auth/engine/snapshot';
import { buildDeviceAdd, buildDeviceHello, buildKeyRotate } from '../src/vault/build';
import { encryptBox, type DeviceKeys } from '../src/vault/crypto';
import { entryHash, signEntry, type SignedEntry } from '../src/vault/entry';
import { boxContexts, openVault } from '../src/vault/open';
import { MemoryVault, device, seededRandom } from './helpers';

const random = seededRandom('prev-key-warning-tests');

/** Phone founds; Tablet joins as an admin. */
function vaultWithTablet(): { vault: MemoryVault; tablet: DeviceKeys } {
  const vault = new MemoryVault(device(random), random);
  const tablet = device(random);
  vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: tablet, role: 'admin', name: 'Tablet', currentKey: vault.key, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), tablet, vault.now()));
  return { vault, tablet };
}

/** Phone's key change, with a prevKey that opens to a random key instead of the previous one. */
function garbageRotation(vault: MemoryVault): SignedEntry {
  const state = vault.state();
  const { entry, newKey } = buildKeyRotate(state, vault.founder, { currentKey: vault.key, random, time: vault.now() });
  const prevKey = encryptBox(newKey, random(32), boxContexts.prevKey(vault.vaultId, state.epoch + 1), random);
  const { sig: _sig, ...unsigned } = entry;
  return signEntry({ ...unsigned, body: { ...entry.body, prevKey: prevKey as unknown as SignedEntry['body'][string] } }, vault.founder);
}

describe('prevKey warning', () => {
  it('names the device whose key change carries a prevKey that does not open', () => {
    const { vault, tablet } = vaultWithTablet();
    const bad = vault.write(garbageRotation(vault));
    const state = vault.state();
    const open = openVault(state, tablet);
    const warnings = prevKeyWarnings(state, open, vault.logs);
    assert.equal(warnings.length, 1);
    const [warning] = warnings;
    assert.equal(warning!.kind, 'prev-key');
    assert.equal(warning!.deviceId, vault.founder.deviceId);
    assert.equal(warning!.id, `prev-key-${entryHash(bad)}`);
    assert.match(warning!.text, /^Phone changed the vault key with a copy of the previous key that doesn't open/);
  });

  it('shows nothing for an honest key change', () => {
    const { vault, tablet } = vaultWithTablet();
    vault.write(buildKeyRotate(vault.state(), vault.founder, { currentKey: vault.key, random, time: vault.now() }).entry);
    const state = vault.state();
    assert.deepEqual(prevKeyWarnings(state, openVault(state, tablet), vault.logs), []);
  });
});
