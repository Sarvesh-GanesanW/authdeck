import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { remakeRejected, type RemakeInput } from '../src/auth/engine/remake';
import { ownSentLength } from '../src/auth/engine/sync';
import { JOIN_ATTEMPT_LIMIT, pausedRefusal, trackWaiting, UNHEARD_WARNING_MS, vaultWarnings, WAIT_WARNING_MS, type WarningInput } from '../src/auth/engine/warnings';
import { checkBeacons, signBeacon } from '../src/vault/beacon';
import { toBase64Url } from '../src/vault/bytes';
import { buildAccountDelete, buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, buildKeyRotate, newAccountId } from '../src/vault/build';
import type { DeviceKeys } from '../src/vault/crypto';
import { entryHash, serializeEntry, signEntry } from '../src/vault/entry';
import { openVault } from '../src/vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase } from '../src/vault/recovery';
import { replayVault, type VaultState } from '../src/vault/replay';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers';

const random = seededRandom('engine-rules-tests');

/** Founder, a second device and a third, all said hello. */
function threeDevices() {
  const vault = new MemoryVault(device(random), random);
  const [second, third] = [device(random), device(random)];
  for (const d of [second, third]) {
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: d, role: 'admin', name: d === second ? 'Pixel 8' : 'iPad', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), d, vault.now()));
  }
  return { vault, second, third };
}

function remakeInput(vault: MemoryVault, author: DeviceKeys, sentLength: number, state: VaultState = vault.state()): RemakeInput {
  return { logs: vault.copy(), state, sentLength, device: author, keys: openVault(state, author).keys, random, time: vault.now(), replay: {} };
}

/**
 * The third device makes a fresh key and the founder adds an account under it, while the second
 * device, not having seen that key, removes the third: the third's key never becomes the vault's,
 * so the rules reject the put.
 */
