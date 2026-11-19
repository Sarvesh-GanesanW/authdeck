// Who is in a set, from the phone: a teammate's repo request, an own device's check-code join
// (both sides), removal with a new key, being removed, taking a set over with the owner's phrase,
// and a 0.3 agent that never hears env.*.
import '../native';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  addEnvMember,
  checkEnvJoined,
  createEnvJoinRequest,
  envApproverCheckCode,
  envKeyWords,
  envNewDeviceCheckCode,
  envRecoveryKeys,
  openEnvDataKey,
  removeEnvMember,
  verifyEnvFile,
  writeEnvFile,
  writeEnvJoinRequest,
  type EnvSetFile,
} from '../../src/envcore';
import type { VaultJoinChallenge, VaultJoinRequest } from '../../src/protocol';
import { createJoinChallenge, createJoinRequest, createJoinReveal } from '../../src/vault/approval';
import { generateDeviceKeys } from '../../src/vault/crypto';
import { generateRecoveryPhrase } from '../../src/vault/recovery';
import { seededRandom } from '../helpers';
import { OLD_COMPUTER, ask, createRequest, createdSet, disposeAll, externalSet, rig, settle, joinedThrough, addVaultDevice } from './fakes';

afterEach(disposeAll);

const otherRandom = seededRandom('others');

function fileOf(text: string): EnvSetFile {
  const verified = verifyEnvFile(text, null);
  if (!verified.ok) throw new Error(`refused: ${verified.problem.kind}`);
  return verified.set.file;
}

describe("a teammate's request in the repo", () => {
  it('shows the six key words, and approving adds them and removes the request file in one write', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const teammate = generateDeviceKeys(otherRandom);
    const request = createEnvJoinRequest({ set: setId, device: teammate, label: 'Chen Wei · iPhone 16', form: 'phone', time: 5 });
    r.agent.addJoinRequest(setId, request, writeEnvJoinRequest(request));
    await r.engine.sync();

    const [view] = r.engine.snapshot().joinRequests;
    assert.equal(view?.via, 'teammate');
    assert.equal(view?.label, 'Chen Wei · iPhone 16');
    assert.deepEqual(view?.keyWords, envKeyWords(teammate.edPublic, teammate.xPublic));
    assert.equal(view?.needsUnlock, false);
    assert.equal(r.engine.snapshot().sets[0]!.joinRequestCount, 1);

    await r.engine.approveJoin(view!.id);
    const written = fileOf(r.agent.sets.get(setId)!.text);
    assert.ok(written.header.members.some((m) => m.id === teammate.deviceId));
    assert.deepEqual(r.agent.sets.get(setId)!.requests, []);
    assert.doesNotThrow(() => openEnvDataKey(written.header, teammate));
    assert.equal(r.engine.snapshot().joinRequests.length, 0);
  });

  it('declining removes only the request file', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const before = r.agent.sets.get(setId)!.text;
    const request = createEnvJoinRequest({ set: setId, device: generateDeviceKeys(otherRandom), label: 'Chen', form: null, time: 5 });
    r.agent.addJoinRequest(setId, request, writeEnvJoinRequest(request));
    await r.engine.sync();
    await r.engine.declineJoin(r.engine.snapshot().joinRequests[0]!.id);
    assert.equal(r.agent.sets.get(setId)!.text, before);
    assert.deepEqual(r.agent.sets.get(setId)!.requests, []);
  });

  it('a request file with a bad signature is not shown', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const request = createEnvJoinRequest({ set: setId, device: generateDeviceKeys(otherRandom), label: 'Chen', form: null, time: 5 });
    r.agent.addJoinRequest(setId, request, writeEnvJoinRequest({ ...request, label: 'Mallory' }));
    await r.engine.sync();
    assert.equal(r.engine.snapshot().joinRequests.length, 0);
  });
});

