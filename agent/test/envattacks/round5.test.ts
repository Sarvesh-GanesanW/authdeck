// Security review of env sets (0.4), round 5, env core: self-certifying set ids and the history
// floor. Each test is a proof of concept for one finding: it fails while the weakness is there and
// passes once it is fixed. Ids match the report.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { changeEnvValues, checkEnvFloor, envHistoryFloor, mergeEnvFiles, setEnvRecovery, takeOverEnvSet, verifyEnvFile, writeEnvFile, type EnvSetFile } from '../../src/envcore';
import { device, makeSet, T0 } from '../envcore/fixtures';
import { seededRandom } from '../helpers/vault';

function history(...texts: string[]) {
  return texts.map((text, i) => ({ commit: `c${i}`.padEnd(40, '0'), text }));
}

function fileOf(text: string): EnvSetFile {
  const result = verifyEnvFile(text, null);
  if (!result.ok) throw new Error(`refused: ${result.problem.kind}`);
  return result.set.file;
}

/** What a device with no memory of the set decides about `current`, given git's history of it. */
function freshDeviceDecides(current: string, versions: string[]): string {
  const verified = verifyEnvFile(current, null);
  if (!verified.ok) return `refused: ${verified.problem.kind}`;
  const problem = checkEnvFloor(current, envHistoryFloor(current, history(...versions)));
  return problem ? `refused: ${problem.kind}` : 'taken';
}

describe('ENV-24: an authority fork from a key the honest line already retired wins every device with no memory of the set', () => {
  it('a lost owner phone\'s key, after the owner took the set over on a new phone, forks with a recovery change and is refused', () => {
    // Maya's phone A owns the set; it is lost. She restores her vault on phone B and takes the set over.
    const set = makeSet('fork-stolen-owner', [{ name: 'DATABASE_URL', value: 'postgres://prod/acme' }]);
    const phoneB = device('fork-stolen-owner/B');
    const taken = takeOverEnvSet({ file: set.file, recovery: set.recovery, newOwner: phoneB, label: 'Maya Rao · Pixel 9', form: 'phone', time: T0 + 10, random: seededRandom('fork/takeover') });
    const takenText = writeEnvFile(taken.file);
    assert.ok(verifyEnvFile(takenText, null).ok);

    // The thief holds phone A's keys. From the last file A owned, A signs a recovery change (n = 1,
    // like the take-over) naming the thief's own recovery identity, then values of the thief's choice.
    const thiefRecovery = device('fork-stolen-owner/thief-recovery');
    const forked = setEnvRecovery({ file: set.file, owner: set.owner, dataKeys: { [set.file.header.epoch]: set.dataKey }, time: T0 + 20, recovery: thiefRecovery, random: seededRandom('fork/recovery') });
    const valued = changeEnvValues({ file: forked.file, author: set.owner, dataKey: forked.dataKey, changes: { upsert: [{ name: 'DATABASE_URL', value: 'postgres://thief-host/acme' }], remove: [] }, time: T0 + 21, random: seededRandom('fork/values') });
    const forkText = writeEnvFile(valued.file);

    // The thief pushes the fork on top of the honest history. A new teammate's phone (or any phone
    // adopting the set for the first time) reads the file with git's history as its only floor.
    const decided = freshDeviceDecides(forkText, [set.text, takenText]);
    assert.match(decided, /^refused/, `a fresh device ${decided} the thief's fork although the take-over that retired phone A is in history`);
  });

  it('a recovery phrase the owner replaced forks with a take-over and is refused', () => {
    // The owner replaced a leaked phrase (recovery change, n = 1).
    const set = makeSet('fork-old-phrase', [{ name: 'DATABASE_URL', value: 'postgres://prod/acme' }]);
    const newRecovery = device('fork-old-phrase/new-recovery');
    const replaced = setEnvRecovery({ file: set.file, owner: set.owner, dataKeys: { [set.file.header.epoch]: set.dataKey }, time: T0 + 10, recovery: newRecovery, random: seededRandom('fork2/replace') });
    const replacedText = writeEnvFile(replaced.file);

    // Whoever holds the old phrase takes over the file from before the change (n = 1 too).
    const mallory = device('fork-old-phrase/mallory');
    const taken = takeOverEnvSet({ file: set.file, recovery: set.recovery, newOwner: mallory, label: 'Maya Rao · Pixel 9', form: 'phone', time: T0 + 20, random: seededRandom('fork2/takeover') });
    const forkText = writeEnvFile(taken.file);

    const decided = freshDeviceDecides(forkText, [set.text, replacedText]);
    assert.match(decided, /^refused/, `a fresh device ${decided} the old phrase's take-over although the owner's replacement of that phrase is in history`);
  });

  it('control: phone A\'s key alone, on the old authority with a higher rev, is refused by the floor', () => {
    const set = makeSet('fork-higher-rev', [{ name: 'DATABASE_URL', value: 'postgres://prod/acme' }]);
    const taken = takeOverEnvSet({ file: set.file, recovery: set.recovery, newOwner: device('fork-higher-rev/B'), label: 'B · Phone', form: 'phone', time: T0 + 10, random: seededRandom('fork4/a') });
    let file = set.file;
    for (let i = 0; i < 5; i++) {
      file = changeEnvValues({ file, author: set.owner, dataKey: set.dataKey, changes: { upsert: [{ name: 'DATABASE_URL', value: `postgres://thief-${i}/acme` }], remove: [] }, time: T0 + 20 + i, random: seededRandom(`fork4/${i}`) }).file;
    }
    assert.match(freshDeviceDecides(writeEnvFile(file), [set.text, writeEnvFile(taken.file)]), /^refused/);
  });

  it('control: the merge driver refuses to join the two lines', () => {
    const set = makeSet('fork-merge', [{ name: 'DATABASE_URL', value: 'postgres://prod/acme' }]);
    const taken = takeOverEnvSet({ file: set.file, recovery: set.recovery, newOwner: device('fork-merge/B'), label: 'B · Phone', form: 'phone', time: T0 + 10, random: seededRandom('fork3/a') });
    const forked = setEnvRecovery({ file: set.file, owner: set.owner, dataKeys: { [set.file.header.epoch]: set.dataKey }, time: T0 + 20, recovery: device('fork-merge/thief'), random: seededRandom('fork3/b') });
    const outcome = mergeEnvFiles({ base: set.text, ours: writeEnvFile(taken.file), theirs: writeEnvFile(forked.file), trust: null });
    assert.equal(outcome.kind, 'refused');
    assert.ok(fileOf(writeEnvFile(forked.file)));
  });
});