function putRejectedByConcurrentRemoval() {
  const { vault, second, third } = threeDevices();
  const shared = vault.state();
  const rotation = buildKeyRotate(shared, third, { currentKey: vault.key, random, time: vault.now() });
  vault.write(rotation.entry);
  const account = newAccountId(random);
  const put = vault.write(buildAccountPut(vault.state(), vault.founder, { account, record: totpRecord({ issuer: 'Bank' }), currentKey: rotation.newKey, random, time: vault.now() }));
  vault.write(buildDeviceRemove(shared, second, { device: third.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
  return { vault, second, third, account, put };
}

describe('remaking changes the rules rejected', () => {
  it('re-encrypts an unsent account under the key that replaced the old one, at the same seq', () => {
    const { vault, third, account, put } = putRejectedByConcurrentRemoval();
    const state = vault.state();
    assert.equal(state.history.find((h) => h.hash === entryHash(put))?.status, 'rejected');

    const remade = remakeRejected(remakeInput(vault, vault.founder, put.seq));
    assert.ok(remade);
    assert.deepEqual(remade.lost, []);
    // Only the removed device's fresh key stays rejected.
    assert.deepEqual(remade.state.rejected.filter((r) => r.deviceId !== third.deviceId), []);
    assert.equal(openVault(remade.state, vault.founder).accounts[account]?.record.issuer, 'Bank');
    assert.equal(remade.state.accounts[account]?.box.epoch, 1);
  });

  it('makes a sent-then-rejected account change again as a new entry, keeping the sent line (N8)', () => {
    const { vault, account, put } = putRejectedByConcurrentRemoval();
    const own = vault.founder.deviceId;
    const sentLine = vault.logs[own]![put.seq];

    const remade = remakeRejected(remakeInput(vault, vault.founder, put.seq + 1));
    assert.ok(remade);
    assert.equal(remade.logs[own]![put.seq], sentLine, 'the sent line is never re-signed');
    assert.equal(remade.logs[own]!.length, put.seq + 2);
    assert.equal(openVault(remade.state, vault.founder).accounts[account]?.record.issuer, 'Bank');

    const again = remakeRejected({ ...remakeInput(vault, vault.founder, put.seq + 2, remade.state), logs: remade.logs });
    assert.equal(again, null, 'once made again, the rejected line is not made a second time');
  });

  it('never re-signs a seq the folder accepted, even when the folder later under-reports it (N7)', () => {
    const { vault, put } = putRejectedByConcurrentRemoval();
    const own = vault.founder.deviceId;
    const sentLine = vault.logs[own]![put.seq];
    // The computer serves the founder's log without the put it accepted earlier.
    const served = { ...vault.copy(), [own]: vault.logs[own]!.slice(0, put.seq) };
    const servedState = replayVault(vault.vaultId, served);
    const ownHead = { seq: put.seq, hash: entryHash(put) };

    assert.equal(ownSentLength(servedState, own, null), put.seq, 'the folder alone would make the put look unsent');
    const sentLength = ownSentLength(servedState, own, ownHead);
    assert.equal(sentLength, put.seq + 1);
    const remade = remakeRejected(remakeInput(vault, vault.founder, sentLength));
    assert.equal(remade?.logs[own]![put.seq], sentLine);
  });

  it('a new phrase that lost to one made at the same time is not made again, and the person is told which phrase works', () => {
    const { vault, second, third } = threeDevices();
    const shared = vault.state();
    // Two new phrases at the same time: one is kept, the other rejected.
    const sets = [second, third].map((by) => ({ by, entry: vault.write(buildRecoverySetFromPhrase(shared, by, { phrase: generateRecoveryPhrase(random), currentKey: vault.key, random, time: vault.now() }).entry) }));
    const state = vault.state();
    const lost = sets.find((x) => state.history.find((h) => h.hash === entryHash(x.entry))?.status === 'rejected');
    assert.ok(lost, 'one of the two phrases is rejected');

    // The other phrase applied, so nothing is made again; the person is told which phrase works.
    const kept = sets.find((x) => x !== lost)!;
    const remade = remakeRejected(remakeInput(vault, lost.by, vault.logs[lost.by.deviceId]!.length));
    assert.ok(remade);
    assert.equal(remade.recoveryChanged, true);
    assert.deepEqual(remade.lost.map((l) => l.hash), [entryHash(lost.entry)]);
    assert.equal(remade.state.recovery?.ed, (kept.entry.body as { ed: string }).ed);
    assert.equal(remade.logs[lost.by.deviceId]!.length, vault.logs[lost.by.deviceId]!.length);
  });

  it('does not make a rejected key rotation again', () => {
    const { vault, second } = threeDevices();
    const shared = vault.state();
    const a = vault.write(buildKeyRotate(shared, vault.founder, { currentKey: vault.key, random, time: vault.now() }).entry);
    const b = vault.write(buildKeyRotate(shared, second, { currentKey: vault.key, random, time: vault.now() }).entry);
    const state = vault.state();
    const loser = [a, b].find((e) => state.history.find((h) => h.hash === entryHash(e))?.status === 'rejected')!;
    const author = loser === a ? vault.founder : second;
    assert.equal(remakeRejected(remakeInput(vault, author, vault.logs[author.deviceId]!.length)), null);
  });

  it('makes nothing again for a device that was removed', () => {
    const { vault, second, third } = threeDevices();
    const shared = vault.state();
    vault.write(buildDeviceRemove(shared, second, { device: third.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    vault.write(buildAccountPut(shared, third, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
    const state = vault.state();
    assert.equal(state.members[third.deviceId]?.removed, true);
    const input = { logs: vault.copy(), state, sentLength: 0, device: third, keys: {}, random, time: vault.now(), replay: {} };
    assert.equal(remakeRejected(input), null);
  });

  it('has nothing to do when nothing is rejected', () => {
    const { vault } = threeDevices();
    vault.write(buildAccountPut(vault.state(), vault.founder, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
    assert.equal(remakeRejected(remakeInput(vault, vault.founder, 0)), null);
  });
});

const names = (id: string) => `device ${id.slice(0, 4)}`;

function warningInput(state: VaultState, overrides: Partial<WarningInput> = {}): WarningInput {
  return { state, self: null, beacons: null, highestEpoch: state.epoch, waitingSince: new Map(), keyProblems: [], stoppedJoins: 0, now: 0, deviceName: names, ...overrides };
}

/** The warnings these tests are about: their vaults have no recovery phrase, which is tested on its own. */
function warningsBesidesRecovery(input: WarningInput) {
  const result = vaultWarnings(input);
  return { ...result, warnings: result.warnings.filter((w) => w.kind !== 'no-recovery') };
}

describe('vault warnings', () => {
  it('pauses new secrets while the folder is below the highest epoch this device reached', () => {
    const { vault } = threeDevices();
    const state = vault.state();
    assert.deepEqual(warningsBesidesRecovery(warningInput(state)), { warnings: [], secretsPaused: false });
    const held = warningsBesidesRecovery(warningInput(state, { highestEpoch: 2 }));
    assert.equal(held.secretsPaused, true);
    assert.equal(held.warnings[0]?.kind, 'withheld');
    assert.match(held.warnings[0]!.text, /^This device has seen a newer vault key/);
  });

  it('treats a beacon epoch as a claim that names its signer and goes when the signer is removed (N4)', () => {
    const { vault, second } = threeDevices();
    const state = vault.state();
    // A newer epoch counts only with a line this copy lacks (the key change held back from it).
    const head = state.heads[vault.founder.deviceId]!;
    const ahead = { ...state, epoch: state.epoch + 2, heads: { ...state.heads, [vault.founder.deviceId]: { ...head, seq: head.seq + 1, hash: 'h'.repeat(43) } } };
    const claim = signBeacon(ahead, second, vault.now());
    const beacons = checkBeacons(state, { [second.deviceId]: JSON.stringify(claim) }, vault.founder.deviceId);
    const claimed = warningsBesidesRecovery(warningInput(state, { beacons }));
    assert.equal(claimed.secretsPaused, true);
    assert.deepEqual(claimed.warnings[0] && [claimed.warnings[0].kind, claimed.warnings[0].deviceId], ['withheld', second.deviceId]);
    assert.match(claimed.warnings[0]!.text, new RegExp(`^${names(second.deviceId)} has seen a newer vault key`));
    // Nothing of the claim is this device's own: the epoch it remembers is its replay's.
    assert.equal(warningsBesidesRecovery(warningInput(state)).secretsPaused, false);

    vault.write(buildDeviceRemove(state, vault.founder, { device: second.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    const after = vault.state();
    assert.equal(warningsBesidesRecovery(warningInput(after, { beacons })).secretsPaused, false, 'held findings of a removed signer count for nothing');
    assert.deepEqual(checkBeacons(after, { [second.deviceId]: JSON.stringify(claim) }, vault.founder.deviceId).problems, []);
  });

  it('reports a far-fetched beacon against its signer without pausing', () => {
    const { vault, second } = threeDevices();
    const state = vault.state();
    const claim = signBeacon({ ...state, epoch: Number.MAX_SAFE_INTEGER }, second, vault.now());
    const beacons = checkBeacons(state, { [second.deviceId]: JSON.stringify(claim) }, vault.founder.deviceId);
    const result = warningsBesidesRecovery(warningInput(state, { beacons }));
    assert.equal(result.secretsPaused, false);
    assert.deepEqual(result.warnings.filter((w) => w.kind !== 'unheard').map((w) => [w.kind, w.deviceId]), [['implausible', second.deviceId]]);
  });

  it('warns about another admin device not heard from in a day, naming it', () => {
    const { vault, second, third } = threeDevices();
    const state = vault.state();
    const now = Date.UTC(2026, 10, 5, 12);
    const fresh = { problems: [], claimedEpoch: state.epoch, heardAt: { [second.deviceId]: now - 60_000, [third.deviceId]: now - 60_000 } };
    const self = vault.founder.deviceId;
    assert.deepEqual(warningsBesidesRecovery(warningInput(state, { self, beacons: fresh, now })).warnings, []);
    assert.deepEqual(warningsBesidesRecovery(warningInput(state, { self, beacons: null, now })).warnings, [], 'no beacons read yet: nothing to say');

    const stale = { ...fresh, heardAt: { [second.deviceId]: now - UNHEARD_WARNING_MS - 1 } };
    const warnings = warningsBesidesRecovery(warningInput(state, { self, beacons: stale, now, deviceName: (id) => (id === second.deviceId ? 'Pixel 8' : 'iPad') })).warnings;
    assert.deepEqual(warnings.map((w) => [w.kind, w.deviceId]), [
      ['unheard', second.deviceId],
      ['unheard', third.deviceId],
    ]);
    assert.match(warnings[0]!.text, /^Pixel 8 hasn't been heard from since .+\. If it removed a device, this computer may be hiding that\./);
    assert.match(warnings[1]!.text, /^iPad hasn't been heard from yet\./);
  });

  it('pauses new secrets while the vault needs a fresh key, but lets an HOTP counter move', () => {
    const { vault, second, third } = threeDevices();
    const shared = vault.state();
    // A new phrase at the same time as a removal: the removal's key is the vault's, and the new
    // phrase can't open it.
    vault.write(buildDeviceRemove(shared, vault.founder, { device: third.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    vault.write(buildRecoverySetFromPhrase(shared, second, { phrase: generateRecoveryPhrase(random), currentKey: vault.key, random, time: vault.now() }).entry);
    const state = vault.state();
    assert.equal(state.needsFreshKey, true);
    const paused = warningsBesidesRecovery(warningInput(state));
    assert.equal(paused.secretsPaused, true);
    assert.equal(paused.warnings[0]?.kind, 'fresh-key');
    assert.equal(pausedRefusal('account.put', true, paused), null, 'using an HOTP code only moves its counter');
    assert.match(pausedRefusal('account.put', false, paused)!, /paused/);
    assert.equal(pausedRefusal('account.delete', false, paused), null);

    // What the engine writes by itself as an admin holding the current key.
    const key = openVault(state, vault.founder).currentKey;
    vault.write(buildKeyRotate(state, vault.founder, { currentKey: key, random, time: vault.now() }).entry);
    const fixed = vault.state();
    assert.equal(fixed.needsFreshKey, false);
    assert.equal(warningsBesidesRecovery(warningInput(fixed)).secretsPaused, false);
  });

  it('tells a solo vault that only its recovery phrase makes the fresh key, never an admin device', () => {
    const { vault, second, third } = threeDevices();
    const shared = vault.state();
    vault.write(buildDeviceRemove(shared, vault.founder, { device: third.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    vault.write(buildRecoverySetFromPhrase(shared, second, { phrase: generateRecoveryPhrase(random), currentKey: vault.key, random, time: vault.now() }).entry);
    const state = vault.state();
    assert.equal(state.needsFreshKey, true);
    const freshKeyText = (kind: VaultState['kind']) => vaultWarnings(warningInput({ ...state, kind })).warnings.find((w) => w.kind === 'fresh-key')?.text ?? '';
    assert.match(freshKeyText('personal'), /admin device makes a fresh key/);
    const solo = freshKeyText('solo');
    assert.doesNotMatch(solo, /admin/);
    assert.match(solo, /only the recovery phrase can make one/);
    assert.match(solo, /Make a new phrase/);
  });

  it('names the device a change has waited on for a long time, not one that just arrived', () => {
    const { vault, second } = threeDevices();
    const base = buildAccountDelete(vault.state(), vault.founder, { account: newAccountId(random), time: vault.now() });
    const { sig: _sig, ...unsigned } = base;
    vault.write(signEntry({ ...unsigned, seen: { ...base.seen, [second.deviceId]: { seq: 50, hash: toBase64Url(random(32)) } } }, vault.founder));
    const state = vault.state();
    const since = trackWaiting(new Map(), state, 1_000);
    assert.equal(since.size, 1);
    assert.deepEqual(warningsBesidesRecovery(warningInput(state, { waitingSince: since, now: 1_000 })).warnings, []);
    const late = warningsBesidesRecovery(warningInput(state, { waitingSince: since, now: 1_000 + WAIT_WARNING_MS }));
    assert.deepEqual(late.warnings.map((w) => [w.kind, w.deviceId]), [['waiting', second.deviceId]]);
    assert.equal(late.secretsPaused, false);
  });

  it('marks a device with valid proof of two histories', () => {
    const { vault, second } = threeDevices();
    const shared = vault.state();
    const first = vault.write(buildAccountPut(shared, second, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
    const other = buildAccountPut(shared, second, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    const proof = { deviceId: second.deviceId, seq: first.seq, lines: [serializeEntry(first), serializeEntry(other)] as [string, string] };
    const state = replayVault(vault.vaultId, vault.logs, { forks: [proof] });
    assert.equal(state.forked[second.deviceId], first.seq);
    const warnings = warningsBesidesRecovery(warningInput(state)).warnings;
    assert.deepEqual(warnings.filter((w) => w.kind === 'fork').map((w) => w.deviceId), [second.deviceId]);
    // It held the current key and counts as removed, so the vault needs a fresh one.
    assert.ok(warnings.some((w) => w.kind === 'fresh-key'));
  });

  it('without a fork proof, names the writer of the conflicting change and accuses nobody (R6)', () => {
    const { vault, second } = threeDevices();
    const shared = vault.state();
    vault.write(buildAccountPut(shared, second, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
    // The founder was shown a different entry from the second device at the same seq.
    const shown = buildAccountPut(shared, second, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    const shownLogs = { ...vault.copy(), [second.deviceId]: [...vault.logs[second.deviceId]!.slice(0, -1), serializeEntry(shown)] };
    vault.write(buildAccountDelete(replayVault(vault.vaultId, shownLogs), vault.founder, { account: newAccountId(random), time: vault.now() }));
    const state = vault.state();
    assert.equal(state.conflicts[0]?.names.deviceId, second.deviceId);
    const forks = warningsBesidesRecovery(warningInput(state)).warnings.filter((w) => w.kind === 'fork');
    assert.deepEqual(forks.map((w) => w.deviceId), [vault.founder.deviceId]);
    assert.match(forks[0]!.text, new RegExp(`^${names(vault.founder.deviceId)}'s change names a version of ${names(second.deviceId)}'s history`));
    assert.doesNotMatch(forks[0]!.text, /signed two different versions|Remove/);
  });

  it('warns once enough join attempts were stopped', () => {
    const { vault } = threeDevices();
    const state = vault.state();
    assert.deepEqual(warningsBesidesRecovery(warningInput(state, { stoppedJoins: JOIN_ATTEMPT_LIMIT - 1 })).warnings, []);
    const [warning] = warningsBesidesRecovery(warningInput(state, { stoppedJoins: JOIN_ATTEMPT_LIMIT })).warnings;
    assert.equal(warning?.kind, 'joins');
    assert.match(warning!.text, /^Someone may be trying to join this vault: 3 join attempts were stopped in the last hour/);
  });
});

describe('the missing recovery phrase warning', () => {
  it('stands while more than one device is in the vault and no phrase is set, and never pauses secrets', () => {
    const { vault } = threeDevices();
    const self = vault.founder.deviceId;
    const result = vaultWarnings(warningInput(vault.state(), { self }));
    assert.equal(result.secretsPaused, false);
    assert.deepEqual(result.warnings.map((w) => w.kind), ['no-recovery']);
    assert.equal(result.warnings[0]!.text, "No recovery phrase is set. If your devices ever remove each other, this vault can't be recovered. Set a recovery phrase.");
  });

  it('goes once a phrase is set', () => {
    const { vault } = threeDevices();
    const set = buildRecoverySetFromPhrase(vault.state(), vault.founder, { phrase: generateRecoveryPhrase(random), currentKey: vault.key, random, time: vault.now() });
    vault.write(set.entry);
    assert.deepEqual(vaultWarnings(warningInput(vault.state(), { self: vault.founder.deviceId })).warnings, []);
  });

  it('is not shown with one device left, or on a device that was removed', () => {
    const lone = new MemoryVault(device(random), random);
    assert.deepEqual(vaultWarnings(warningInput(lone.state(), { self: lone.founder.deviceId })).warnings, []);

    const { vault, second, third } = threeDevices();
    vault.write(buildDeviceRemove(vault.state(), vault.founder, { device: second.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    const state = vault.state();
    assert.deepEqual(vaultWarnings(warningInput(state, { self: second.deviceId })).warnings.map((w) => w.kind), [], 'the removed device can\'t set a phrase');
    assert.deepEqual(vaultWarnings(warningInput(state, { self: third.deviceId })).warnings.map((w) => w.kind), ['no-recovery'], 'two devices are still in');
  });
});
