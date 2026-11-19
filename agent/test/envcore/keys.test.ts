/** Data keys, wraps, value boxes and variable changes. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addEnvMember,
  changeEnvValues,
  createEnvSet,
  envAuthorityValid,
  envSetIdOf,
  EnvFileRefused,
  envRecoveryKeys,
  findBadEnvWraps,
  nextEnvTrust,
  openEnvDataKey,
  openEnvValue,
  openEnvValues,
  planEnvPush,
  sealEnvValue,
  takeOverEnvSet,
  verifyEnvFile,
  writeEnvFile,
  type EnvValueLine,
} from '../../src/envcore';
import { toBase64Url } from '../../src/vault/bytes';
import { recoveryKeysFromPhrase } from '../../src/vault/recovery';
import { seededRandom } from '../helpers/vault';
import { device, makeSet, T0, VALUES, verified } from './fixtures';

const set = makeSet();
const random = seededRandom('keys');
const ben = device('ben');
const keys = { 1: set.dataKey };
const withBen = addEnvMember({ file: set.file, owner: set.owner, dataKeys: keys, time: T0 + 1, member: { edPublic: ben.edPublic, xPublic: ben.xPublic, label: 'Ben', form: 'phone' } });

describe('creating a set', () => {
  it('makes rev 1, epoch 1, the owner as only member and every value at version 1', () => {
    const { header, values } = set.file;
    assert.deepEqual([header.rev, header.epoch, header.signer, header.authority.changes], [1, 1, set.owner.deviceId, []]);
    assert.deepEqual(header.members.map((member) => [member.id, member.role, member.label]), [[set.owner.deviceId, 'owner', 'Maya Rao · Pixel 8']]);
    assert.equal(header.recovery?.id, set.recovery.deviceId);
    assert.deepEqual(values.map((line) => [line.name, line.version, line.author]), VALUES.map((value) => [value.name, 1, set.owner.deviceId]));
    assert.deepEqual(openEnvValues(set.file, set.dataKey), VALUES);
  });

  it('refuses bad values, a bad set name and an empty label', () => {
    const base = { name: 'acme-api', owner: set.owner, ownerLabel: 'Maya', ownerForm: null, recovery: null, values: [], time: T0, random };
    assert.throws(() => createEnvSet({ ...base, values: [{ name: '1X', value: '' }] }), (err: unknown) => err instanceof EnvFileRefused && err.problem.kind === 'bad-name');
    assert.throws(() => createEnvSet({ ...base, name: 'Acme API' }));
    assert.throws(() => createEnvSet({ ...base, ownerLabel: '​ ' }));
    assert.equal(createEnvSet(base).file.header.recovery, null);
  });

  it("uses the owner's vault recovery identity: its public keys go in, the phrase opens the set", () => {
    const fromPhrase = envRecoveryKeys(set.phrase, set.vaultId);
    assert.deepEqual(fromPhrase, recoveryKeysFromPhrase(set.phrase, set.vaultId));
    assert.deepEqual(openEnvDataKey(set.file.header, fromPhrase), set.dataKey);
    assert.throws(() => openEnvDataKey(set.file.header, envRecoveryKeys(set.phrase, makeSet('other').vaultId)), 'another vault gives another identity');
    assert.throws(() => envRecoveryKeys('not a phrase', set.vaultId));
  });

  it('a phone with only the public half makes the set, and the phrase takes it over', () => {
    const publicOnly = { edPublic: set.recovery.edPublic, xPublic: set.recovery.xPublic, deviceId: set.recovery.deviceId };
    const created = createEnvSet({ name: 'pebble', owner: set.owner, ownerLabel: 'Maya', ownerForm: 'phone', recovery: publicOnly, values: VALUES, time: T0, random });
    const newPhone = device('maya-new');
    const taken = takeOverEnvSet({ file: created.file, recovery: envRecoveryKeys(set.phrase, set.vaultId), newOwner: newPhone, label: 'Maya · Pixel 10', form: 'phone', time: T0 + 1, random });
    assert.equal(taken.file.header.signer, newPhone.deviceId, 'the new owner signs the header; the recovery identity signs only the take-over');
    assert.deepEqual(openEnvValues(taken.file, openEnvDataKey(taken.file.header, newPhone)), VALUES);
    verified(writeEnvFile(taken.file), nextEnvTrust(null, verified(created.text, null)));
  });
});

describe('the set id', () => {
  it('is the hash of a birth certificate the owner signed, cut to 16 bytes', () => {
    const { birth } = set.file.header.authority;
    assert.equal(set.setId, envSetIdOf(birth));
    assert.equal(set.setId.length, 22);
    assert.deepEqual([birth.owner.ed, birth.recovery?.ed], [toBase64Url(set.owner.edPublic), toBase64Url(set.recovery.edPublic)]);
    assert.equal(envAuthorityValid(set.setId, set.file.header.authority), true);
  });

  it('changes with anything in the birth certificate, and two sets by one owner differ', () => {
    const { birth } = set.file.header.authority;
    assert.notEqual(envSetIdOf({ ...birth, time: birth.time + 1 }), set.setId);
    assert.notEqual(envSetIdOf({ ...birth, recovery: null }), set.setId);
    const again = createEnvSet({ name: 'acme-api', owner: set.owner, ownerLabel: 'Maya', ownerForm: null, recovery: null, values: [], time: T0, random });
    assert.notEqual(again.file.header.set, createEnvSet({ name: 'acme-api', owner: set.owner, ownerLabel: 'Maya', ownerForm: null, recovery: null, values: [], time: T0, random }).file.header.set);
  });

  it('a birth certificate is not valid for another id, nor with a signature by another key', () => {
    const { authority } = set.file.header;
    assert.equal(envAuthorityValid(makeSet('other').setId, authority), false);
    const other = makeSet('other').file.header.authority.birth;
    assert.equal(envAuthorityValid(set.setId, { ...authority, birth: { ...authority.birth, sig: other.sig } }), false);
  });
});

describe('wraps', () => {
  it('opens the data key for each member and for the recovery identity', () => {
    assert.deepEqual(openEnvDataKey(withBen.header, set.owner), set.dataKey);
    assert.deepEqual(openEnvDataKey(withBen.header, ben), set.dataKey);
    assert.deepEqual(openEnvDataKey(withBen.header, set.recovery), set.dataKey);
  });

  it('refuses a device outside the set, and a wrap moved to another member', () => {
    assert.throws(() => openEnvDataKey(withBen.header, device('stranger')), /not a member/);
    const [owner, member] = withBen.header.members;
    const swapped = { ...withBen.header, members: [owner!, { ...member!, key: { ...owner!.key, r: member!.x } }] };
    assert.throws(() => openEnvDataKey(swapped, ben), /not sealed to this device/);
  });

  it('findBadEnvWraps names every wrap that is not the key sealed to its holder', () => {
    assert.deepEqual(findBadEnvWraps(withBen.header, set.dataKey), []);
    const [owner, member] = withBen.header.members;
    const other = makeSet('other');
    const bad = { ...withBen.header, members: [owner!, { ...member!, key: { ...other.file.header.members[0]!.key, r: member!.x } }] };
    assert.deepEqual(findBadEnvWraps(bad, set.dataKey), [ben.deviceId]);
    const badRecovery = { ...withBen.header, recovery: { ...withBen.header.recovery!, key: { ...owner!.key, r: withBen.header.recovery!.x } } };
    assert.deepEqual(findBadEnvWraps(badRecovery, set.dataKey), [set.recovery.deviceId]);
    assert.deepEqual(findBadEnvWraps(withBen.header, other.dataKey).length, 3);
  });
});

describe('value boxes', () => {
  const line = set.file.values[0]!;
  const open = (changed: Partial<EnvValueLine>, setId = set.setId) => () => openEnvValue(set.dataKey, setId, { ...line, ...changed });

  it('opens a value and gives null for a deletion', () => {
    assert.equal(open({})(), VALUES[0]!.value);
    assert.equal(open({ box: null })(), null);
  });

  it('is bound to the set, the epoch, the name and the version', () => {
    assert.throws(open({ name: 'STRIPE_SECRET_KEY' }));
    assert.throws(open({ version: 2 }));
    assert.throws(open({}, makeSet('other').setId));
    assert.throws(open({ box: { ...line.box!, epoch: 2 } }));
    assert.throws(open({ box: set.file.values[1]!.box }));
    assert.throws(() => openEnvValue(makeSet('other').dataKey, set.setId, line));
  });

  it('a box sealed for one scope opens only there', () => {
    const box = sealEnvValue(set.dataKey, { set: set.setId, epoch: 1, name: 'A', version: 3 }, 'é ✓', random);
    assert.equal(openEnvValue(set.dataKey, set.setId, { ...line, name: 'A', version: 3, box }), 'é ✓');
    assert.throws(() => openEnvValue(set.dataKey, set.setId, { ...line, name: 'A', version: 4, box }));
  });
});

describe('changing variables', () => {
  const change = (upsert: { name: string; value: string }[], remove: string[] = [], author = ben, file = withBen) =>
    changeEnvValues({ file, author, dataKey: set.dataKey, changes: { upsert, remove }, time: T0 + 10, random });

  it('adds, changes and removes, bumping versions and signing as the author', () => {
    const result = change([{ name: 'NEW', value: 'n' }, { name: 'PEM', value: 'p2' }], ['DATABASE_URL']);
    assert.deepEqual([result.added, result.changed, result.removed], [['NEW'], ['PEM'], ['DATABASE_URL']]);
    const lines = new Map(result.file.values.map((line) => [line.name, line]));
    assert.deepEqual([lines.get('PEM')!.version, lines.get('PEM')!.author], [2, ben.deviceId]);
    assert.deepEqual([lines.get('DATABASE_URL')!.version, lines.get('DATABASE_URL')!.box], [2, null]);
    assert.equal(lines.get('NEW')!.version, 1);
    assert.deepEqual(result.file.values.map((line) => line.name), ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'PEM', 'NEW']);
    assert.equal(result.file.values[1], withBen.values[1], 'an unchanged line is kept as it was');
    verified(writeEnvFile(result.file), null);
    assert.deepEqual(openEnvValues(result.file, set.dataKey), [VALUES[1]!, { name: 'PEM', value: 'p2' }, { name: 'NEW', value: 'n' }]);
  });

  it('skips a value that did not change, and brings a deleted name back as added', () => {
    assert.deepEqual(change([{ name: 'PEM', value: VALUES[2]!.value }]).changed, []);
    const removed = change([], ['PEM']);
    const back = change([{ name: 'PEM', value: 'again' }], [], ben, removed.file);
    assert.deepEqual(back.added, ['PEM']);
    assert.equal(back.file.values.find((line) => line.name === 'PEM')!.version, 3);
  });

  it('refuses outsiders, a stale key, bad names, removing what is not there, and going over the caps', () => {
    assert.throws(() => change([{ name: 'A', value: '' }], [], device('stranger')), /Only a member/);
    assert.throws(() => changeEnvValues({ file: withBen, author: ben, dataKey: makeSet('other').dataKey, changes: { upsert: [], remove: [] }, time: T0, random }), /current key/);
    assert.throws(() => change([{ name: 'A-B', value: '' }]), (err: unknown) => err instanceof EnvFileRefused && err.problem.kind === 'bad-name');
    assert.throws(() => change([], ['MISSING']), /isn't a variable/);
    assert.throws(() => change([{ name: 'PEM', value: '' }], ['PEM']), /both set and removed/);
    const big = Array.from({ length: 4 }, (_, i) => ({ name: `BIG${i}`, value: 'x'.repeat(32 * 1024) }));
    assert.throws(() => change(big), (err: unknown) => err instanceof EnvFileRefused && err.problem.kind === 'too-large' && err.problem.limit === 'values');
  });

  it('plans a push: changed and new names, and with prune the names missing', () => {
    const current = [{ name: 'A', value: '1' }, { name: 'B', value: '2' }, { name: 'C', value: '3' }];
    const pushed = [{ name: 'A', value: '1' }, { name: 'B', value: '20' }, { name: 'D', value: '4' }];
    assert.deepEqual(planEnvPush(current, pushed, false), { upsert: [pushed[1], pushed[2]], remove: [] });
    assert.deepEqual(planEnvPush(current, pushed, true).remove, ['C']);
    assert.throws(() => planEnvPush(current, [{ name: '', value: '' }], false), EnvFileRefused);
  });
});

it('the header signature covers every wrap', () => {
  const header = { ...withBen.header, members: [withBen.header.members[0]!, { ...withBen.header.members[1]!, key: { ...withBen.header.members[1]!.key, ct: toBase64Url(new Uint8Array(48)) } }] };
  assert.equal(verifyEnvFile(writeEnvFile({ ...withBen, header }), null).ok, false);
});
