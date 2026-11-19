// A set's git history, checked before the set is first taken: folded page by page (no page cap),
// and the agent's own refusals shown as the reason.
import '../native';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { addEnvMember, envRecoveryKeys, takeOverEnvSet, verifyEnvFile, writeEnvFile, type EnvSetFile } from '../../src/envcore';
import { generateDeviceKeys } from '../../src/vault/crypto';
import { phraseOn, valueLineOf, withLine } from '../envattacks/helpers';
import { seededRandom } from '../helpers';
import { createJoinChallenge } from '../../src/vault/approval';
import { ask, createdSet, disposeAll, joinKeysRequest, rig, settle, type Rig } from './fakes';

afterEach(disposeAll);

const SHALLOW = "This repo is a shallow clone, so its history can't be checked. Run git fetch --unshallow, then try again.";

function fileOf(text: string): EnvSetFile {
  const verified = verifyEnvFile(text, null);
  if (!verified.ok) throw new Error(`refused: ${verified.problem.kind}`);
  return verified.set.file;
}

/** Maya's set with `edits` signed versions of API_KEY, then OLD_TOKEN deleted (or not). */
async function longSet(edits: number, deleteOldToken: boolean) {
  const maya = await rig({ seed: `maya-history-${edits}-${deleteOldToken}` });
  const setId = await createdSet(maya, [
    { name: 'API_KEY', value: 'v0' },
    { name: 'OLD_TOKEN', value: 'leaked-and-revoked' },
  ]);
  const oldTokenLine = valueLineOf(maya.agent.sets.get(setId)!.text, 'OLD_TOKEN');
  if (deleteOldToken) await maya.engine.deleteVariable(setId, 'OLD_TOKEN');
  for (let i = 1; i <= edits; i++) await maya.engine.saveVariable(setId, { name: 'API_KEY', value: `v${i}` });
  return { maya, setId, oldTokenLine };
}

/** Chen asked to join and compared the owner's words; the computer then has `history` and Maya's file adding him. */
async function chenJoining(maya: Rig, setId: string, edit: (withChen: string) => string = (t) => t) {
  const chen = await rig({ seed: `chen-history-${setId}`, personName: 'Chen Wei' });
  const first = maya.agent.sets.get(setId)!.history[0]!;
  chen.agent.put(setId, 'acme-api', first);
  await chen.engine.sync();
  ask(chen, joinKeysRequest(chen.agent, 'jk-h', setId));
  await chen.engine.answer('jk-h', 'approve');
  await chen.engine.confirmOwnerWords(setId, chen.engine.snapshot().ownRequests[0]!.ownerKeyWords);
  for (const text of maya.agent.sets.get(setId)!.history.slice(1)) chen.agent.put(setId, 'acme-api', text);
  const current = fileOf(maya.agent.sets.get(setId)!.text);
  const withChen = addEnvMember({
    file: current,
    owner: maya.device,
    dataKeys: { 1: maya.store.keys.get(setId)![1]! },
    time: 7,
    member: { edPublic: chen.device.edPublic, xPublic: chen.device.xPublic, label: 'Chen Wei · Pixel 8', form: 'phone' },
  });
  chen.agent.put(setId, 'acme-api', edit(writeEnvFile(withChen)));
  return chen;
}

describe('the history floor, read to the end page by page', () => {
  it('a deletion more than 50 pages back still refuses the swapped tombstone, and says why', async () => {
    const { maya, setId, oldTokenLine } = await longSet(120, true);
    const chen = await chenJoining(maya, setId, (withChen) => withLine(withChen, 'OLD_TOKEN', oldTokenLine));
    assert.ok(chen.agent.sets.get(setId)!.history.length > 100, 'over 50 pages of two commits');
    await chen.engine.sync();
    const view = chen.engine.snapshot().sets.find((s) => s.id === setId)!;
    assert.equal(view.role, 'outside');
    assert.match(view.refusedNote ?? '', /OLD_TOKEN at version 1; this device has seen version 2/);
  });

  it('an honest set with a long history is taken', async () => {
    const { maya, setId } = await longSet(120, false);
    const chen = await chenJoining(maya, setId);
    await chen.engine.sync();
    assert.equal(chen.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'member');
    assert.equal(await chen.engine.reveal(setId, 'API_KEY'), 'v120');
  });
});

