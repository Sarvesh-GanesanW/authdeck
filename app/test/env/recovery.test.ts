// The vault's recovery phrase on sets this phone owns, the owner fixing lines under an old key,
// the person's name in member labels, and the device unlock before member changes.
import '../native';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  addEnvMember,
  changeEnvValues,
  createEnvJoinRequest,
  envKeyWords,
  envFileProblemWords,
  envRecoveryKeys,
  takeOverEnvSet,
  mergeEnvFiles,
  removeEnvMember,
  verifyEnvFile,
  writeEnvFile,
  writeEnvJoinRequest,
  type EnvSetFile,
} from '../../src/envcore';
import { generateDeviceKeys, type DeviceKeys } from '../../src/vault/crypto';
import { generateRecoveryPhrase } from '../../src/vault/recovery';
import { valueLineOf, withLine } from '../envattacks/helpers';
import { seededRandom } from '../helpers';
import { ask, COMPUTER, createdSet, createRequest, joinedThrough, joinKeysRequest, disposeAll, externalSet, rig, type Rig } from './fakes';

afterEach(disposeAll);

const otherRandom = seededRandom('recovery-others');

/** The sentence a file the core refuses is shown with, as the engine words it. */
function refusalWords(text: string): string {
  const verified = verifyEnvFile(text, null);
  assert.ok(!verified.ok);
  assert.equal(verified.problem.kind, 'header-unsigned');
  const words = envFileProblemWords(verified.problem, { file: '.authdeck/acme-api.env', set: 'acme-api', where: 'phone' });
  return `${words.message} ${words.hint}`;
}

function fileOf(text: string): EnvSetFile {
  const verified = verifyEnvFile(text, null);
  if (!verified.ok) throw new Error(`refused: ${verified.problem.kind}`);
  return verified.set.file;
}

/** The vault's recovery phrase as the vault engine would report it: its identity's public keys. */
function phraseOn(r: Rig): { phrase: string; keys: DeviceKeys } {
  const phrase = generateRecoveryPhrase(otherRandom);
  const keys = envRecoveryKeys(phrase, r.vault.vault!);
  r.vault.recoveryKeys = { deviceId: keys.deviceId, edPublic: keys.edPublic, xPublic: keys.xPublic };
  return { phrase, keys };
}

describe("the vault's recovery phrase on sets this phone owns", () => {
  it('a set made without a phrase has no recovery identity', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    assert.equal(fileOf(r.agent.sets.get(setId)!.text).header.recovery, null);
  });

  it("a set made with a phrase carries the vault's recovery identity", async () => {
    const r = await rig({ open: false });
    const { keys } = phraseOn(r);
    r.vault.state = 'open';
    await r.engine.vaultChanged();
    const setId = await createdSet(r);
    assert.equal(fileOf(r.agent.sets.get(setId)!.text).header.recovery?.id, keys.deviceId);
  });

  it('setting, then changing the phrase updates every owned set (a change makes a new key), and the phrase then takes it over', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const first = phraseOn(r);
    await r.engine.vaultRecoveryChanged();
    let file = fileOf(r.agent.sets.get(setId)!.text);
    assert.equal(file.header.recovery?.id, first.keys.deviceId);
    assert.equal(file.header.epoch, 1);
    assert.equal(r.engine.snapshot().sets[0]!.problems.some((p) => p.id === 'recovery-pending'), false);

    const second = phraseOn(r);
    await r.engine.vaultRecoveryChanged();
    file = fileOf(r.agent.sets.get(setId)!.text);
    assert.equal(file.header.recovery?.id, second.keys.deviceId);
    assert.equal(file.header.epoch, 2);
    assert.equal(await r.engine.reveal(setId, 'API_KEY'), 'sk_live_1');

    // The phone is lost; a new phone restored with the phrase has the same vault id.
    const restored = await rig({ seed: 'restored' });
    restored.vault.vault = r.vault.vault;
    restored.agent.put(setId, 'acme-api', r.agent.sets.get(setId)!.text);
    await restored.engine.sync();
    await assert.rejects(restored.engine.becomeOwner(setId, first.phrase.split(' ')), /don't open/);
    const asked = restored.vault.confirms.length;
    await restored.engine.becomeOwner(setId, second.phrase.split(' '));
    assert.ok(restored.vault.confirms.length > asked, 'becoming the owner asks for the device unlock');
    assert.equal(restored.engine.snapshot().sets[0]!.role, 'owner');
  });

  it('while the computer is away, the owner sees that the phrase is not on the set yet; it goes on when the computer is back', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    await r.engine.computerChanged(null);
    const { keys } = phraseOn(r);
    await r.engine.vaultRecoveryChanged();
    assert.ok(r.engine.snapshot().sets[0]!.problems.some((p) => p.id === 'recovery-pending' && p.title === 'Recovery phrase not on this set yet'));
    await r.engine.computerChanged(COMPUTER);
    assert.equal(fileOf(r.agent.sets.get(setId)!.text).header.recovery?.id, keys.deviceId);
    assert.equal(r.engine.snapshot().sets[0]!.problems.some((p) => p.id === 'recovery-pending'), false);
  });
});

