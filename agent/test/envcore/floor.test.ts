/** The history floor a device with no trust applies before adopting a file. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addEnvMember,
  changeEnvValues,
  checkEnvFloor,
  createEnvFloorBuilder,
  envFileProblemWords,
  envHistoryFloor,
  envRecoveryKeys,
  removeEnvMember,
  setEnvRecovery,
  signEnvHeader,
  takeOverEnvSet,
  writeEnvFile,
  type EnvHeader,
  type EnvSetFile,
} from '../../src/envcore';
import { generateRecoveryPhrase } from '../../src/vault/recovery';
import { seededRandom } from '../helpers/vault';
import { device, makeSet, T0 } from './fixtures';

const set = makeSet('floor');
const random = seededRandom('floor');
const keys = { 1: set.dataKey };
const ben = device('ben');
const withBen = addEnvMember({ file: set.file, owner: set.owner, dataKeys: keys, time: T0 + 1, member: { edPublic: ben.edPublic, xPublic: ben.xPublic, label: 'Ben', form: null } });
const deleted = changeEnvValues({ file: withBen, author: set.owner, dataKey: set.dataKey, changes: { upsert: [], remove: ['PEM'] }, time: T0 + 2, random }).file;
const commits = (...files: EnvSetFile[]) => files.map((file, i) => ({ commit: `c${i}`, text: writeEnvFile(file) }));
/** The deletion's file with PEM's tombstone swapped back for the line before it: signed, same header. */
const swapped = writeEnvFile({ ...deleted, values: deleted.values.map((line) => (line.name === 'PEM' ? set.file.values[2]! : line)) });

