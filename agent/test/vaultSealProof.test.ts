// R6-D: deterministic seals, bad-seal proofs, the read-only fallback, key changes built on the
// last good key, and restore with a phrase whose current seal is bad.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { numberToBytesLE } from '@noble/curves/utils.js';
import {
  buildAccountPut,
  buildDeviceAdd,
  buildDeviceHello,
  buildDeviceRemove,
  buildKeyRotate,
  newAccountId,
  newVaultKey,
} from '../src/vault/build';
import { fromBase64Url, toBase64Url } from '../src/vault/bytes';
import { sealKey, sealsEqual, SealPoint, type DeviceKeys, type SealedKey } from '../src/vault/crypto';
import { entryHash, signEntry, type SignedEntry } from '../src/vault/entry';
import { planAppend } from '../src/vault/logs';
import { openVault } from '../src/vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, recoveryKeysFromPhrase, restoreWithPhrase } from '../src/vault/recovery';
import type { VaultState } from '../src/vault/replay';
import { findBadSeals, judgeSealProof, makeSealProof, ownSealProofs, sealProofValid } from '../src/vault/sealProof';
import { VaultStore } from '../src/vaultStore';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers/vault';

/** The fixtures cover the 0.4 multi-device code, so they run with it on (test/setup/multiDevice.ts). */
const MULTI_DEVICE_SETUP = new URL('./setup/multiDevice.ts', import.meta.url).href;

const random = seededRandom('vault-seal-proof-tests');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

function agentAppend(vault: MemoryVault, entries: SignedEntry[]): VaultState {
  const plan = planAppend(vault.vaultId, vault.logs, entries);
  for (const id of plan.changed) vault.logs[id] = [...plan.logs[id]!];
  return plan.state;
}

function statusOf(state: VaultState, entry: SignedEntry): string | undefined {
  return state.history.find((h) => h.hash === entryHash(entry))?.status;
}

function addAdmin(vault: MemoryVault, by: DeviceKeys, who: DeviceKeys): void {
  agentAppend(vault, [buildDeviceAdd(vault.state(), by, { device: who, role: 'admin', name: 'x', currentKey: openVault(vault.state(), by).currentKey, random, time: vault.now() })]);
  agentAppend(vault, [buildDeviceHello(vault.state(), who, vault.now())]);
}

function putAccount(vault: MemoryVault, by: DeviceKeys, issuer: string): void {
  const state = vault.state();
  agentAppend(vault, [buildAccountPut(state, by, { account: newAccountId(random), record: totpRecord({ issuer }), currentKey: openVault(state, by).currentKey, random, time: vault.now() })]);
}

/** A key change by `author` whose seals to everyone else hold another key: the R6-D rotation. */
function poisonedRotation(state: VaultState, author: DeviceKeys): SignedEntry {
  const honest = buildKeyRotate(state, author, { currentKey: openVault(state, author).currentKey, random, time: 9_000_000 });
  const { sig: _sig, ...unsigned } = honest.entry;
  const body = unsigned.body as unknown as { epoch: number; keys: Record<string, SealedKey> };
  const wrong = newVaultKey(random);
  for (const [to, sealed] of Object.entries(body.keys)) {
    if (to !== author.deviceId) body.keys[to] = sealKey(wrong, fromBase64Url(sealed.r), { vault: state.vaultId, epoch: body.epoch, to });
  }
  return signEntry(unsigned, author);
}

/** Founder `thief`, owner tablet, a phrase and three accounts; then the thief's poisoned rotation. */
function poisonedVault() {
  const thief = device(random);
  const tablet = device(random);
  const vault = MemoryVault.found(thief, random);
  addAdmin(vault, thief, tablet);
  const phrase = generateRecoveryPhrase(random);
  const before = vault.state();
  agentAppend(vault, [buildRecoverySetFromPhrase(before, tablet, { phrase, currentKey: openVault(before, tablet).currentKey, random, time: vault.now() }).entry]);
  for (const issuer of ['Bank', 'Mail', 'Shop']) putAccount(vault, tablet, issuer);
  const goodEpoch = vault.state().epoch;
  const poisoned = poisonedRotation(vault.state(), thief);
  assert.equal(statusOf(agentAppend(vault, [poisoned]), poisoned), 'applied');
  const recovery = recoveryKeysFromPhrase(phrase, vault.vaultId);
  return { vault, thief, tablet, phrase, recovery, poisoned, goodEpoch };
}