/**
 * A member edits under key 1 while the owner removes someone (key 2); git's merge driver keeps the
 * member's line, still under key 1.
 */
function oldKeyLine(owner: DeviceKeys, ownerKey: Uint8Array, base: EnvSetFile, member: DeviceKeys, removed: DeviceKeys): string {
  const rekeyed = removeEnvMember({ file: base, owner, dataKeys: { 1: ownerKey }, time: 50, memberId: removed.deviceId, random: otherRandom });
  const edited = changeEnvValues({
    file: base,
    author: member,
    dataKey: ownerKey,
    changes: { upsert: [{ name: 'API_KEY', value: 'from-member' }], remove: [] },
    time: 60,
    random: otherRandom,
  });
  const merged = mergeEnvFiles({ base: null, ours: writeEnvFile(rekeyed.file), theirs: writeEnvFile(edited.file), trust: null });
  assert.equal(merged.kind, 'merged');
  return (merged as { file: string }).file;
}

describe('lines under an old key', () => {
  /** An owner phone whose set has a member's edit under key 1 merged into the owner's key-2 file. */
  async function ownerWithOldKeyLine() {
    const r = await rig();
    const setId = await createdSet(r);
    const member = generateDeviceKeys(otherRandom);
    const leaving = generateDeviceKeys(otherRandom);
    const key = r.store.keys.get(setId)![1]!;
    let base = fileOf(r.agent.sets.get(setId)!.text);
    for (const [i, device] of [member, leaving].entries()) {
      base = addEnvMember({ file: base, owner: r.device, dataKeys: { 1: key }, time: 10 + i, member: { edPublic: device.edPublic, xPublic: device.xPublic, label: `M${i}`, form: null } });
    }
    r.agent.put(setId, 'acme-api', writeEnvFile(base));
    await r.engine.sync();
    const merged = oldKeyLine(r.device, key, base, member, leaving);
    assert.equal(verifyEnvFile(merged, null).ok, false);
    r.agent.put(setId, 'acme-api', merged);
    await r.engine.sync();
    return { r, setId, merged };
  }

  it('nothing is encrypted again unseen: the owner sees the names, and the computer file stays as it is', async () => {
    const { r, setId, merged } = await ownerWithOldKeyLine();
    assert.equal(r.agent.sets.get(setId)!.text, merged);
    const problem = r.engine.snapshot().sets[0]!.problems.find((p) => p.kind === 'epoch');
    assert.deepEqual(problem?.names, ['API_KEY']);
  });

  it('keep: the owner confirms, the lines are encrypted again, and every kept old-key value is listed to rotate', async () => {
    const { r, setId } = await ownerWithOldKeyLine();
    const asked = r.vault.confirms.length;
    const { rotate } = await r.engine.fixOldKeyLines(setId, true, ['API_KEY']);
    assert.equal(r.vault.confirms.length, asked + 1);
    assert.deepEqual(rotate, ['API_KEY']);
    const fixed = r.agent.sets.get(setId)!.text;
    assert.ok(verifyEnvFile(fixed, null).ok, 'the computer now has a file every reader accepts');
    assert.equal(await r.engine.reveal(setId, 'API_KEY'), 'from-member');
    assert.equal(r.engine.snapshot().sets[0]!.problems.length, 0);
  });

  it('drop: the old-key values are deleted under the new key, and still listed to rotate', async () => {
    const { r, setId } = await ownerWithOldKeyLine();
    assert.deepEqual(await r.engine.fixOldKeyLines(setId, false, ['API_KEY']), { rotate: ['API_KEY'] });
    const fixed = fileOf(r.agent.sets.get(setId)!.text);
    assert.ok(!fixed.values.some((line) => line.name === 'API_KEY' && line.box !== null));
    assert.equal(await r.engine.reveal(setId, 'DB_URL'), 'postgres://db');
  });

  it('a member sees that it waits for the owner', async () => {
    const owner = generateDeviceKeys(otherRandom);
    const leaving = generateDeviceKeys(otherRandom);
    const r = await rig();
    const made = externalSet(owner, otherRandom, { members: [r.device, leaving] });
    await joinedThrough(r, made.setId, made.text);
    r.agent.put(made.setId, 'acme-api', oldKeyLine(owner, made.dataKey, made.file, r.device, leaving));
    await r.engine.sync();
    const problem = r.engine.snapshot().sets[0]!.problems.find((p) => p.kind === 'epoch');
    assert.equal(problem?.title, 'Waiting for Ben Okafor · Pixel 9 to fix the set');
    await assert.rejects(r.engine.fixOldKeyLines(made.setId, true, ['API_KEY']), /owner/);
  });

  it('names other than the reviewed ones are refused, and the review shows the new names', async () => {
    const { r, setId } = await ownerWithOldKeyLine();
    const before = r.agent.sets.get(setId)!.text;
    await assert.rejects(r.engine.fixOldKeyLines(setId, true, ['API_KEY', 'OTHER']), /Review them again/);
    assert.equal(r.agent.sets.get(setId)!.text, before);
    assert.deepEqual(r.engine.snapshot().sets[0]!.problems.find((p) => p.kind === 'epoch')?.names, ['API_KEY']);
  });
});