describe('own-device join', () => {
  it('owner: answers, shows the same code as the new device, and adds exactly the keys it checked', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const newDevice = generateDeviceKeys(otherRandom);
    const { request, nonce } = createJoinRequest(newDevice, 'Maya Rao · iPad mini', otherRandom);
    r.engine.handleEvent({ event: 'env.join.requested', data: { requestId: 'j1', setId, request, fromDevice: 'iPad mini', expiresAt: Date.now() + 300_000 } });
    const offered = r.engine.snapshot().joinRequests[0]!;
    assert.equal(offered.via, 'own-device');
    assert.equal(offered.code, null);

    await r.engine.acceptOwnDeviceJoin('j1');
    const challenge = r.agent.calls.find((c) => c.method === 'env.join.challenge')!.params as { challenge: VaultJoinChallenge };
    assert.equal(challenge.challenge.vault, setId);
    const newDeviceCode = envNewDeviceCheckCode(request, nonce, challenge.challenge);
    r.engine.handleEvent({ event: 'env.join.revealed', data: { requestId: 'j1', reveal: createJoinReveal(nonce) } });
    assert.equal(r.engine.snapshot().joinRequests[0]!.code, newDeviceCode);

    await r.engine.approveJoin('j1');
    const written = fileOf(r.agent.sets.get(setId)!.text);
    assert.equal(checkEnvJoined(written, newDevice, challenge.challenge).status, 'ok');
    assert.deepEqual(r.agent.calls.at(-1), { method: 'env.join.finish', params: { requestId: 'j1', approved: true } });
  });

  it('owner: a reveal that does not match the commitment ends the join without a code', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const { request } = createJoinRequest(generateDeviceKeys(otherRandom), 'iPad', otherRandom);
    r.engine.handleEvent({ event: 'env.join.requested', data: { requestId: 'j1', setId, request, fromDevice: 'iPad', expiresAt: Date.now() + 300_000 } });
    await r.engine.acceptOwnDeviceJoin('j1');
    r.engine.handleEvent({ event: 'env.join.revealed', data: { requestId: 'j1', reveal: createJoinReveal(new Uint8Array(16)) } });
    assert.equal(r.engine.snapshot().joinRequests.length, 0);
    assert.ok(r.agent.methods().includes('env.join.cancel'));
  });

  it('new device: asks, compares the code, and keeps the set once the owner added it', async () => {
    const owner = generateDeviceKeys(otherRandom);
    const r = await rig();
    const made = externalSet(owner, otherRandom);
    r.agent.put(made.setId, 'acme-api', made.text);
    await r.engine.sync();
    assert.equal(r.engine.snapshot().sets[0]!.role, 'outside');

    await r.engine.requestJoin(made.setId);
    const sent = r.agent.calls.find((c) => c.method === 'env.join.request')!.params as { request: VaultJoinRequest };
    const requestId = 'join-1';
    const { challenge } = createJoinChallenge(owner, { vaultId: made.setId, vaultName: 'acme-api', deviceName: 'Ben Okafor · Pixel 9' }, otherRandom);
    r.engine.handleEvent({ event: 'env.join.challenged', data: { requestId, challenge } });
    await settle();
    const reveal = (r.agent.calls.find((c) => c.method === 'env.join.reveal')!.params as { reveal: { nonce: string } }).reveal;
    const ownerCode = envApproverCheckCode(sent.request, challenge, reveal);
    assert.equal(r.engine.snapshot().join?.code, ownerCode);
    assert.equal(r.engine.snapshot().join?.stage, 'compare');

    const added = addEnvMember({
      file: made.file,
      owner,
      dataKeys: { 1: made.dataKey },
      time: 9,
      member: { edPublic: r.device.edPublic, xPublic: r.device.xPublic, label: sent.request.name, form: null },
    });
    r.agent.put(made.setId, 'acme-api', writeEnvFile(added));
    r.engine.handleEvent({ event: 'env.join.finished', data: { requestId, approved: true } });
    await settle();
    assert.equal(r.engine.snapshot().join?.stage, 'done');
    assert.equal(r.engine.snapshot().sets[0]!.role, 'member');
    assert.equal(await r.engine.reveal(made.setId, 'API_KEY'), 'sk_live_1');
    r.engine.cancelJoin();
    assert.equal(r.engine.snapshot().join, null);
  });
});

