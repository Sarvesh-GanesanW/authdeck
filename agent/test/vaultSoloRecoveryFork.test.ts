/**
 * Rule A1.2 (replay.ts soloRecoveryVersions): in a solo vault a proven fork of the recovery
 * identity R never cuts R. At R's forked seq one version counts, the same on every copy: the one
 * later lines build on, else the lowest entry hash. Both routes a hostile computer has to collect
 * two R lines at one seq (a refused phrase change signed again, a refused restore signed again)
 * leave the phrase working; the result doesn't depend on which version the folder took first,
 * and the agent's VaultStore and the replay agree.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAccountPut, buildDeviceHello, buildKeyRotate, newAccountId } from '../src/vault/build';
import { entryHash, serializeEntry, type SignedEntry } from '../src/vault/entry';
import { openVault } from '../src/vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, recoveryKeysFromPhrase, restoreWithPhrase } from '../src/vault/recovery';
import { LOST_RECOVERY_VERSION, replayVault, type VaultState } from '../src/vault/replay';
import type { VaultLogs } from '../src/vault/chain';
import type { ForkProof } from '../src/vault/chain';
import type { DeviceKeys } from '../src/vault/crypto';
import { MULTI_DEVICE_VAULTS, vaultFeatures } from '../src/vault/features';
import { VaultStore } from '../src/vaultStore';
import { device, MemoryVault, seededRandom, totpRecord } from './helpers/vault';

const random = seededRandom('solo-recovery-fork');
let home: string;
let store: VaultStore;

beforeEach(() => {
  vaultFeatures.multiDevice = MULTI_DEVICE_VAULTS;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-rfork-'));
  store = new VaultStore({ personal: path.join(home, 'vault'), team: () => null });
});

afterEach(() => {
  vaultFeatures.multiDevice = true;
  fs.rmSync(home, { recursive: true, force: true });
});

function soloVault(): { v: MemoryVault; phone: DeviceKeys; phrase: string } {
  const phone = device(random);
  const v = MemoryVault.found(phone, random, 'solo');
  const phrase = generateRecoveryPhrase(random);
  const set = buildRecoverySetFromPhrase(v.state(), phone, { phrase, currentKey: v.key, random, time: v.now() });
  v.write(set.entry);
  v.key = set.newKey;
  return { v, phone, phrase };
}

/** The folder as the agent holds it. */
function folder(vaultId: string): Record<string, string[]> {
  const logs = store.read(vaultId, {}).logs;
  return Object.fromEntries(Object.entries(logs).map(([id, page]) => [id, page.lines]));
}

function storeAll(v: MemoryVault): void {
  for (const lines of Object.values(v.snapshot())) store.append(v.vaultId, lines.map((l) => JSON.parse(l)), false);
}

/** A phrase change R signs on `state`: a new phrase and its recovery.set. */
function phraseChange(v: MemoryVault, phrase: string, state: VaultState): { entry: SignedEntry; phrase: string } {
  const recovery = recoveryKeysFromPhrase(phrase, v.vaultId);
  const next = generateRecoveryPhrase(random);
  const { entry, newKey } = buildRecoverySetFromPhrase(state, recovery, { phrase: next, currentKey: openVault(state, recovery).currentKey, random, time: v.now() });
  newKey.fill(0);
  return { entry, phrase: next };
}

/** A restore's three lines, signed on `logs`. */
function restore(v: MemoryVault, phrase: string, logs: VaultLogs, forks: ForkProof[] = []): { lines: SignedEntry[]; newPhone: DeviceKeys } {
  const state = replayVault(v.vaultId, logs, { forks });
  const newPhone = device(random);
  const recovery = recoveryKeysFromPhrase(phrase, v.vaultId);
  const restored = restoreWithPhrase(state, { phrase, device: newPhone, name: 'New phone', random, time: v.now() });
  const withAdd = { ...logs, [recovery.deviceId]: [...(logs[recovery.deviceId] ?? []), serializeEntry(restored.entry)] };
  const hello = buildDeviceHello(replayVault(v.vaultId, withAdd, { forks }), newPhone, v.now(), entryHash(restored.entry));
  const rotate = buildKeyRotate(replayVault(v.vaultId, { ...withAdd, [newPhone.deviceId]: [serializeEntry(hello)] }, { forks }), recovery, { currentKey: restored.key, random, time: v.now() });
  return { lines: [restored.entry, hello, rotate.entry], newPhone };
}