describe("the person's name", () => {
  it('labels this device "Name · Device" once set, and refuses an empty or long name', async () => {
    const r = await rig({ personName: null });
    assert.equal(r.engine.snapshot().personName, null);
    await assert.rejects(r.engine.setPersonName('   '), /Type your name/);
    await assert.rejects(r.engine.setPersonName('x'.repeat(41)), /40 characters/);
    const setIdBefore = await createdSet(r);
    assert.equal(fileOf(r.agent.sets.get(setIdBefore)!.text).header.members[0]!.label, 'Pixel 8');
    await r.engine.setPersonName('  Maya  Rao ');
    assert.equal(r.engine.snapshot().personName, 'Maya Rao');
    assert.equal(r.store.prefs.personName, 'Maya Rao');
    ask(r, { ...createRequest(r.agent, 'create-2', [{ name: 'A', value: 'b' }]), setName: 'acme-web' });
    await r.engine.answer('create-2', 'approve');
    const created = r.agent.answers.get('create-2');
    assert.equal(created?.kind, 'created');
    assert.equal(fileOf((created as { file: string }).file).header.members[0]!.label, 'Maya Rao · Pixel 8');
  });
});

describe('the device unlock before member changes', () => {
  it('approving a join and removing a member ask first; a cancelled unlock changes nothing', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const teammate = generateDeviceKeys(otherRandom);
    const request = createEnvJoinRequest({ set: setId, device: teammate, label: 'Chen Wei · iPhone 16', form: 'phone', time: 5 });
    r.agent.addJoinRequest(setId, request, writeEnvJoinRequest(request));
    await r.engine.sync();
    const before = r.agent.sets.get(setId)!.text;
    const requestId = r.engine.snapshot().joinRequests[0]!.id;

    r.vault.cancel = 'Unlock was cancelled.';
    await assert.rejects(r.engine.approveJoin(requestId), /cancelled/);
    assert.equal(r.agent.sets.get(setId)!.text, before);

    r.vault.cancel = null;
    const asked = r.vault.confirms.length;
    await r.engine.approveJoin(requestId);
    assert.equal(r.vault.confirms.length, asked + 1);
    await r.engine.removeMember(setId, teammate.deviceId);
    assert.equal(r.vault.confirms.length, asked + 2);
    // Edits only need the vault open.
    await r.engine.saveVariable(setId, { name: 'API_KEY', value: 'v' });
    assert.equal(r.vault.confirms.length, asked + 2);
  });
});

describe('teammate joins compare words both ways', () => {
  it("the teammate's request shows the owner it was made against, and the owner's sheet shows the same six words", async () => {
    const maya = await rig({ seed: 'maya-words' });
    const setId = await createdSet(maya);
    const chen = await rig({ seed: 'chen-words', personName: 'Chen Wei' });
    chen.agent.put(setId, 'acme-api', maya.agent.sets.get(setId)!.text);
    await chen.engine.sync();
    ask(chen, joinKeysRequest(chen.agent, 'jk-w', setId));
    await chen.engine.answer('jk-w', 'approve');
    const own = chen.engine.snapshot().ownRequests[0]!;
    assert.equal(own.ownerLabel, 'Maya Rao · Pixel 8');
    assert.deepEqual(own.ownerKeyWords, envKeyWords(maya.device.edPublic, maya.device.xPublic));

    const request = chen.agent.answers.get('jk-w');
    assert.ok(request?.kind === 'join-keys');
    maya.agent.addJoinRequest(setId, request.request, writeEnvJoinRequest(request.request));
    await maya.engine.sync();
    const sheet = maya.engine.snapshot().joinRequests[0]!;
    assert.deepEqual(sheet.ownerKeyWords, own.ownerKeyWords);
    assert.deepEqual(sheet.keyWords, own.keyWords);
  });
});

