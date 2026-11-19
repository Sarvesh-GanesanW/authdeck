/** The git merge driver's decision, and history diffs. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addEnvMember,
  changeEnvValues,
  diffEnvFiles,
  envValueLineHash,
  mergeEnvFiles,
  nextEnvTrust,
  openEnvValues,
  parseEnvFile,
  rekeyEnvSet,
  envRecoveryKeys,
  removeEnvMember,
  setEnvRecovery,
  signEnvHeader,
  takeOverEnvSet,
  verifyEnvFile,
  writeEnvFile,
  type EnvHeader,
  type EnvMergeOutcome,
  type EnvSetFile,
} from '../../src/envcore';
import type { DeviceKeys } from '../../src/vault/crypto';
import { generateRecoveryPhrase } from '../../src/vault/recovery';
import { seededRandom } from '../helpers/vault';
import { device, makeSet, T0, VALUES, verified } from './fixtures';

const set = makeSet();
const random = seededRandom('merge');
const keys = { 1: set.dataKey };
const ben = device('ben');
const priya = device('priya');
const base = [ben, priya].reduce(
  (file, who, i) => addEnvMember({ file, owner: set.owner, dataKeys: keys, time: T0 + 1 + i, member: { edPublic: who.edPublic, xPublic: who.xPublic, label: `M${i}`, form: null } }),
  set.file,
);

function edit(file: EnvSetFile, author: DeviceKeys, upsert: Record<string, string>, remove: string[] = [], time = T0 + 10, dataKey = set.dataKey): EnvSetFile {
  return changeEnvValues({ file, author, dataKey, changes: { upsert: Object.entries(upsert).map(([name, value]) => ({ name, value })), remove }, time, random }).file;
}

function merge(ours: EnvSetFile | string, theirs: EnvSetFile | string): EnvMergeOutcome {
  const text = (file: EnvSetFile | string) => (typeof file === 'string' ? file : writeEnvFile(file));
  return mergeEnvFiles({ base: writeEnvFile(base), ours: text(ours), theirs: text(theirs), trust: null });
}

function merged(outcome: EnvMergeOutcome): string {
  assert.equal(outcome.kind, 'merged', JSON.stringify(outcome));
  return (outcome as { file: string }).file;
}

function valuesOf(text: string, dataKey = set.dataKey) {
  return Object.fromEntries(openEnvValues(verified(text, null).file, dataKey).map(({ name, value }) => [name, value]));
}

describe('merging two sides', () => {
  it('keeps both edits when the sides change different names', () => {
    const ours = edit(base, ben, { DATABASE_URL: 'ours', NEW_OURS: '1' });
    const theirs = edit(base, priya, { PEM: 'theirs', NEW_THEIRS: '2' });
    const text = merged(merge(ours, theirs));
    assert.deepEqual(valuesOf(text), { DATABASE_URL: 'ours', STRIPE_SECRET_KEY: VALUES[1]!.value, PEM: 'theirs', NEW_OURS: '1', NEW_THEIRS: '2' });
    assert.deepEqual(verified(text, null).file.values.map((line) => line.name), ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'PEM', 'NEW_OURS', 'NEW_THEIRS']);
  });

  it('on the same name: the higher version, then the later time, then the lower line hash', () => {
    const twice = edit(edit(base, ben, { PEM: 'b1' }), ben, { PEM: 'b2' });
    const once = edit(base, priya, { PEM: 'p1' }, [], T0 + 99);
    assert.equal(valuesOf(merged(merge(twice, once))).PEM, 'b2');
    assert.equal(valuesOf(merged(merge(once, twice))).PEM, 'b2');

    const early = edit(base, ben, { PEM: 'early' }, [], T0 + 10);
    const late = edit(base, priya, { PEM: 'late' }, [], T0 + 20);
    assert.equal(valuesOf(merged(merge(early, late))).PEM, 'late');
    assert.equal(valuesOf(merged(merge(late, early))).PEM, 'late');

    const a = edit(base, ben, { PEM: 'a' }, [], T0 + 30);
    const b = edit(base, priya, { PEM: 'b' }, [], T0 + 30);
    const lineOf = (file: EnvSetFile) => file.values.find((line) => line.name === 'PEM')!;
    const scope = { set: set.setId, epoch: 1 };
    const [hashA, hashB] = [envValueLineHash(lineOf(a), scope), envValueLineHash(lineOf(b), scope)];
    const lower = Buffer.compare(Buffer.from(hashA), Buffer.from(hashB)) < 0 ? 'a' : 'b';
    assert.equal(valuesOf(merged(merge(a, b))).PEM, lower);
    assert.equal(merged(merge(a, b)), merged(merge(b, a)), 'the same file whichever side is ours');
  });

  it('a delete against an edit: the later wins at equal versions, the higher version otherwise', () => {
    const deleted = edit(base, ben, {}, ['PEM'], T0 + 20);
    const changed = edit(base, priya, { PEM: 'kept' }, [], T0 + 10);
    assert.equal(valuesOf(merged(merge(deleted, changed))).PEM, undefined);
    assert.equal(valuesOf(merged(merge(changed, deleted))).PEM, undefined);
    const changedTwice = edit(changed, priya, { PEM: 'kept again' }, [], T0 + 11);
    assert.equal(valuesOf(merged(merge(deleted, changedTwice))).PEM, 'kept again');
  });

  it('takes the newer header when its authority continues the other', () => {
    const ours = edit(base, ben, { PEM: 'ours' });
    const theirs = addEnvMember({ file: base, owner: set.owner, dataKeys: keys, time: T0 + 5, member: { edPublic: device('chen').edPublic, xPublic: device('chen').xPublic, label: 'Chen', form: null } });
    const text = merged(merge(ours, theirs));
    assert.equal(verified(text, null).file.header.rev, 4);
    assert.equal(valuesOf(text).PEM, 'ours');
  });

  it('takes a take-over over a higher rev from the owner it replaced', () => {
    const takeover = takeOverEnvSet({ file: base, recovery: set.recovery, newOwner: device('maya-new'), label: 'Maya', form: null, time: T0 + 9, random });
    const oldOwner = addEnvMember({ file: base, owner: set.owner, dataKeys: keys, time: T0 + 9, member: { edPublic: device('chen').edPublic, xPublic: device('chen').xPublic, label: 'Chen', form: null } });
    const higher = { ...oldOwner, header: signEnvHeader({ ...unsignedOf(oldOwner.header), rev: 40 }, set.owner) };
    for (const outcome of [merge(higher, takeover.file), merge(takeover.file, higher)]) {
      assert.deepEqual(verified(merged(outcome), null).file.header, takeover.file.header);
    }
  });

  it('refuses two authorities that went separate ways', () => {
    const second = envRecoveryKeys(generateRecoveryPhrase(seededRandom('merge-phrase')), set.vaultId);
    const replaced = setEnvRecovery({ file: base, owner: set.owner, dataKeys: keys, time: T0 + 9, recovery: second, random });
    const takeover = takeOverEnvSet({ file: base, recovery: set.recovery, newOwner: device('maya-new'), label: 'Maya', form: null, time: T0 + 9, random });
    assert.deepEqual(merge(replaced.file, takeover.file), { kind: 'refused', problem: { kind: 'authority-fork', change: 1, ours: 'recovery', theirs: 'takeover' } });
    assert.deepEqual(merge(takeover.file, replaced.file), { kind: 'refused', problem: { kind: 'authority-fork', change: 1, ours: 'takeover', theirs: 'recovery' } });
  });

  it("refuses a newer header whose key went back under the same authority", () => {
    const removed = removeEnvMember({ file: base, owner: set.owner, dataKeys: keys, time: T0 + 5, memberId: ben.deviceId, random });
    const oldKey = { ...base, header: signEnvHeader({ ...unsignedOf(base.header), rev: 10 }, set.owner) };
    assert.deepEqual(merge(removed.file, oldKey), { kind: 'refused', problem: { kind: 'header-chain', rev: 10 } });
  });

  it('stops at two different headers at one rev', () => {
    const chen = device('chen');
    const dana = device('dana');
    const add = (who: DeviceKeys) => addEnvMember({ file: base, owner: set.owner, dataKeys: keys, time: T0 + 5, member: { edPublic: who.edPublic, xPublic: who.xPublic, label: 'X', form: null } });
    assert.deepEqual(merge(add(chen), add(dana)), { kind: 'two-headers', rev: 4 });
  });

  it('keeps a member edit made while the owner re-keyed, for the owner to box again', () => {
    const removed = removeEnvMember({ file: base, owner: set.owner, dataKeys: keys, time: T0 + 5, memberId: ben.deviceId, random });
    const priyaEdit = edit(base, priya, { PEM: 'priya, old key' }, [], T0 + 6);
    const benEdit = edit(base, ben, { DATABASE_URL: 'from the removed member' }, [], T0 + 6);
    const text = merged(merge(removed.file, priyaEdit));
    const problem = verifyEnvFile(text, null);
    assert.deepEqual(problem.ok ? null : problem.problem, { kind: 'wrong-epoch', line: 11, name: 'PEM', epoch: 1, current: 2 });
    const fixed = rekeyEnvSet({ file: verifiedLoose(text), owner: set.owner, dataKeys: { 1: set.dataKey, 2: removed.dataKey }, time: T0 + 7, random });
    assert.equal(valuesOf(writeEnvFile(fixed.file), fixed.dataKey).PEM, 'priya, old key');
    assert.equal(valuesOf(merged(merge(removed.file, benEdit)), removed.dataKey).DATABASE_URL, VALUES[0]!.value, "a removed member's edit is dropped");
  });

  it('drops a deletion made under the old key, keeping the re-keyed line', () => {
    const removed = removeEnvMember({ file: base, owner: set.owner, dataKeys: keys, time: T0 + 5, memberId: ben.deviceId, random });
    const deleted = edit(base, priya, {}, ['PEM'], T0 + 6);
    assert.equal(valuesOf(merged(merge(removed.file, deleted)), removed.dataKey).PEM, VALUES[2]!.value);
  });

  it('refuses a side that fails its checks, and conflict markers', () => {
    const ours = writeEnvFile(base);
    assert.deepEqual(merge(ours.replace('PEM=', '<<<<<<< HEAD\nPEM='), base), { kind: 'refused', problem: { kind: 'conflict-markers', line: 12 } });
    const tampered = ours.replace(/^(PEM=.* ; v1 \S+ )\d+/m, '$1123');
    assert.equal(merge(base, tampered).kind, 'refused');
    assert.deepEqual(merge(base, makeSet('other').file), { kind: 'refused', problem: { kind: 'header-chain', rev: 1 } });
  });

  it('checks each side against the computer’s trust', () => {
    const later = edit(base, ben, { PEM: 'v2' });
    const trust = nextEnvTrust(null, verified(writeEnvFile(later), null));
    const outcome = mergeEnvFiles({ base: null, ours: writeEnvFile(later), theirs: writeEnvFile(base), trust });
    assert.deepEqual(outcome, { kind: 'refused', problem: { kind: 'older-value', line: 12, name: 'PEM', seen: 2, found: 1 } });
  });

  it('refuses a merge that would go over a cap', () => {
    const many = (prefix: string, author: DeviceKeys) => edit(base, author, Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`${prefix}${i}`, ''])));
    assert.deepEqual(merge(many('A', ben), many('B', priya)), { kind: 'refused', problem: { kind: 'too-large', limit: 'names' } });
  });
});

/** The model of a file that only fails `wrong-epoch`, which the owner's re-key starts from. */
function verifiedLoose(text: string): EnvSetFile {
  const result = verifyEnvFile(text, null);
  assert.equal(result.ok ? null : result.problem.kind, 'wrong-epoch');
  return parseOk(text);
}