describe('deterministic seals', () => {
  it('give the same bytes for the same key, recipient and context, and differ per recipient and epoch', () => {
    const a = device(random);
    const b = device(random);
    const key = newVaultKey(random);
    const context = { vault: 'V'.repeat(22), epoch: 3, to: a.deviceId };
    assert.ok(sealsEqual(sealKey(key, a.xPublic, context), sealKey(key, a.xPublic, context)));
    assert.ok(!sealsEqual(sealKey(key, a.xPublic, context), sealKey(key, b.xPublic, context)));
    assert.ok(!sealsEqual(sealKey(key, a.xPublic, context), sealKey(key, a.xPublic, { ...context, epoch: 4 })));
    assert.equal(sealKey(key, a.xPublic, context).r, toBase64Url(a.xPublic));
  });

  it('refuses the identity point as a sealing key', () => {
    assert.throws(() => sealKey(newVaultKey(random), new Uint8Array(32), { vault: 'V'.repeat(22), epoch: 0, to: 'T'.repeat(22) }));
  });
});

describe('a device holding the key checks every seal of it', () => {
  it('finds no bad seal in an honest vault', () => {
    const [a, b, c] = [device(random), device(random), device(random)];
    const vault = MemoryVault.found(a, random);
    addAdmin(vault, a, b);
    addAdmin(vault, b, c);
    const state = vault.state();
    agentAppend(vault, [buildDeviceRemove(state, a, { device: c.deviceId, currentKey: openVault(state, a).currentKey, random, time: vault.now() }).entry]);
    const after = vault.state();
    assert.deepEqual(findBadSeals(after, vault.logs, openVault(after, a).keys), []);
    assert.deepEqual(findBadSeals(after, vault.logs, openVault(after, b).keys), []);
  });

  it('finds a seal to another device that is not what the key gives, and names its author', () => {
    const [author, holder, victim] = [device(random), device(random), device(random)];
    const vault = MemoryVault.found(author, random);
    addAdmin(vault, author, holder);
    addAdmin(vault, author, victim);
    const state = vault.state();
    const honest = buildKeyRotate(state, author, { currentKey: openVault(state, author).currentKey, random, time: vault.now() });
    const { sig: _sig, ...unsigned } = honest.entry;
    const body = unsigned.body as unknown as { epoch: number; keys: Record<string, SealedKey> };
    body.keys[victim.deviceId] = sealKey(newVaultKey(random), victim.xPublic, { vault: vault.vaultId, epoch: body.epoch, to: victim.deviceId });
    const bad = signEntry(unsigned, author);
    agentAppend(vault, [bad]);
    const after = vault.state();
    const found = findBadSeals(after, vault.logs, openVault(after, holder).keys);
    assert.deepEqual(found, [{ hash: entryHash(bad), author: author.deviceId, seq: bad.seq, to: victim.deviceId, epoch: after.epoch }]);
    // The victim, read-only, proves it too.
    assert.notEqual(openVault(after, victim).readOnly, null);
    const [proof] = ownSealProofs(after, vault.logs, victim);
    assert.ok(proof && sealProofValid(proof, bad, toBase64Url(victim.xPublic), after.keyChecks));
  });
});

describe('bad-seal proofs', () => {
  it('every recipient of a poisoned rotation proves its seal bad, and anyone can check it', () => {
    const { vault, tablet, recovery, poisoned } = poisonedVault();
    const state = vault.state();
    const forTablet = makeSealProof(poisoned, tablet, state.keyChecks)!;
    const forPhrase = makeSealProof(poisoned, recovery, state.keyChecks)!;
    assert.ok(sealProofValid(forTablet, poisoned, toBase64Url(tablet.xPublic), state.keyChecks));
    assert.ok(sealProofValid(forPhrase, poisoned, state.recovery!.x, state.keyChecks));
    // JSON round trip, and deterministic.
    assert.deepEqual(JSON.parse(JSON.stringify(forTablet)), forTablet);
    assert.deepEqual(makeSealProof(poisoned, tablet, state.keyChecks), forTablet);
    const judged = judgeSealProof(state, vault.logs, forPhrase);
    assert.equal(judged.ok, true);
    assert.equal(judged.ok && judged.author, poisoned.author);
  });

  it('nothing proves the thief\'s own good seal bad', () => {
    const { vault, thief, poisoned } = poisonedVault();
    assert.equal(makeSealProof(poisoned, thief, vault.state().keyChecks), null);
  });
});

