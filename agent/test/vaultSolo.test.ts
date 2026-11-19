/**
 * Solo vaults (0.3.0): one device and the recovery phrase. Only the recovery identity adds a
 * device (a restore, which cuts every earlier device and rotates the key), changes the key or sets
 * a new phrase; a device writes only its hello and its own lines. Each rule is checked in the
 * replay and in the agent's planAppend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, buildKeyRotate, newAccountId } from '../src/vault/build';
import { entryHash, serializeEntry, type SignedEntry } from '../src/vault/entry';
import { openVault } from '../src/vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, recoveryKeysFromPhrase, restoreWithPhrase } from '../src/vault/recovery';
import { replayVault, type VaultState } from '../src/vault/replay';
import { AppendRefused, planAppend } from '../src/vault/logs';
import { checkRollback } from '../src/vault/rollback';
import { quotaProblem, DEFAULT_QUOTA_LIMITS } from '../src/vaultQuota';
import type { DeviceKeys } from '../src/vault/crypto';
import { device, MemoryVault, seededRandom, totpRecord } from './helpers/vault';

const random = seededRandom('solo');

function soloVault(): { v: MemoryVault; phone: DeviceKeys; phrase: string } {
  const phone = device(random);
  const v = MemoryVault.found(phone, random, 'solo');
  const phrase = generateRecoveryPhrase(random);
  const set = buildRecoverySetFromPhrase(v.state(), phone, { phrase, currentKey: v.key, random, time: v.now() });
  v.write(set.entry);
  v.key = set.newKey;
  return { v, phone, phrase };
}

function keyOf(state: VaultState, keys: DeviceKeys): Uint8Array {
  return openVault(state, keys).currentKey;
}

function put(v: MemoryVault, author: DeviceKeys, state = v.state()): SignedEntry {
  return buildAccountPut(state, author, { account: newAccountId(random), record: totpRecord(), currentKey: keyOf(state, author), random, time: v.now() });
}

/** The three lines of a restore, signed on `state`: the recovery identity's add, the new device's hello, the recovery identity's key change. */
function restoreLines(v: MemoryVault, phrase: string, state = v.state()): { lines: SignedEntry[]; newPhone: DeviceKeys } {
  const newPhone = device(random);
  const recovery = recoveryKeysFromPhrase(phrase, v.vaultId);
  const restored = restoreWithPhrase(state, { phrase, device: { deviceId: newPhone.deviceId, edPublic: newPhone.edPublic, xPublic: newPhone.xPublic }, name: 'New phone', random, time: v.now() });
  const logs = { ...v.snapshot() };
  const withAdd = { ...logs, [recovery.deviceId]: [...(logs[recovery.deviceId] ?? []), serializeEntry(restored.entry)] };
  const hello = buildDeviceHello(replayVault(v.vaultId, withAdd), newPhone, v.now(), entryHash(restored.entry));
  const withHello = { ...withAdd, [newPhone.deviceId]: [serializeEntry(hello)] };
  const rotate = buildKeyRotate(replayVault(v.vaultId, withHello), recovery, { currentKey: restored.key, random, time: v.now() });
  return { lines: [restored.entry, hello, rotate.entry], newPhone };
}

function statusOf(state: VaultState, entry: SignedEntry) {
  return state.history.find((h) => h.hash === entryHash(entry));
}

function assertRefused(v: MemoryVault, entry: SignedEntry, pattern: RegExp): void {
  assert.throws(() => planAppend(v.vaultId, v.snapshot(), [entry]), (err: unknown) => err instanceof AppendRefused && pattern.test(err.message));
}

test('a solo vault is created with its first phrase, and the founder is its one device', () => {
  const { v, phone } = soloVault();
  const state = v.state();
  assert.equal(state.kind, 'solo');
  assert.equal(state.rejected.length, 0);
  assert.ok(state.recovery);
  assert.deepEqual(Object.keys(state.members), [phone.deviceId]);
});

test('every line kind a device may not write is rejected in replay and refused by the agent', () => {
  const { v, phone } = soloVault();
  const other = device(random);
  const state = v.state();
  const forbidden: [string, SignedEntry][] = [
    ['device.add', buildDeviceAdd(state, phone, { device: { deviceId: other.deviceId, edPublic: other.edPublic, xPublic: other.xPublic }, role: 'admin', name: 'Puppet', currentKey: v.key, random, time: v.now() })],
    ['key.rotate', buildKeyRotate(state, phone, { currentKey: v.key, random, time: v.now() }).entry],
    ['recovery.set', buildRecoverySetFromPhrase(state, phone, { phrase: generateRecoveryPhrase(random), currentKey: v.key, random, time: v.now() }).entry],
    ['device.remove', buildDeviceRemove(state, phone, { device: state.recovery!.deviceId, currentKey: v.key, random, time: v.now() }).entry],
  ];
  for (const [kind, entry] of forbidden) {
    assertRefused(v, entry, /solo vault/);
    const logs = { ...v.snapshot(), [phone.deviceId]: [...v.logs[phone.deviceId]!, serializeEntry(entry)] };
    const after = replayVault(v.vaultId, logs);
    assert.equal(statusOf(after, entry)?.status, 'rejected', kind);
  }
  // Its own lines still go.
  const own = put(v, phone);
  assert.doesNotThrow(() => planAppend(v.vaultId, v.snapshot(), [own]));
});

