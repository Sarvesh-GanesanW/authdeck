// Security review of env sets (0.4), phone engine. Each test is a proof of concept for one finding:
// it fails while the weakness is there and passes once it is fixed. Ids match the review report.
import '../native';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  addEnvMember,
  changeEnvValues,
  createEnvJoinRequest,
  openEnvDataKey,
  newEnvTransferKey,
  openEnvSealedValues,
  openEnvValues,
  verifyEnvFile,
  writeEnvFile,
  writeEnvJoinRequest,
  type EnvSetFile,
} from '../../src/envcore';
import { generateDeviceKeys, type DeviceKeys } from '../../src/vault/crypto';
import { seededRandom } from '../helpers';
import { onRealAuthority } from './helpers';
import { ask, COMPUTER, createdSet, disposeAll, externalSet, joinKeysRequest, pushRequest, releaseRequest, rig, settle, type Rig } from '../env/fakes';

afterEach(disposeAll);

const otherRandom = seededRandom('envattacks-others');

function fileOf(text: string): EnvSetFile {
  const verified = verifyEnvFile(text, null);
  if (!verified.ok) throw new Error(`refused: ${verified.problem.kind}`);
  return verified.set.file;
}

/** Adds `member` to the set as the owner phone would, outside the engine (the file on the computer only). */
function addedOnComputer(r: Rig, setId: string, member: DeviceKeys, label: string): string {
  const current = fileOf(r.agent.sets.get(setId)!.text);
  const file = addEnvMember({
    file: current,
    owner: r.device,
    dataKeys: { [current.header.epoch]: r.store.keys.get(setId)![current.header.epoch]! },
    time: 7,
    member: { edPublic: member.edPublic, xPublic: member.xPublic, label, form: 'phone' },
  });
  return writeEnvFile(file);
}

/** The value line for `name` in a file's text, as written. */
function valueLineOf(text: string, name: string): string {
  const line = text.split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`no line for ${name}`);
  return line;
}

/** The text with the line for `name` replaced by `line`: no duplicate name, so only versions can catch it. */
function replaceLine(text: string, name: string, line: string): string {
  return text
    .split('\n')
    .map((l) => (l.startsWith(`${name}=`) ? line : l))
    .join('\n');
}

function liveNames(text: string): string[] {
  return fileOf(text)
    .values.filter((line) => line.box !== null)
    .map((line) => line.name);
}

/** A set with OLD_TOKEN deleted (tombstone v2), and the epoch-1 line that held its value. */
async function deletedToken(r: Rig): Promise<{ setId: string; oldTokenLine: string }> {
  const setId = await createdSet(r, [
    { name: 'API_KEY', value: 'sk_live_1' },
    { name: 'OLD_TOKEN', value: 'leaked-and-revoked' },
  ]);
  const oldTokenLine = valueLineOf(r.agent.sets.get(setId)!.text, 'OLD_TOKEN');
  await r.engine.deleteVariable(setId, 'OLD_TOKEN');
  return { setId, oldTokenLine };
}

