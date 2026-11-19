/**
 * One regression test per attack from round 3 of the vault review (findings3.md, R1-R7), plus the
 * principle the membership rules follow (docs/authenticator.md, "Deciding what is real"). Each
 * attack worked against the round-2 rules; each must fail now. Secrets are never printed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkBeacons, signBeacon } from '../src/vault/beacon';
import { buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, buildKeyRotate, buildRecoverySet, newAccountId } from '../src/vault/build';
import { VerifyCache } from '../src/vault/chain';
import { entryHash, serializeEntry, signEntry, type SignedEntry } from '../src/vault/entry';
import { cleanJoinName } from '../src/vault/approval';
import { planAppend } from '../src/vault/logs';
import { openVault } from '../src/vault/open';
import { MAX_KEY_CHANGES_PER_AUTHOR, recoveryRanking, replayVault, type VaultState } from '../src/vault/replay';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, restoreWithPhrase } from '../src/vault/recovery';
import type { DeviceKeys } from '../src/vault/crypto';
import { MemoryVault, device, seededRandom, shuffled, totpRecord } from './helpers/vault';

const random = seededRandom('vault-round3-tests');

function agentAppend(vault: MemoryVault, entries: SignedEntry[]): void {
  const plan = planAppend(vault.vaultId, vault.logs, entries);
  for (const id of plan.changed) vault.logs[id] = [...plan.logs[id]!];
}

function addDevice(vault: MemoryVault, by: DeviceKeys, who: DeviceKeys, role: 'admin' | 'member' = 'admin'): void {
  vault.write(buildDeviceAdd(vault.state(), by, { device: who, role, name: 'x', currentKey: openVault(vault.state(), by).currentKey, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), who, vault.now()));
}

function statusOf(state: VaultState, entry: SignedEntry): string {
  const item = state.history.find((h) => h.hash === entryHash(entry));
  return item ? item.status : 'absent';
}

/** The same state for several read orders; returns it. */
function sameEverywhere(vault: MemoryVault, seed: string): VaultState {
  const strip = (s: VaultState) => JSON.stringify({ ...s, history: undefined, rejected: undefined, conflicts: undefined });
  const reference = replayVault(vault.vaultId, vault.logs);
  for (let i = 0; i < 4; i++) {
    const ids = shuffled(Object.keys(vault.logs), seededRandom(`${seed}-${i}`));
    assert.equal(strip(replayVault(vault.vaultId, Object.fromEntries(ids.map((id) => [id, vault.logs[id]!])))), strip(reference));
  }
  return reference;
}

