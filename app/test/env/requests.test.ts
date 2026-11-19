// Answering a computer's env requests on the phone: create, run/pull (once and grant), push,
// join-keys and deny, with the vault locked and open, and requests that end elsewhere.
import '../native';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { envKeyWords, newEnvTransferKey, openEnvSealedValues, verifyEnvFile } from '../../src/envcore';
import { ENDED_KEEP_MS } from '../../src/auth/env/engine';
import { COMPUTER, ask, disposeAll, createRequest, createdSet, joinKeysRequest, pushRequest, releaseRequest, rig, settle } from './fakes';

afterEach(disposeAll);

describe('create', () => {
  it('a locked vault shows only who asks; approving unlocks first, makes the set and keeps it as owner', async () => {
    const r = await rig({ open: false });
    ask(r, createRequest(r.agent, 'c1', [{ name: 'API_KEY', value: 'sk_1' }]));
    const view = r.engine.snapshot().incoming[0]!;
    assert.equal(view.needsUnlock, true);
    assert.equal(view.kind, 'create');
    assert.equal(view.file, null);
    assert.equal(view.variableCount, 1);

    await r.engine.answer('c1', 'approve');
    assert.equal(r.vault.confirms.length, 1);
    const answer = r.agent.answers.get('c1');
    assert.equal(answer?.kind, 'created');
    const set = r.engine.snapshot().sets[0]!;
    assert.equal(set.role, 'owner');
    assert.equal(set.variableCount, 1);
    assert.equal(set.ownerLabel, 'Maya Rao · Pixel 8');
    assert.equal(r.engine.snapshot().incoming.length, 0);
    assert.equal(await r.engine.reveal(set.id, 'API_KEY'), 'sk_1');
  });

  it('a cancelled device unlock answers nothing', async () => {
    const r = await rig();
    r.vault.cancel = 'Unlock was cancelled.';
    ask(r, createRequest(r.agent, 'c1', []));
    await assert.rejects(r.engine.answer('c1', 'approve'), /Unlock was cancelled/);
    assert.equal(r.agent.answers.size, 0);
    assert.equal(r.engine.snapshot().incoming.length, 1);
  });

  it('the wrong answer for the kind is refused', async () => {
    const r = await rig();
    ask(r, createRequest(r.agent, 'c1', []));
    await assert.rejects(r.engine.answer('c1', 'once'), /doesn't fit/);
  });
});

describe('run and pull', () => {
  it('Allow once seals the values to the one-time key, for this request only', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const oneTime = newEnvTransferKey(r.random);
    const grant = newEnvTransferKey(r.random);
    ask(r, releaseRequest(r.agent, 'run-1', setId, { oneTime: oneTime.xPublic, grant: grant.xPublic }));
    const view = r.engine.snapshot().incoming[0]!;
    assert.equal(view.command, 'npm run dev');
    assert.equal(view.variableCount, 2);
    assert.equal(view.file, '.authdeck/acme-api.env');
    assert.equal(view.problem, null);

    const result = await r.engine.answer('run-1', 'once');
    assert.deepEqual(result, { changes: null });
    const answer = r.agent.answers.get('run-1');
    assert.ok(answer?.kind === 'release' && answer.scope === 'once');
    const values = openEnvSealedValues(answer.values, { set: setId, request: 'run-1' }, oneTime);
    assert.deepEqual(values, [{ name: 'API_KEY', value: 'sk_live_1' }, { name: 'DB_URL', value: 'postgres://db' }]);
    assert.throws(() => openEnvSealedValues(answer.values, { set: setId, request: 'run-1' }, grant));
    assert.throws(() => openEnvSealedValues(answer.values, { set: setId, request: 'run-2' }, oneTime));
    assert.ok(r.engine.snapshot().sets[0]!.lastReleasedAt);
  });

  it('Allow for 15 minutes seals to the grant key', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const oneTime = newEnvTransferKey(r.random);
    const grant = newEnvTransferKey(r.random);
    ask(r, releaseRequest(r.agent, 'run-1', setId, { oneTime: oneTime.xPublic, grant: grant.xPublic }));
    await r.engine.answer('run-1', 'grant');
    const answer = r.agent.answers.get('run-1');
    assert.ok(answer?.kind === 'release' && answer.scope === 'grant');
    assert.equal(openEnvSealedValues(answer.values, { set: setId, request: 'run-1' }, grant).length, 2);
  });

  it('with app lock on, an open vault still asks for the device unlock before releasing', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const before = r.vault.confirms.length;
    const keys = { oneTime: newEnvTransferKey(r.random).xPublic, grant: newEnvTransferKey(r.random).xPublic };
    ask(r, releaseRequest(r.agent, 'run-1', setId, keys));
    await r.engine.answer('run-1', 'once');
    assert.equal(r.vault.confirms.length, before + 1);
  });

  it('a locked vault: needsUnlock, and Deny answers without unlocking', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    r.vault.state = 'locked';
    await r.engine.vaultChanged();
    const before = r.vault.confirms.length;
    const keys = { oneTime: newEnvTransferKey(r.random).xPublic, grant: newEnvTransferKey(r.random).xPublic };
    ask(r, releaseRequest(r.agent, 'pull-1', setId, keys));
    assert.equal(r.engine.snapshot().incoming[0]!.needsUnlock, true);
    assert.equal(r.engine.snapshot().status, 'locked');
    await r.engine.answer('pull-1', 'deny');
    assert.deepEqual(r.agent.answers.get('pull-1'), { kind: 'deny' });
    assert.equal(r.vault.confirms.length, before);
    assert.equal(r.vault.state, 'locked');
    assert.equal(r.engine.snapshot().incoming.length, 0);
  });

  it('a locked vault unlocks inside answer, then releases', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    r.vault.state = 'locked';
    await r.engine.vaultChanged();
    const oneTime = newEnvTransferKey(r.random);
    ask(r, releaseRequest(r.agent, 'run-1', setId, { oneTime: oneTime.xPublic, grant: newEnvTransferKey(r.random).xPublic }));
    await r.engine.answer('run-1', 'once');
    assert.equal(r.engine.snapshot().status, 'open');
    const answer = r.agent.answers.get('run-1');
    assert.ok(answer?.kind === 'release');
    assert.equal(openEnvSealedValues(answer.values, { set: setId, request: 'run-1' }, oneTime).length, 2);
  });
});