function unsignedOf(header: EnvHeader): Omit<EnvHeader, 'sig'> {
  const { sig: _sig, ...unsigned } = header;
  return unsigned;
}

function parseOk(text: string): EnvSetFile {
  const result = parseEnvFile(text);
  assert.ok(result.ok);
  return result.parsed.file;
}

describe('history', () => {
  it('names added, changed and removed variables and who signed', () => {
    const before = edit(base, ben, {}, ['STRIPE_SECRET_KEY']);
    const after = edit(before, priya, { PEM: 'p2', STRIPE_SECRET_KEY: 'back', NEW: 'n' }, ['DATABASE_URL']);
    assert.deepEqual(diffEnvFiles(before, after), {
      added: ['STRIPE_SECRET_KEY', 'NEW'],
      changed: ['PEM'],
      removed: ['DATABASE_URL'],
      membersAdded: [],
      membersRemoved: [],
      newKey: false,
      signers: [priya.deviceId],
    });
  });

  it('names members added and removed, the new key, and the owner as signer', () => {
    const removed = removeEnvMember({ file: base, owner: set.owner, dataKeys: keys, time: T0 + 5, memberId: ben.deviceId, random });
    const change = diffEnvFiles(base, removed.file);
    assert.deepEqual(change.membersRemoved.map((member) => member.id), [ben.deviceId]);
    assert.deepEqual([change.newKey, change.added, change.changed, change.removed, change.signers], [true, [], [], [], [set.owner.deviceId]]);
    assert.deepEqual(diffEnvFiles(set.file, base).membersAdded.map((member) => member.id), [ben.deviceId, priya.deviceId]);
  });

  it('describes the first commit as everything added', () => {
    const change = diffEnvFiles(null, set.file);
    assert.deepEqual([change.added, change.membersAdded.length, change.newKey, change.signers], [VALUES.map((value) => value.name), 1, false, [set.owner.deviceId]]);
  });
});
