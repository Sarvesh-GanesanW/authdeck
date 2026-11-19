// Security review of env sets (0.4), round 2, phone engine. Each test is a proof of concept for one
// finding: it fails while the weakness is there and passes once it is fixed. Ids match the report.
import '../native';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { addEnvMember, openEnvDataKey, verifyEnvFile, writeEnvFile } from '../../src/envcore';
import { generateDeviceKeys } from '../../src/vault/crypto';
import { seededRandom } from '../helpers';
import { addVaultDevice, ask, createdSet, disposeAll, externalSet, joinKeysRequest, rig, type Rig } from '../env/fakes';
import { addMember, fileOf, liveNames, memberLines, phraseOn, valueLineOf, withLine } from './helpers';

afterEach(disposeAll);

const random = seededRandom('envattacks-round2');

/** The names the owner's review shows for lines under an old key. */
function reviewedNames(r: Rig, setId: string): string[] {
  return r.engine.detail(setId)?.set.problems.find((p) => Array.isArray(p.names))?.names ?? [];
}

/**
 * Owner phone `r` with members M and R; M signs `lines` under the first key at `lineTime`; then R
 * is removed (a new key) at the rig's clock. Returns the re-keyed text and M's lines.
 */
async function removalWithOldKeyLines(r: Rig, upsert: { name: string; value: string }[], lineTime: number) {
  const setId = await createdSet(r);
  const m = generateDeviceKeys(random);
  const removed = generateDeviceKeys(random);
  await addMember(r, setId, m, 'Ben Okafor · Pixel 9');
  await addMember(r, setId, removed, 'Lucía Ortiz · Pixel 7a');
  const lines = memberLines(r.agent.sets.get(setId)!.text, m, upsert, lineTime, random);
  await r.engine.removeMember(setId, removed.deviceId);
  const epochTwo = r.agent.sets.get(setId)!.text;
  assert.equal(fileOf(epochTwo).header.epoch, 2);
  return { setId, epochTwo, lines };
}

describe('ENV-08 (regression): a take-over on a restored phone does not sign a deleted variable back in', () => {
  it('becoming owner of a file whose tombstone was swapped for the old value line does not make it current', async () => {
    const r = await rig({ open: false });
    const { phrase } = phraseOn(r, random);
    r.vault.state = 'open';
    await r.engine.vaultChanged();
    const setId = await createdSet(r, [
      { name: 'API_KEY', value: 'sk_live_1' },
      { name: 'OLD_TOKEN', value: 'leaked-and-revoked' },
    ]);
    const oldTokenLine = valueLineOf(r.agent.sets.get(setId)!.text, 'OLD_TOKEN');
    await r.engine.deleteVariable(setId, 'OLD_TOKEN');
    // Same key as the deletion: the swapped line verifies on any device that has no memory of the set.
    const crafted = withLine(r.agent.sets.get(setId)!.text, 'OLD_TOKEN', oldTokenLine);

    // The phone is lost; the new phone, restored with the phrase, reads the set on a computer whose
    // clone has the real history (the deletion commit) with the crafted commit on top.
    const restored = await rig({ seed: 'restored-08' });
    restored.vault.vault = r.vault.vault;
    for (const text of r.agent.sets.get(setId)!.history) restored.agent.put(setId, 'acme-api', text);
    restored.agent.put(setId, 'acme-api', crafted);
    await restored.engine.sync();
    const outcome = await restored.engine.becomeOwner(setId, phrase.split(' ')).then(
      () => 'taken',
      (err: Error) => err.message,
    );

    // The crafted file is the attacker's: what matters is whether this phone signed anything over it.
    const now = restored.agent.sets.get(setId)!.text;
    assert.equal(now, crafted, `the take-over wrote a file over the crafted one (${outcome}); OLD_TOKEN live in it: ${liveNames(now).includes('OLD_TOKEN')}`);
    assert.notEqual(restored.engine.snapshot().sets.find((s) => s.id === setId)?.role, 'owner');
  });
});

describe("ENV-09 (regression): the owner's old-key review is bound to the names it showed", () => {
  it('Keep keeps only the names the owner reviewed', async () => {
    const r = await rig();
    const { setId, epochTwo, lines } = await removalWithOldKeyLines(
      r,
      [
        { name: 'API_KEY', value: 'sk_from_ben' },
        { name: 'NEW_X', value: 'never-reviewed' },
      ],
      r.clock.now,
    );
    const [apiLine, newXLine] = lines as [string, string];
    r.agent.put(setId, 'acme-api', withLine(epochTwo, 'API_KEY', apiLine));
    await r.engine.sync();
    assert.deepEqual(reviewedNames(r, setId), ['API_KEY'], 'the review lists API_KEY only');

    // While the review is open, the computer adds another old-key line.
    r.agent.put(setId, 'acme-api', withLine(r.agent.sets.get(setId)!.text, 'NEW_X', newXLine));
    const before = r.agent.sets.get(setId)!.history.length;
    await r.engine.fixOldKeyLines(setId, true, reviewedNames(r, setId)).catch(() => undefined);
    // Any file the phone wrote after the review: none may carry NEW_X re-keyed under the new key.
    const written = r.agent.sets.get(setId)!.history.slice(before);
    const signedNew = written.some((text) => {
      const checked = verifyEnvFile(text, null);
      return checked.ok && checked.set.live.some((line) => line.name === 'NEW_X');
    });
    assert.equal(signedNew, false, 'Keep re-keyed and signed NEW_X, which the review never showed');
  });
});

