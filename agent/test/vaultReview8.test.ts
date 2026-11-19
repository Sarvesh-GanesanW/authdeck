/**
 * The checker's solo holes (review 8), on the vault core the agent and the app share:
 * - pinning: a cut identity's lines that standing identities' applied lines name are written
 *   back by a repair over junk or another version, and nothing past them;
 * - lines are normalised on read: a re-encoded log reads as its entries, a restore builds on it,
 *   and the computer writes it back canonical; a repair writes a founding line or R's lines over junk;
 * - rule A1.2: an R version the active device built on can't be beaten by someone holding the
 *   phrase, however many versions they grind or chain; junk and R's own chaining never decide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountPut, buildDeviceHello, buildDeviceRename, buildKeyRotate, newAccountId } from '../src/vault/build';
import { entryHash, serializeEntry, type SignedEntry } from '../src/vault/entry';
import { AppendRefused, planAppend } from '../src/vault/logs';
import { openVault } from '../src/vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, recoveryKeysFromPhrase, restoreWithPhrase } from '../src/vault/recovery';
import { replayVault, type VaultState } from '../src/vault/replay';
import type { ForkProof, VaultLogs } from '../src/vault/chain';
import type { DeviceKeys } from '../src/vault/crypto';
import { toBase64Url } from '../src/vault/bytes';
import { MULTI_DEVICE_VAULTS, vaultFeatures } from '../src/vault/features';
import { device, MemoryVault, seededRandom, soloRestoreLines, totpRecord } from './helpers/vault';

vaultFeatures.multiDevice = MULTI_DEVICE_VAULTS;
const random = seededRandom('review-8');

function soloVault(): { v: MemoryVault; phone: DeviceKeys; phrase: string } {
  const phone = device(random);
  const v = MemoryVault.found(phone, random, 'solo');
  const phrase = generateRecoveryPhrase(random);
  const set = buildRecoverySetFromPhrase(v.state(), phone, { phrase, currentKey: v.key, random, time: v.now() });
  v.write(set.entry);
  v.key = set.newKey;
  return { v, phone, phrase };
}

const copy = (logs: VaultLogs): Record<string, string[]> => Object.fromEntries(Object.entries(logs).map(([id, lines]) => [id, [...lines]]));
const junk = (line: string) => serializeEntry({ ...(JSON.parse(line) as SignedEntry), sig: toBase64Url(random(64)) });

/** A solo vault with account a1 by the phone F (F#2), restored onto a new phone D: F is cut after F#2. */
function restored() {
  const { v, phone, phrase } = soloVault();
  const put = buildAccountPut(v.state(), phone, { account: newAccountId(random), record: totpRecord(), currentKey: v.key, random, time: v.now() });
  v.write(put);
  const D = device(random);
  for (const entry of soloRestoreLines(v.vaultId, v.logs, phrase, D, random, v.now())) v.write(entry);
  const account = put.body.account as string;
  return { v, phone, phrase, D, put, account, logs: v.snapshot() };
}

const proofOf = (logs: VaultLogs, id: string): Record<string, { seq: number; hash: string }> => {
  const last = JSON.parse(logs[id]!.at(-1)!) as SignedEntry;
  return { [id]: { seq: last.seq, hash: entryHash(last) } };
};

test('S4: a repair writes a cut phone\'s pinned line back over junk, and the account returns', () => {
  const { v, phone, account, logs } = restored();
  assert.ok(replayVault(v.vaultId, logs).accounts[account]);
  const folder = copy(logs);
  folder[phone.deviceId]![2] = junk(folder[phone.deviceId]![2]!);
  assert.equal(replayVault(v.vaultId, folder).accounts[account], undefined);
  const before = replayVault(v.vaultId, folder);
  assert.equal(before.pins?.[phone.deviceId]?.hash, entryHash(JSON.parse(logs[phone.deviceId]![2]!)));
  const entries = logs[phone.deviceId]!.map((l) => JSON.parse(l));
  const plan = planAppend(v.vaultId, folder, entries, { repair: true, proof: proofOf(logs, phone.deviceId) });
  assert.ok(plan.state.accounts[account]);
  assert.deepEqual(plan.logs[phone.deviceId], logs[phone.deviceId]);
});