describe("the agent's refusal to serve the history", () => {
  it('is the reason a pinned set stays outside, and the set is taken once the history reads', async () => {
    const { maya, setId } = await longSet(1, false);
    const chen = await chenJoining(maya, setId);
    chen.agent.historyRefusal = SHALLOW;
    await chen.engine.sync();
    const view = chen.engine.snapshot().sets.find((s) => s.id === setId)!;
    assert.equal(view.role, 'outside');
    assert.equal(view.refusedNote, SHALLOW);

    chen.agent.historyRefusal = null;
    // The same file, now with its history readable: the next sync tries again.
    await chen.engine.sync();
    assert.equal(chen.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'member');
  });

  it('is the sentence a take-over rejects with', async () => {
    const maya = await rig({ seed: 'maya-shallow', open: false });
    const { phrase } = phraseOn(maya, seededRandom('phrase-shallow'));
    maya.vault.state = 'open';
    await maya.engine.vaultChanged();
    const setId = await createdSet(maya);
    const restored = await rig({ seed: 'restored-shallow' });
    restored.vault.vault = maya.vault.vault;
    restored.agent.put(setId, 'acme-api', maya.agent.sets.get(setId)!.text);
    await restored.engine.sync();
    restored.agent.historyRefusal = SHALLOW;
    await assert.rejects(restored.engine.becomeOwner(setId, phrase.split(' ')), (err: Error) => err.message === SHALLOW);
    assert.equal(restored.agent.sets.get(setId)!.text, maya.agent.sets.get(setId)!.text);
  });
});

describe('a member that missed a change of authority reads the history first', () => {
  /** Maya's set, with her vault phrase on it, and Chen a member who saw only that (authority epoch 0). */
  async function chenAtEpochZero(seed: string) {
    const random = seededRandom(`authority-${seed}`);
    const maya = await rig({ seed: `maya-${seed}`, open: false });
    const first = phraseOn(maya, random);
    maya.vault.state = 'open';
    await maya.engine.vaultChanged();
    const setId = await createdSet(maya);
    const chen = await chenJoining(maya, setId);
    await chen.engine.sync();
    assert.equal(chen.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'member');
    return { maya, chen, setId, random, firstPhrase: first.phrase };
  }

  it('refuses a take-over on a line that forked from a retired recovery phrase', async () => {
    const { maya, chen, setId, random, firstPhrase } = await chenAtEpochZero('fork');
    const epochZero = fileOf(chen.agent.sets.get(setId)!.text);
    // Maya replaces her phrase: an owner-signed recovery change (authority 1) on the set.
    phraseOn(maya, random);
    maya.agent.put(setId, 'acme-api', chen.agent.sets.get(setId)!.text);
    await maya.engine.sync();
    await maya.engine.vaultRecoveryChanged();
    const replaced = maya.agent.sets.get(setId)!.text;
    // Whoever kept the retired phrase takes over from before the change: a second line of authority.
    const mallory = generateDeviceKeys(random);
    const fork = takeOverEnvSet({
      file: epochZero,
      recovery: envRecoveryKeys(firstPhrase, maya.vault.vault!),
      newOwner: mallory,
      label: 'Maya Rao · Pixel 9',
      form: 'phone',
      time: 50,
      random,
    });
    chen.agent.put(setId, 'acme-api', replaced);
    chen.agent.put(setId, 'acme-api', writeEnvFile(fork.file));
    await chen.engine.sync();

    const view = chen.engine.snapshot().sets.find((s) => s.id === setId)!;
    assert.equal(view.role, 'member', 'the fork did not remove Chen');
    const problem = view.problems.find((p) => p.id === 'file:authority-fork');
    assert.equal(problem?.title, 'Two lines of ownership');
    assert.equal(await chen.engine.reveal(setId, 'API_KEY'), 'sk_live_1');
  });

  it('refuses an own-device join into a forked line, though the device still has its copy', async () => {
    const { maya, chen, setId, random, firstPhrase } = await chenAtEpochZero('join-fork');
    const epochZero = fileOf(chen.agent.sets.get(setId)!.text);
    phraseOn(maya, random);
    maya.agent.put(setId, 'acme-api', chen.agent.sets.get(setId)!.text);
    await maya.engine.sync();
    await maya.engine.vaultRecoveryChanged();
    const replaced = maya.agent.sets.get(setId)!.text;
    // Mallory, holding the retired phrase, takes over from before the change and adds Chen back.
    const mallory = generateDeviceKeys(random);
    const fork = takeOverEnvSet({ file: epochZero, recovery: envRecoveryKeys(firstPhrase, maya.vault.vault!), newOwner: mallory, label: 'Maya Rao · Pixel 9', form: 'phone', time: 50, random });
    const forkWithChen = addEnvMember({
      file: fork.file,
      owner: mallory,
      dataKeys: { [fork.file.header.epoch]: fork.dataKey },
      time: 51,
      member: { edPublic: chen.device.edPublic, xPublic: chen.device.xPublic, label: 'Chen Wei · Pixel 8', form: 'phone' },
    });
    chen.agent.put(setId, 'acme-api', replaced);
    chen.agent.put(setId, 'acme-api', writeEnvFile(forkWithChen));

    // Chen compares codes with Mallory's phone, which then says it added him.
    await chen.engine.requestJoin(setId);
    const requestId = 'join-1';
    const { challenge } = createJoinChallenge(mallory, { vaultId: setId, vaultName: 'acme-api', deviceName: 'Maya Rao · Pixel 9' }, random);
    chen.engine.handleEvent({ event: 'env.join.challenged', data: { requestId, challenge } });
    await settle();
    chen.engine.handleEvent({ event: 'env.join.finished', data: { requestId, approved: true } });
    await settle();

    const join = chen.engine.snapshot().join;
    assert.equal(join?.stage, 'failed');
    assert.match(join?.error ?? '', /ownership|line/i);
    assert.equal(fileOf(chen.store.sets.get(setId)!.text).header.authority.changes.length, 0, 'the copy stays on its own line');
    assert.equal(await chen.engine.reveal(setId, 'API_KEY'), 'sk_live_1');
  });

  it('accepts an honest take-over with no fork in the history', async () => {
    const { maya, chen, setId, random, firstPhrase } = await chenAtEpochZero('honest');
    const newPhone = generateDeviceKeys(random);
    const taken = takeOverEnvSet({
      file: fileOf(chen.agent.sets.get(setId)!.text),
      recovery: envRecoveryKeys(firstPhrase, maya.vault.vault!),
      newOwner: newPhone,
      label: 'Maya Rao · Pixel 9',
      form: 'phone',
      time: 50,
      random,
    });
    chen.agent.put(setId, 'acme-api', writeEnvFile(taken.file));
    await chen.engine.sync();
    const view = chen.engine.snapshot().sets.find((s) => s.id === setId)!;
    // A take-over keeps no other member: Chen is out, and keeps what he saw until he deletes it.
    assert.equal(view.role, 'removed');
    assert.equal(view.problems.some((p) => p.kind === 'file'), false);
  });
});