describe('push', () => {
  it('shows the changes by name, signs them, and returns them', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    ask(r, pushRequest(r.agent, 'push-1', setId, [{ name: 'API_KEY', value: 'sk_live_2' }, { name: 'NEW_ONE', value: 'x' }], true));
    await settle();
    const view = r.engine.snapshot().incoming[0]!;
    assert.deepEqual(view.changes, [
      { name: 'API_KEY', change: 'change', loadsCode: false },
      { name: 'NEW_ONE', change: 'add', loadsCode: false },
      { name: 'DB_URL', change: 'remove', loadsCode: false },
    ]);
    assert.equal(r.engine.pushedValue('push-1', 'NEW_ONE'), 'x');

    const result = await r.engine.answer('push-1', 'approve');
    assert.deepEqual(new Set(result.changes!.map((c) => `${c.change}:${c.name}`)), new Set(['change:API_KEY', 'add:NEW_ONE', 'remove:DB_URL']));
    const answer = r.agent.answers.get('push-1');
    assert.ok(answer?.kind === 'signed');
    assert.deepEqual(answer.changed, ['API_KEY']);
    assert.deepEqual(answer.added, ['NEW_ONE']);
    assert.deepEqual(answer.removed, ['DB_URL']);
    assert.ok(verifyEnvFile(answer.file, null).ok);
    assert.equal(await r.engine.reveal(setId, 'API_KEY'), 'sk_live_2');
    assert.deepEqual(r.engine.detail(setId)!.variables.map((v) => v.name), ['API_KEY', 'NEW_ONE']);
  });
});

