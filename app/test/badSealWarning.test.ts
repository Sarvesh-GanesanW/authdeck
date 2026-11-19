/**
 * A key change that gives someone a copy of the key that does not open (R6-D): a device holding
 * the key, and the recipient itself through its proof, show a banner naming who wrote it, and
 * a fresh key is due. Honest key changes show nothing.
 */
import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { badSealAtCurrentKey, badSealWarnings, knownBadSeals } from '../src/auth/engine/snapshot';
import { buildDeviceAdd, buildDeviceHello, buildKeyRotate, newVaultKey } from '../src/vault/build';
import { fromBase64Url } from '../src/vault/bytes';
import { sealKey, type DeviceKeys, type SealedKey } from '../src/vault/crypto';
import { entryHash, signEntry, type SignedEntry } from '../src/vault/entry';
import { openVault } from '../src/vault/open';
import { ownSealProofs } from '../src/vault/sealProof';
import { MemoryVault, device, seededRandom } from './helpers';

const random = seededRandom('bad-seal-warning-tests');

/** Phone founds; Tablet and Laptop join as admins. */
function vaultWithTwo(): { vault: MemoryVault; tablet: DeviceKeys; laptop: DeviceKeys } {
  const vault = new MemoryVault(device(random), random);
  const [tablet, laptop] = [device(random), device(random)];
  for (const [who, name] of [[tablet, 'Tablet'], [laptop, 'Laptop']] as const) {
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: who, role: 'admin', name, currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), who, vault.now()));
  }
  return { vault, tablet, laptop };
}

/** Phone's key change, sealing a wrong key to `victim`. */
function poisoned(vault: MemoryVault, victim: DeviceKeys): SignedEntry {
  const { entry } = buildKeyRotate(vault.state(), vault.founder, { currentKey: vault.key, random, time: vault.now() });
  const { sig: _sig, ...unsigned } = entry;
  const body = unsigned.body as unknown as { epoch: number; keys: Record<string, SealedKey> };
  body.keys[victim.deviceId] = sealKey(newVaultKey(random), fromBase64Url(body.keys[victim.deviceId]!.r), { vault: vault.vaultId, epoch: body.epoch, to: victim.deviceId });
  return signEntry(unsigned, vault.founder);
}

describe('bad-seal warning', () => {
  it('a device holding the key names who gave another device a key that does not open', () => {
    const { vault, tablet, laptop } = vaultWithTwo();
    const bad = vault.write(poisoned(vault, laptop));
    const state = vault.state();
    const open = openVault(state, tablet);
    const seals = knownBadSeals(state, open, vault.logs, [], new Map());
    assert.ok(badSealAtCurrentKey(state, seals));
    const [warning] = badSealWarnings(state, open, tablet.deviceId, seals);
    assert.equal(warning?.kind, 'bad-seal');
    assert.equal(warning?.id, `bad-seal-${entryHash(bad)}`);
    assert.equal(warning?.deviceId, vault.founder.deviceId);
    assert.match(warning!.text, /^Phone changed the vault key, and the copy it gave Laptop does not open/);
  });

  it('the recipient, read-only, shows it from its own proof', () => {
    const { vault, laptop } = vaultWithTwo();
    vault.write(poisoned(vault, laptop));
    const state = vault.state();
    const open = openVault(state, laptop);
    assert.notEqual(open.readOnly, null);
    const proofs = ownSealProofs(state, vault.logs, laptop);
    assert.equal(proofs.length, 1);
    const [warning] = badSealWarnings(state, open, laptop.deviceId, knownBadSeals(state, open, vault.logs, proofs, new Map()));
    assert.match(warning!.text, /the copy it gave this device does not open/);
    assert.match(warning!.text, /This device shows codes as of the last key it could open/);
  });

  it('shows nothing for honest key changes, and ignores a proof that does not hold', () => {
    const { vault, tablet, laptop } = vaultWithTwo();
    const { entry } = buildKeyRotate(vault.state(), vault.founder, { currentKey: vault.key, random, time: vault.now() });
    vault.write(entry);
    const state = vault.state();
    const open = openVault(state, tablet);
    const fake = { entry: entryHash(entry), to: laptop.deviceId, proof: 'A'.repeat(128) };
    assert.deepEqual(knownBadSeals(state, open, vault.logs, [fake], new Map()), []);
  });
});