describe('history floor', () => {
  it('refuses a deleted variable swapped back in, from the signed history of the same header', () => {
    const floor = envHistoryFloor(swapped, commits(set.file, withBen, deleted));
    assert.equal(floor.versions.PEM, 2);
    assert.deepEqual(floor.commits, ['c0', 'c1', 'c2']);
    assert.deepEqual(checkEnvFloor(swapped, floor), { kind: 'older-value', line: 11, name: 'PEM', seen: 2, found: 1 });
    assert.equal(checkEnvFloor(writeEnvFile(deleted), floor), null);
  });

  it('carries the floor across a re-key', () => {
    const rekeyed = removeEnvMember({ file: deleted, owner: set.owner, dataKeys: keys, time: T0 + 3, memberId: ben.deviceId, random }).file;
    const dropped = writeEnvFile({ ...rekeyed, values: rekeyed.values.filter((line) => line.name !== 'PEM') });
    const floor = envHistoryFloor(dropped, commits(deleted, rekeyed));
    assert.deepEqual(checkEnvFloor(dropped, floor), { kind: 'older-value', line: 3, name: 'PEM', seen: 2, found: 0 });
  });

  it('refuses a file older than a later header of the set', () => {
    const floor = envHistoryFloor(writeEnvFile(set.file), commits(withBen));
    assert.deepEqual([floor.authority, floor.rev, floor.header.rev], [0, 2, 2]);
    assert.deepEqual(checkEnvFloor(writeEnvFile(set.file), floor), { kind: 'older-header', seen: 2, found: 1 });
  });

  it('ignores history of another set, unsigned history, and a set someone else made under the id', () => {
    const other = makeSet('floor-other');
    const tampered = writeEnvFile(deleted).replace(/^(PEM=deleted ; v2 \S+ )\d+/m, '$1999');
    // Another owner's set, its header renamed to this set's id and signed: its birth doesn't hash to the id.
    const renamed = { ...other.file, header: signEnvHeader({ ...unsignedOf(other.file.header), set: set.setId, rev: 9 }, other.owner) };
    const history = [...commits(other.file), { commit: 'bad', text: tampered }, { commit: 'forged', text: writeEnvFile(renamed) }, { commit: 'junk', text: 'not a set' }];
    const floor = envHistoryFloor(swapped, history);
    assert.deepEqual([floor.versions, floor.commits, floor.rev], [{}, [], 2]);
    assert.equal(checkEnvFloor(swapped, floor), null, 'with no usable history, nothing to compare against');
  });

  it('counts every version of the set when git skipped some (ENV-18)', () => {
    const withPriya = addEnvMember({ file: withBen, owner: set.owner, dataKeys: keys, time: T0 + 3, member: { edPublic: device('priya').edPublic, xPublic: device('priya').xPublic, label: 'Priya', form: null } });
    // Revs 1 and 3 committed, never rev 2.
    const floor = envHistoryFloor(writeEnvFile(withPriya), commits(set.file, withPriya));
    assert.deepEqual([floor.commits, floor.rev], [['c0', 'c1'], 3]);
    assert.equal(checkEnvFloor(writeEnvFile(withPriya), floor), null);
  });

  it('a forged same-id commit that was reverted does not block the honest file (ENV-19)', () => {
    const mallory = makeSet('floor-mallory');
    const forged = { ...mallory.file, header: signEnvHeader({ ...unsignedOf(mallory.file.header), set: set.setId, rev: 50 }, mallory.owner) };
    const history = [...commits(set.file, withBen, deleted), { commit: 'forged', text: writeEnvFile(forged) }, { commit: 'revert', text: writeEnvFile(deleted) }];
    const floor = envHistoryFloor(writeEnvFile(deleted), history);
    assert.deepEqual([floor.commits, floor.rev], [['c0', 'c1', 'c2', 'revert'], 2]);
    assert.equal(checkEnvFloor(writeEnvFile(deleted), floor), null);
  });

  it('a take-over is newer than any rev of the owner it replaced, and that owner adds nothing', () => {
    const newPhone = device('maya-new');
    const taken = takeOverEnvSet({ file: deleted, recovery: set.recovery, newOwner: newPhone, label: 'Maya', form: null, time: T0 + 5, random });
    const oldOwner = { ...withBen, header: signEnvHeader({ ...unsignedOf(withBen.header), rev: 40 }, set.owner) };
    const oldEdit = changeEnvValues({ file: oldOwner, author: set.owner, dataKey: set.dataKey, changes: { upsert: [{ name: 'DATABASE_URL', value: 'later' }], remove: [] }, time: T0 + 6, random }).file;
    const floor = envHistoryFloor(writeEnvFile(taken.file), commits(set.file, deleted, oldEdit));
    assert.deepEqual([floor.authority, floor.rev, floor.header.authority.changes.length], [1, 3, 1]);
    assert.equal(floor.versions.DATABASE_URL, undefined, "lines by the replaced owner aren't lines of the taken-over set");
    assert.equal(checkEnvFloor(writeEnvFile(taken.file), floor), null);
    const back = envHistoryFloor(writeEnvFile(oldEdit), commits(taken.file));
    assert.deepEqual(checkEnvFloor(writeEnvFile(oldEdit), back), { kind: 'older-header', seen: 3, found: 40 });
  });

  it('a take-over signed with a phrase the owner had replaced is a fork, whichever line the file is on', () => {
    const second = envRecoveryKeys(generateRecoveryPhrase(seededRandom('floor-phrase')), set.vaultId);
    const replaced = setEnvRecovery({ file: deleted, owner: set.owner, dataKeys: keys, time: T0 + 5, recovery: second, random });
    const fork = takeOverEnvSet({ file: deleted, recovery: set.recovery, newOwner: device('thief'), label: 'Thief', form: null, time: T0 + 5, random });
    const forkHigher = { ...fork.file, header: signEnvHeader({ ...unsignedOf(fork.file.header), rev: 90 }, device('thief')) };
    const floor = envHistoryFloor(writeEnvFile(replaced.file), [...commits(deleted), { commit: 'fork', text: writeEnvFile(forkHigher) }]);
    assert.deepEqual(floor.commits, ['c0'], "the other line's versions don't count");
    assert.deepEqual(floor.forks, [{ change: 1, ours: 'recovery', theirs: 'takeover', commit: 'fork' }]);
    assert.deepEqual(checkEnvFloor(writeEnvFile(replaced.file), floor), { kind: 'authority-fork', change: 1, ours: 'recovery', theirs: 'takeover' });
    const fromFork = envHistoryFloor(writeEnvFile(forkHigher), commits(deleted, replaced.file));
    assert.deepEqual(checkEnvFloor(writeEnvFile(forkHigher), fromFork), { kind: 'authority-fork', change: 1, ours: 'takeover', theirs: 'recovery' });
  });

  it('a retired owner device signing a recovery change after a take-over is a fork, listed once', () => {
    const taken = takeOverEnvSet({ file: deleted, recovery: set.recovery, newOwner: device('maya-new'), label: 'Maya', form: null, time: T0 + 5, random });
    const thief = setEnvRecovery({ file: deleted, owner: set.owner, dataKeys: keys, time: T0 + 6, recovery: device('thief-recovery'), random });
    const thiefLater = changeEnvValues({ file: thief.file, author: set.owner, dataKey: thief.dataKey, changes: { upsert: [{ name: 'DATABASE_URL', value: 'thief' }], remove: [] }, time: T0 + 7, random }).file;
    const history = [...commits(set.file, deleted, taken.file), { commit: 'f1', text: writeEnvFile(thief.file) }, { commit: 'f2', text: writeEnvFile(thiefLater) }];
    const floor = envHistoryFloor(writeEnvFile(taken.file), history);
    assert.deepEqual(floor.forks, [{ change: 1, ours: 'takeover', theirs: 'recovery', commit: 'f1' }]);
    assert.equal(checkEnvFloor(writeEnvFile(taken.file), floor)?.kind, 'authority-fork', 'the honest file is refused too: the fork shows a key is out');
  });

  it('words a fork as two lines of ownership and the way out', () => {
    const words = envFileProblemWords({ kind: 'authority-fork', change: 2, ours: 'takeover', theirs: 'recovery' }, { file: '.authdeck/acme-api.env', set: 'acme-api', where: 'phone' });
    assert.equal(words.title, 'Two lines of ownership');
    assert.match(words.message, /^\.authdeck\/acme-api\.env has two competing lines of ownership .*change 2: a take-over by the recovery phrase on one, a new recovery phrase set by the owner on the other.*AuthDeck won't take either\.$/);
    assert.equal(words.hint, 'Make a new set and rotate every value that was in acme-api.');
  });

  it('the builder folds files one at a time into the same floor, in any order', () => {
    const history = commits(set.file, withBen, deleted);
    const builder = createEnvFloorBuilder(swapped);
    for (const entry of [...history].reverse()) builder.add(entry);
    const folded = builder.floor();
    const whole = envHistoryFloor(swapped, history);
    assert.deepEqual([folded.versions, folded.rev, folded.authority, folded.header], [whole.versions, whole.rev, whole.authority, whole.header]);
    assert.deepEqual([...folded.commits].sort(), [...whole.commits].sort());
    builder.add({ commit: 'junk', text: 'not a set' });
    assert.notEqual(builder.floor(), builder.floor(), 'each call gives its own object');
  });

  it('a refused file reports its own parse problem', () => {
    assert.deepEqual(checkEnvFloor('<<<<<<< HEAD\n', envHistoryFloor(swapped, [])), { kind: 'conflict-markers', line: 1 });
    assert.throws(() => envHistoryFloor('nonsense', []));
  });
});

function unsignedOf(header: EnvHeader): Omit<EnvHeader, 'sig'> {
  const { sig: _sig, ...unsigned } = header;
  return unsigned;
}