test('S4: a repair writes the pinned version back over another version the thief signed at that seq', () => {
  const { v, phone, account, logs, D } = restored();
  const folder = copy(logs);
  // The thief (F's keys and its copy before F#2) signs another F#2.
  const preState = replayVault(v.vaultId, Object.fromEntries(Object.entries(logs).filter(([id]) => id === phone.deviceId).map(([id, l]) => [id, l.slice(0, 2)])));
  const other = buildAccountPut(preState, phone, { account: newAccountId(random), record: totpRecord({ issuer: 'thief' }), currentKey: openVault(preState, phone).currentKey, random, time: v.now() });
  folder[phone.deviceId]![2] = serializeEntry(other);
  assert.equal(replayVault(v.vaultId, folder).accounts[account], undefined);
  const plan = planAppend(v.vaultId, folder, [JSON.parse(logs[phone.deviceId]![2]!)], { repair: true, proof: proofOf(logs, phone.deviceId) });
  assert.ok(plan.state.accounts[account]);
  assert.equal(plan.state.accounts[other.body.account as string], undefined);
  assert.ok(plan.state.members[D.deviceId] && !plan.state.members[D.deviceId]!.removed);
});

test('a pinned line can\'t be used to bring back anything past the cut', () => {
  const { v, phone, logs } = restored();
  const folder = copy(logs);
  folder[phone.deviceId]![2] = junk(folder[phone.deviceId]![2]!);
  // The thief's next line, chaining on the real F#2: past the cut.
  const withReal = replayVault(v.vaultId, Object.fromEntries([[phone.deviceId, logs[phone.deviceId]!]]));
  const past = buildAccountPut(withReal, phone, { account: newAccountId(random), record: totpRecord({ issuer: 'thief' }), currentKey: openVault(withReal, phone).currentKey, random, time: v.now() });
  const real = JSON.parse(logs[phone.deviceId]![2]!) as SignedEntry;
  const head = { [phone.deviceId]: { seq: past.seq, hash: entryHash(past) } };
  assert.throws(() => planAppend(v.vaultId, folder, [real, past], { repair: true, proof: head }), AppendRefused);
  assert.throws(() => planAppend(v.vaultId, logs, [past], { repair: true, proof: head }), AppendRefused);
  assert.throws(() => planAppend(v.vaultId, logs, [past]), AppendRefused);
  // Not a repair: nothing from a cut author, pinned or not.
  assert.throws(() => planAppend(v.vaultId, folder, [real]), AppendRefused);
});