describe('an honest author can\'t be framed', () => {
  /** A real Chaum-Pedersen proof with the true shared point for an honest seal (its key check faked). */
  function trueProofForHonestSeal() {
    const [admin, joiner] = [device(random), device(random)];
    const vault = MemoryVault.found(admin, random);
    const add = buildDeviceAdd(vault.state(), admin, { device: joiner, role: 'admin', name: 'J', currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [add]);
    const state = vault.state();
    const lying = { ...state.keyChecks, [0]: toBase64Url(new Uint8Array(32)) };
    const proof = makeSealProof(add, joiner, lying)!;
    return { vault, state, add, joiner, admin, proof };
  }

  it('a valid proof of the true shared point does not show a good seal bad', () => {
    const { state, add, joiner, proof } = trueProofForHonestSeal();
    assert.ok(proof, 'the proof itself is made');
    assert.equal(sealProofValid(proof, add, toBase64Url(joiner.xPublic), state.keyChecks), false);
    assert.equal(makeSealProof(add, joiner, state.keyChecks), null);
  });

  it('a forged shared point fails the proof', () => {
    const { state, add, joiner, proof } = trueProofForHonestSeal();
    const bytes = fromBase64Url(proof.proof);
    const forged = SealPoint.BASE.multiply(12345n).toBytes();
    for (const tampered of [
      new Uint8Array([...forged, ...bytes.subarray(32)]),
      new Uint8Array([...bytes.subarray(0, 64), ...numberToBytesLE(77n, 32)]),
      new Uint8Array([...bytes.subarray(0, 32), ...numberToBytesLE(SealPoint.Fn.ORDER + 1n, 32), ...bytes.subarray(64)]),
      new Uint8Array(96),
    ]) {
      assert.equal(sealProofValid({ ...proof, proof: toBase64Url(tampered) }, add, toBase64Url(joiner.xPublic), state.keyChecks), false);
    }
  });

  it('a proof made for another seal, another recipient, the author itself or another key does not count', () => {
    const { vault, tablet, recovery, poisoned } = poisonedVault();
    const state = vault.state();
    const good = makeSealProof(poisoned, tablet, state.keyChecks)!;
    // Moved to the honest rotation that came before (another entry).
    const honestSet = state.history.find((h) => h.kind === 'recovery.set' && h.status === 'applied')!;
    const honestEntry = JSON.parse(vault.logs[honestSet.author]![honestSet.seq]!) as SignedEntry;
    assert.equal(sealProofValid({ ...good, entry: entryHash(honestEntry) }, honestEntry, toBase64Url(tablet.xPublic), state.keyChecks), false);
    // Relabelled as the recovery identity's (another recipient), with either key.
    assert.equal(sealProofValid({ ...good, to: recovery.deviceId }, poisoned, state.recovery!.x, state.keyChecks), false);
    assert.equal(sealProofValid({ ...good, to: recovery.deviceId }, poisoned, toBase64Url(tablet.xPublic), state.keyChecks), false);
    // Against the author's own seal.
    assert.equal(sealProofValid({ ...good, to: poisoned.author }, poisoned, state.members[poisoned.author]!.x, state.keyChecks), false);
    // With a key the seal doesn't name.
    assert.equal(sealProofValid(good, poisoned, state.recovery!.x, state.keyChecks), false);
  });
});

describe('a bad seal never locks a device out', () => {
  it('the owner reads every account read-only, and can\'t write under the current epoch', () => {
    const { vault, tablet, thief } = poisonedVault();
    const state = vault.state();
    const opened = openVault(state, tablet);
    assert.notEqual(opened.readOnly, null);
    assert.equal(opened.epoch, state.epoch - 1);
    assert.deepEqual(Object.values(opened.accounts).map((a) => a.record.issuer).sort(), ['Bank', 'Mail', 'Shop']);
    assert.equal(openVault(state, thief).readOnly, null);
  });

  it('a removed device still opens nothing new', () => {
    const [a, b] = [device(random), device(random)];
    const vault = MemoryVault.found(a, random);
    addAdmin(vault, a, b);
    const state = vault.state();
    agentAppend(vault, [buildDeviceRemove(state, a, { device: b.deviceId, currentKey: openVault(state, a).currentKey, random, time: vault.now() }).entry]);
    assert.throws(() => openVault(vault.state(), b));
  });

  it('the owner removes the thief on the last good key; everyone left reads every account under the fresh key', () => {
    const { vault, tablet, thief, recovery } = poisonedVault();
    const state = vault.state();
    const removal = buildDeviceRemove(state, tablet, { device: thief.deviceId, currentKey: openVault(state, tablet).currentKey, random, time: vault.now() });
    assert.equal(statusOf(agentAppend(vault, [removal.entry]), removal.entry), 'applied');
    const after = vault.state();
    const opened = openVault(after, tablet);
    assert.equal(opened.readOnly, null);
    assert.equal(opened.epoch, after.epoch);
    assert.equal(Object.keys(opened.accounts).length, 3);
    // The skipped epoch (the thief's) is the only one it can't read.
    assert.deepEqual(opened.keyProblems.map((p) => p.epoch), [after.epoch - 1]);
    assert.equal(Object.keys(openVault(after, recovery).accounts).length, 3);
    assert.throws(() => openVault(after, thief));
    // A device approved now walks back through the carried key to the old accounts.
    const fresh = device(random);
    agentAppend(vault, [buildDeviceAdd(after, tablet, { device: fresh, role: 'admin', name: 'new', currentKey: opened.currentKey, random, time: vault.now() })]);
    agentAppend(vault, [buildDeviceHello(vault.state(), fresh, vault.now())]);
    assert.equal(Object.keys(openVault(vault.state(), fresh).accounts).length, 3);
  });

  it('restore with the phrase adds the device on the newest key the phrase opens, read-only', () => {
    const { vault, phrase, goodEpoch } = poisonedVault();
    const state = vault.state();
    const fresh = device(random);
    const restored = restoreWithPhrase(state, { phrase, device: fresh, name: 'new', random, time: vault.now() });
    assert.notEqual(restored.readOnly, null);
    assert.equal(restored.epoch, goodEpoch);
    agentAppend(vault, [restored.entry]);
    agentAppend(vault, [buildDeviceHello(vault.state(), fresh, vault.now(), entryHash(restored.entry))]);
    const after = vault.state();
    const opened = openVault(after, fresh);
    assert.equal(Object.keys(opened.accounts).length, 3);
    // Read-only while the poisoned key is current; once the rules drop it (it no longer reaches
    // every device), the restored device holds the current key.
    assert.equal(opened.readOnly === null, opened.epoch === after.epoch);
  });
});

describe('seal proofs in the vault folder', () => {
  it('the agent keeps a proof that holds, refuses one that does not, and serves it with the fork proofs', () => {
    const { vault, tablet, poisoned } = poisonedVault();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-seals-'));
    const store = new VaultStore({ personal: root, team: () => null });
    // In the order they were written: each line names only lines before it.
    for (const item of vault.state().history) store.append(vault.vaultId, [JSON.parse(vault.logs[item.author]![item.seq]!)], false);
    const state = vault.state();
    const proof = makeSealProof(poisoned, tablet, state.keyChecks)!;
    assert.throws(() => store.writeSealProof(vault.vaultId, { ...proof, to: poisoned.author }), /not valid/);
    assert.throws(() => store.writeSealProof(vault.vaultId, { ...proof, extra: 1 }), /malformed/);
    store.writeSealProof(vault.vaultId, proof);
    const read = store.readForks(vault.vaultId);
    assert.deepEqual(read.sealProofs, [proof]);
    assert.deepEqual(read.forks, []);
    // One per author: a later proof of the same author's entry adds nothing.
    store.writeSealProof(vault.vaultId, proof);
    assert.deepEqual(store.readForks(vault.vaultId).sealProofs, [proof]);
  });
});

describe('round-6 PoC R6-D, blocked', () => {
  it('a poisoned key.rotate leaves codes, a removal of the thief, restore and a fresh key', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--import', MULTI_DEVICE_SETUP, path.join(FIXTURES, 'round6', 'r6d_poisoned_rotation.ts')], { encoding: 'utf8', timeout: 300_000 });
    assert.deepEqual(out.split('\n').filter((l) => l.startsWith('PASS')), [], out);
    assert.match(out, /FAIL {2}the owner cannot remove the thief/);
  });
});

