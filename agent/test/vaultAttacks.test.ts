/**
 * One regression test per attack from the security review (findings.md, PoCs 1-9). Each built
 * the attack against the old rules and succeeded; each must fail now.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkJoinedVault, createJoinChallenge, createJoinRequest, createJoinReveal, approverCheckCode, newDeviceCheckCode, readJoinRequest } from '../src/vault/approval';
import { checkBeacons, signBeacon } from '../src/vault/beacon';
import { toBase64Url } from '../src/vault/bytes';
import { afterOwnEntry as afterOwnEntryState, buildAccountDelete, buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, buildKeyRotate, buildRecoverySet, createVault, newAccountId } from '../src/vault/build';
import { VerifyCache, type VaultLogs } from '../src/vault/chain';
import { canonicalJson } from '../src/vault/canonical';
import { entryHash, serializeEntry, signEntry, type SignedEntry } from '../src/vault/entry';
import { AppendRefused, planAppend } from '../src/vault/logs';
import { openVault, validateAccountRecord } from '../src/vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, recoveryKeysFromPhrase, restoreWithPhrase } from '../src/vault/recovery';
import { replayVault, type VaultState } from '../src/vault/replay';
import { findForks } from '../src/vault/rollback';
import type { DeviceKeys } from '../src/vault/crypto';
import { MemoryVault, device, seededRandom, shuffled, totpRecord } from './helpers/vault';

const random = seededRandom('vault-attack-tests');

/** Appends the way an honest agent does: only what planAppend accepts. */
function agentAppend(vault: MemoryVault, entries: SignedEntry[], options: Parameters<typeof planAppend>[3] = {}): void {
  const plan = planAppend(vault.vaultId, vault.logs, entries, options);
  for (const id of plan.changed) vault.logs[id] = [...plan.logs[id]!];
}

function resign(entry: SignedEntry, author: DeviceKeys, change: Partial<SignedEntry>): SignedEntry {
  const { sig: _sig, ...unsigned } = entry;
  return signEntry({ ...unsigned, ...change }, author);
}

/** A vault.create for an existing vault id, by someone else. */
function hijackCreate(vaultId: string, who: DeviceKeys, kind: 'personal' | 'team' = 'personal'): SignedEntry {
  const created = createVault({ founder: who, kind, name: 'pwned', deviceName: 'x', random, time: 0 });
  return resign(created.entry, who, { vault: vaultId });
}

const reasons = (state: VaultState) => state.rejected.map((r) => r.reason).join(' | ');

describe('PoC 1: a relay swaps only the new device\'s sealing key', () => {
  it('the two screens show different codes, and the new device calls the result intercepted', () => {
    const approver = device(random);
    const vault = MemoryVault.found(approver, random);
    const newcomer = device(random);
    const relay = device(random);
    const { request, nonce } = createJoinRequest(newcomer, 'My new phone', random);
    const forwarded = { ...request, x: toBase64Url(relay.xPublic) };
    const { challenge } = createJoinChallenge(approver, { vaultId: vault.vaultId, vaultName: 'Home', deviceName: 'Phone' }, random);
    const onNewcomer = newDeviceCheckCode(request, nonce, challenge);
    // The commitment covers x, so the swapped request no longer matches the reveal: no code at all.
    assert.throws(() => approverCheckCode(forwarded, challenge, createJoinReveal(nonce)), /different number than it committed to/);

    // Even an approver that skipped the code: the new device refuses the vault it was given.
    agentAppend(vault, [buildDeviceAdd(vault.state(), approver, { device: readJoinRequest(forwarded), role: 'admin', name: forwarded.name, currentKey: vault.key, random, time: vault.now() })]);
    const verdict = checkJoinedVault(vault.state(), newcomer, challenge);
    assert.equal(verdict.status, 'intercepted');
    assert.match(onNewcomer, /^\d{6}$/);
  });
});