test('a restore adds the new phone, cuts the old one at what the phrase had seen, and rotates the key to the two of them', () => {
  const { v, phone, phrase } = soloVault();
  v.write(put(v, phone));
  const before = v.state();
  const { lines, newPhone } = restoreLines(v, phrase);
  const plan = planAppend(v.vaultId, v.snapshot(), lines);
  const state = plan.state;
  for (const line of lines) assert.equal(statusOf(state, line)?.status, 'applied', line.kind);
  assert.equal(state.members[phone.deviceId]!.removed, true);
  assert.equal(state.members[newPhone.deviceId]!.removed, false);
  assert.equal(state.cutoffs[phone.deviceId], before.heads[phone.deviceId]!.seq);
  assert.equal(state.epoch, before.epoch + 1);
  assert.deepEqual(Object.keys(state.sealedKeys[state.epoch]!).sort(), [newPhone.deviceId, state.recovery!.deviceId].sort());
  assert.equal(state.needsFreshKey, false);
  // The accounts made before the restore are still there and readable on the new phone.
  assert.equal(Object.keys(openVault(state, newPhone).accounts).length, 1);
});

test('the agent takes a restore only with its key change; without it the vault needs a fresh key', () => {
  const { v, phrase } = soloVault();
  const { lines } = restoreLines(v, phrase);
  assert.throws(() => planAppend(v.vaultId, v.snapshot(), lines.slice(0, 2)), (err: unknown) => err instanceof AppendRefused && /key change/.test(err.message));
  // A computer that drops the key change: the old phone is still out, and the key it held is flagged.
  for (const line of lines.slice(0, 2)) v.write(line);
  const state = v.state();
  assert.equal(statusOf(state, lines[0]!)?.status, 'applied');
  assert.equal(state.needsFreshKey, true);
});

test("a thief's lines on the old phone after the cut are caught, and later ones are refused", () => {
  const { v, phone, phrase } = soloVault();
  const read = v.state();
  const { lines } = restoreLines(v, phrase, read);
  // The thief writes while the restore is on its way: the computer takes it first.
  const stolen = put(v, phone);
  v.write(planAppend(v.vaultId, v.snapshot(), [stolen]) && stolen);
  const plan = planAppend(v.vaultId, v.snapshot(), lines);
  const item = statusOf(plan.state, stolen)!;
  assert.equal(item.status, 'rejected');
  assert.equal(item.caught, true);
  const later = put(v, phone);
  for (const line of lines) v.write(line);
  // After the restore landed, the old phone's lines are refused outright.
  assert.throws(() => planAppend(v.vaultId, v.snapshot(), [later]), AppendRefused);
});

test('the old phone cannot change the phrase, rotate, add a puppet or remove anyone, before or after a restore', () => {
  const { v, phone, phrase } = soloVault();
  const puppet = device(random);
  const state = v.state();
  const attempts = [
    buildRecoverySetFromPhrase(state, phone, { phrase: generateRecoveryPhrase(random), currentKey: v.key, random, time: v.now() }).entry,
    buildKeyRotate(state, phone, { currentKey: v.key, random, time: v.now() }).entry,
    buildDeviceAdd(state, phone, { device: { deviceId: puppet.deviceId, edPublic: puppet.edPublic, xPublic: puppet.xPublic }, role: 'admin', name: 'Puppet', currentKey: v.key, random, time: v.now() }),
  ];
  for (const entry of attempts) assertRefused(v, entry, /solo vault/);
  const { lines, newPhone } = restoreLines(v, phrase);
  for (const line of lines) v.write(line);
  const after = v.state();
  const removal = buildDeviceRemove(after, phone, { device: newPhone.deviceId, currentKey: v.key, random, time: v.now() }).entry;
  assertRefused(v, removal, /solo vault|removed/);
  const logs = { ...v.snapshot(), [phone.deviceId]: [...v.logs[phone.deviceId]!, serializeEntry(removal)] };
  assert.equal(statusOf(replayVault(v.vaultId, logs), removal)?.status, 'rejected');
  assert.equal(replayVault(v.vaultId, logs).members[newPhone.deviceId]!.removed, false);
});