describe("the teammate confirms the owner's words before the set is taken", () => {
  async function askedToJoin() {
    const maya = await rig({ seed: 'maya-confirm', open: false });
    const { phrase } = phraseOn(maya);
    maya.vault.state = 'open';
    await maya.engine.vaultChanged();
    const setId = await createdSet(maya);
    const chen = await rig({ seed: 'chen-confirm', personName: 'Chen Wei' });
    chen.agent.put(setId, 'acme-api', maya.agent.sets.get(setId)!.text);
    await chen.engine.sync();
    ask(chen, joinKeysRequest(chen.agent, 'jk-c', setId));
    await chen.engine.answer('jk-c', 'approve');
    const current = fileOf(maya.agent.sets.get(setId)!.text);
    const withChen = addEnvMember({
      file: current,
      owner: maya.device,
      dataKeys: { 1: maya.store.keys.get(setId)![1]! },
      time: 7,
      member: { edPublic: chen.device.edPublic, xPublic: chen.device.xPublic, label: 'Chen Wei · Pixel 8', form: 'phone' },
    });
    return { maya, phrase, chen, setId, withChen: writeEnvFile(withChen) };
  }

  /**
   * Maya lost her phone and her new one takes the set over with the phrase: the only way a set
   * gets another owner under the same id (a set someone else made can't carry it).
   */
  function takenOver(maya: Rig, phrase: string, setId: string): { newOwner: DeviceKeys; text: string } {
    const newOwner = generateDeviceKeys(otherRandom);
    const taken = takeOverEnvSet({
      file: fileOf(maya.agent.sets.get(setId)!.text),
      recovery: envRecoveryKeys(phrase, maya.vault.vault!),
      newOwner,
      label: 'Maya Rao · Pixel 9',
      form: 'phone',
      time: 9,
      random: otherRandom,
    });
    return { newOwner, text: writeEnvFile(taken.file) };
  }

  it('a file listing the device stays outside until the words are confirmed, then is taken', async () => {
    const { chen, setId, withChen } = await askedToJoin();
    chen.agent.put(setId, 'acme-api', withChen);
    await chen.engine.sync();
    assert.equal(chen.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'outside');
    assert.equal(chen.engine.snapshot().ownRequests[0]!.ownerConfirmed, false);
    await chen.engine.confirmOwnerWords(setId, chen.engine.snapshot().ownRequests[0]!.ownerKeyWords);
    assert.equal(chen.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'member');
  });

  it('asking again against a file with another owner needs the words compared again', async () => {
    const { maya, phrase, chen, setId } = await askedToJoin();
    await chen.engine.confirmOwnerWords(setId, chen.engine.snapshot().ownRequests[0]!.ownerKeyWords);
    const { newOwner, text } = takenOver(maya, phrase, setId);
    chen.agent.put(setId, 'acme-api', text);
    ask(chen, joinKeysRequest(chen.agent, 'jk-c2', setId));
    await chen.engine.answer('jk-c2', 'approve');
    const own = chen.engine.snapshot().ownRequests[0]!;
    assert.equal(own.ownerConfirmed, false);
    assert.deepEqual(own.ownerKeyWords, envKeyWords(newOwner.edPublic, newOwner.xPublic));
  });

  it('confirming the words a sheet showed before the owner changed is refused', async () => {
    const { maya, phrase, chen, setId } = await askedToJoin();
    const shownBefore = chen.engine.snapshot().ownRequests[0]!.ownerKeyWords;
    chen.agent.put(setId, 'acme-api', takenOver(maya, phrase, setId).text);
    ask(chen, joinKeysRequest(chen.agent, 'jk-c3', setId));
    await chen.engine.answer('jk-c3', 'approve');
    await assert.rejects(chen.engine.confirmOwnerWords(setId, shownBefore), /owner's words changed/);
    assert.equal(chen.engine.snapshot().ownRequests[0]!.ownerConfirmed, false);
  });
});

describe('history across a take-over', () => {
  it('commits before a take-over this device made stay signed', async () => {
    const r = await rig({ open: false });
    const { phrase } = phraseOn(r);
    r.vault.state = 'open';
    await r.engine.vaultChanged();
    const setId = await createdSet(r);
    await r.engine.saveVariable(setId, { name: 'API_KEY', value: 'v2' });
    const restored = await rig({ seed: 'restored-history' });
    restored.vault.vault = r.vault.vault;
    restored.agent.put(setId, 'acme-api', r.agent.sets.get(setId)!.text);
    await restored.engine.sync();
    await restored.engine.becomeOwner(setId, phrase.split(' '));
    const items: { signed: boolean }[] = [];
    let page = await restored.engine.history(setId);
    items.push(...page.items);
    while (page.more) {
      page = await restored.engine.history(setId, (page.items[page.items.length - 1] as { commit: string }).commit);
      items.push(...page.items);
    }
    assert.ok(items.length >= 2);
    assert.ok(items.every((item) => item.signed), 'every commit on the chain shows as signed');
  });
});

describe('a take-over holds the file to its history', () => {
  it("a set made under another set's id is refused as unsigned, even by a device of this vault, and the computer's file stays", async () => {
    const r = await rig({ open: false });
    const { phrase, keys } = phraseOn(r);
    r.vault.state = 'open';
    await r.engine.vaultChanged();
    const setId = await createdSet(r);
    const recovery = { deviceId: keys.deviceId, edPublic: keys.edPublic, xPublic: keys.xPublic } as DeviceKeys;
    // A second set claiming the same id, by the same device: the id is its birth line's hash, so it can't.
    const other = externalSet(r.device, otherRandom, { setId, recovery });
    const restored = await rig({ seed: 'restored-two-sets' });
    restored.vault.vault = r.vault.vault;
    for (const text of r.agent.sets.get(setId)!.history) restored.agent.put(setId, 'acme-api', text);
    restored.agent.put(setId, 'acme-api', other.text);
    await restored.engine.sync();
    await assert.rejects(restored.engine.becomeOwner(setId, phrase.split(' ')), (err: Error) => err.message === refusalWords(other.text));
    assert.equal(restored.agent.sets.get(setId)!.text, other.text);
  });
});

describe('a set this device declined to take says why', () => {
  it('a pinned teammate set below its history floor stays outside with the refusal sentence, until the file changes', async () => {
    const maya = await rig({ seed: 'maya-refused' });
    const setId = await createdSet(maya, [
      { name: 'API_KEY', value: 'sk_live_1' },
      { name: 'OLD_TOKEN', value: 'leaked-and-revoked' },
    ]);
    const oldTokenLine = valueLineOf(maya.agent.sets.get(setId)!.text, 'OLD_TOKEN');
    // Chen asks to join before the deletion: his pin still has OLD_TOKEN at version 1, so only the history shows the tombstone.
    const chen = await rig({ seed: 'chen-refused', personName: 'Chen Wei' });
    chen.agent.put(setId, 'acme-api', maya.agent.sets.get(setId)!.text);
    await chen.engine.sync();
    ask(chen, joinKeysRequest(chen.agent, 'jk-r', setId));
    await chen.engine.answer('jk-r', 'approve');
    await chen.engine.confirmOwnerWords(setId, chen.engine.snapshot().ownRequests[0]!.ownerKeyWords);
    await maya.engine.deleteVariable(setId, 'OLD_TOKEN');
    chen.agent.put(setId, 'acme-api', maya.agent.sets.get(setId)!.text);

    // The owner adds Chen; a repo writer swaps OLD_TOKEN's tombstone back for its old value line.
    const current = fileOf(maya.agent.sets.get(setId)!.text);
    const withChen = writeEnvFile(
      addEnvMember({
        file: current,
        owner: maya.device,
        dataKeys: { 1: maya.store.keys.get(setId)![1]! },
        time: 7,
        member: { edPublic: chen.device.edPublic, xPublic: chen.device.xPublic, label: 'Chen Wei · Pixel 8', form: 'phone' },
      }),
    );
    chen.agent.put(setId, 'acme-api', withLine(withChen, 'OLD_TOKEN', oldTokenLine));
    await chen.engine.sync();
    const refused = chen.engine.snapshot().sets.find((s) => s.id === setId)!;
    assert.equal(refused.role, 'outside');
    assert.match(refused.refusedNote ?? '', /OLD_TOKEN at version 1; this device has seen version 2/);

    // The honest file is taken, and the note goes.
    chen.agent.put(setId, 'acme-api', withChen);
    await chen.engine.sync();
    const taken = chen.engine.snapshot().sets.find((s) => s.id === setId)!;
    assert.equal(taken.role, 'member');
    assert.equal(taken.refusedNote, null);
  });
});