describe('ENV-10 (regression): the rotate list after Keep covers every old-key value', () => {
  it('a new variable boxed under the old key before the removal is listed to rotate', async () => {
    const r = await rig();
    // Ben added NEW_SECRET offline (or with a clock behind) under the old key; it reaches the
    // computer after Lucía's removal. Lucía holds the old key and the repo keeps the box.
    const { setId, epochTwo, lines } = await removalWithOldKeyLines(r, [{ name: 'NEW_SECRET', value: 'sk_new' }], r.clock.now - 60_000);
    const text = withLine(epochTwo, 'NEW_SECRET', lines[0]!);
    r.agent.put(setId, 'acme-api', text);
    await r.engine.sync();
    assert.deepEqual(reviewedNames(r, setId), ['NEW_SECRET']);

    const { rotate } = await r.engine.fixOldKeyLines(setId, true, ['NEW_SECRET']);
    assert.ok(rotate.includes('NEW_SECRET'), `rotate was [${rotate.join(', ')}]; the removed device can read NEW_SECRET from the repo with its old key`);
  });
});

describe('ENV-11 (regression): a take-over keeps no member a file lists', () => {
  async function forgedTakeOver(ownerIsVaultDevice: boolean) {
    const restored = await rig({ seed: `restored-11-${ownerIsVaultDevice}` });
    const { phrase, keys: recovery } = phraseOn(restored, random);
    // The recovery identity's public keys are in every set file the owner made. Mallory builds a set
    // at the real path, wrapped to that identity, with an owner key and a tablet of hers as a member.
    const mallory = generateDeviceKeys(random);
    const malloryTablet = generateDeviceKeys(random);
    // Worst case for this test: the owner key passes the vault-device check (ENV-14) as well.
    if (ownerIsVaultDevice) addVaultDevice(restored.vault.vault!, mallory.deviceId);
    const forged = externalSet(mallory, random, { members: [malloryTablet], recovery });
    restored.agent.put(forged.setId, 'acme-api', forged.text);
    await restored.engine.sync();
    const outcome = await restored.engine.becomeOwner(forged.setId, phrase.split(' ')).then(() => 'taken', () => 'refused');
    return { restored, forged, malloryTablet, outcome };
  }

  it("an owner that was never a device of this vault is refused, and the file is left as it was", async () => {
    const { restored, forged, outcome } = await forgedTakeOver(false);
    assert.equal(outcome, 'refused');
    assert.equal(restored.agent.sets.get(forged.setId)!.text, forged.text);
  });

  it("the recovery phrase does not hand the new key to a device the file listed", async () => {
    const { restored, forged, malloryTablet, outcome } = await forgedTakeOver(true);
    assert.equal(outcome, 'taken');
    const written = fileOf(restored.agent.sets.get(forged.setId)!.text);
    let malloryReads = true;
    try {
      openEnvDataKey(written.header, malloryTablet);
    } catch {
      malloryReads = false;
    }
    assert.equal(malloryReads, false, "the take-over sealed the new key to Mallory's tablet, which the phone never showed or approved");
  });
});

describe("ENV-12 (regression): a teammate's pin needs the owner's words confirmed", () => {
  it("a set forged before the teammate asked is not adopted until the teammate confirms the owner's key words", async () => {
    const chen = await rig({ seed: 'chen-12', personName: 'Chen Wei' });
    const mallory = generateDeviceKeys(random);
    const forged = externalSet(mallory, random, { values: [{ name: 'API_KEY', value: 'sk_mallory' }] });
    chen.agent.put(forged.setId, 'acme-api', forged.text);
    await chen.engine.sync();
    ask(chen, joinKeysRequest(chen.agent, 'jk-12', forged.setId));
    await chen.engine.answer('jk-12', 'approve');

    const withChen = addEnvMember({
      file: forged.file,
      owner: mallory,
      dataKeys: { 1: forged.dataKey },
      time: 3_000,
      member: { edPublic: chen.device.edPublic, xPublic: chen.device.xPublic, label: 'Chen Wei · Pixel 8', form: 'phone' },
    });
    chen.agent.put(forged.setId, 'acme-api', writeEnvFile(withChen));
    await chen.engine.sync();
    const view = chen.engine.snapshot().sets.find((s) => s.id === forged.setId);
    assert.notEqual(view?.role, 'member', "Chen's phone joined Mallory's set; no screen showed him the owner's key words to compare");
  });
});