describe('push against a set that changed under the sheet', () => {
  it('refuses to sign a plan other than the one shown, and leaves the request open with the new plan', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    ask(r, pushRequest(r.agent, 'push-2', setId, [{ name: 'API_KEY', value: 'sk_live_1' }, { name: 'DB_URL', value: 'postgres://db' }, { name: 'NODE_OPTIONS', value: '--x' }], false));
    await settle();
    assert.deepEqual(r.engine.snapshot().incoming[0]!.changes, [{ name: 'NODE_OPTIONS', change: 'add', loadsCode: true }]);
    // Another device changes API_KEY on the computer before this one approves.
    await r.engine.saveVariable(setId, { name: 'API_KEY', value: 'sk_live_9' });
    await assert.rejects(r.engine.answer('push-2', 'approve'), /Check the changes again/);
    assert.equal(r.agent.answers.has('push-2'), false);
    const plan = r.engine.snapshot().incoming[0]!.changes!.map((c) => `${c.change}:${c.name}`);
    assert.deepEqual(plan.sort(), ['add:NODE_OPTIONS', 'change:API_KEY']);
    await r.engine.answer('push-2', 'approve');
    assert.equal(r.agent.answers.get('push-2')?.kind, 'signed');
  });
});

describe('join-keys', () => {
  it('signs a request with this device and remembers the six key words', async () => {
    const owner = await rig({ seed: 'owner' });
    const setId = await createdSet(owner);
    const r = await rig({ seed: 'teammate' });
    r.agent.put(setId, 'acme-api', owner.agent.sets.get(setId)!.text);
    ask(r, joinKeysRequest(r.agent, 'jk-1', setId));
    await r.engine.answer('jk-1', 'approve');
    const answer = r.agent.answers.get('jk-1');
    assert.ok(answer?.kind === 'join-keys');
    assert.equal(answer.request.member, r.device.deviceId);
    const own = r.engine.snapshot().ownRequests;
    assert.equal(own.length, 1);
    assert.deepEqual(own[0]!.keyWords, envKeyWords(r.device.edPublic, r.device.xPublic));
  });
});

describe('requests that end elsewhere', () => {
  it('env.request.closed moves the request to ended, until dismissed', async () => {
    const r = await rig();
    ask(r, createRequest(r.agent, 'c1', []));
    r.engine.handleEvent({ event: 'env.request.closed', data: { requestId: 'c1', reason: 'answered', by: 'iPad mini' } });
    const snapshot = r.engine.snapshot();
    assert.equal(snapshot.incoming.length, 0);
    assert.equal(snapshot.ended.length, 1);
    assert.deepEqual({ ...snapshot.ended[0]!, endedAt: 0 }, { id: 'c1', reason: 'answered', by: 'iPad mini', endedAt: 0 });
    r.engine.dismissEnded('c1');
    assert.equal(r.engine.snapshot().ended.length, 0);
    assert.ok(ENDED_KEEP_MS >= 30_000);
    r.engine.dispose();
  });

  it('answering a request the agent already closed says it ended', async () => {
    const r = await rig();
    ask(r, createRequest(r.agent, 'c1', []));
    r.agent.pending = [];
    await assert.rejects(r.engine.answer('c1', 'approve'), /already ended/);
    assert.equal(r.engine.snapshot().incoming.length, 0);
  });

  it('env.grants.changed shows the grant on its set', async () => {
    const r = await rig();
    const setId = await createdSet(r);
    const grant = { grantId: 'g1', setId, setName: 'acme-api', path: '/x', startedAt: 1, endsAt: 2, by: 'Pixel 8', uses: ['npm run dev'] };
    r.engine.handleEvent({ event: 'env.grants.changed', data: { grants: [grant] } });
    assert.deepEqual(r.engine.snapshot().sets[0]!.grant, { grantId: 'g1', computerName: COMPUTER.name, endsAt: 2, by: 'Pixel 8', usedBy: ['npm run dev'] });
    await r.engine.endGrant(setId);
    assert.ok(r.agent.methods().includes('env.grant.end'));
  });
});
