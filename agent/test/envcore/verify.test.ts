/** Whole-file checks: signatures, the header chain, rollback and trust on first use. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addEnvMember,
  changeEnvValues,
  envAuthorityChangeSignedBytes,
  envAuthorityFork,
  envCrossesAuthority,
  envHeaderHash,
  nextEnvTrust,
  envRecoveryKeys,
  removeEnvMember,
  setEnvRecovery,
  signEnvHeader,
  signEnvValueLine,
  takeOverEnvSet,
  verifyEnvFile,
  writeEnvFile,
  type EnvFileProblem,
  type EnvHeader,
  type EnvSetFile,
  type EnvTrust,
  type EnvValueLine,
} from '../../src/envcore';
import { toBase64Url } from '../../src/vault/bytes';
import { sign, type DeviceKeys } from '../../src/vault/crypto';
import { generateRecoveryPhrase } from '../../src/vault/recovery';
import { seededRandom } from '../helpers/vault';
import { device, makeSet, T0, verified } from './fixtures';

const set = makeSet();
const random = seededRandom('verify');
const ben = device('ben');
const priya = device('priya');
const keys = { [set.file.header.epoch]: set.dataKey };

function problemOf(text: string, trust: EnvTrust | null = null): EnvFileProblem {
  const result = verifyEnvFile(text, trust);
  assert.equal(result.ok, false, 'expected the file to be refused');
  return (result as { problem: EnvFileProblem }).problem;
}

function trustOf(file: EnvSetFile, previous: EnvTrust | null = null): EnvTrust {
  return nextEnvTrust(previous, verified(writeEnvFile(file), previous));
}

const withBen = addEnvMember({ file: set.file, owner: set.owner, dataKeys: keys, time: T0 + 1, member: { edPublic: ben.edPublic, xPublic: ben.xPublic, label: 'Ben Okafor · Pixel 9', form: 'phone' } });

describe('verifying a set file', () => {
  it('accepts a fresh set on first sight and reports its owner, hashes and live lines', () => {
    const result = verified(set.text, null);
    assert.equal(result.owner.id, set.owner.deviceId);
    assert.equal(result.headerHash, envHeaderHash(set.file.header));
    assert.deepEqual(result.live.map((line) => line.name), ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'PEM']);
  });

  it('passes on a parse problem as it is', () => {
    assert.deepEqual(problemOf('<<<<<<< HEAD\n'), { kind: 'conflict-markers', line: 1 });
  });

  it('header-unsigned: a header signed by a member, or by nobody it lists', () => {
    const forged = { ...withBen.header, signer: ben.deviceId };
    assert.deepEqual(problemOf(writeEnvFile({ ...withBen, header: forged })), { kind: 'header-unsigned' });
    const stranger = { ...set.file.header, signer: priya.deviceId };
    assert.deepEqual(problemOf(writeEnvFile({ ...set.file, header: stranger })), { kind: 'header-unsigned' });
  });

  it('not-a-member: a properly signed line by a device outside the set', () => {
    const line = signEnvValueLine({ ...set.file.values[0]!, author: priya.deviceId, version: 2 }, { set: set.setId, epoch: 1 }, priya);
    const text = writeEnvFile({ ...set.file, values: [line, ...set.file.values.slice(1)] });
    assert.deepEqual(problemOf(text), { kind: 'not-a-member', line: 8, name: 'DATABASE_URL', author: priya.deviceId });
  });

  it('unsigned-line: a line whose signature does not check', () => {
    const line = { ...set.file.values[1]!, time: T0 + 5 };
    const text = writeEnvFile({ ...set.file, values: [set.file.values[0]!, line, set.file.values[2]!] });
    assert.deepEqual(problemOf(text), { kind: 'unsigned-line', line: 9, name: 'STRIPE_SECRET_KEY' });
  });

  it('wrong-epoch: a line still boxed under the key a removed member held', () => {
    const removed = removeEnvMember({ file: withBen, owner: set.owner, dataKeys: keys, time: T0 + 3, memberId: ben.deviceId, random });
    const old = set.file.values[0]!;
    const text = writeEnvFile({ ...removed.file, values: [old, ...removed.file.values.slice(1)] });
    assert.deepEqual(problemOf(text), { kind: 'wrong-epoch', line: 8, name: 'DATABASE_URL', epoch: 1, current: 2 });
  });
});

describe('tampering', () => {
  const base = withBen;
  const text = writeEnvFile(base);
  const header = base.header;
  const otherKey = { ...header.members[1]!.key, ct: toBase64Url(new Uint8Array(48)) };

  it('refuses a change to any header field', () => {
    const changes: Partial<EnvHeader>[] = [
      { set: toBase64Url(new Uint8Array(16)) },
      { name: 'acme-api-prod' },
      { rev: 3 },
      { epoch: 2 },
      { authority: { ...header.authority, birth: { ...header.authority.birth, time: header.authority.birth.time + 1 } } },
      { authority: { ...header.authority, birth: makeSet('other').file.header.authority.birth } },
      { authority: { ...header.authority, birth: { ...header.authority.birth, recovery: null } } },
      { time: header.time + 1 },
      { members: [header.members[0]!, { ...header.members[1]!, role: 'member', label: 'Ben' }] },
      { members: [header.members[0]!, { ...header.members[1]!, form: 'tablet' }] },
      { members: [header.members[0]!, { ...header.members[1]!, since: 1 }] },
      { members: [header.members[0]!, { ...header.members[1]!, key: otherKey }] },
      { members: [header.members[0]!] },
      { members: [header.members[1]!, header.members[0]!] },
      { recovery: null },
      { recovery: { ...header.recovery!, key: { ...header.recovery!.key, e: header.members[0]!.key.e } } },
      { sig: header.sig.slice(0, -2) + (header.sig.endsWith('AA') ? 'Ag' : 'AA') },
    ];
    for (const change of changes) {
      const result = verifyEnvFile(writeEnvFile({ ...base, header: { ...header, ...change } }), null);
      assert.equal(result.ok, false, `accepted a header with ${JSON.stringify(Object.keys(change))} changed`);
    }
    assert.equal(verifyEnvFile(text, null).ok, true);
  });

  it('refuses a change to any value line field', () => {
    const line = base.values[0]!;
    const box = line.box!;
    const flip = (text: string) => (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
    const changes: Partial<EnvValueLine>[] = [
      { name: 'DATABASE_URL2' },
      { version: 2 },
      { author: set.owner.deviceId === ben.deviceId ? priya.deviceId : ben.deviceId },
      { time: line.time + 1 },
      { box: null },
      { box: { ...box, n: flip(box.n) } },
      { box: { ...box, ct: flip(box.ct) } },
      { box: { ...box, c: flip(box.c) } },
      { box: base.values[1]!.box },
      { sig: base.values[1]!.sig },
    ];
    for (const change of changes) {
      const values = [{ ...line, ...change }, ...base.values.slice(1)];
      const result = verifyEnvFile(writeEnvFile({ ...base, values }), null);
      assert.equal(result.ok, false, `accepted a line with ${JSON.stringify(Object.keys(change))} changed`);
      assert.ok(['unsigned-line', 'wrong-epoch'].includes((result as { problem: EnvFileProblem }).problem.kind));
    }
  });

  it('refuses a value line moved from another set', () => {
    const other = makeSet('other');
    const values = [{ ...other.file.values[0]!, author: set.owner.deviceId }, ...set.file.values.slice(1)];
    assert.equal(problemOf(writeEnvFile({ ...set.file, values })).kind, 'unsigned-line');
  });
});

describe('rollback and the header chain', () => {
  const first = trustOf(set.file);

  it('older-header: a member list below the one accepted', () => {
    const trust = trustOf(withBen, first);
    assert.deepEqual(problemOf(set.text, trust), { kind: 'older-header', seen: 2, found: 1 });
  });

  it('header-chain: another header at the accepted rev, or another set', () => {
    const withPriya = addEnvMember({ file: set.file, owner: set.owner, dataKeys: keys, time: T0 + 1, member: { edPublic: priya.edPublic, xPublic: priya.xPublic, label: 'Priya', form: null } });
    const trust = trustOf(withBen, first);
    assert.deepEqual(problemOf(writeEnvFile(withPriya), trust), { kind: 'header-chain', rev: 2 });
    assert.deepEqual(problemOf(makeSet('other').text, first), { kind: 'header-chain', rev: 1 });
  });

  it('trust on first use: a self-made set is taken on first sight, refused once the real one is trusted', () => {
    const attacker = makeSet('acme-forged');
    assert.equal(verifyEnvFile(attacker.text, null).ok, true);
    const forged = { ...attacker.file, header: { ...attacker.file.header } };
    assert.equal(verifyEnvFile(writeEnvFile(forged), first).ok, false);
  });

  it('a later rev signed by a device that was never the owner is refused, trusted or not', () => {
    // Ben makes himself owner of a copy of the set: a valid self-signature, but not the trusted owner's.
    const hijack = addEnvMember({ file: set.file, owner: set.owner, dataKeys: keys, time: T0 + 1, member: { edPublic: ben.edPublic, xPublic: ben.xPublic, label: 'Ben', form: null } });
    const benOwner = { ...hijack.header.members[1]!, role: 'owner' as const };
    const mayaMember = { ...hijack.header.members[0]!, role: 'member' as const };
    const forgedUnsigned = { ...hijack.header, members: [mayaMember, benOwner], rev: 3, signer: ben.deviceId };
    const forged = { ...hijack, header: { ...forgedUnsigned, sig: '' } };
    forged.header.sig = signHeaderAs(forged.header, ben);
    assert.deepEqual(problemOf(writeEnvFile(forged), null), { kind: 'header-unsigned' }, "the set's authority names Maya's device, not Ben's");
    assert.deepEqual(problemOf(writeEnvFile(forged), first), { kind: 'header-unsigned' });
  });

  it('accepts a higher rev signed by the trusted owner even when the revs between are unknown', () => {
    const rev3 = addEnvMember({ file: withBen, owner: set.owner, dataKeys: keys, time: T0 + 2, member: { edPublic: priya.edPublic, xPublic: priya.xPublic, label: 'Priya', form: null } });
    assert.equal(verifyEnvFile(writeEnvFile(rev3), first).ok, true);
  });

  it('follows a take-over, and headers after it, without the headers between', () => {
    const newPhone = device('maya-new');
    const takeover = takeOverEnvSet({ file: set.file, recovery: set.recovery, newOwner: newPhone, label: 'Maya Rao · Pixel 10', form: 'phone', time: T0 + 5, random });
    assert.equal(verifyEnvFile(writeEnvFile(takeover.file), first).ok, true, 'its authority carries the take-over the recovery identity signed');
    const rev3 = addEnvMember({ file: takeover.file, owner: newPhone, dataKeys: { 2: takeover.dataKey }, time: T0 + 6, member: { edPublic: ben.edPublic, xPublic: ben.xPublic, label: 'Ben', form: null } });
    const next = nextEnvTrust(first, verified(writeEnvFile(rev3), first));
    assert.deepEqual([next.head.authority, next.head.rev], [1, 3]);
  });

  it('older-value: a lower version than accepted, or a remembered name gone', () => {
    const edited = changeEnvValues({ file: set.file, author: set.owner, dataKey: set.dataKey, changes: { upsert: [{ name: 'PEM', value: 'v2' }], remove: [] }, time: T0 + 1, random });
    const trust = trustOf(edited.file, first);
    assert.equal(trust.head.versions.PEM, 2);
    assert.deepEqual(problemOf(set.text, trust), { kind: 'older-value', line: 10, name: 'PEM', seen: 2, found: 1 });
    const dropped = writeEnvFile({ ...edited.file, values: edited.file.values.slice(0, 2) });
    assert.deepEqual(problemOf(dropped, trust), { kind: 'older-value', line: 3, name: 'PEM', seen: 2, found: 0 });
  });

  it('remembers every name across epochs, deletions included', () => {
    const deleted = changeEnvValues({ file: withBen, author: set.owner, dataKey: set.dataKey, changes: { upsert: [], remove: ['PEM'] }, time: T0 + 2, random });
    const trust = trustOf(deleted.file, trustOf(withBen, first));
    const removed = removeEnvMember({ file: deleted.file, owner: set.owner, dataKeys: keys, time: T0 + 3, memberId: ben.deviceId, random });
    const next = nextEnvTrust(trust, verified(writeEnvFile(removed.file), trust));
    assert.equal(next.head.epoch, 2);
    assert.deepEqual(next.head.versions, { DATABASE_URL: 1, STRIPE_SECRET_KEY: 1, PEM: 2 });
    const withoutTombstone = writeEnvFile({ ...removed.file, values: removed.file.values.filter((line) => line.name !== 'PEM') });
    assert.deepEqual(problemOf(withoutTombstone, next), { kind: 'older-value', line: 3, name: 'PEM', seen: 2, found: 0 });
    const withoutLive = writeEnvFile({ ...removed.file, values: removed.file.values.filter((line) => line.name !== 'DATABASE_URL') });
    assert.deepEqual(problemOf(withoutLive, trust), { kind: 'older-value', line: 3, name: 'DATABASE_URL', seen: 1, found: 0 });
  });

  it('remembers the higher version of each name, and refuses to go back', () => {
    const edited = changeEnvValues({ file: set.file, author: set.owner, dataKey: set.dataKey, changes: { upsert: [{ name: '__proto__', value: 'odd but allowed' }], remove: [] }, time: T0 + 1, random });
    const trust = trustOf(edited.file, first);
    assert.equal(Object.getPrototypeOf(trust.head.versions), Object.prototype);
    assert.equal(Object.hasOwn(trust.head.versions, '__proto__'), true);
    assert.equal(JSON.parse(JSON.stringify(trust.head.versions)).__proto__, 1);
    assert.throws(() => nextEnvTrust(trustOf(withBen, first), verified(set.text, null)));
    assert.throws(() => nextEnvTrust(first, verified(makeSet('other').text, null)));
  });
});

function signHeaderAs(header: EnvHeader, signer: DeviceKeys): string {
  const { sig: _sig, ...unsigned } = header;
  return signEnvHeader(unsigned, signer).sig;
}

describe('authority', () => {
  const newPhone = device('maya-new');
  const takeover = takeOverEnvSet({ file: withBen, recovery: set.recovery, newOwner: newPhone, label: 'Maya · Pixel 10', form: 'phone', time: T0 + 5, random });
  const first = trustOf(set.file);
  const afterTakeover = trustOf(takeover.file, trustOf(withBen, first));
  const priyaMember = { edPublic: priya.edPublic, xPublic: priya.xPublic, label: 'Priya', form: null };

  it('the recovery identity signs no header, even one that names a new owner', () => {
    const keepsOwner = signEnvHeader({ ...unsignedOf(withBen.header), signer: set.recovery.deviceId }, set.recovery);
    assert.deepEqual(problemOf(writeEnvFile({ ...withBen, header: keepsOwner }), null), { kind: 'header-unsigned' });
    const recoverySigned = signEnvHeader({ ...unsignedOf(takeover.file.header), signer: set.recovery.deviceId }, set.recovery);
    assert.deepEqual(problemOf(writeEnvFile({ ...takeover.file, header: recoverySigned }), null), { kind: 'header-unsigned' });
  });

  it('a set made by someone else under the real id never verifies (the id is the hash of the birth)', () => {
    const mallory = makeSet('mallory');
    const renamed = { ...mallory.file, header: signEnvHeader({ ...unsignedOf(mallory.file.header), set: set.setId }, mallory.owner) };
    assert.deepEqual(problemOf(writeEnvFile(renamed), null), { kind: 'header-unsigned' });
    const ownBirth = { ...renamed, header: signEnvHeader({ ...unsignedOf(renamed.header), authority: set.file.header.authority }, mallory.owner) };
    assert.deepEqual(problemOf(writeEnvFile(ownBirth), null), { kind: 'header-unsigned' }, "with the real birth, the owner must be the birth's");
  });

  it('refuses a take-over that is missing, out of order, or not signed by the recovery identity', () => {
    const { authority } = takeover.file.header;
    const change = authority.changes[0]!;
    const { sig: _sig, ...unsignedChange } = change;
    const forgedBy = (signer: DeviceKeys) => ({ ...change, sig: toBase64Url(sign(envAuthorityChangeSignedBytes(set.setId, unsignedChange), signer.edSecret)) });
    const variants = [
      { ...authority, changes: [] },
      { ...authority, changes: [{ ...change, n: 2 }] },
      { ...authority, changes: [{ ...change, prev: toBase64Url(new Uint8Array(32)) }] },
      { ...authority, changes: [{ ...change, kind: 'recovery' as const }] },
      { ...authority, changes: [{ ...change, time: change.time + 1 }] },
      { ...authority, changes: [forgedBy(set.owner)] },
      { ...authority, changes: [forgedBy(newPhone)] },
      { ...authority, changes: [change, change] },
    ];
    for (const variant of variants) {
      const header = signEnvHeader({ ...unsignedOf(takeover.file.header), authority: variant }, newPhone);
      assert.deepEqual(problemOf(writeEnvFile({ ...takeover.file, header }), null), { kind: 'header-unsigned' }, JSON.stringify(variant.changes.map((c) => [c.kind, c.n])));
    }
  });

  it('after a take-over, the replaced owner device signs nothing this device accepts', () => {
    // The old owner still has a copy from before the take-over; however high its rev, it is older.
    const oldOwnersRev3 = addEnvMember({ file: withBen, owner: set.owner, dataKeys: keys, time: T0 + 6, member: priyaMember });
    const higher = { ...oldOwnersRev3, header: signEnvHeader({ ...unsignedOf(oldOwnersRev3.header), rev: 40 }, set.owner) };
    assert.deepEqual(problemOf(writeEnvFile(higher), afterTakeover), { kind: 'older-header', seen: 3, found: 40 });
    const onTopOfTakeover = signEnvHeader({ ...unsignedOf(takeover.file.header), rev: 4, signer: set.owner.deviceId }, set.owner);
    assert.deepEqual(problemOf(writeEnvFile({ ...takeover.file, header: onTopOfTakeover }), afterTakeover), { kind: 'header-unsigned' });
    const ownerListed = { ...unsignedOf(takeover.file.header), rev: 4, members: withBen.header.members, signer: set.owner.deviceId };
    assert.deepEqual(problemOf(writeEnvFile({ ...takeover.file, header: signEnvHeader(ownerListed, set.owner) }), afterTakeover), { kind: 'header-unsigned' });
  });

  it('envAuthorityFork names the first change two lines differ at; envCrossesAuthority says when to read history', () => {
    const replaced = setEnvRecovery({ file: withBen, owner: set.owner, dataKeys: keys, time: T0 + 6, recovery: device('verify-new-recovery'), random });
    assert.deepEqual(envAuthorityFork(replaced.file.header, takeover.file.header), { change: 1, ours: 'recovery', theirs: 'takeover' });
    assert.equal(envAuthorityFork(withBen.header, takeover.file.header), null, 'one continues the other');
    assert.equal(envAuthorityFork(takeover.file.header, takeover.file.header), null);
    assert.equal(envAuthorityFork(takeover.file.header, makeSet('other').file.header), null, 'another set is not a fork');
    const memberTrust = trustOf(withBen, first);
    assert.equal(envCrossesAuthority(memberTrust, takeover.file.header), true);
    assert.equal(envCrossesAuthority(afterTakeover, takeover.file.header), false);
    assert.equal(envCrossesAuthority(memberTrust, withBen.header), false);
  });

  it('orders headers by authority epoch, then rev', () => {
    assert.throws(() => nextEnvTrust(afterTakeover, verified(writeEnvFile(addEnvMember({ file: withBen, owner: set.owner, dataKeys: keys, time: T0 + 6, member: priyaMember })), null)), /older/);
    assert.equal(afterTakeover.head.authority, 1);
  });

  it('a take-over signed with a phrase the owner had replaced is a fork once the change is trusted', () => {
    const second = envRecoveryKeys(generateRecoveryPhrase(seededRandom('verify-phrase')), set.vaultId);
    const replaced = setEnvRecovery({ file: withBen, owner: set.owner, dataKeys: keys, time: T0 + 6, recovery: second, random });
    const trust = trustOf(replaced.file, trustOf(withBen, first));
    // takeover was made from withBen with the old phrase: one change, like the trusted file, but another one.
    assert.deepEqual([takeover.file.header.authority.changes.length, takeover.file.header.rev, replaced.file.header.rev], [1, 3, 3]);
    assert.deepEqual(problemOf(writeEnvFile(takeover.file), trust), { kind: 'authority-fork', change: 1, ours: 'recovery', theirs: 'takeover' });
    const later = addEnvMember({ file: takeover.file, owner: newPhone, dataKeys: { 2: takeover.dataKey }, time: T0 + 7, member: priyaMember });
    assert.deepEqual(problemOf(writeEnvFile(later), trust), { kind: 'authority-fork', change: 1, ours: 'recovery', theirs: 'takeover' });
    // A lower rev on the other line is still a fork, not merely older.
    const replacedLater = setEnvRecovery({ file: replaced.file, owner: set.owner, dataKeys: { 2: replaced.dataKey }, time: T0 + 8, recovery: null, random });
    const trustLater = trustOf(replacedLater.file, trust);
    assert.deepEqual(problemOf(writeEnvFile(takeover.file), trustLater), { kind: 'authority-fork', change: 1, ours: 'recovery', theirs: 'takeover' });
  });
});

function unsignedOf(header: EnvHeader): Omit<EnvHeader, 'sig'> {
  const { sig: _sig, ...unsigned } = header;
  return unsigned;
}