describe('the history budget', () => {
  /** What the fake agent's history costs in UTF-8 bytes, metadata included (see readHistoryFloor). */
  function historyBytes(texts: readonly string[]): number {
    const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
    return texts.reduce((sum, text, i) => sum + 40 + bytes('Maya') + bytes(`change ${i}`) + bytes(text), 0);
  }

  async function takeOverWithComment(comment: string, budget: (history: string[]) => number) {
    const random = seededRandom('budget');
    const maya = await rig({ seed: 'maya-budget', open: false });
    const { phrase } = phraseOn(maya, random);
    maya.vault.state = 'open';
    await maya.engine.vaultChanged();
    const setId = await createdSet(maya);
    // A commit of something else at the set's path (it doesn't parse, so it only costs bytes), then the set again.
    const history = [...maya.agent.sets.get(setId)!.history, comment, maya.agent.sets.get(setId)!.text];
    const restored = await rig({ seed: 'restored-budget', historyBudgetBytes: budget(history) });
    restored.vault.vault = maya.vault.vault;
    for (const text of history) restored.agent.put(setId, 'acme-api', text);
    await restored.engine.sync();
    return restored.engine.becomeOwner(setId, phrase.split(' ')).then(
      () => 'taken',
      (err: Error) => err.message,
    );
  }

  it('counts a non-ASCII comment in bytes, not characters', async () => {
    const size = 50_000;
    // Room for the comment as characters, not as bytes ("é" is two bytes in UTF-8).
    const budget = (history: string[]) => historyBytes(history) - size;
    assert.match(await takeOverWithComment(`# ${'é'.repeat(size)}`, budget), /too long for this device to check/);
    assert.equal(await takeOverWithComment(`# ${'e'.repeat(size * 2)}`, (history) => historyBytes(history)), 'taken');
  });
});