const proofOf = (a: SignedEntry, b: SignedEntry): ForkProof => ({ deviceId: a.author, seq: a.seq, lines: [serializeEntry(a), serializeEntry(b)] });

function writeProof(vaultId: string, proof: ForkProof): void {
  store.writeFork(vaultId, proof);
}

for (const sent of ['the winner', 'the loser'] as const)
test(`the phrase route: two phrase changes at one seq, a proof, and the phrase still works on the agent and in the replay (the phone sends ${sent})`, () => {
  const { v, phrase } = soloVault();
  storeAll(v);
  const before = replayVault(v.vaultId, folder(v.vaultId));
  // The computer refused both and kept them: neither is in the folder.
  const [low, high] = [phraseChange(v, phrase, before), phraseChange(v, phrase, before)].sort((x, y) => (entryHash(x.entry) < entryHash(y.entry) ? -1 : 1));
  const [a, b] = sent === 'the winner' ? [low!, high!] : [high!, low!];
  assert.equal(a.entry.seq, b.entry.seq);
  const proof = proofOf(a.entry, b.entry);
  // Until the folder holds a line of R at that seq, the proof changes nothing.
  const none = replayVault(v.vaultId, folder(v.vaultId), { forks: [proof] });
  assert.equal(none.recovery?.deviceId, before.recovery?.deviceId);
  assert.equal(Object.hasOwn(none.forked, a.entry.author), false);
  // The proof reaches the folder, and the phone sends its one pending change. A losing line is
  // kept as a placeholder or refused; either way the winner counts.
  writeProof(v.vaultId, proof);
  try {
    store.append(v.vaultId, [a.entry], false);
  } catch (err) {
    assert.equal(sent, 'the loser', (err as Error).message);
  }
  if (folder(v.vaultId)[a.entry.author] === undefined) {
    // Refused: the phone learns its line lost when it sends the winner's seq is taken; here nothing holds R's seq yet.
    store.append(v.vaultId, [b.entry], false);
  }
  const logs = folder(v.vaultId);
  const state = replayVault(v.vaultId, logs, { forks: [proof] });
  const winner = low!;
  assert.equal(state.recovery?.deviceId, recoveryKeysFromPhrase(winner.phrase, v.vaultId).deviceId, 'the lower hash wins when nothing builds on either');
  assert.equal(Object.hasOwn(state.forked, a.entry.author), false, 'R is never cut by its fork');
  if (winner === b) assert.equal(state.history.find((h) => h.hash === entryHash(a.entry))?.reason, LOST_RECOVERY_VERSION);
  // The winning phrase restores through the honest agent, with the proof in the folder.
  const { lines, newPhone } = restore(v, winner.phrase, logs, [proof]);
  store.append(v.vaultId, lines, false);
  const after = replayVault(v.vaultId, folder(v.vaultId), { forks: [proof] });
  assert.equal(after.members[newPhone.deviceId]?.removed, false);
  // And it can make a new phrase after that.
  const later = phraseChange(v, winner.phrase, after);
  store.append(v.vaultId, [later.entry], false);
  assert.equal(replayVault(v.vaultId, folder(v.vaultId), { forks: [proof] }).recovery?.deviceId, recoveryKeysFromPhrase(later.phrase, v.vaultId).deviceId);
});