test('only the current phrase sets a new one, and the old phrase then restores nothing', () => {
  const { v, phrase } = soloVault();
  const { lines, newPhone } = restoreLines(v, phrase);
  for (const line of lines) v.write(line);
  let state = v.state();
  // The device can't, even holding the key.
  const byDevice = buildRecoverySetFromPhrase(state, newPhone, { phrase: generateRecoveryPhrase(random), currentKey: keyOf(state, newPhone), random, time: v.now() }).entry;
  assertRefused(v, byDevice, /solo vault/);
  // The recovery identity can.
  const recovery = recoveryKeysFromPhrase(phrase, v.vaultId);
  const next = generateRecoveryPhrase(random);
  const change = buildRecoverySetFromPhrase(state, recovery, { phrase: next, currentKey: keyOf(state, recovery), random, time: v.now() }).entry;
  planAppend(v.vaultId, v.snapshot(), [change]);
  v.write(change);
  state = v.state();
  assert.equal(statusOf(state, change)?.status, 'applied');
  assert.equal(state.recovery!.deviceId, recoveryKeysFromPhrase(next, v.vaultId).deviceId);
  assert.ok(state.sealedKeys[state.epoch]![newPhone.deviceId], 'the phone keeps the key');
  // The old phrase is out: it can't restore any more.
  assert.throws(() => restoreLines(v, phrase), /not the current recovery phrase/);
  // And the new one restores.
  const again = restoreLines(v, next);
  const plan = planAppend(v.vaultId, v.snapshot(), again.lines);
  assert.equal(plan.state.members[newPhone.deviceId]!.removed, true);
});

test('a phone that forks its own log is cut at the seq before the fork', () => {
  const { v, phone } = soloVault();
  v.write(put(v, phone));
  const state = v.state();
  const a = put(v, phone, state);
  const b = put(v, phone, state);
  v.write(a);
  const proof = { deviceId: phone.deviceId, seq: a.seq, lines: [serializeEntry(a), serializeEntry(b)] as [string, string] };
  const forked = replayVault(v.vaultId, v.snapshot(), { forks: [proof] });
  assert.equal(forked.forked[phone.deviceId], a.seq);
  assert.equal(forked.cutoffs[phone.deviceId], a.seq - 1);
  assert.equal(statusOf(forked, a)?.status, 'rejected');
});

test('a computer that rolls the folder back past a restore shows as withholding it', () => {
  const { v, phrase } = soloVault();
  const rolledBack = v.snapshot();
  const { lines } = restoreLines(v, phrase);
  for (const line of lines) v.write(line);
  const remembered = checkRollback({}, v.state()).heads;
  const check = checkRollback(remembered, replayVault(v.vaultId, rolledBack));
  const withheld = new Set(check.problems.filter((p) => p.kind === 'rolled-back').map((p) => p.deviceId));
  assert.ok(withheld.has(lines[0]!.author), 'the recovery identity\'s lines');
  assert.ok(withheld.has(lines[1]!.author), 'the new phone\'s hello');
});

test("a restore and the phrase's own lines pass a full vault and a full share", () => {
  const { v, phone, phrase } = soloVault();
  for (let i = 0; i < 6; i++) v.write(put(v, phone));
  const limits = { ...DEFAULT_QUOTA_LIMITS, admin: { lines: 4, bytes: 1 << 20 }, member: { lines: 4, bytes: 1 << 20 }, vault: { lines: 4, bytes: 1 << 20 } };
  const { lines } = restoreLines(v, phrase);
  const plan = planAppend(v.vaultId, v.snapshot(), lines);
  assert.equal(quotaProblem(plan.state, plan.logs, new Set(lines.map(entryHash)), limits, plan.before), null);
  for (const line of lines) v.write(line);
  const state = v.state();
  const recovery = recoveryKeysFromPhrase(phrase, v.vaultId);
  const change = buildRecoverySetFromPhrase(state, recovery, { phrase: generateRecoveryPhrase(random), currentKey: keyOf(state, recovery), random, time: v.now() }).entry;
  const plan2 = planAppend(v.vaultId, v.snapshot(), [change]);
  assert.equal(quotaProblem(plan2.state, plan2.logs, new Set([entryHash(change)]), limits, plan2.before), null);
});

for (const kind of ['personal', 'team'] as const) {
  test(`in a ${kind} vault the recovery identity's key change and new phrase are refused`, () => {
    const phone = device(random);
    const v = MemoryVault.found(phone, random, kind);
    const phrase = generateRecoveryPhrase(random);
    const set = buildRecoverySetFromPhrase(v.state(), phone, { phrase, currentKey: v.key, random, time: v.now() });
    v.write(set.entry);
    const state = v.state();
    const recovery = recoveryKeysFromPhrase(phrase, v.vaultId);
    const key = keyOf(state, recovery);
    const lines = [
      buildKeyRotate(state, recovery, { currentKey: key, random, time: v.now() }).entry,
      buildRecoverySetFromPhrase(state, recovery, { phrase: generateRecoveryPhrase(random), currentKey: key, random, time: v.now() }).entry,
    ];
    for (const entry of lines) {
      assertRefused(v, entry, /only a solo vault/);
      const after = replayVault(v.vaultId, { ...v.snapshot(), [recovery.deviceId]: [serializeEntry(entry)] });
      assert.equal(statusOf(after, entry)?.status, 'rejected', entry.kind);
      assert.equal(after.recovery!.deviceId, recovery.deviceId);
      assert.equal(after.epoch, state.epoch);
    }
  });
}