describe('ENV-01 (regression): a deleted variable never comes back as current', () => {
  it('same key: the tombstone line swapped for the old value line is refused, and a release leaves it out', async () => {
    const r = await rig();
    const { setId, oldTokenLine } = await deletedToken(r);
    const crafted = replaceLine(r.agent.sets.get(setId)!.text, 'OLD_TOKEN', oldTokenLine);
    assert.ok(liveNames(crafted).includes('OLD_TOKEN'), 'the crafted file has OLD_TOKEN live and no duplicate');
    r.agent.put(setId, 'acme-api', crafted);
    await r.engine.sync();
    const detail = r.engine.detail(setId)!;
    assert.ok(!detail.variables.some((v) => v.name === 'OLD_TOKEN'));
    assert.ok(detail.set.problems.some((p) => p.id === 'older-copy'), JSON.stringify(detail.set.problems.map((p) => p.id)));
    const once = newEnvTransferKey(otherRandom);
    const grant = newEnvTransferKey(otherRandom);
    ask(r, releaseRequest(r.agent, 'rel-1', setId, { oneTime: once.xPublic, grant: grant.xPublic }));
    await r.engine.answer('rel-1', 'once');
    const answer = r.agent.answers.get('rel-1');
    assert.equal(answer?.kind, 'release');
    if (answer?.kind !== 'release') return;
    const released = openEnvSealedValues(answer.values, { set: setId, request: 'rel-1' }, once).map((v) => v.name);
    assert.deepEqual(released, ['API_KEY']);
  });

  it('after a re-key: the old-key value line in place of the tombstone is refused, and the owner cannot keep it', async () => {
    const r = await rig();
    const { setId, oldTokenLine } = await deletedToken(r);
    const other = generateDeviceKeys(otherRandom);
    r.agent.put(setId, 'acme-api', addedOnComputer(r, setId, other, 'Lucía Ortiz · Pixel 7a'));
    await r.engine.sync();
    await r.engine.removeMember(setId, other.deviceId);
    const epochTwo = r.agent.sets.get(setId)!.text;
    assert.ok(epochTwo.includes('OLD_TOKEN=deleted'), 'the re-key keeps the tombstone');

    const crafted = replaceLine(epochTwo, 'OLD_TOKEN', oldTokenLine);
    r.agent.put(setId, 'acme-api', crafted);
    await r.engine.sync();
    assert.ok(!r.engine.detail(setId)!.variables.some((v) => v.name === 'OLD_TOKEN'));
    await assert.rejects(r.engine.fixOldKeyLines(setId, true, ['OLD_TOKEN']));
    assert.equal(r.agent.sets.get(setId)!.text, crafted, 'nothing was signed');
  });
});

describe("ENV-02: a repo writer forges the set a teammate's phone is waiting to join", () => {
  it("the teammate's phone does not take a self-made set with the real id as the set it asked to join", async () => {
    // Maya's phone owns the real set.
    const maya = await rig({ seed: 'maya' });
    const setId = await createdSet(maya);
    const realText = maya.agent.sets.get(setId)!.text;

    // Chen clones the repo and asks to join from his phone (env init → join-keys).
    const chen = await rig({ seed: 'chen', personName: 'Chen Wei' });
    chen.agent.put(setId, 'acme-api', realText);
    await chen.engine.sync();
    ask(chen, joinKeysRequest(chen.agent, 'jk-1', setId));
    await chen.engine.answer('jk-1', 'approve');

    // Mallory, who can push to the repo, replaces the file: same id and name, Mallory's own owner
    // key, Chen's public keys (from his request file) as a member, values of Mallory's choosing.
    const mallory = generateDeviceKeys(otherRandom);
    // Since set ids are self-certifying, the strongest forgery copies the real authority whole.
    const forged = onRealAuthority(realText, mallory, otherRandom, {
      members: [chen.device],
      values: [{ name: 'NODE_OPTIONS', value: '--require /tmp/mallory.js' }],
    });
    chen.agent.put(setId, 'acme-api', forged.text);
    await chen.engine.sync();

    const view = chen.engine.snapshot().sets.find((s) => s.id === setId);
    assert.notEqual(view?.role, 'member', "Chen's phone took Mallory's forged set as the set it asked to join");
  });

  it('what Chen then adds to the forged set opens with the forger\'s key (impact)', async () => {
    const maya = await rig({ seed: 'maya2' });
    const setId = await createdSet(maya);
    const chen = await rig({ seed: 'chen2', personName: 'Chen Wei' });
    chen.agent.put(setId, 'acme-api', maya.agent.sets.get(setId)!.text);
    await chen.engine.sync();
    ask(chen, joinKeysRequest(chen.agent, 'jk-2', setId));
    await chen.engine.answer('jk-2', 'approve');
    const mallory = generateDeviceKeys(otherRandom);
    const forged = onRealAuthority(maya.agent.sets.get(setId)!.text, mallory, otherRandom, { members: [chen.device], values: [{ name: 'API_KEY', value: 'sk_mallory' }] });
    chen.agent.put(setId, 'acme-api', forged.text);
    await chen.engine.sync();

    let saved = true;
    try {
      await chen.engine.saveVariable(setId, { name: 'STRIPE_SECRET_KEY', value: 'sk_live_chen' });
    } catch {
      saved = false;
    }
    const readable = saved && openEnvValues(fileOf(chen.agent.sets.get(setId)!.text), forged.dataKey).some((v) => v.value === 'sk_live_chen');
    assert.equal(readable, false, "Mallory reads the value Chen's phone encrypted into the forged set");
  });
});