test('the restore route: a refused restore and a landed one at one seq of R; the landed one counts and the phrase keeps restoring', () => {
  const { v, phone, phrase } = soloVault();
  storeAll(v);
  const first = restore(v, phrase, folder(v.vaultId));
  const second = restore(v, phrase, folder(v.vaultId));
  store.append(v.vaultId, second.lines, false);
  assert.equal(first.lines[0]!.seq, second.lines[0]!.seq);
  const proof = proofOf(first.lines[0]!, second.lines[0]!);
  // The honest agent refuses it (N1): the landed restore's hello already built on that line.
  assert.throws(() => writeProof(v.vaultId, proof), /already built on the recovery phrase's line/);
  // A computer that writes it in anyway: the landed one still counts.
  const state = replayVault(v.vaultId, folder(v.vaultId), { forks: [proof] });
  assert.equal(state.members[second.newPhone.deviceId]?.removed, false, 'the version later lines build on counts, whatever the hashes');
  assert.equal(state.members[phone.deviceId]?.removed, true);
  assert.equal(Object.hasOwn(state.forked, first.lines[0]!.author), false);
  const third = restore(v, phrase, folder(v.vaultId));
  store.append(v.vaultId, third.lines, false);
  assert.equal(replayVault(v.vaultId, folder(v.vaultId), { forks: [proof] }).members[third.newPhone.deviceId]?.removed, false);
});

test('a fork whose versions reach the folder in either order gives the same vault', () => {
  const { v, phrase } = soloVault();
  const base = v.snapshot();
  const state = replayVault(v.vaultId, base);
  const a = phraseChange(v, phrase, state);
  const b = phraseChange(v, phrase, state);
  const proof = proofOf(a.entry, b.entry);
  const recoveryId = a.entry.author;
  const withA = { ...base, [recoveryId]: [serializeEntry(a.entry)] };
  const withB = { ...base, [recoveryId]: [serializeEntry(b.entry)] };
  const fromA = replayVault(v.vaultId, withA, { forks: [proof] });
  const fromB = replayVault(v.vaultId, withB, { forks: [{ ...proof, lines: [proof.lines[1], proof.lines[0]] }] });
  assert.equal(fromA.recovery?.deviceId, fromB.recovery?.deviceId);
  assert.equal(fromA.epoch, fromB.epoch);
  assert.deepEqual(fromA.chains[recoveryId], fromB.chains[recoveryId]);
});

test('the lines of a device only the losing restore brings in are rejected, its account lines caught', () => {
  const { v, phrase } = soloVault();
  const base = v.snapshot();
  // Two restores signed on the same folder; the folder holds the second's add only, and the
  // first's new phone wrote a hello and nothing builds on the second: then the first is built on.
  const first = restore(v, phrase, base);
  const second = restore(v, phrase, base);
  const recoveryId = first.lines[0]!.author;
  const logs = { ...base, [recoveryId]: [serializeEntry(second.lines[0]!)], [first.newPhone.deviceId]: [serializeEntry(first.lines[1]!)] };
  const state = replayVault(v.vaultId, logs, { forks: [proofOf(first.lines[0]!, second.lines[0]!)] });
  // The first is built on (its hello names it): it wins, and the folder's line loses.
  assert.equal(state.chains[recoveryId]![first.lines[0]!.seq], entryHash(first.lines[0]!));
  assert.equal(state.history.find((h) => h.hash === entryHash(second.lines[0]!))?.reason, LOST_RECOVERY_VERSION);
  // Both built on: the lower hash wins, and the other new phone's lines are rejected.
  const both = { ...logs, [second.newPhone.deviceId]: [serializeEntry(second.lines[1]!)] };
  const decided = replayVault(v.vaultId, both, { forks: [proofOf(first.lines[0]!, second.lines[0]!)] });
  const [win, lose] = entryHash(first.lines[0]!) < entryHash(second.lines[0]!) ? [first, second] : [second, first];
  assert.equal(decided.chains[recoveryId]![0], entryHash(win.lines[0]!));
  const lostHello = decided.history.find((h) => h.hash === entryHash(lose.lines[1]!));
  assert.equal(lostHello?.status, 'rejected');
});

test('a fork proof of a device in a solo vault still cuts the device', () => {
  const { v, phone } = soloVault();
  const state = v.state();
  const k = openVault(state, phone).currentKey;
  const x = buildAccountPut(state, phone, { account: newAccountId(random), record: totpRecord(), currentKey: k, random, time: v.now() });
  const y = buildAccountPut(state, phone, { account: newAccountId(random), record: totpRecord(), currentKey: k, random, time: v.now() });
  const logs = { ...v.snapshot(), [phone.deviceId]: [...v.snapshot()[phone.deviceId]!, serializeEntry(x)] };
  const cut = replayVault(v.vaultId, logs, { forks: [proofOf(x, y)] });
  assert.equal(cut.forked[phone.deviceId], x.seq);
});