test('a re-encoded log reads as its entries, a restore builds on it, and the computer writes it back canonical', () => {
  const { v, phone, phrase } = soloVault();
  v.write(buildAccountPut(v.state(), phone, { account: newAccountId(random), record: totpRecord(), currentKey: v.key, random, time: v.now() }));
  const clean = v.snapshot();
  const padded = copy(clean);
  padded[phone.deviceId] = padded[phone.deviceId]!.map((line) => line.replace('{', '{ ').replace(/,"/g, ', "'));
  const a = replayVault(v.vaultId, clean);
  const b = replayVault(v.vaultId, padded);
  assert.deepEqual(b.chains, a.chains);
  assert.deepEqual(Object.keys(b.accounts), Object.keys(a.accounts));
  assert.equal(b.recovery?.deviceId, a.recovery?.deviceId);
  assert.deepEqual(Object.keys(b.reencoded ?? {}), [phone.deviceId]);
  const lines = soloRestoreLines(v.vaultId, padded, phrase, device(random), random, v.now());
  const plan = planAppend(v.vaultId, padded, lines);
  assert.ok(plan.changed.includes(phone.deviceId));
  assert.deepEqual(plan.logs[phone.deviceId], clean[phone.deviceId]);
  // An exact retry over a re-encoded log changes nothing but the text.
  const retry = planAppend(v.vaultId, padded, clean[phone.deviceId]!.map((l) => JSON.parse(l)), { repair: true, proof: proofOf(clean, phone.deviceId) });
  assert.deepEqual(retry.changed, [phone.deviceId]);
  assert.deepEqual(retry.logs[phone.deviceId], clean[phone.deviceId]);
});

test('a line past the raw cap is never parsed', () => {
  const { v, phone } = soloVault();
  const logs = copy(v.snapshot());
  logs[phone.deviceId]![1] = logs[phone.deviceId]![1]!.replace('{', `{${' '.repeat(130 * 1024)}`);
  assert.equal(replayVault(v.vaultId, logs).chains[phone.deviceId]?.length, 1);
});

test('a repair writes the founding line and R\'s lines back over junk', () => {
  const { v, phone, logs, D } = restored();
  const recoveryId = Object.keys(logs).find((id) => id !== phone.deviceId && id !== D.deviceId)!;
  const noFounder = copy(logs);
  noFounder[phone.deviceId]![0] = junk(noFounder[phone.deviceId]![0]!);
  assert.equal(replayVault(v.vaultId, noFounder).created, false);
  const founding = JSON.parse(logs[phone.deviceId]![0]!) as SignedEntry;
  const fixed = planAppend(v.vaultId, noFounder, [founding], { repair: true, proof: { [phone.deviceId]: { seq: 0, hash: entryHash(founding) } } });
  assert.equal(fixed.state.created, true);
  const noR = copy(logs);
  noR[recoveryId] = noR[recoveryId]!.map(junk);
  const rLines = logs[recoveryId]!.map((l) => JSON.parse(l) as SignedEntry);
  const back = planAppend(v.vaultId, noR, rLines, { repair: true, proof: proofOf(logs, recoveryId) });
  assert.deepEqual(back.state.chains, replayVault(v.vaultId, logs).chains);
});

/** The owner's phrase change H at R's seq, built on at once by the phone's rename naming it; then `n` versions an old-phrase holder grinds. */
function phraseFork(n: number) {
  const { v, phone, phrase } = soloVault();
  const recovery = recoveryKeysFromPhrase(phrase, v.vaultId);
  const base = v.state();
  const key = openVault(base, recovery).currentKey;
  const honest = buildRecoverySetFromPhrase(base, recovery, { phrase: generateRecoveryPhrase(random), currentKey: key, random, time: v.now() });
  v.write(honest.entry);
  const withH = v.state();
  const ack = buildDeviceRename(withH, phone, { device: phone.deviceId, name: 'Phone', currentKey: openVault(withH, phone).currentKey, random, time: v.now() });
  v.write(ack);
  const ground: { entry: SignedEntry; phrase: string }[] = [];
  for (let i = 0; i < n; i++) {
    const p = generateRecoveryPhrase(random);
    ground.push({ entry: buildRecoverySetFromPhrase(base, recovery, { phrase: p, currentKey: key, random, time: v.now() }).entry, phrase: p });
  }
  ground.sort((a, b) => (entryHash(a.entry) < entryHash(b.entry) ? -1 : 1));
  return { v, phone, phrase, recovery, honest: honest.entry, ground, logs: v.snapshot() };
}

/** The attacker's version in the folder at R's seq, chained on by its own next line and junk; the honest one in a proof. */
function attackedFolder(logs: VaultLogs, recoveryId: string, attack: { entry: SignedEntry; phrase: string }): Record<string, string[]> {
  const folder = copy(logs);
  // R's next line chaining on the attacker's version (unsigned: the old phrase holder could sign one, and R's chaining never counts anyway).
  const chained = { ...attack.entry, seq: 1, prev: entryHash(attack.entry), time: attack.entry.time + 1 };
  folder[recoveryId] = [serializeEntry(attack.entry), junk(serializeEntry(chained as SignedEntry))];
  return folder;
}

test('A1.2: an old-phrase holder grinding 1000 versions, chained and junk-followed, never beats the version the active device built on (agent and app)', async () => {
  const { v, recovery, honest, ground, logs } = phraseFork(1000);
  const appReplay = (await import(new URL('../../app/src/vault/replay.ts', import.meta.url).href)).replayVault as typeof replayVault;
  const lowest = ground[0]!;
  assert.ok(entryHash(lowest.entry) < entryHash(honest) || ground.some((g) => entryHash(g.entry) < entryHash(honest)), 'grinding found versions with a lower hash than the honest one');
  for (const attack of ground.slice(0, 10)) {
    const proof: ForkProof = { deviceId: recovery.deviceId, seq: 0, lines: [serializeEntry(attack.entry), serializeEntry(honest)] };
    const attacked = attackedFolder(logs, recovery.deviceId, attack);
    for (const [label, folder, forks] of [
      ['attacker in the folder', attacked, [proof]],
      ['honest in the folder', copy(logs), [{ ...proof, lines: [proof.lines[1], proof.lines[0]] as [string, string] }]],
    ] as const) {
      for (const replay of [replayVault, appReplay]) {
        const state: VaultState = replay(v.vaultId, folder, { forks });
        assert.equal(state.chains[recovery.deviceId]?.[0], entryHash(honest), `${label}: the honest version counts`);
        assert.notEqual(state.recovery?.deviceId, recoveryKeysFromPhrase(attack.phrase, v.vaultId).deviceId, label);
      }
    }
  }
  // Every one of the 1000 against the honest folder: none ever counts.
  for (const attack of ground) {
    const proof: ForkProof = { deviceId: recovery.deviceId, seq: 0, lines: [serializeEntry(honest), serializeEntry(attack.entry)] };
    assert.equal(replayVault(v.vaultId, logs, { forks: [proof] }).chains[recovery.deviceId]?.[0], entryHash(honest));
  }
});

test('A1.2: with no standing builder, junk naming a version or R chaining on it decides nothing (the lowest hash counts)', () => {
  const { v, phone, phrase } = soloVault();
  const recovery = recoveryKeysFromPhrase(phrase, v.vaultId);
  const base = v.state();
  const key = openVault(base, recovery).currentKey;
  const [a, b] = [0, 1].map(() => buildRecoverySetFromPhrase(base, recovery, { phrase: generateRecoveryPhrase(random), currentKey: key, random, time: v.now() }).entry).sort((x, y) => (entryHash(x) < entryHash(y) ? -1 : 1));
  const proof: ForkProof = { deviceId: recovery.deviceId, seq: 0, lines: [serializeEntry(a!), serializeEntry(b!)] };
  const logs = v.snapshot();
  // The folder holds b, chained on by a junk R line, and a junk phone line naming b.
  const higher = { ...logs, [recovery.deviceId]: [serializeEntry(b!), junk(serializeEntry({ ...b!, seq: 1, prev: entryHash(b!) }))] };
  const st = replayVault(v.vaultId, higher);
  const fakeAck = buildDeviceRename(st, phone, { device: phone.deviceId, name: 'Phone', currentKey: openVault(st, phone).currentKey, random, time: v.now() });
  higher[phone.deviceId] = [...higher[phone.deviceId]!, junk(serializeEntry(fakeAck))];
  assert.equal(replayVault(v.vaultId, higher, { forks: [proof] }).chains[recovery.deviceId]?.[0], entryHash(a!));
});

const appReplayOf = async () => (await import(new URL('../../app/src/vault/replay.ts', import.meta.url).href)).replayVault as typeof replayVault;

/**
 * `n` restores signed with `phrase` on `logs` (n adds ground; the lowest-hashing one completed
 * with its hello and R's key change), as a thief holding an old phrase or a hostile computer
 * keeping refused attempts would.
 */
function groundRestore(vaultId: string, logs: VaultLogs, phrase: string, n: number, time: number) {
  const base = replayVault(vaultId, logs);
  const recovery = recoveryKeysFromPhrase(phrase, vaultId);
  let best: { add: SignedEntry; key: Uint8Array; device: DeviceKeys } | null = null;
  for (let i = 0; i < n; i++) {
    const thief = device(random);
    const restored = restoreWithPhrase(base, { phrase, device: thief, name: 'Thief', random, time });
    if (!best || entryHash(restored.entry) < entryHash(best.add)) best = { add: restored.entry, key: restored.key, device: thief };
  }
  const { add, key, device: thief } = best!;
  const withAdd = { ...logs, [recovery.deviceId]: [...(logs[recovery.deviceId] ?? []), serializeEntry(add)] };
  const hello = buildDeviceHello(replayVault(vaultId, withAdd), thief, time, entryHash(add));
  const withHello = { ...withAdd, [thief.deviceId]: [serializeEntry(hello)] };
  const rotate = buildKeyRotate(replayVault(vaultId, withHello), recovery, { currentKey: key, random, time: time + 1 }).entry;
  return { add, hello, rotate, thief };
}

test('P4: an old phrase grinding 1000 restores at the phrase change\'s seq never takes the vault back, ack in the folder or withheld (agent and app)', async () => {
  const appReplay = await appReplayOf();
  const { v, phone, phrase: old, recovery, honest, logs } = phraseFork(0);
  const before = Object.fromEntries(Object.entries(logs).map(([id, lines]) => [id, id === recovery.deviceId ? [] : lines.slice(0, id === phone.deviceId ? lines.length - 1 : lines.length)]).filter(([, l]) => (l as string[]).length > 0));
  const attack = groundRestore(v.vaultId, before, old, 1000, v.now());
  assert.ok(entryHash(attack.add) < entryHash(honest), 'the grind found a restore hashing below the phrase change');
  const proof: ForkProof = { deviceId: recovery.deviceId, seq: 0, lines: [serializeEntry(attack.add), serializeEntry(honest)] };
  const ack = logs[phone.deviceId]!.at(-1)!;
  for (const withAck of [true, false]) {
    const folder = copy(logs);
    folder[recovery.deviceId] = [serializeEntry(attack.add), serializeEntry(attack.rotate)];
    folder[attack.thief.deviceId] = [serializeEntry(attack.hello)];
    if (!withAck) folder[phone.deviceId] = folder[phone.deviceId]!.filter((l) => l !== ack);
    for (const replay of [replayVault, appReplay]) {
      const state = replay(v.vaultId, folder, { forks: [proof] });
      assert.equal(state.chains[recovery.deviceId]?.[0], entryHash(honest), `ack ${withAck}: the phrase change counts`);
      assert.ok(!Object.hasOwn(state.members, attack.thief.deviceId), `ack ${withAck}: the thief is not in`);
      assert.ok(state.members[phone.deviceId] && !state.members[phone.deviceId]!.removed, `ack ${withAck}: the phone stays in`);
    }
  }
});

test('rule 5: an old phrase grinding 1000 recovery.sets wins only while the ack is withheld, and the phone writes its ack back over it (agent and app)', async () => {
  const appReplay = await appReplayOf();
  const { v, phone, recovery, honest, ground, logs } = phraseFork(1000);
  const lowest = ground[0]!;
  assert.ok(entryHash(lowest.entry) < entryHash(honest));
  const ackLine = logs[phone.deviceId]!.at(-1)!;
  const ack = JSON.parse(ackLine) as SignedEntry;
  const folder = copy(logs);
  folder[recovery.deviceId] = [serializeEntry(lowest.entry)];
  folder[phone.deviceId] = folder[phone.deviceId]!.slice(0, -1);
  const proof: ForkProof = { deviceId: recovery.deviceId, seq: 0, lines: [serializeEntry(lowest.entry), serializeEntry(honest)] };
  // The edge the docs list: ack withheld, two recovery.sets, the lowest hash.
  for (const replay of [replayVault, appReplay]) assert.equal(replay(v.vaultId, folder, { forks: [proof] }).chains[recovery.deviceId]?.[0], entryHash(lowest.entry));
  const head = { [phone.deviceId]: { seq: ack.seq, hash: entryHash(ack) } };
  for (const options of [{ repair: true, proof: head, forks: [proof] }, { forks: [proof] }]) {
    const plan = planAppend(v.vaultId, folder, [ack], options);
    assert.equal(plan.logs[phone.deviceId]!.at(-1), ackLine);
    for (const replay of [replayVault, appReplay]) {
      const state = replay(v.vaultId, plan.logs, { forks: [proof] });
      assert.equal(state.chains[recovery.deviceId]?.[0], entryHash(honest), 'the ack written back decides');
      assert.equal(state.chains[phone.deviceId]?.at(-1), entryHash(ack));
    }
  }
});

test('P1: between restores, the one whose new device signed more lines counts, whatever the hashes; equal, the lowest hash', async () => {
  const appReplay = await appReplayOf();
  const { v, phrase } = soloVault();
  const logs = v.snapshot();
  const attempts = [0, 1, 2, 3].map(() => groundRestore(v.vaultId, logs, phrase, 1, v.now())).sort((a, b) => (entryHash(a.add) < entryHash(b.add) ? -1 : 1));
  const [low, high] = [attempts[0]!, attempts[3]!];
  const recoveryId = recoveryKeysFromPhrase(phrase, v.vaultId).deviceId;
  // The honest restore (high) took the folder and its phone made a change; the computer writes the low one over it.
  const honest = copy(logs);
  honest[recoveryId] = [serializeEntry(high.add), serializeEntry(high.rotate)];
  honest[high.thief.deviceId] = [serializeEntry(high.hello)];
  const st = replayVault(v.vaultId, honest);
  const put = buildAccountPut(st, high.thief, { account: newAccountId(random), record: totpRecord(), currentKey: openVault(st, high.thief).currentKey, random, time: v.now() });
  honest[high.thief.deviceId]!.push(serializeEntry(put));
  const flipped = copy(honest);
  flipped[recoveryId] = [serializeEntry(low.add), serializeEntry(low.rotate)];
  flipped[low.thief.deviceId] = [serializeEntry(low.hello)];
  const proof: ForkProof = { deviceId: recoveryId, seq: 0, lines: [serializeEntry(low.add), serializeEntry(high.add)] };
  for (const replay of [replayVault, appReplay]) {
    for (const folder of [honest, flipped]) {
      const state = replay(v.vaultId, folder, { forks: [proof] });
      assert.equal(state.chains[recoveryId]?.[0], entryHash(high.add), 'the restore the owner used counts');
      assert.ok(!Object.hasOwn(state.members, low.thief.deviceId));
    }
    // Neither new device signed anything past its hello: the lowest hash.
    const bare = copy(flipped);
    bare[high.thief.deviceId] = [serializeEntry(high.hello)];
    assert.equal(replay(v.vaultId, bare, { forks: [proof] }).chains[recoveryId]?.[0], entryHash(low.add));
  }
});