describe('ENV-03: the push sheet shows changes against an older copy than the one the phone signs', () => {
  it('every name the phone signs was on the sheet', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    // Ben is a member; his phone changes DB_URL. The computer has that file; this phone hasn't synced it.
    const ben = generateDeviceKeys(otherRandom);
    r.agent.put(setId, 'acme-api', addedOnComputer(r, setId, ben, 'Ben Okafor · Pixel 9'));
    await r.engine.sync();
    const withBen = fileOf(r.agent.sets.get(setId)!.text);
    const changed = changeEnvValues({
      file: withBen,
      author: ben,
      dataKey: openEnvDataKey(withBen.header, ben),
      changes: { upsert: [{ name: 'DB_URL', value: 'postgres://rotated' }], remove: [] },
      time: 9,
      random: otherRandom,
    });
    r.agent.put(setId, 'acme-api', writeEnvFile(changed.file));

    // The computer offers a push that only "changes API_KEY"; DB_URL carries the value Ben replaced.
    ask(
      r,
      pushRequest(
        r.agent,
        'push-1',
        setId,
        [
          { name: 'API_KEY', value: 'sk_live_2' },
          { name: 'DB_URL', value: 'postgres://db' },
        ],
        false,
      ),
    );
    await settle();
    const shown = new Set((r.engine.snapshot().incoming[0]?.changes ?? []).map((c) => `${c.change}:${c.name}`));
    const { changes: signed } = await r.engine.answer('push-1', 'approve');
    const unseen = (signed ?? []).filter((c) => !shown.has(`${c.change}:${c.name}`)).map((c) => `${c.change}:${c.name}`);
    assert.deepEqual(unseen, [], `the phone signed changes the sheet never showed: ${unseen.join(', ')}`);
  });
});

describe('ENV-04: history marks a forged commit as signed by the real owner', () => {
  it('a commit whose member list no device in the chain signed is not shown as signed', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const ownerLabel = fileOf(r.agent.sets.get(setId)!.text).header.members[0]!.label;

    // A repo writer commits a self-made file with the same id, signed by its own key under the owner's label.
    const mallory = generateDeviceKeys(otherRandom);
    r.agent.put(setId, 'acme-api', onRealAuthority(r.agent.sets.get(setId)!.text, mallory, otherRandom, { ownerLabel }).text);

    const { items } = await r.engine.history(setId);
    const newest = items[0]!;
    assert.ok(!(newest.signed && newest.by === ownerLabel), `history shows the forged commit as signed by ${newest.by}`);
  });
});

describe('ENV-02b: a phone with no copy adopts any self-made set that lists it', () => {
  it('a set this device never asked to join, made by a stranger with its public keys, is not taken as a member set', async () => {
    const r = await rig({ seed: 'victim' });
    const stranger = generateDeviceKeys(otherRandom);
    const planted = externalSet(stranger, otherRandom, { members: [r.device], name: 'acme-api' });
    r.agent.put(planted.setId, 'acme-api', planted.text);
    await r.engine.computerChanged(COMPUTER);
    await r.engine.sync();
    const view = r.engine.snapshot().sets.find((s) => s.id === planted.setId);
    assert.notEqual(view?.role, 'member', 'the phone lists a stranger\'s set as one it is a member of, with no request or approval');
  });
});