describe('R1: removing the device that approved the remover', () => {
  /** f is stolen; b approves n; n removes f. The thief's copy ends before n was approved. */
  function r1Setup() {
    const [f, b, n] = [device(random), device(random), device(random)];
    const vault = MemoryVault.found(f, random);
    addDevice(vault, f, b);
    const thiefCopy = vault.state();
    addDevice(vault, b, n);
    const removal = buildDeviceRemove(vault.state(), n, { device: f.deviceId, currentKey: openVault(vault.state(), n).currentKey, random, time: vault.now() });
    agentAppend(vault, [removal.entry]);
    const after = vault.state();
    const later = buildAccountPut(after, n, { account: newAccountId(random), record: totpRecord({ issuer: 'AfterRemoval' }), currentKey: openVault(after, n).currentKey, random, time: vault.now() });
    agentAppend(vault, [later]);
    const counter = buildDeviceRemove(thiefCopy, f, { device: b.deviceId, currentKey: openVault(thiefCopy, f).currentKey, random, time: vault.now() });
    return { f, b, n, vault, thiefCopy, removal, later, counter };
  }

  it('through an honest agent the removed thief gets nothing in: its stale removal is a true-symmetric counter (all out), anything else is refused', () => {
    const { f, b, n, vault, thiefCopy, counter } = r1Setup();
    // Any stale line that is not a counter-removal is refused outright.
    const phrase = buildRecoverySet(thiefCopy, f, { recovery: device(random), currentKey: openVault(thiefCopy, f).currentKey, random, time: vault.now() });
    const before = JSON.stringify(vault.logs);
    assert.throws(() => agentAppend(vault, [phrase.entry]), /removed from this vault/);
    assert.equal(JSON.stringify(vault.logs), before);
    // The removal of the device that approved its remover is true symmetry: everyone involved goes.
    agentAppend(vault, [counter.entry]);
    const state = vault.state();
    for (const who of [f, b]) assert.equal(state.members[who.deviceId]?.removed, true);
    assert.notEqual(state.members[n.deviceId]?.joined, true);
    assert.equal(state.recovery, null);
    // Nobody is left: the vault comes back only through the recovery phrase (a stale key f still holds opens nothing new).
    assert.deepEqual(Object.values(state.members).filter((m) => !m.removed && m.joined), []);
    // And nothing after it.
    const more = buildAccountPut(state, f, { account: newAccountId(random), record: totpRecord(), currentKey: openVault(thiefCopy, f).currentKey, random, time: vault.now() });
    assert.throws(() => agentAppend(vault, [more]), /removed from this vault/);
  });

  it('the checker\'s small form through an agent: whoever arrives first, the thief never wins', () => {
    for (const thiefFirst of [false, true]) {
      const [f, d1, d2] = [device(random), device(random), device(random)];
      const vault = MemoryVault.found(f, random);
      addDevice(vault, f, d1);
      const shared = vault.state();
      // d1 (honest) removes the stolen f; f, on its stale copy, approves d2, and d2 removes d1.
      const d1RemovesF = buildDeviceRemove(shared, d1, { device: f.deviceId, currentKey: vault.key, random, time: vault.now() });
      const thief: Record<string, string[]> = Object.fromEntries(Object.entries(vault.logs).map(([k, v]) => [k, [...v]]));
      const addD2 = buildDeviceAdd(shared, f, { device: d2, role: 'admin', name: 'd2', currentKey: vault.key, random, time: vault.now() });
      thief[f.deviceId]!.push(serializeEntry(addD2));
      const hello = buildDeviceHello(replayVault(vault.vaultId, thief), d2, vault.now());
      thief[d2.deviceId] = [serializeEntry(hello)];
      const d2RemovesD1 = buildDeviceRemove(replayVault(vault.vaultId, thief), d2, { device: d1.deviceId, currentKey: vault.key, random, time: vault.now() });
      if (thiefFirst) {
        agentAppend(vault, [addD2]);
        agentAppend(vault, [hello]);
        agentAppend(vault, [d2RemovesD1.entry]);
        agentAppend(vault, [d1RemovesF.entry]); // a true-symmetric counter: taken
        const state = vault.state();
        for (const who of [f, d1, d2]) assert.notEqual(state.members[who.deviceId]?.removed === false && state.members[who.deviceId]?.joined, true, 'all out');
      } else {
        agentAppend(vault, [d1RemovesF.entry]);
        assert.throws(() => agentAppend(vault, [addD2]), /removed from this vault/);
        const state = vault.state();
        assert.equal(state.members[f.deviceId]?.removed, true);
        assert.equal(state.members[d1.deviceId]?.removed, false);
        assert.equal(state.members[d2.deviceId], undefined);
      }
    }
  });

  it('written straight into the folder it is true symmetry: everyone involved is out and the thief gains nothing', () => {
    const { f, b, n, vault, thiefCopy, removal, counter } = r1Setup();
    vault.write(counter.entry);
    const state = sameEverywhere(vault, 'r1');
    assert.equal(statusOf(state, removal.entry), 'applied');
    for (const who of [f, b]) assert.equal(state.members[who.deviceId]?.removed, true);
    assert.notEqual(state.members[n.deviceId]?.joined, true);
    // The thief can't set its own recovery phrase afterwards either.
    const thiefState = { ...state, appliedHeads: { ...state.heads } };
    const phrase = buildRecoverySet(thiefState, f, { recovery: device(random), currentKey: openVault(thiefCopy, f).currentKey, random, time: vault.now() });
    vault.write(phrase.entry);
    assert.notEqual(statusOf(vault.state(), phrase.entry), 'applied');
    assert.equal(vault.state().recovery, null);
  });

  it('the mirror (a removed thief approves a puppet that removes its remover) gives the thief nothing', () => {
    const [a, x, p, phrase] = [device(random), device(random), device(random), device(random)];
    const vault = MemoryVault.found(a, random);
    addDevice(vault, a, x);
    const thief: Record<string, string[]> = Object.fromEntries(Object.entries(vault.logs).map(([k, v]) => [k, [...v]]));
    agentAppend(vault, [buildDeviceRemove(vault.state(), a, { device: x.deviceId, currentKey: vault.key, random, time: vault.now() }).entry]);
    const thiefState = () => replayVault(vault.vaultId, thief);
    let key = vault.key;
    const set = buildRecoverySet(thiefState(), x, { recovery: phrase, currentKey: key, random, time: vault.now() });
    thief[x.deviceId]!.push(serializeEntry(set.entry));
    key = set.newKey;
    const addP = buildDeviceAdd(thiefState(), x, { device: p, role: 'admin', name: 'p', currentKey: key, random, time: vault.now() });
    thief[x.deviceId]!.push(serializeEntry(addP));
    thief[p.deviceId] = [serializeEntry(buildDeviceHello(thiefState(), p, vault.now()))];
    const rm = buildDeviceRemove(thiefState(), p, { device: a.deviceId, currentKey: key, random, time: vault.now() });
    // Through an honest agent: refused at the first line.
    assert.throws(() => agentAppend(vault, [set.entry, addP]), /removed from this vault/);
    // Written straight into the folder: all out, no phrase, no puppet.
    vault.logs[x.deviceId]!.push(serializeEntry(set.entry), serializeEntry(addP));
    vault.logs[p.deviceId] = [...thief[p.deviceId]!, serializeEntry(rm.entry)];
    const state = sameEverywhere(vault, 'mirror');
    assert.equal(state.members[a.deviceId]?.removed, true);
    assert.equal(state.members[x.deviceId]?.removed, true);
    assert.notEqual(state.members[p.deviceId]?.joined, true);
    assert.notEqual(state.recovery?.deviceId, phrase.deviceId);
    assert.throws(() => openVault(state, p));
  });

  it('a device the thief removed first can still remove the thief back through the agent', () => {
    const [f, d] = [device(random), device(random)];
    const vault = MemoryVault.found(f, random);
    addDevice(vault, f, d);
    const shared = vault.state();
    const put = buildAccountPut(shared, d, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    const afterPut = { ...shared, heads: { ...shared.heads, [d.deviceId]: { seq: put.seq, hash: entryHash(put), time: put.time } } };
    const dRemovesF = buildDeviceRemove(afterPut, d, { device: f.deviceId, currentKey: vault.key, random, time: vault.now() });
    // The thief gets to the computer first.
    agentAppend(vault, [buildDeviceRemove(shared, f, { device: d.deviceId, currentKey: vault.key, random, time: vault.now() }).entry]);
    // d's unsent put and its removal of f arrive together: taken, up to the counter-removal.
    agentAppend(vault, [put, dRemovesF.entry]);
    const state = vault.state();
    assert.equal(statusOf(state, dRemovesF.entry), 'applied');
    assert.equal(state.members[f.deviceId]?.removed, true);
    assert.equal(state.members[d.deviceId]?.removed, true);
    assert.equal(state.history.find((h) => h.hash === entryHash(put))?.caught, true);
    // Nothing more from either.
    const more = buildAccountPut(state, d, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    assert.throws(() => agentAppend(vault, [more]), /removed from this vault/);
  });

  it('an exact retry of a line the folder holds changes nothing, even once its author is removed', () => {
    const [f, d] = [device(random), device(random)];
    const vault = MemoryVault.found(f, random);
    addDevice(vault, f, d);
    const put = buildAccountPut(vault.state(), d, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [put]);
    const lines = JSON.stringify(vault.logs);
    agentAppend(vault, [put]);
    assert.equal(JSON.stringify(vault.logs), lines);
    // Still taken, changing nothing, once its author is removed: the line is already there.
    agentAppend(vault, [buildDeviceRemove(vault.state(), f, { device: d.deviceId, currentKey: vault.key, random, time: vault.now() }).entry]);
    const removed = JSON.stringify(vault.logs);
    agentAppend(vault, [put]);
    assert.equal(JSON.stringify(vault.logs), removed);
  });

  it('an applied removal never changes once its causal past is known (whatever arrives later)', () => {
    const [f, b, n, c] = [device(random), device(random), device(random), device(random)];
    const vault = MemoryVault.found(f, random);
    addDevice(vault, f, b);
    addDevice(vault, f, c);
    const stale = vault.state();
    addDevice(vault, b, n);
    const removal = buildDeviceRemove(vault.state(), n, { device: f.deviceId, currentKey: openVault(vault.state(), n).currentKey, random, time: vault.now() });
    vault.write(removal.entry);
    // Every stale removal the thief can sign: of b, of c; none takes n's removal back.
    for (const target of [b, c]) {
      const r = buildDeviceRemove(stale, f, { device: target.deviceId, currentKey: openVault(stale, f).currentKey, random, time: vault.now() });
      vault.write(r.entry);
      assert.equal(statusOf(vault.state(), removal.entry), 'applied');
      assert.equal(vault.state().members[f.deviceId]?.removed, true);
      vault.logs[f.deviceId]!.pop();
    }
  });
});

describe('R2: a rejected change never beats anything', () => {
  it('a removed device\'s stale recovery.set, ground to a low hash, leaves the honest phrase and the accounts alone', () => {
    const [a, b, x] = [device(random), device(random), device(random)];
    const vault = MemoryVault.found(a, random, 'team');
    addDevice(vault, a, b);
    addDevice(vault, a, x);
    const stale = vault.state();
    vault.write(buildDeviceRemove(vault.state(), a, { device: x.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    const honest = buildRecoverySet(vault.state(), b, { recovery: device(random), currentKey: openVault(vault.state(), b).currentKey, random, time: vault.now() });
    vault.write(honest.entry);
    const put = buildAccountPut(vault.state(), a, { account: newAccountId(random), record: totpRecord(), currentKey: openVault(vault.state(), a).currentKey, random, time: vault.now() });
    vault.write(put);
    let forged: SignedEntry;
    for (let t = vault.now(); ; t++) {
      forged = buildRecoverySet(stale, x, { recovery: device(random), currentKey: openVault(stale, x).currentKey, random, time: t }).entry;
      if (entryHash(forged) < entryHash(honest.entry)) break;
    }
    vault.write(forged);
    const state = sameEverywhere(vault, 'r2');
    assert.equal(statusOf(state, forged), 'rejected');
    assert.equal(statusOf(state, honest.entry), 'applied');
    assert.equal(statusOf(state, put), 'applied');
    assert.equal(state.recovery?.ed, (honest.entry.body as { ed: string }).ed);
    assert.equal(Object.keys(state.accounts).length, 1);
  });

  it('dropping a rejected line changes nothing', () => {
    const [a, b, x] = [device(random), device(random), device(random)];
    const vault = MemoryVault.found(a, random, 'team');
    addDevice(vault, a, b);
    addDevice(vault, a, x);
    const stale = vault.state();
    vault.write(buildDeviceRemove(vault.state(), a, { device: x.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    const without = JSON.stringify({ ...vault.state(), history: undefined, rejected: undefined, heads: undefined, chains: undefined });
    vault.write(buildKeyRotate(stale, x, { currentKey: openVault(stale, x).currentKey, random, time: vault.now() }).entry);
    const withLine = vault.state();
    assert.equal(withLine.history.at(-1)?.status, 'rejected');
    assert.equal(JSON.stringify({ ...withLine, history: undefined, rejected: undefined, heads: undefined, chains: undefined }), without);
  });
});

describe('R3: many key changes', () => {
  it('a device\'s key changes past the cap are refused, and a warm replay stays fast', () => {
    const [a, b] = [device(random), device(random)];
    const vault = MemoryVault.found(a, random, 'team');
    addDevice(vault, a, b);
    const base = vault.state();
    const template = buildKeyRotate(base, a, { currentKey: vault.key, random, time: vault.now() }).entry;
    const extra = 40;
    const start = vault.now() + 1000;
    for (const who of [a, b]) {
      const other = who === a ? b : a;
      let prev = base.heads[who.deviceId]!;
      for (let i = 0; i < MAX_KEY_CHANGES_PER_AUTHOR + extra; i++) {
        const epoch = 1 + i;
        const body = { ...template.body, epoch, prevKey: { ...(template.body as { prevKey: object }).prevKey, epoch } };
        const e = signEntry({ v: 2, vault: vault.vaultId, author: who.deviceId, seq: prev.seq + 1, prev: prev.hash, seen: { [other.deviceId]: { seq: base.appliedHeads[other.deviceId]!.seq, hash: base.appliedHeads[other.deviceId]!.hash } }, time: start + i, kind: 'key.rotate', body } as never, who);
        vault.logs[who.deviceId]!.push(serializeEntry(e));
        prev = { seq: e.seq, hash: entryHash(e), time: e.time };
      }
    }
    const cache = new VerifyCache();
    const cold = replayVault(vault.vaultId, vault.logs, { cache });
    assert.ok(cold.epoch <= MAX_KEY_CHANGES_PER_AUTHOR, `epoch ${cold.epoch}`);
    assert.ok(cold.rejected.filter((r) => /key changes, the most one device may/.test(r.reason)).length >= 2 * extra);
    const started = Date.now();
    replayVault(vault.vaultId, vault.logs, { cache });
    assert.ok(Date.now() - started < 1000, 'warm replay under a second');
  });

  it('a key.rotate must start the epoch after the last key it had seen', () => {
    const [a, b] = [device(random), device(random)];
    const vault = MemoryVault.found(a, random, 'team');
    addDevice(vault, a, b);
    const rotation = buildKeyRotate(vault.state(), a, { currentKey: vault.key, random, time: vault.now() });
    const { sig: _sig, ...unsigned } = rotation.entry;
    const body = { ...(rotation.entry.body as object), epoch: 5, prevKey: { ...(rotation.entry.body as { prevKey: object }).prevKey, epoch: 5 } };
    vault.write(signEntry({ ...unsigned, body } as never, a));
    const state = vault.state();
    assert.equal(state.history.at(-1)?.status, 'rejected');
    assert.match(state.history.at(-1)?.reason ?? '', /starts epoch 5, but the last key it had seen was epoch 0/);
    assert.equal(state.epoch, 0);
  });
});

describe('R5: beacons and removed devices', () => {
  it('a removed device deleting its own line never pauses anyone through an honest beacon', () => {
    const [a, b, x, c] = [device(random), device(random), device(random), device(random)];
    const vault = MemoryVault.found(a, random, 'team');
    addDevice(vault, a, b);
    addDevice(vault, a, x, 'member');
    addDevice(vault, a, c);
    const xStale = vault.state();
    vault.write(buildDeviceRemove(vault.state(), a, { device: x.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    vault.write(buildAccountPut(xStale, x, { account: newAccountId(random), record: totpRecord(), currentKey: openVault(xStale, x).currentKey, random, time: vault.now() }));
    const beacon = signBeacon(vault.state(), b, vault.now());
    assert.equal(beacon.heads[x.deviceId], undefined);
    vault.logs[x.deviceId]!.pop();
    // Even a beacon that names the removed device's head (an older AuthDeck) is not held against the folder.
    const old = signBeacon({ ...vault.state(), cutoffs: {}, members: {} }, b, vault.now());
    const checked = checkBeacons(vault.state(), { [b.deviceId]: JSON.stringify(beacon), [c.deviceId]: JSON.stringify({ ...old, device: c.deviceId }) }, a.deviceId);
    assert.deepEqual(checked.problems.filter((p) => p.device === b.deviceId), []);
  });
});

describe('R7: a planted sealing key', () => {
  it('a device approved with someone else\'s sealing key never joins, and new keys never reach it', () => {
    const [a, b, joiner, relay] = [device(random), device(random), device(random), device(random)];
    const vault = MemoryVault.found(a, random, 'team');
    addDevice(vault, a, b);
    // a, malicious, approves the joiner's signing key with its own sealing key.
    const planted = { ...joiner, xPublic: relay.xPublic, xSecret: relay.xSecret };
    vault.write(buildDeviceAdd(vault.state(), a, { device: planted, role: 'admin', name: 'Joiner', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), joiner, vault.now()));
    const state = vault.state();
    assert.equal(state.history.at(-1)?.status, 'rejected');
    assert.match(state.history.at(-1)?.reason ?? '', /sealing key that is not its own/);
    assert.equal(state.members[joiner.deviceId]?.joined, false);
    assert.deepEqual(state.unkeyedDevices, []);
    // b removes a, the approver: from then on new keys go to b alone, never to the planted key.
    const removal = buildDeviceRemove(state, b, { device: a.deviceId, currentKey: openVault(state, b).currentKey, random, time: vault.now() });
    vault.write(removal.entry);
    const after = vault.state();
    assert.deepEqual(Object.keys(after.sealedKeys[after.epoch] ?? {}), [b.deviceId]);
    // A rotation sealed to a device that never joined and whose approver is gone is refused.
    const sneaky = buildKeyRotate({ ...after, members: { ...after.members, [joiner.deviceId]: { ...after.members[joiner.deviceId]!, joined: true } } }, b, { currentKey: openVault(after, b).currentKey, random, time: vault.now() });
    vault.write(sneaky.entry);
    assert.match(vault.state().history.at(-1)?.reason ?? '', /has not joined/);
  });
});

describe('principle: the better-informed side wins; only true symmetry removes both', () => {
  it('mutual removals remove both, keep what each had seen, and cut what each had not', () => {
    const [a, x, c] = [device(random), device(random), device(random)];
    const vault = MemoryVault.found(a, random, 'team');
    addDevice(vault, a, x);
    addDevice(vault, a, c);
    const shared = vault.state();
    const byA = buildDeviceRemove(shared, a, { device: x.deviceId, currentKey: vault.key, random, time: vault.now() });
    vault.write(byA.entry);
    // x signs a recovery phrase first and then removes a, both without seeing a's removal.
    const xPhrase = buildRecoverySet(shared, x, { recovery: device(random), currentKey: vault.key, random, time: vault.now() });
    vault.write(xPhrase.entry);
    const byX = buildDeviceRemove({ ...shared, heads: { ...shared.heads, [x.deviceId]: { seq: xPhrase.entry.seq, hash: entryHash(xPhrase.entry), time: xPhrase.entry.time } } }, x, { device: a.deviceId, currentKey: vault.key, random, time: vault.now() });
    vault.write(byX.entry);
    const state = sameEverywhere(vault, 'mutual');
    assert.equal(statusOf(state, byA.entry), 'applied');
    assert.equal(statusOf(state, byX.entry), 'applied');
    assert.equal(statusOf(state, xPhrase.entry), 'rejected');
    assert.equal(state.recovery, null);
    assert.equal(state.members[a.deviceId]?.removed, true);
    assert.equal(state.members[x.deviceId]?.removed, true);
    assert.equal(state.members[c.deviceId]?.removed, false);
    assert.equal(state.needsFreshKey, true);
  });
});

describe('device names', () => {
  it('drop invisible characters and are capped at 64 characters', () => {
    assert.equal(cleanJoinName('Ph​one⠀ㅤᅟᅠﾠ￼\u{E0041}­'), 'Phone');
    assert.equal(cleanJoinName('My\tlaptop\n'), 'My laptop');
    assert.equal(Array.from(cleanJoinName('é'.repeat(100))).length, 64);
  });
});

describe('recovery ranking: ends, with one answer, and fails safe', () => {
  /**
   * The deepest ranking built here: the founder sets phrase P1; a device restored through P1
   * sets P3 while another admin, who saw P1 but not that restore, sets P2 at the same time. P2
   * cuts P1 off before the restore, which takes the restored device and P3 with it; P3 cuts P1
   * after it. Which of P2 and P3 is kept depends on the hashes, and the ranking needs several
   * rounds to settle either way.
   */
  function deepRanking(seed: string) {
    const rnd = seededRandom(seed);
    const [f, e, d] = [device(rnd), device(rnd), device(rnd)];
    const vault = MemoryVault.found(f, rnd);
    vault.write(buildDeviceAdd(vault.state(), f, { device: e, role: 'admin', name: 'e', currentKey: vault.key, random: rnd, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), e, vault.now()));
    const p1 = generateRecoveryPhrase(rnd);
    const set1 = buildRecoverySetFromPhrase(vault.state(), f, { phrase: p1, currentKey: vault.key, random: rnd, time: vault.now() });
    vault.write(set1.entry);
    const seenByE = vault.state();
    const restore = restoreWithPhrase(vault.state(), { phrase: p1, device: d, name: 'd', random: rnd, time: vault.now() });
    vault.write(restore.entry);
    vault.write(buildDeviceHello(vault.state(), d, vault.now()));
    const p3 = buildRecoverySetFromPhrase(vault.state(), d, { phrase: generateRecoveryPhrase(rnd), currentKey: restore.key, random: rnd, time: vault.now() });
    vault.write(p3.entry);
    const p2 = buildRecoverySetFromPhrase(seenByE, e, { phrase: generateRecoveryPhrase(rnd), currentKey: set1.newKey, random: rnd, time: vault.now() });
    vault.write(p2.entry);
    return { vault, e, d, p2, p3 };
  }

  it('settles the deepest ranking we can build, the same in every read order, whichever phrase wins', () => {
    const winners = new Set<string>();
    for (let i = 0; i < 12 && winners.size < 2; i++) {
      const { vault, d, p2, p3 } = deepRanking(`deep-${i}`);
      const state = sameEverywhere(vault, `deep-${i}`);
      assert.deepEqual(state.unsettledRecovery, []);
      const s2 = statusOf(state, p2.entry);
      const s3 = statusOf(state, p3.entry);
      // Exactly one of the two phrases made at the same time is kept.
      assert.equal([s2, s3].filter((s) => s === 'applied').length, 1, `${s2} / ${s3}`);
      if (s3 === 'applied') assert.equal(state.members[d.deviceId]?.joined, true, 'the kept phrase\'s author stays in');
      winners.add(s2 === 'applied' ? 'p2' : 'p3');
    }
    assert.equal(winners.size, 2, 'both orders of the hashes were tried');
  });

  it('when the ranking cannot settle within its bound, it rejects the phrases it could not settle, pauses secrets, and a fresh key clears it', () => {
    const { vault, e, p2, p3 } = deepRanking('deep-0');
    const saved = recoveryRanking.maxRounds;
    recoveryRanking.maxRounds = 1;
    try {
      const state = sameEverywhere(vault, 'failsafe');
      assert.ok(state.unsettledRecovery.length > 0);
      for (const hash of state.unsettledRecovery) assert.equal(state.history.find((h) => h.hash === hash)?.status, 'rejected');
      assert.equal(statusOf(state, p2.entry) === 'applied' && statusOf(state, p3.entry) === 'applied', false);
      assert.equal(state.needsFreshKey, true);
      // An admin still in writes a fresh key after them: the pause ends.
      const fresh = buildKeyRotate(state, e, { currentKey: openVault(state, e).currentKey, random, time: vault.now() });
      vault.write(fresh.entry);
      const after = vault.state();
      assert.equal(statusOf(after, fresh.entry), 'applied');
      assert.equal(after.needsFreshKey, false);
    } finally {
      recoveryRanking.maxRounds = saved;
    }
  });
});