describe('PoC 2 and 9: only the founder may write vault.create', () => {
  it('refuses a vault.create from a device another device introduced, and from an identity minted under repair', () => {
    const admin = device(random);
    const vault = MemoryVault.found(admin, random, 'team');
    const member = device(random);
    agentAppend(vault, [buildDeviceAdd(vault.state(), admin, { device: member, role: 'member', name: 'M', currentKey: vault.key, random, time: vault.now() })]);
    agentAppend(vault, [buildDeviceHello(vault.state(), member, vault.now())]);
    const sock = device(random);
    const mint = buildDeviceAdd(vault.state(), member, { device: sock, role: 'admin', name: 'S', currentKey: vault.key, random, time: vault.now() });
    // The agent keeps it only as a placeholder for the member's seq: rejected, it changes nothing.
    agentAppend(vault, [mint]);
    assert.match(statusOf(vault.state(), mint), /^rejected \(only an admin device/);
    vault.write(hijackCreate(vault.vaultId, sock));
    const state = vault.state();
    assert.equal(state.founder, admin.deviceId);
    assert.equal(state.members[sock.deviceId], undefined);
    assert.doesNotThrow(() => openVault(state, admin));
  });

  it('refuses a vault.create in place of a new device\'s hello', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const newcomer = device(random);
    agentAppend(vault, [buildDeviceAdd(vault.state(), founder, { device: newcomer, role: 'admin', name: 'T', currentKey: vault.key, random, time: vault.now() })]);
    assert.throws(() => agentAppend(vault, [hijackCreate(vault.vaultId, newcomer)]), AppendRefused);
    vault.write(hijackCreate(vault.vaultId, newcomer));
    assert.equal(vault.state().founder, founder.deviceId);
    assert.match(reasons(vault.state()), /device.hello|founder/);
  });

  it('refuses a vault.create from a removed device\'s puppet and from an old recovery identity', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const phrase = generateRecoveryPhrase(random);
    const set = buildRecoverySetFromPhrase(vault.state(), founder, { phrase, currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [set.entry]);
    vault.key = set.newKey;
    const again = buildRecoverySetFromPhrase(vault.state(), founder, { phrase: generateRecoveryPhrase(random), currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [again.entry]);
    vault.key = again.newKey;
    const oldRecovery = recoveryKeysFromPhrase(phrase, vault.vaultId);
    vault.write(hijackCreate(vault.vaultId, oldRecovery, 'team'));
    const state = vault.state();
    assert.equal(state.founder, founder.deviceId);
    assert.equal(state.kind, 'personal');
  });
});

describe('PoC 3: a removed device backdates its entries', () => {
  it('rejects every entry past the removal\'s view of it, whatever time it claims', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const lost = device(random);
    agentAppend(vault, [buildDeviceAdd(vault.state(), founder, { device: lost, role: 'admin', name: 'Lost phone', currentKey: vault.key, random, time: vault.now() })]);
    agentAppend(vault, [buildDeviceHello(vault.state(), lost, vault.now())]);
    const github = newAccountId(random);
    agentAppend(vault, [buildAccountPut(vault.state(), founder, { account: github, record: totpRecord({ secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }), currentKey: vault.key, random, time: vault.now() })]);
    const oldKey = vault.key;
    const atLoss = vault.state();
    const removal = buildDeviceRemove(vault.state(), founder, { device: lost.deviceId, currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [removal.entry]);
    vault.key = removal.newKey;
    assert.equal(vault.state().cutoffs[lost.deviceId], 0);

    // Time 0 is raised to the latest entry it saw, which still sorts before the removal.
    const put = buildAccountPut(atLoss, lost, { account: github, record: totpRecord({ secret: 'KRUGS4ZANFZSA5DIMUQGC5DUMFRWW2LS' }), currentKey: oldKey, random, time: 0 });
    assert.ok(put.time < removal.entry.time);
    const stolen = device(random);
    assert.throws(() => agentAppend(vault, [put]), /removed/);
    vault.write(put);
    const afterPut = vault.state();
    vault.write(buildDeviceAdd(afterPut, lost, { device: stolen, role: 'admin', name: 'Spare', currentKey: oldKey, random, time: 0 }));
    const state = vault.state();
    assert.equal(openVault(state, founder).accounts[github]?.record.secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(state.members[stolen.deviceId], undefined);
    assert.equal(state.rejected.filter((r) => r.deviceId === lost.deviceId).length, 2);
    assert.match(reasons(state), /removed/);
  });
});

describe('PoC 4: a replaced recovery phrase', () => {
  it('cannot open the key of the epoch that replaced it, nor add a device with a backdated entry', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const oldPhrase = generateRecoveryPhrase(random);
    const first = buildRecoverySetFromPhrase(vault.state(), founder, { phrase: oldPhrase, currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [first.entry]);
    vault.key = first.newKey;
    const atOldSet = vault.state();
    const second = buildRecoverySetFromPhrase(vault.state(), founder, { phrase: generateRecoveryPhrase(random), currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [second.entry]);
    vault.key = second.newKey;
    const bank = newAccountId(random);
    agentAppend(vault, [buildAccountPut(vault.state(), founder, { account: bank, record: totpRecord({ issuer: 'Bank' }), currentKey: vault.key, random, time: vault.now() })]);

    const old = recoveryKeysFromPhrase(oldPhrase, vault.vaultId);
    assert.throws(() => openVault(vault.state(), old));
    const intruder = device(random);
    const { entry } = restoreWithPhrase(atOldSet, { phrase: oldPhrase, device: intruder, name: 'Attacker', random, time: 0 });
    assert.throws(() => agentAppend(vault, [entry]), AppendRefused);
    vault.write(entry);
    assert.equal(vault.state().members[intruder.deviceId], undefined);
  });
});

describe('PoC 5: one entry with a poisoned seen', () => {
  it('a contradicting hash is rejected as a conflict and a far-off seq waits, without freezing honest writers', () => {
    const admin = device(random);
    const vault = MemoryVault.found(admin, random, 'team');
    const member = device(random);
    agentAppend(vault, [buildDeviceAdd(vault.state(), admin, { device: member, role: 'member', name: 'M', currentKey: vault.key, random, time: vault.now() })]);
    agentAppend(vault, [buildDeviceHello(vault.state(), member, vault.now())]);

    const base = buildAccountDelete(vault.state(), member, { account: newAccountId(random), time: vault.now() });
    const contradicting = resign(base, member, { seen: { ...base.seen, [admin.deviceId]: { seq: 0, hash: toBase64Url(random(32)) } } });
    vault.write(contradicting);
    const conflicted = vault.state();
    assert.equal(conflicted.conflicts.length, 1);
    assert.equal(conflicted.conflicts[0]!.author, member.deviceId);

    vault.logs[member.deviceId]!.pop();
    const waiting = resign(base, member, { seen: { ...base.seen, [admin.deviceId]: { seq: 99, hash: toBase64Url(random(32)) } } });
    vault.write(waiting);
    assert.equal(vault.state().history.filter((h) => h.status === 'waiting').length, 1);
    for (let i = 0; i < 3; i++) {
      agentAppend(vault, [buildAccountPut(vault.state(), admin, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() })]);
    }
    const removal = buildDeviceRemove(vault.state(), admin, { device: member.deviceId, currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [removal.entry]);
    const state = vault.state();
    assert.equal(Object.keys(state.accounts).length, 3);
    assert.equal(state.members[member.deviceId]?.removed, true);
  });
});

describe('PoC 7: replay cost', () => {
  it('re-checks signatures only on new lines once a prefix is verified', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    for (let i = 0; i < 1500; i++) vault.write(buildAccountDelete(fastState(vault, founder), founder, { account: newAccountId(random), time: vault.now() }));
    const cache = new VerifyCache();
    const cold = time(() => replayVault(vault.vaultId, vault.logs, { cache }));
    const next = buildAccountPut(fastState(vault, founder), founder, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    const warm = time(() => planAppend(vault.vaultId, vault.logs, [next], { cache }));
    assert.ok(warm < cold, `a cached append (${warm.toFixed(0)} ms, two replays) should beat one cold replay (${cold.toFixed(0)} ms)`);
  });
});

/** Chains the founder's next entry on its own head without replaying the whole vault each time. */
let fastHeads: { vault: MemoryVault; state: VaultState } | null = null;
function fastState(vault: MemoryVault, founder: DeviceKeys): VaultState {
  if (fastHeads?.vault !== vault) fastHeads = { vault, state: vault.state() };
  const lines = vault.logs[founder.deviceId]!;
  const last = JSON.parse(lines.at(-1)!) as SignedEntry;
  const head = { seq: last.seq, hash: entryHash(last), time: last.time };
  fastHeads.state = { ...fastHeads.state, heads: { ...fastHeads.state.heads, [founder.deviceId]: head }, appliedHeads: { ...fastHeads.state.appliedHeads, [founder.deviceId]: head } };
  return fastHeads.state;
}

function time(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

describe('PoC 8: keys and secrets', () => {
  it('(a) refuses a low-order recovery sealing key, so removing a lost device still works', () => {
    const admin = device(random);
    const vault = MemoryVault.found(admin, random, 'team');
    const lost = device(random);
    agentAppend(vault, [buildDeviceAdd(vault.state(), admin, { device: lost, role: 'admin', name: 'L', currentKey: vault.key, random, time: vault.now() })]);
    const set = buildRecoverySet(vault.state(), admin, { recovery: device(random), currentKey: vault.key, random, time: vault.now() });
    const bad = resign(set.entry, admin, { body: { ...(set.entry.body as object), x: toBase64Url(new Uint8Array(32)) } as never });
    assert.throws(() => agentAppend(vault, [bad]), AppendRefused);
    vault.write(bad);
    assert.equal(vault.state().recovery, null);
    assert.doesNotThrow(() => buildDeviceRemove(vault.state(), admin, { device: lost.deviceId, currentKey: vault.key, random, time: vault.now() }));
  });

  it('(b) a key sealed to one device that differs from the vault\'s is refused by that device', () => {
    const admin = device(random);
    const vault = MemoryVault.found(admin, random, 'team');
    const account = newAccountId(random);
    agentAppend(vault, [buildAccountPut(vault.state(), admin, { account, record: totpRecord({ secret: 'GEZDGNBVGY3TQOJQ' }), currentKey: vault.key, random, time: vault.now() })]);
    const newcomer = device(random);
    const fake = random(32);
    agentAppend(vault, [buildDeviceAdd(vault.state(), admin, { device: newcomer, role: 'member', name: 'N', currentKey: fake, random, time: vault.now() })]);
    vault.write(buildAccountPut(vault.state(), admin, { account, record: totpRecord({ secret: 'KRUGS4ZANFZSA5DI' }), currentKey: fake, random, time: vault.now() }));
    const state = vault.state();
    assert.throws(() => openVault(state, newcomer), /does not match the vault/);
    assert.equal(openVault(state, admin).accounts[account]?.record.secret, 'GEZDGNBVGY3TQOJQ');
  });

  it('(c) a device shown a folder without a removal learns of it from the remover\'s beacon', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const other = device(random);
    const lost = device(random);
    for (const d of [other, lost]) {
      agentAppend(vault, [buildDeviceAdd(vault.state(), founder, { device: d, role: 'admin', name: 'x', currentKey: vault.key, random, time: vault.now() })]);
      agentAppend(vault, [buildDeviceHello(vault.state(), d, vault.now())]);
    }
    const hidden = vault.snapshot();
    const removal = buildDeviceRemove(vault.state(), founder, { device: lost.deviceId, currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [removal.entry]);
    const beacon = signBeacon(vault.state(), founder, vault.now());
    const shown = replayVault(vault.vaultId, hidden);
    const check = checkBeacons(shown, { [founder.deviceId]: JSON.stringify(beacon) }, other.deviceId);
    assert.deepEqual(check.problems.map((p) => p.kind).sort(), ['missing-entry', 'newer-epoch']);
    assert.equal(check.claimedEpoch, 1);
  });

  it('(d) refuses a secret too short to be a real key', () => {
    assert.throws(() => validateAccountRecord(totpRecord({ secret: 'A' })), /secret/i);
    assert.doesNotThrow(() => validateAccountRecord(totpRecord()));
  });
});

describe('forks', () => {
  it('two folders with different entries at one seq give a proof naming the device', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const shared = vault.state();
    const a = buildAccountDelete(shared, founder, { account: newAccountId(random), time: vault.now() });
    const b = buildAccountDelete(shared, founder, { account: newAccountId(random), time: vault.now() });
    const left: VaultLogs = { ...vault.snapshot(), [founder.deviceId]: [...vault.logs[founder.deviceId]!, serializeEntry(a)] };
    const right: VaultLogs = { ...vault.snapshot(), [founder.deviceId]: [...vault.logs[founder.deviceId]!, serializeEntry(b)] };
    const forks = findForks(left, replayVault(vault.vaultId, left), right, replayVault(vault.vaultId, right));
    assert.deepEqual(forks.map((f) => [f.deviceId, f.seq]), [[founder.deviceId, 1]]);
    assert.deepEqual(forks[0]!.lines, [serializeEntry(a), serializeEntry(b)]);
  });
});

describe('L-5: repair', () => {
  it('needs a remembered head that proves a gap, and never writes past it', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const first = buildAccountPut(vault.state(), founder, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    const proof = { [founder.deviceId]: { seq: first.seq, hash: entryHash(first) } };
    assert.throws(() => planAppend(vault.vaultId, vault.logs, [first], { repair: true }), /must say which entry/);
    assert.throws(() => planAppend(vault.vaultId, vault.logs, [first], { repair: true, proof: { [founder.deviceId]: { seq: first.seq, hash: toBase64Url(random(32)) } } }), /do not lead/);
    assert.doesNotThrow(() => planAppend(vault.vaultId, vault.logs, [first], { repair: true, proof }));
    vault.write(first);
    const second = buildAccountPut(vault.state(), founder, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    assert.throws(() => planAppend(vault.vaultId, vault.logs, [second], { repair: true, proof }), /nothing to repair|up to the one/);
  });
});

describe('determinism', () => {
  /** Concurrent membership changes and edits, with each author's clock drawn from `clock`. */
  function scenario(clock: () => number) {
    const local = seededRandom('determinism-scenario');
    const founder = device(local);
    const created = createVault({ founder, kind: 'team', name: 'Home', deviceName: 'Phone', random: local, time: clock() });
    const vault = new MemoryVault(created);
    const [b, c, d] = [device(local), device(local), device(local)];
    for (const member of [b, c]) {
      vault.write(buildDeviceAdd(vault.state(), founder, { device: member, role: 'admin', name: 'x', currentKey: vault.key, random: local, time: clock() }));
      vault.write(buildDeviceHello(vault.state(), member, clock()));
    }
    const shared = vault.state();
    const account = newAccountId(local);
    // From one shared view: the founder removes c, c removes b, b approves d, b and c edit one account.
    vault.write(buildDeviceRemove(shared, founder, { device: c.deviceId, currentKey: vault.key, random: local, time: clock() }).entry);
    vault.write(buildDeviceRemove(shared, c, { device: b.deviceId, currentKey: vault.key, random: local, time: clock() }).entry);
    vault.write(buildDeviceAdd(shared, b, { device: d, role: 'member', name: 'd', currentKey: vault.key, random: local, time: clock() }));
    vault.write(buildAccountPut(shared, b, { account, record: totpRecord({ label: 'b' }), currentKey: vault.key, random: local, time: clock() }));
    vault.write(buildAccountPut(shared, c, { account, record: totpRecord({ label: 'c' }), currentKey: vault.key, random: local, time: clock() }));
    return { vault, ids: { founder: founder.deviceId, b: b.deviceId, c: c.deviceId, d: d.deviceId } };
  }

  const membership = (state: VaultState) =>
    canonicalJson({
      epoch: state.epoch,
      members: Object.fromEntries(Object.values(state.members).map((m) => [m.deviceId, `${m.role}:${m.removed}`])),
      cutoffs: state.cutoffs,
      rejected: state.rejected.filter((r) => r.kind?.startsWith('device.')).map((r) => `${r.deviceId}#${r.seq}`).sort(),
    });

  it('gives one state for every read order, and one membership for every set of clocks', () => {
    const outcomes = new Set<string>();
    for (let run = 0; run < 12; run++) {
      const clocks = seededRandom(`clocks-${run}`);
      const { vault, ids } = scenario(() => 1_000_000 + ((clocks(2)[0]! << 8) | clocks(2)[1]!));
      const reference = vault.state();
      for (let order = 0; order < 4; order++) {
        const ids = shuffled(Object.keys(vault.logs), seededRandom(`order-${run}-${order}`));
        const state = replayVault(vault.vaultId, Object.fromEntries(ids.map((id) => [id, vault.logs[id]!])));
        assert.equal(canonicalJson(JSON.parse(JSON.stringify({ ...state, history: undefined, rejected: undefined, conflicts: undefined }))), canonicalJson(JSON.parse(JSON.stringify({ ...reference, history: undefined, rejected: undefined, conflicts: undefined }))));
      }
      outcomes.add(membership(reference));
      // The founder's removal of c stands; c's removal of b, made without seeing it, is past c's
      // cutoff and not a counter-removal, so it is rejected (rule 1): b stays, its approval of d
      // stands.
      assert.equal(reference.members[ids.c]?.removed, true);
      assert.equal(reference.members[ids.b]?.removed, false);
      assert.equal(reference.members[ids.d]?.removed, false);
      // (Both edits were signed on the shared copy at seqs their authors had already used, so
      // neither verifies.)
      assert.deepEqual(reference.accounts, {});
    }
    assert.equal(outcomes.size, 1, 'membership must not depend on the authors\' clocks');
  });
});

// ---------------------------------------------------------------------------------------------
// Round 2 (security-review-2/findings2.md, PoCs N1-N11). Each succeeded against the round-1
// rules; each must fail now.
// ---------------------------------------------------------------------------------------------

function sameForEveryReadOrder(vault: MemoryVault, seed: string, forks: Parameters<typeof replayVault>[2] = {}): VaultState {
  const strip = (state: VaultState) => canonicalJson(JSON.parse(JSON.stringify({ ...state, history: undefined, rejected: undefined, conflicts: undefined })));
  const reference = replayVault(vault.vaultId, vault.logs, forks);
  for (let order = 0; order < 6; order++) {
    const ids = shuffled(Object.keys(vault.logs), seededRandom(`${seed}-${order}`));
    const state = replayVault(vault.vaultId, Object.fromEntries(ids.map((id) => [id, vault.logs[id]!])), forks);
    assert.equal(strip(state), strip(reference));
  }
  return reference;
}

function statusOf(state: VaultState, entry: SignedEntry): string {
  const item = state.history.find((h) => h.hash === entryHash(entry));
  return item ? `${item.status}${item.reason ? ` (${item.reason})` : ''}` : 'absent';
}

/** An admin added by `by`, with its hello written. */
function addAdmin(vault: MemoryVault, by: DeviceKeys, who: DeviceKeys, role: 'admin' | 'member' = 'admin'): void {
  vault.write(buildDeviceAdd(vault.state(), by, { device: who, role, name: 'x', currentKey: openVault(vault.state(), by).currentKey, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), who, vault.now()));
}

describe('N1: a late rotation from a senior device', () => {
  it('never becomes the key when it reached a device removed at the same time; the removal and what was built on it stand', () => {
    const [f, b, x] = [device(random), device(random), device(random)];
    const vault = MemoryVault.found(f, random);
    vault.write(buildRecoverySetFromPhrase(vault.state(), f, { phrase: generateRecoveryPhrase(random), currentKey: vault.key, random, time: vault.now() }).entry);
    addAdmin(vault, f, b);
    addAdmin(vault, f, x);
    const offline = vault.state();
    // The founder, offline, makes a new recovery phrase (sealed to x, which it still sees).
    const late = buildRecoverySetFromPhrase(offline, f, { phrase: generateRecoveryPhrase(random), currentKey: openVault(offline, f).currentKey, random, time: vault.now() });
    // Meanwhile b removes x and adds an account under the new key.
    const removal = buildDeviceRemove(offline, b, { device: x.deviceId, currentKey: openVault(offline, b).currentKey, random, time: vault.now() });
    agentAppend(vault, [removal.entry]);
    const afterRemoval = vault.state();
    const account = buildAccountPut(afterRemoval, b, { account: newAccountId(random), record: totpRecord({ issuer: 'After' }), currentKey: openVault(afterRemoval, b).currentKey, random, time: vault.now() });
    agentAppend(vault, [account]);
    // The founder reconnects. Its new phrase stands (the founder is still in the vault), but its
    // key reached x, so the removal's key stays the vault's and the new phrase gets a fresh key.
    const beforeLate = vault.state();
    agentAppend(vault, [late.entry]);
    assert.deepEqual(vault.state().members, beforeLate.members);
    const state = sameForEveryReadOrder(vault, 'n1');
    assert.equal(statusOf(state, late.entry), 'applied');
    assert.equal(statusOf(state, removal.entry), 'applied');
    assert.equal(state.sealedKeys[state.epoch]?.[x.deviceId], undefined);
    assert.equal(state.members[x.deviceId]?.removed, true);
    assert.throws(() => openVault(state, x));
    assert.equal(Object.values(openVault(state, b).accounts).some((a) => a.record.issuer === 'After'), true);
    assert.equal(state.needsFreshKey, true);
    const fresh = buildKeyRotate(state, b, { currentKey: openVault(state, b).currentKey, random, time: vault.now() });
    agentAppend(vault, [fresh.entry]);
    const settled = vault.state();
    assert.equal(settled.needsFreshKey, false);
    assert.ok(settled.sealedKeys[settled.epoch]?.[settled.recovery!.deviceId]);
    assert.throws(() => openVault(settled, x));
  });
});

describe('N2: a removed device removes its remover from a stale copy', () => {
  it('both removals apply (old phone and founder alike), neither comes back, and the remaining admin makes a fresh key', () => {
    const [f, old, fresh] = [device(random), device(random), device(random)];
    const vault = MemoryVault.found(f, random);
    addAdmin(vault, f, old);
    addAdmin(vault, old, fresh);
    const stale = vault.state();
    const removal = buildDeviceRemove(stale, fresh, { device: old.deviceId, currentKey: openVault(stale, fresh).currentKey, random, time: vault.now() });
    agentAppend(vault, [removal.entry]);
    const counter = buildDeviceRemove(stale, old, { device: fresh.deviceId, currentKey: openVault(stale, old).currentKey, random, time: vault.now() });
    agentAppend(vault, [counter.entry]);
    const state = sameForEveryReadOrder(vault, 'n2');
    assert.equal(statusOf(state, removal.entry), 'applied');
    assert.equal(statusOf(state, counter.entry), 'applied');
    assert.equal(state.members[old.deviceId]?.removed, true);
    assert.equal(state.members[fresh.deviceId]?.removed, true);
    assert.deepEqual(state.members[fresh.deviceId]?.removedBy, [old.deviceId]);
    assert.equal(state.needsFreshKey, true);
    // Neither removed device can approve itself back in.
    assert.throws(() => agentAppend(vault, [buildDeviceAdd(state, old, { device: old, role: 'admin', name: 'x', currentKey: vault.key, random, time: vault.now() })]), AppendRefused);
    // The founder writes the fresh key: only it holds it.
    const rotate = buildKeyRotate(state, f, { currentKey: openVault(state, f).currentKey, random, time: vault.now() });
    agentAppend(vault, [rotate.entry]);
    const after = vault.state();
    assert.equal(after.needsFreshKey, false);
    assert.deepEqual(Object.keys(after.sealedKeys[after.epoch]!), [f.deviceId]);
    assert.throws(() => openVault(after, old));
    assert.throws(() => openVault(after, fresh));
  });

  it('a removal by a device that had already seen its own removal is refused', () => {
    const [f, b] = [device(random), device(random)];
    const vault = MemoryVault.found(f, random);
    addAdmin(vault, f, b);
    const removal = buildDeviceRemove(vault.state(), f, { device: b.deviceId, currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [removal.entry]);
    const seen = vault.state();
    const back = buildDeviceRemove(seen, b, { device: f.deviceId, currentKey: vault.key, random, time: vault.now() });
    vault.write(back.entry);
    assert.match(statusOf(vault.state(), back.entry), /rejected \(the author was removed/);
    assert.equal(vault.state().members[f.deviceId]?.removed, false);
  });
});

describe('N3: a device re-signs its own entry that a removal named', () => {
  it('the removal still applies in the folder, the forged line is cut off, and a fork proof makes every copy agree on the line the removal named', () => {
    const [a, d] = [device(random), device(random)];
    const vault = MemoryVault.found(a, random, 'team');
    addAdmin(vault, a, d, 'member');
    agentAppend(vault, [buildAccountPut(vault.state(), d, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() })]);
    const removal = buildDeviceRemove(vault.state(), a, { device: d.deviceId, currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [removal.entry]);
    vault.key = removal.newKey;
    const original = vault.snapshot();
    // d rewrites its last line in the folder.
    const lines = vault.logs[d.deviceId]!;
    const last = JSON.parse(lines[lines.length - 1]!) as SignedEntry;
    const forged = resign(last, d, { time: last.time + 1 });
    vault.logs[d.deviceId] = [...lines.slice(0, -1), serializeEntry(forged)];
    const folder = vault.state();
    assert.equal(statusOf(folder, removal.entry), 'applied');
    assert.equal(folder.members[d.deviceId]?.removed, true);
    assert.match(statusOf(folder, forged), /rejected \(the author was removed/);
    // a keeps working; d can't.
    agentAppend(vault, [buildAccountPut(folder, a, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() })]);
    assert.throws(() => agentAppend(vault, [buildAccountDelete(vault.state(), d, { account: Object.keys(vault.state().accounts)[0]!, time: vault.now() })]), AppendRefused);
    // With the proof, a's copy (which has the original line) and the folder agree on what counts.
    const proofs = findForks(original, replayVault(vault.vaultId, original), vault.logs, vault.state());
    assert.deepEqual(proofs.map((p) => [p.deviceId, p.seq]), [[d.deviceId, last.seq]]);
    const local = replayVault(vault.vaultId, original, { forks: proofs });
    const remote = sameForEveryReadOrder(vault, 'n3', { forks: proofs });
    assert.equal(local.forked[d.deviceId], last.seq);
    // a's removal named d's original line, so the proof never takes it back (rule 4): the folder's
    // replay reads the original from the proof instead of the forged version nobody named, and
    // both copies agree on it, with d cut off just after it.
    assert.equal(remote.cutoffs[d.deviceId], last.seq);
    assert.equal(statusOf(local, last), 'applied');
    assert.equal(statusOf(remote, last), 'applied');
    assert.equal(remote.history.some((h) => h.hash === entryHash(forged)), false);
    const before = replayVault(vault.vaultId, original).accounts;
    for (const id of Object.keys(before)) assert.equal(Boolean(remote.accounts[id]), Boolean(local.accounts[id]));
  });

  it('a fork proof must carry two valid signatures of that device', () => {
    const [a, d] = [device(random), device(random)];
    const vault = MemoryVault.found(a, random);
    addAdmin(vault, a, d);
    const line = vault.logs[d.deviceId]![0]!;
    const entry = JSON.parse(line) as SignedEntry;
    const byOther = serializeEntry(resign(entry, a, { time: entry.time + 1 }));
    const state = replayVault(vault.vaultId, vault.logs, { forks: [{ deviceId: d.deviceId, seq: 0, lines: [line, byOther] }] });
    assert.deepEqual(state.forked, {});
    assert.equal(state.members[d.deviceId]?.removed, false);
  });
});

describe('N4: beacon claims', () => {
  it('a claim no vault could reach is reported against its signer and changes nothing', () => {
    const [f, m] = [device(random), device(random)];
    const vault = MemoryVault.found(f, random, 'team');
    addAdmin(vault, f, m, 'member');
    const state = vault.state();
    const poisoned = signBeacon({ ...state, epoch: Number.MAX_SAFE_INTEGER }, m, vault.now());
    const check = checkBeacons(state, { [m.deviceId]: JSON.stringify(poisoned) }, f.deviceId);
    assert.equal(check.claimedEpoch, state.epoch);
    assert.deepEqual(check.problems.map((p) => [p.device, p.kind]), [[m.deviceId, 'implausible']]);
  });
});

describe('N6: replay cost', () => {
  it('checks each log once, however deep the chain of approvals', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    let adder = founder;
    for (let i = 0; i < 12; i++) {
      const next = device(random);
      addAdmin(vault, adder, next);
      adder = next;
    }
    let checks = 0;
    class Counting extends VerifyCache {
      override remember(...args: Parameters<VerifyCache['remember']>): void {
        checks++;
        super.remember(...args);
      }
    }
    const state = replayVault(vault.vaultId, vault.logs, { cache: new Counting() });
    assert.equal(Object.keys(state.members).length, 13);
    assert.equal(checks, 13);
  });

  it('refuses a malformed batch before replaying the folder', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    let replays = 0;
    class Counting extends VerifyCache {
      override prefix(...args: Parameters<VerifyCache['prefix']>) {
        replays++;
        return super.prefix(...args);
      }
    }
    assert.throws(() => planAppend(vault.vaultId, vault.logs, [{ nonsense: true }], { cache: new Counting() }), AppendRefused);
    assert.throws(() => planAppend(vault.vaultId, vault.logs, [{ ...JSON.parse(vault.logs[founder.deviceId]![0]!), seq: 7 }], { cache: new Counting() }), AppendRefused);
    assert.equal(replays, 0);
  });

  it('a verified prefix cached for one vault is never reused for another', () => {
    const founder = device(random);
    const one = MemoryVault.found(founder, random);
    const cache = new VerifyCache();
    replayVault(one.vaultId, one.logs, { cache });
    const identity = { deviceId: founder.deviceId, ed: founder.edPublic, role: 'founder' as const };
    assert.equal(cache.prefix(one.vaultId, identity, one.logs[founder.deviceId]!).length, 1);
    assert.equal(cache.prefix('another-vault-id', identity, one.logs[founder.deviceId]!).length, 0);
  });
});

describe('determinism under clashes', () => {
  /** b removes x and builds on it; the founder, offline, removes y. The late removal arrives last. */
  function lateClash(clock: () => number) {
    const local = seededRandom('late-clash');
    const founder = device(local);
    const vault = new MemoryVault(createVault({ founder, kind: 'team', name: 'Home', deviceName: 'Phone', random: local, time: clock() }));
    const [b, x, y, n] = [device(local), device(local), device(local), device(local)];
    for (const who of [b, x, y]) {
      vault.write(buildDeviceAdd(vault.state(), founder, { device: who, role: 'admin', name: 'x', currentKey: vault.key, random: local, time: clock() }));
      vault.write(buildDeviceHello(vault.state(), who, clock()));
    }
    const shared = vault.state();
    const offline = buildDeviceRemove(shared, founder, { device: y.deviceId, currentKey: vault.key, random: local, time: clock() });
    const removal = buildDeviceRemove(shared, b, { device: x.deviceId, currentKey: vault.key, random: local, time: clock() });
    vault.write(removal.entry);
    const onB = vault.state();
    const key = openVault(onB, b).currentKey;
    vault.write(buildAccountPut(onB, b, { account: newAccountId(local), record: totpRecord(), currentKey: key, random: local, time: clock() }));
    vault.write(buildDeviceAdd(vault.state(), b, { device: n, role: 'member', name: 'n', currentKey: key, random: local, time: clock() }));
    const before = vault.state();
    vault.write(offline.entry);
    return { vault, before, ids: { founder: founder.deviceId, b: b.deviceId, x: x.deviceId, y: y.deviceId, n: n.deviceId } };
  }

  it('a removal arriving after others built on its rival: both removals stand, for every clock and read order', () => {
    const outcomes = new Set<string>();
    for (let run = 0; run < 10; run++) {
      const clocks = seededRandom(`late-clocks-${run}`);
      const { vault, before, ids } = lateClash(() => 1_000_000 + ((clocks(2)[0]! << 8) | clocks(2)[1]!));
      assert.equal(before.members[ids.x]?.removed, true);
      const state = sameForEveryReadOrder(vault, `late-${run}`);
      assert.equal(state.members[ids.x]?.removed, true);
      assert.equal(state.members[ids.y]?.removed, true);
      assert.equal(state.members[ids.n]?.removed, false);
      assert.equal(state.needsFreshKey, true);
      outcomes.add(canonicalJson({ members: Object.fromEntries(Object.values(state.members).map((m) => [m.deviceId, m.removed])), cutoffs: state.cutoffs }));
    }
    assert.equal(outcomes.size, 1);
  });

  it('mutual removals remove both devices for every clock and read order', () => {
    for (let run = 0; run < 8; run++) {
      const clocks = seededRandom(`mutual-${run}`);
      const clock = () => 1_000_000 + ((clocks(2)[0]! << 8) | clocks(2)[1]!);
      const local = seededRandom('mutual');
      const founder = device(local);
      const vault = new MemoryVault(createVault({ founder, kind: 'team', name: 'Home', deviceName: 'Phone', random: local, time: clock() }));
      const [a, b] = [device(local), device(local)];
      for (const who of [a, b]) {
        vault.write(buildDeviceAdd(vault.state(), founder, { device: who, role: 'admin', name: 'x', currentKey: vault.key, random: local, time: clock() }));
        vault.write(buildDeviceHello(vault.state(), who, clock()));
      }
      const shared = vault.state();
      vault.write(buildDeviceRemove(shared, a, { device: b.deviceId, currentKey: vault.key, random: local, time: clock() }).entry);
      vault.write(buildDeviceRemove(shared, b, { device: a.deviceId, currentKey: vault.key, random: local, time: clock() }).entry);
      const state = sameForEveryReadOrder(vault, `mutual-${run}`);
      assert.equal(state.members[a.deviceId]?.removed, true);
      assert.equal(state.members[b.deviceId]?.removed, true);
      assert.equal(state.members[founder.deviceId]?.removed, false);
      assert.equal(state.needsFreshKey, true);
    }
  });

  it('clashing fresh keys keep one, and the vault no longer needs another', () => {
    const [f, b, x, y] = [device(random), device(random), device(random), device(random)];
    const vault = MemoryVault.found(f, random);
    for (const who of [b, x, y]) addAdmin(vault, f, who);
    const shared = vault.state();
    vault.write(buildDeviceRemove(shared, f, { device: x.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    vault.write(buildDeviceRemove(shared, b, { device: y.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    const clashed = vault.state();
    assert.equal(clashed.needsFreshKey, true);
    // Both remaining admins write a fresh key at once.
    const one = buildKeyRotate(clashed, f, { currentKey: openVault(clashed, f).currentKey, random, time: vault.now() });
    const two = buildKeyRotate(clashed, b, { currentKey: openVault(clashed, b).currentKey, random, time: vault.now() });
    vault.write(one.entry);
    vault.write(two.entry);
    const state = sameForEveryReadOrder(vault, 'fresh');
    assert.equal(state.needsFreshKey, false);
    // Both apply; one is the vault's key, and the other changed nobody, so nothing more is needed.
    assert.equal([one.entry, two.entry].filter((e) => state.keyChecks[state.epoch] === (e.body as { keyCheck: string }).keyCheck).length, 1);
    assert.deepEqual(Object.keys(state.sealedKeys[state.epoch]!).sort(), [f.deviceId, b.deviceId].sort());
    assert.equal(openVault(state, f).epoch, openVault(state, b).epoch);
  });
});

describe('ids that are object keys', () => {
  it('a "__proto__" or "constructor" log or beacon from a hostile folder is ignored and changes nothing', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const clean = vault.state();
    const hostile = JSON.parse(`{"__proto__": ["x"], "constructor": ["y"], ${JSON.stringify(founder.deviceId)}: ${JSON.stringify(vault.logs[founder.deviceId])}}`) as VaultLogs;
    const state = replayVault(vault.vaultId, hostile);
    assert.equal(canonicalJson(JSON.parse(JSON.stringify({ ...state, rejected: undefined }))), canonicalJson(JSON.parse(JSON.stringify({ ...clean, rejected: undefined }))));
    assert.equal(Object.getPrototypeOf(state.members), Object.prototype);
    const beacons = JSON.parse('{"__proto__": "{}", "constructor": "{}"}') as Record<string, string>;
    assert.deepEqual(checkBeacons(state, beacons, null).problems, []);
  });
});

describe('N7: a send whose acknowledgement was lost', () => {
  function threeAdmins() {
    const [f, b, x] = [device(random), device(random), device(random)];
    const vault = MemoryVault.found(f, random);
    addAdmin(vault, f, b);
    addAdmin(vault, f, x);
    return { f, b, x, vault };
  }

  it('is sent again with the same bytes; the agent takes it once and an exact repeat changes nothing', () => {
    const { b, vault } = threeAdmins();
    const put = buildAccountPut(vault.state(), b, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [put]); // stored, but the answer never reached b
    const after = vault.snapshot();
    // b retries with the identical line: the folder already has it at that seq, so there is nothing to add.
    agentAppend(vault, [put]);
    assert.deepEqual(vault.logs, after);
    assert.equal(statusOf(vault.state(), put), 'applied');
  });

  it('while a clashing rotation arrives, the same line is kept as a placeholder and the change is made again after it', () => {
    const { f, b, x, vault } = threeAdmins();
    const shared = vault.state();
    // x makes a fresh key, which b sees; meanwhile f removes x, so x's key never becomes the vault's.
    const xRotation = buildKeyRotate(shared, x, { currentKey: vault.key, random, time: vault.now() });
    vault.write(xRotation.entry);
    const seenByB = vault.state();
    // b signs a put under x's key and stores it before sending; the send is lost.
    const put = buildAccountPut(seenByB, b, { account: newAccountId(random), record: totpRecord({ issuer: 'Kept' }), currentKey: xRotation.newKey, random, time: vault.now() });
    const removal = buildDeviceRemove(shared, f, { device: x.deviceId, currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [removal.entry]);
    // b retries the identical bytes: the agent keeps them as a placeholder (rejected, no effect)...
    const beforeRetry = vault.state();
    agentAppend(vault, [put]);
    const held = vault.state();
    assert.match(statusOf(held, put), /^rejected \(it is encrypted under a key that a change made at the same time replaced/);
    assert.deepEqual(held.accounts, beforeRetry.accounts);
    assert.equal(held.heads[b.deviceId]?.seq, put.seq);
    // ...and b makes the change again as a new entry at the next seq, under the new key.
    const remade = buildAccountPut(held, b, { account: (put.body as { account: string }).account, record: totpRecord({ issuer: 'Kept' }), currentKey: openVault(held, b).currentKey, random, time: vault.now() });
    assert.equal(remade.seq, put.seq + 1);
    agentAppend(vault, [remade]);
    const done = vault.state();
    assert.equal(statusOf(done, remade), 'applied');
    assert.equal(Object.values(openVault(done, b).accounts).some((a) => a.record.issuer === 'Kept'), true);
    assert.throws(() => openVault(done, x));
  });

  it('an agent that never stored the line takes the same bytes later, as an entry or a placeholder', () => {
    const { b, vault } = threeAdmins();
    const put = buildAccountPut(vault.state(), b, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    // The first send never arrived. The retry is the same line, which simply applies.
    agentAppend(vault, [put]);
    assert.equal(statusOf(vault.state(), put), 'applied');
    // A removed device's retry is refused: it can't fill the folder with placeholders.
    const [f, c, gone] = [device(random), device(random), device(random)];
    const other = MemoryVault.found(f, random);
    addAdmin(other, f, c);
    addAdmin(other, f, gone);
    const stale = other.state();
    const lost = buildAccountPut(stale, gone, { account: newAccountId(random), record: totpRecord(), currentKey: other.key, random, time: other.now() });
    agentAppend(other, [buildDeviceRemove(stale, f, { device: gone.deviceId, currentKey: other.key, random, time: other.now() }).entry]);
    assert.throws(() => agentAppend(other, [lost]), /removed/);
  });

  it('a placeholder never brings in a log, and a batch of placeholders alone never undoes an applied entry', () => {
    const { f, b, vault } = threeAdmins();
    const member = device(random);
    // A forged log for a device nobody added, then a rejected approval of it (only from a
    // device that isn't allowed): kept, it would make every replay read that log. Refused.
    const team = MemoryVault.found(f, random, 'team');
    addAdmin(team, f, b, 'member');
    team.write(signEntry({ v: 2, vault: team.vaultId, author: member.deviceId, seq: 0, prev: null, seen: {}, time: team.now(), kind: 'device.hello', body: {} }, member));
    const sneaky = buildDeviceAdd(team.state(), b, { device: member, role: 'member', name: 'M', currentKey: team.key, random, time: team.now() });
    assert.throws(() => agentAppend(team, [sneaky]), /only an admin device/);
    // A placeholder next to an applied change that undoes another device's applied entry is
    // fine: the undoing comes from the applied change, exactly as without the placeholder.
    const stale = vault.state();
    const put = buildAccountPut(stale, f, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    const bad = buildAccountDelete(stale, b, { account: newAccountId(random), time: vault.now() });
    const removal = buildDeviceRemove(afterOwnEntryState(stale, bad), b, { device: f.deviceId, currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [put]);
    agentAppend(vault, [bad, removal.entry]);
    assert.match(statusOf(vault.state(), put), /^rejected \(a removal made at the same time|^rejected/);
    assert.match(statusOf(vault.state(), bad), /^rejected/);
  });

});
