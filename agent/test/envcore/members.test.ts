/** Header changes: adding, removing with a new key, recovery, take-over and settling two headers. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addEnvMember,
  changeEnvValues,
  EnvFileRefused,
  ENV_LIMITS,
  envRecoveryKeys,
  findBadEnvWraps,
  nextEnvTrust,
  openEnvDataKey,
  openEnvValues,
  rekeyEnvSet,
  removeEnvMember,
  setEnvRecovery,
  settleEnvHeaders,
  takeOverEnvSet,
  signEnvValueLine,
  verifyEnvFile,
  verifyEnvFileForRekey,
  writeEnvFile,
  type EnvNewMember,
} from '../../src/envcore';
import type { DeviceKeys } from '../../src/vault/crypto';
import { generateRecoveryPhrase } from '../../src/vault/recovery';
import { seededRandom } from '../helpers/vault';
import { device, makeSet, T0, VALUES, verified } from './fixtures';

const set = makeSet();
const random = seededRandom('members');
const keys = { 1: set.dataKey };
const ben = device('ben');
const priya = device('priya');
const asMember = (keysOf: DeviceKeys, label: string): EnvNewMember => ({ edPublic: keysOf.edPublic, xPublic: keysOf.xPublic, label, form: 'phone' });
const add = (who: DeviceKeys, file = set.file, time = T0 + 1) => addEnvMember({ file, owner: set.owner, dataKeys: keys, time, member: asMember(who, who === ben ? 'Ben' : 'Priya') });
const withBen = add(ben);
const withBoth = add(priya, withBen, T0 + 2);

describe('adding a member', () => {
  it('adds rev + 1 at the same epoch, under the same authority, with a wrap that opens', () => {
    assert.deepEqual([withBen.header.rev, withBen.header.epoch, withBen.header.authority], [2, 1, set.file.header.authority]);
    assert.equal(withBen.values, set.file.values);
    assert.deepEqual(openEnvDataKey(withBen.header, ben), set.dataKey);
    assert.deepEqual(findBadEnvWraps(withBen.header, set.dataKey), []);
    verified(writeEnvFile(withBen), nextEnvTrust(null, verified(set.text, null)));
  });

  it('refuses a non-owner, a device already in, unusable keys, and a 65th member', () => {
    assert.throws(() => addEnvMember({ file: withBen, owner: ben, dataKeys: keys, time: T0, member: asMember(priya, 'P') }), /Only the owner/);
    assert.throws(() => add(ben, withBen), /already in the set/);
    assert.throws(() => add(set.recovery), /already in the set/);
    assert.throws(() => addEnvMember({ file: set.file, owner: set.owner, dataKeys: keys, time: T0, member: { ...asMember(priya, 'P'), xPublic: new Uint8Array(32) } }), /can't be used/);
    assert.throws(() => addEnvMember({ file: set.file, owner: set.owner, dataKeys: { 1: makeSet('other').dataKey }, time: T0, member: asMember(priya, 'P') }), /current key/);
    let file = set.file;
    for (let i = 1; i < ENV_LIMITS.members; i++) file = addEnvMember({ file, owner: set.owner, dataKeys: keys, time: T0 + i, member: asMember(device(`m${i}`), `M${i}`) });
    assert.equal(file.header.members.length, ENV_LIMITS.members);
    assert.equal(verifyEnvFile(writeEnvFile(file), null).ok, true);
    assert.throws(
      () => addEnvMember({ file, owner: set.owner, dataKeys: keys, time: T0, member: asMember(priya, 'P') }),
      (err: unknown) => err instanceof EnvFileRefused && err.problem.kind === 'too-large' && err.problem.limit === 'members',
    );
  });
});

describe('removing a member', () => {
  const deleted = changeEnvValues({ file: withBoth, author: ben, dataKey: set.dataKey, changes: { upsert: [], remove: ['PEM'] }, time: T0 + 3, random });
  const removed = removeEnvMember({ file: deleted.file, owner: set.owner, dataKeys: keys, time: T0 + 4, memberId: ben.deviceId, random });

  it('makes a new key, keeps deletions, and lists the live variables to rotate', () => {
    const { header } = removed.file;
    assert.deepEqual([header.rev, header.epoch], [4, 2]);
    assert.deepEqual(header.members.map((member) => member.id), [set.owner.deviceId, priya.deviceId]);
    assert.deepEqual(removed.rotate, ['DATABASE_URL', 'STRIPE_SECRET_KEY']);
    assert.notDeepEqual(removed.dataKey, set.dataKey);
    assert.deepEqual(removed.file.values.map((line) => [line.name, line.version, line.author, line.box?.epoch ?? null]), [
      ['DATABASE_URL', 1, set.owner.deviceId, 2],
      ['STRIPE_SECRET_KEY', 1, set.owner.deviceId, 2],
      ['PEM', 2, set.owner.deviceId, null],
    ]);
    assert.deepEqual(openEnvValues(removed.file, removed.dataKey), VALUES.slice(0, 2));
    verified(writeEnvFile(removed.file), nextEnvTrust(null, verified(writeEnvFile(deleted.file), null)));
  });

  it('a name added again after a re-key continues from its deleted version', () => {
    const back = changeEnvValues({ file: removed.file, author: priya, dataKey: removed.dataKey, changes: { upsert: [{ name: 'PEM', value: 'back' }], remove: [] }, time: T0 + 6, random });
    assert.deepEqual(back.added, ['PEM']);
    assert.equal(back.file.values.find((line) => line.name === 'PEM')!.version, 3);
  });

  it('the removed device cannot open the new key; the others and the recovery identity can', () => {
    assert.throws(() => openEnvDataKey(removed.file.header, ben));
    assert.deepEqual(openEnvDataKey(removed.file.header, priya), removed.dataKey);
    assert.deepEqual(openEnvDataKey(removed.file.header, set.recovery), removed.dataKey);
    assert.deepEqual(findBadEnvWraps(removed.file.header, removed.dataKey), []);
  });

  it('refuses removing the owner or someone not in the set', () => {
    assert.throws(() => removeEnvMember({ file: withBen, owner: set.owner, dataKeys: keys, time: T0, memberId: set.owner.deviceId, random }), /can't remove itself/);
    assert.throws(() => removeEnvMember({ file: withBen, owner: set.owner, dataKeys: keys, time: T0, memberId: priya.deviceId, random }), /isn't a member/);
  });

  it('rekeyEnvSet boxes an old-epoch line again under the current key, rotating nothing', () => {
    const stale = { ...removed.file, values: [set.file.values[0]!, ...removed.file.values.slice(1)] };
    assert.equal(verifyEnvFile(writeEnvFile(stale), null).ok, false);
    const fixed = rekeyEnvSet({ file: stale, owner: set.owner, dataKeys: { 1: set.dataKey, 2: removed.dataKey }, time: T0 + 5, random });
    assert.deepEqual(fixed.rotate, []);
    assert.equal(fixed.file.header.epoch, 3);
    verified(writeEnvFile(fixed.file), null);
    assert.deepEqual(openEnvValues(fixed.file, fixed.dataKey), VALUES.slice(0, 2));
    assert.throws(() => rekeyEnvSet({ file: stale, owner: set.owner, dataKeys: { 2: removed.dataKey }, time: T0, random }), /under key 1/);
  });
});

describe('recovery', () => {
  it('adding one wraps the current key; replacing it re-keys and rotates', () => {
    const phrase = generateRecoveryPhrase(seededRandom('phrase2'));
    const second = envRecoveryKeys(phrase, set.vaultId);
    const replaced = setEnvRecovery({ file: set.file, owner: set.owner, dataKeys: keys, time: T0 + 1, recovery: second, random });
    assert.equal(replaced.file.header.epoch, 2);
    assert.deepEqual(replaced.rotate, VALUES.map((value) => value.name));
    assert.deepEqual(openEnvDataKey(replaced.file.header, second), replaced.dataKey);
    assert.throws(() => openEnvDataKey(replaced.file.header, set.recovery));
    assert.deepEqual(
      replaced.file.header.authority.changes.map((change) => [change.kind, change.n, change.recovery?.ed]),
      [['recovery', 1, replaced.file.header.recovery!.ed]],
      'the owner signs the new recovery identity onto the authority',
    );
    verified(writeEnvFile(replaced.file), nextEnvTrust(null, verified(set.text, null)));

    const cleared = setEnvRecovery({ file: replaced.file, owner: set.owner, dataKeys: { 2: replaced.dataKey }, time: T0 + 2, recovery: null, random });
    assert.equal(cleared.file.header.recovery, null);
    const readded = setEnvRecovery({ file: cleared.file, owner: set.owner, dataKeys: { 3: cleared.dataKey }, time: T0 + 3, recovery: second, random });
    assert.deepEqual([readded.file.header.epoch, readded.rotate], [3, []]);
    assert.deepEqual(openEnvDataKey(readded.file.header, second), cleared.dataKey);
    assert.equal(readded.file.header.authority.changes.length, 3);
    verified(writeEnvFile(readded.file), nextEnvTrust(null, verified(writeEnvFile(replaced.file), null)));
    assert.throws(() => setEnvRecovery({ file: set.file, owner: set.owner, dataKeys: keys, time: T0, recovery: set.recovery, random }), /already/);
  });

  it('a replaced phrase can no longer take the set over', () => {
    const second = envRecoveryKeys(generateRecoveryPhrase(seededRandom('phrase3')), set.vaultId);
    const replaced = setEnvRecovery({ file: set.file, owner: set.owner, dataKeys: keys, time: T0 + 1, recovery: second, random });
    const newPhone = device('maya-new');
    const takeOver = (recovery: DeviceKeys) => takeOverEnvSet({ file: replaced.file, recovery, newOwner: newPhone, label: 'Maya', form: null, time: T0 + 2, random });
    assert.throws(() => takeOver(set.recovery), /isn't this set's/);
    verified(writeEnvFile(takeOver(second).file), null);
  });

  it('takeOverEnvSet makes a new phone the only member, with a take-over signed by the recovery identity and a new key', () => {
    const newPhone = device('maya-new');
    const result = takeOverEnvSet({ file: withBen, recovery: set.recovery, newOwner: newPhone, label: 'Maya · Pixel 10', form: 'phone', time: T0 + 9, random });
    const { header } = result.file;
    assert.equal(header.signer, newPhone.deviceId);
    assert.deepEqual([header.rev, header.epoch], [3, 2]);
    assert.deepEqual(header.authority.changes.map((change) => [change.kind, change.n, change.owner.ed, change.recovery?.ed]), [['takeover', 1, header.members[0]!.ed, header.recovery!.ed]]);
    assert.deepEqual(header.members.map((member) => [member.id, member.role]), [[newPhone.deviceId, 'owner']]);
    assert.equal(header.recovery?.id, set.recovery.deviceId);
    assert.deepEqual(result.removed, [
      { id: set.owner.deviceId, label: 'Maya Rao · Pixel 8', form: 'phone', role: 'owner' },
      { id: ben.deviceId, label: 'Ben', form: 'phone', role: 'member' },
    ]);
    assert.throws(() => openEnvDataKey(header, ben), 'no listed member gets the new key');
    assert.deepEqual(result.rotate, VALUES.map((value) => value.name));
    assert.ok(result.file.values.every((line) => line.author === newPhone.deviceId));
    assert.deepEqual(openEnvValues(result.file, openEnvDataKey(header, newPhone)), VALUES);
    assert.throws(() => openEnvDataKey(header, set.owner));
    verified(writeEnvFile(result.file), nextEnvTrust(null, verified(writeEnvFile(withBen), null)));
  });

  it('a member device can be the one taken over to, and a wrong phrase is refused', () => {
    const result = takeOverEnvSet({ file: withBen, recovery: set.recovery, newOwner: ben, label: 'Ben', form: null, time: T0 + 9, random });
    assert.deepEqual(result.file.header.members.map((member) => [member.id, member.role]), [[ben.deviceId, 'owner']]);
    const wrong = envRecoveryKeys(generateRecoveryPhrase(seededRandom('wrong')), set.vaultId);
    assert.throws(() => takeOverEnvSet({ file: withBen, recovery: wrong, newOwner: ben, label: 'Ben', form: null, time: T0, random }), /isn't this set's/);
  });
});

describe('settling two headers', () => {
  it('keeps both added members and both sides values under a new key above both revs', () => {
    const ours = changeEnvValues({ file: add(ben), author: set.owner, dataKey: set.dataKey, changes: { upsert: [{ name: 'OURS', value: 'o' }], remove: [] }, time: T0 + 2, random }).file;
    const theirs = changeEnvValues({ file: add(priya), author: set.owner, dataKey: set.dataKey, changes: { upsert: [{ name: 'THEIRS', value: 't' }], remove: [] }, time: T0 + 3, random }).file;
    const settled = settleEnvHeaders({ file: ours, base: set.file, theirs, owner: set.owner, dataKeys: keys, time: T0 + 4, random });
    const { header } = settled.file;
    assert.deepEqual([header.rev, header.epoch, header.authority], [3, 2, set.file.header.authority]);
    assert.deepEqual(header.members.map((member) => member.id), [set.owner.deviceId, ben.deviceId, priya.deviceId]);
    assert.deepEqual(settled.rotate, []);
    assert.deepEqual(openEnvValues(settled.file, settled.dataKey).map((value) => value.name), ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'PEM', 'OURS', 'THEIRS']);
    verified(writeEnvFile(settled.file), nextEnvTrust(null, verified(writeEnvFile(theirs), null)));
  });

  it('a removal on one side stands, and its variables are listed to rotate', () => {
    const base = withBoth;
    const ours = removeEnvMember({ file: base, owner: set.owner, dataKeys: keys, time: T0 + 3, memberId: ben.deviceId, random });
    const theirs = add(device('chen'), base, T0 + 3);
    const settled = settleEnvHeaders({ file: ours.file, base, theirs, owner: set.owner, dataKeys: { 1: set.dataKey, 2: ours.dataKey }, time: T0 + 4, random });
    assert.deepEqual(settled.file.header.members.map((member) => member.id), [set.owner.deviceId, priya.deviceId, device('chen').deviceId]);
    assert.deepEqual(settled.rotate, VALUES.map((value) => value.name));
    assert.throws(() => settleEnvHeaders({ file: ours.file, base, theirs, owner: ben, dataKeys: keys, time: T0, random }), /Only the owner/);
  });
});

describe('settling two headers under two authorities', () => {
  const second = envRecoveryKeys(generateRecoveryPhrase(seededRandom('phrase4')), set.vaultId);
  const replaced = setEnvRecovery({ file: withBen, owner: set.owner, dataKeys: keys, time: T0 + 3, recovery: second, random });
  const theirs = add(priya, withBen, T0 + 3);

  it('keeps the side with the new recovery identity, whichever side is ours', () => {
    const dataKeys = { 1: set.dataKey, 2: replaced.dataKey };
    for (const [ours, other] of [
      [replaced.file, theirs],
      [theirs, replaced.file],
    ] as const) {
      const settled = settleEnvHeaders({ file: ours, base: withBen, theirs: other, owner: set.owner, dataKeys, time: T0 + 4, random });
      const { header } = settled.file;
      assert.deepEqual(header.authority, replaced.file.header.authority);
      assert.equal(header.recovery?.id, second.deviceId);
      assert.deepEqual(header.members.map((member) => member.id).sort(), [set.owner.deviceId, ben.deviceId, priya.deviceId].sort());
      verified(writeEnvFile(settled.file), nextEnvTrust(null, verified(writeEnvFile(replaced.file), null)));
    }
  });

  it('refuses two authorities that went separate ways', () => {
    const third = envRecoveryKeys(generateRecoveryPhrase(seededRandom('phrase5')), set.vaultId);
    const elsewhere = setEnvRecovery({ file: withBen, owner: set.owner, dataKeys: keys, time: T0 + 3, recovery: third, random });
    const dataKeys = { 1: set.dataKey, 2: replaced.dataKey };
    assert.throws(() => settleEnvHeaders({ file: replaced.file, base: withBen, theirs: elsewhere.file, owner: set.owner, dataKeys, time: T0 + 4, random }), /can't be settled/);
  });
});

describe('fixing old-epoch lines', () => {
  // Priya edits PEM under key 1 while the owner removes Ben (key 2): the merged file holds her line.
  const priyaEdit = changeEnvValues({ file: withBoth, author: priya, dataKey: set.dataKey, changes: { upsert: [{ name: 'PEM', value: 'priya' }], remove: [] }, time: T0 + 3, random }).file;
  const removed = removeEnvMember({ file: withBoth, owner: set.owner, dataKeys: keys, time: T0 + 4, memberId: ben.deviceId, random });
  const oldPem = priyaEdit.values[2]!;
  const stale = { ...removed.file, values: [...removed.file.values.slice(0, 2), oldPem] };
  const staleText = writeEnvFile(stale);
  const problemOf = (text: string, trust: Parameters<typeof verifyEnvFileForRekey>[1] = null) => {
    const result = verifyEnvFileForRekey(text, trust);
    assert.equal(result.ok, false);
    return (result as { problem: { kind: string } }).problem.kind;
  };

  it('accepts a file whose only fault is an old-epoch line, and the re-key then verifies', () => {
    assert.equal(verifyEnvFile(staleText, null).ok, false);
    const check = verifyEnvFileForRekey(staleText, null);
    assert.ok(check.ok);
    assert.deepEqual(check.oldEpoch, ['PEM']);
    const fixed = rekeyEnvSet({ file: check.set.file, owner: set.owner, dataKeys: { 1: set.dataKey, 2: removed.dataKey }, time: T0 + 5, random });
    verified(writeEnvFile(fixed.file), nextEnvTrust(null, check.set));
    assert.equal(openEnvValues(fixed.file, fixed.dataKey).find((value) => value.name === 'PEM')!.value, 'priya');
    const clean = verifyEnvFileForRekey(writeEnvFile(removed.file), null);
    assert.deepEqual(clean.ok ? clean.oldEpoch : null, []);
  });

  it('lists every old-key name to rotate, whatever time its line claims', () => {
    // Priya's line says it predates the removal; the removed device still holds key 1 and the repo keeps the box.
    const check = verifyEnvFileForRekey(staleText, null, T0 + 100);
    assert.deepEqual(check.ok ? [check.rotate, check.writtenAfterRemoval] : null, [['PEM'], ['PEM']]);
    const clean = verifyEnvFileForRekey(writeEnvFile(removed.file), null);
    assert.deepEqual(clean.ok ? clean.rotate : null, []);
  });

  it('refuses to bring a deleted value back from history', () => {
    // The owner deleted PEM at version 2 and removed Ben; the tombstone stays through the re-key.
    const deleted = changeEnvValues({ file: withBoth, author: set.owner, dataKey: set.dataKey, changes: { upsert: [], remove: ['PEM'] }, time: T0 + 3, random }).file;
    const rekeyed = removeEnvMember({ file: deleted, owner: set.owner, dataKeys: keys, time: T0 + 4, memberId: ben.deviceId, random });
    const ownerTrust = nextEnvTrust(null, verified(writeEnvFile(rekeyed.file), null));
    const swapIn = (line: (typeof oldPem)) => writeEnvFile({ ...rekeyed.file, values: [...rekeyed.file.values.slice(0, 2), line] });
    assert.equal(problemOf(swapIn(set.file.values[2]!), ownerTrust), 'older-value', 'the version-1 value from before the deletion');
    assert.equal(problemOf(swapIn(oldPem), ownerTrust), 'older-value', "an old-key line at the deletion's own version");
    const later = changeEnvValues({ file: priyaEdit, author: priya, dataKey: set.dataKey, changes: { upsert: [{ name: 'PEM', value: 'v3' }], remove: [] }, time: T0 + 5, random }).file;
    const check = verifyEnvFileForRekey(swapIn(later.values[2]!), ownerTrust);
    assert.deepEqual(check.ok ? check.oldEpoch : null, ['PEM'], 'an edit above the deletion is a real change');
  });

  it('refuses any other fault mixed in', () => {
    const tampered = { ...stale, values: [{ ...stale.values[0]!, time: T0 + 99 }, ...stale.values.slice(1)] };
    assert.equal(problemOf(writeEnvFile(tampered)), 'unsigned-line');
    const tamperedOld = { ...stale, values: [...stale.values.slice(0, 2), { ...oldPem, version: 3 }] };
    assert.equal(problemOf(writeEnvFile(tamperedOld)), 'unsigned-line');
    const benLine = signEnvValueLine({ ...oldPem, author: ben.deviceId }, { set: set.setId, epoch: 1 }, ben);
    assert.equal(problemOf(writeEnvFile({ ...stale, values: [...stale.values.slice(0, 2), benLine] })), 'not-a-member');
    const newer = changeEnvValues({ file: removed.file, author: set.owner, dataKey: removed.dataKey, changes: { upsert: [{ name: 'PEM', value: 'v3' }, { name: 'DATABASE_URL', value: 'd2' }], remove: [] }, time: T0 + 6, random }).file;
    const trust = nextEnvTrust(null, verified(writeEnvFile(newer), null));
    assert.equal(problemOf(staleText, trust), 'older-value');
    assert.equal(problemOf(writeEnvFile(withBoth), trust), 'older-header');
  });
});