describe('removing a member', () => {
  it('makes a new key, encrypts every value again, and lists the names to rotate', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const other = generateDeviceKeys(otherRandom);
    const current = fileOf(r.agent.sets.get(setId)!.text);
    const withOther = addEnvMember({
      file: current,
      owner: r.device,
      dataKeys: { 1: r.store.keys.get(setId)![1]! },
      time: 7,
      member: { edPublic: other.edPublic, xPublic: other.xPublic, label: 'Lucía Ortiz · Pixel 7a', form: 'phone' },
    });
    r.agent.put(setId, 'acme-api', writeEnvFile(withOther));
    await r.engine.sync();
    assert.equal(r.engine.detail(setId)!.members.length, 2);

    const { rotate } = await r.engine.removeMember(setId, other.deviceId);
    assert.deepEqual(rotate, ['API_KEY', 'DB_URL']);
    const written = fileOf(r.agent.sets.get(setId)!.text);
    assert.equal(written.header.epoch, 2);
    assert.ok(!written.header.members.some((m) => m.id === other.deviceId));
    assert.throws(() => openEnvDataKey(written.header, other));
    assert.equal(await r.engine.reveal(setId, 'DB_URL'), 'postgres://db');
    assert.ok(r.store.keys.get(setId)![2]);
  });

  it('a member that is not the owner may not remove anyone', async () => {
    const owner = generateDeviceKeys(otherRandom);
    const r = await rig();
    const made = externalSet(owner, otherRandom, { members: [r.device] });
    await joinedThrough(r, made.setId, made.text);
    await assert.rejects(r.engine.removeMember(made.setId, owner.deviceId), /owner device/);
  });

  it('a device the owner removed keeps what it saw, read-only, until it deletes it', async () => {
    const owner = generateDeviceKeys(otherRandom);
    const r = await rig();
    const made = externalSet(owner, otherRandom, { members: [r.device] });
    await joinedThrough(r, made.setId, made.text);
    assert.equal(r.engine.snapshot().sets[0]!.role, 'member');

    const removed = removeEnvMember({ file: made.file, owner, dataKeys: { 1: made.dataKey }, time: 9, memberId: r.device.deviceId, random: otherRandom });
    r.agent.put(made.setId, 'acme-api', writeEnvFile(removed.file));
    await r.engine.sync();
    const view = r.engine.snapshot().sets[0]!;
    assert.equal(view.role, 'removed');
    assert.match(view.removedNote ?? '', /Ben Okafor · Pixel 9 removed this device/);
    assert.equal(await r.engine.reveal(made.setId, 'API_KEY'), 'sk_live_1');
    await assert.rejects(r.engine.saveVariable(made.setId, { name: 'API_KEY', value: 'x' }), /removed/);
    await r.engine.deleteRemovedSet(made.setId);
    assert.equal(r.store.sets.has(made.setId), false);
  });
});

describe('becoming the owner with the recovery phrase', () => {
  const VAULT_ID = 'BBBBBBBBBBBBBBBBBBBBBB';

  async function ownedElsewhere() {
    const owner = generateDeviceKeys(otherRandom);
    const phrase = generateRecoveryPhrase(otherRandom);
    const made = externalSet(owner, otherRandom, { recovery: envRecoveryKeys(phrase, VAULT_ID) });
    // The lost phone was a device of the vault the phrase restores.
    addVaultDevice(VAULT_ID, owner.deviceId);
    const r = await rig();
    r.agent.put(made.setId, 'acme-api', made.text);
    await r.engine.sync();
    return { r, made, owner, phrase };
  }

  it('a phone restored with the phrase (same vault id) becomes the owner; other words are refused', async () => {
    const { r, made, owner, phrase } = await ownedElsewhere();
    r.vault.vault = VAULT_ID;
    const wrong = generateRecoveryPhrase(seededRandom('wrong')).split(' ');
    await assert.rejects(r.engine.becomeOwner(made.setId, wrong), /These words don't open acme-api/);
    await assert.rejects(r.engine.becomeOwner(made.setId, ['not', 'a', 'phrase']), /These words don't open/);

    await r.engine.becomeOwner(made.setId, phrase.toUpperCase().split(' '));
    const written = fileOf(r.agent.sets.get(made.setId)!.text);
    assert.equal(written.header.members.find((m) => m.role === 'owner')?.id, r.device.deviceId);
    assert.ok(!written.header.members.some((m) => m.id === owner.deviceId));
    assert.equal(r.engine.snapshot().sets[0]!.role, 'owner');
    assert.equal(await r.engine.reveal(made.setId, 'API_KEY'), 'sk_live_1');
  });

  it('a fresh vault on this phone, even with the same words, is told to restore first', async () => {
    const { r, made, phrase } = await ownedElsewhere();
    r.vault.vault = 'CCCCCCCCCCCCCCCCCCCCCC';
    await assert.rejects(
      r.engine.becomeOwner(made.setId, phrase.split(' ')),
      /These words don't open acme-api\. If you set up a new vault on this phone instead of restoring it, restore your vault with this phrase first\./,
    );
    assert.equal(r.engine.snapshot().sets[0]!.role, 'outside');
  });

  it('a set without a recovery identity says so', async () => {
    const owner = generateDeviceKeys(otherRandom);
    const made = externalSet(owner, otherRandom);
    const r = await rig();
    r.agent.put(made.setId, 'acme-api', made.text);
    await r.engine.sync();
    await assert.rejects(r.engine.becomeOwner(made.setId, generateRecoveryPhrase(otherRandom).split(' ')), /no recovery phrase/);
  });
});

describe('a 0.3 agent without env sets', () => {
  it('gets no env.* call, its events are ignored, and the section asks to update it', async () => {
    const r = await rig({ computer: OLD_COMPUTER });
    assert.deepEqual(r.agent.calls, []);
    assert.equal(r.engine.snapshot().agentTooOld, true);
    ask(r, createRequest(r.agent, 'c1', []));
    assert.equal(r.engine.snapshot().incoming.length, 0);
    await r.engine.sync();
    assert.deepEqual(r.agent.calls, []);
  });
});
