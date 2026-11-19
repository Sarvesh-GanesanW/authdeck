/**
 * "Allow for 15 minutes": runs inside the grant need no phone, a grant covers one set file, and
 * every way a grant ends tells the watching phones and the desktop app why.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { CLOCK_JUMP_MS, GRANT_CHECK_MS } from '../../src/env/grants';
import { ENV_GRANT_MS, type EnvGrantEndReason } from '../../src/protocol';
import type { LinkedDevice } from '../helpers/link';
import {
  callSocket,
  makeRepo,
  makeSet,
  nthEvent,
  oneTimeKey,
  openReleased,
  phoneRelease,
  releaseParams,
  removeTemps,
  startEnvAgent,
  VALUES,
  type Repo,
  type TestAgent,
  type TestSet,
} from './harness';

after(removeTemps);

async function openGrant(agent: TestAgent, set: TestSet, repo: Repo, phone: LinkedDevice) {
  const asked = phone.events.filter((e) => e.event === 'env.request').length;
  const key = oneTimeKey();
  const call = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, key.xPublic));
  const { request } = await nthEvent(phone, 'env.request', asked);
  const answered = await phone.request('env.request.answer', { requestId: request.requestId, answer: phoneRelease(set, request, 'grant') });
  assert.equal(answered.ok, true, JSON.stringify(answered.error));
  const reply = await call.reply;
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return { reply, key, request };
}

/** The ended grant in the last env.grants.changed a phone got. */
async function endedOn(phone: LinkedDevice) {
  for (let tries = 0; tries < 100; tries++) {
    const ended = phone.events.filter((e) => e.event === 'env.grants.changed' && e.data.ended).at(-1);
    if (ended) return ended.data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('no grant ended');
}

describe('env grants', () => {
  let agent: TestAgent;
  let set: TestSet;
  let repo: Repo;
  let pixel: LinkedDevice;

  beforeEach(async () => {
    agent = await startEnvAgent();
    set = makeSet();
    repo = makeRepo(set);
    pixel = await agent.phone('Pixel 8', [set.owner.deviceId]);
  });
  afterEach(() => agent.stop());

  it('opens a grant on Allow for 15 minutes and releases inside it without asking, each run under its own request id', async () => {
    const { reply, key, request } = await openGrant(agent, set, repo, pixel);
    assert.equal(reply.result.via, 'new-grant');
    assert.equal(reply.result.grantEndsAt, agent.clock.wall + ENV_GRANT_MS);
    assert.deepEqual(openReleased(reply.result, set.setId, key), VALUES);
    const [grant] = agent.env.grants();
    assert.ok(grant);
    assert.equal(grant.path, repo.setPath);
    assert.equal(grant.by, 'Pixel 8');
    const opened = await nthEvent(pixel, 'env.grants.changed');
    assert.equal(opened.grants.length, 1);

    const second = oneTimeKey();
    const run = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, second.xPublic, { command: ['npm', 'test'] }));
    const inside = await run.reply;
    assert.equal(inside.ok, true, JSON.stringify(inside));
    assert.equal(inside.result.via, 'grant');
    assert.notEqual(inside.result.requestId, request.requestId, 'every run is sealed under a new request id');
    assert.deepEqual(openReleased(inside.result, set.setId, second), VALUES);
    assert.throws(() => openReleased({ ...inside.result, requestId: request.requestId }, set.setId, second), 'a bundle opens only under its own request');
    assert.equal(pixel.events.filter((e) => e.event === 'env.request').length, 1, 'no phone was asked inside the grant');
    assert.deepEqual(agent.env.grants()[0]?.uses, ['npm test', 'npm run dev']);
    const rows = agent.envEvents.filter((event) => event.type === 'env.activity').map((event: any) => event.entry.outcome.text);
    assert.deepEqual(rows, ['Allowed for 15 min on Pixel 8', 'Inside the 15-min grant']);
  });

  it('covers one set file: a second clone of the same set asks again', async () => {
    await openGrant(agent, set, repo, pixel);
    const clone = makeRepo(set);
    const call = callSocket(agent.socketPath, 'release', releaseParams(clone, set.text, oneTimeKey().xPublic));
    const { request } = await nthEvent(pixel, 'env.request', 1);
    assert.equal(request.path, clone.setPath);
    await pixel.request('env.request.answer', { requestId: request.requestId, answer: { kind: 'deny' } });
    assert.equal((await call.reply).error.code, 'denied');
  });

  it('never opens a grant for a push', async () => {
    const call = callSocket(agent.socketPath, 'push', {
      project: { repoRoot: repo.root, remote: null, path: repo.setPath },
      file: set.text,
      source: '.env.local',
      values: VALUES,
      prune: false,
      invocation: 'authdeck env push .env.local',
    });
    const { request } = await nthEvent(pixel, 'env.request');
    const answer = await pixel.request('env.request.answer', { requestId: request.requestId, answer: { kind: 'release', scope: 'grant', values: { key: { e: 'a', r: 'b', ct: 'c' }, box: { epoch: 0, n: 'n', ct: 'c', c: 'c' } }, source: { rev: 1, fileHash: 'x' } } });
    assert.equal(answer.error?.code, 'bad_request');
    call.close();
    assert.deepEqual(agent.env.grants(), []);
  });

  const endings: { reason: EnvGrantEndReason; end: (agent: TestAgent, grantId: string, repo: Repo) => Promise<void> | void }[] = [
    {
      reason: 'expired',
      end: (agent) => {
        agent.clock.advance(ENV_GRANT_MS);
        agent.env.checkGrants();
      },
    },
    { reason: 'ended-on-device', end: async () => {} },
    { reason: 'ended-on-computer', end: (agent, grantId) => assert.equal(agent.env.endGrant(grantId), true) },
    { reason: 'computer-locked', end: (agent) => agent.env.endAllGrants('computer-locked') },
    { reason: 'computer-slept', end: (agent) => agent.env.endAllGrants('computer-slept') },
    {
      reason: 'clock-jumped',
      end: (agent) => {
        // Asleep: the wall clock moved, the process clock didn't.
        agent.clock.wall += CLOCK_JUMP_MS + 1_000;
        agent.env.checkGrants();
      },
    },
    {
      reason: 'set-changed',
      end: (agent, _grantId, repo) => {
        fs.appendFileSync(repo.setPath, '# a pull brought a change\n');
        agent.env.checkGrants();
      },
    },
    { reason: 'unpaired', end: (agent) => agent.unpair('Pixel 8') },
  ];

  for (const { reason, end } of endings) {
    it(`ends a grant with ${reason}, telling watching phones and the desktop app`, async () => {
      const watcher = await agent.phone('iPad mini', [set.owner.deviceId]);
      await openGrant(agent, set, repo, pixel);
      const grantId = agent.env.grants()[0]!.grantId;
      if (reason === 'ended-on-device') assert.equal((await pixel.request('env.grant.end', { grantId })).ok, true);
      else await end(agent, grantId, repo);
      assert.deepEqual(agent.env.grants(), []);
      const changed = await endedOn(watcher);
      assert.deepEqual(changed, { grants: [], ended: { grantId, setId: set.setId, reason } });
      const desktop = agent.envEvents.filter((event) => event.type === 'env.grants.changed').at(-1);
      assert.deepEqual(desktop, { type: 'env.grants.changed', grants: [], ended: { grantId, setId: set.setId, reason } });
    });
  }

  it('ends grants when the periodic check comes late (the process clock ran through a sleep)', async () => {
    await openGrant(agent, set, repo, pixel);
    agent.env.checkGrants();
    agent.clock.advance(GRANT_CHECK_MS + CLOCK_JUMP_MS + 1_000);
    agent.env.checkGrants();
    assert.equal((await endedOn(pixel)).ended.reason, 'clock-jumped');
  });

  it('keeps a grant through ordinary time passing', async () => {
    await openGrant(agent, set, repo, pixel);
    for (let elapsed = 0; elapsed < ENV_GRANT_MS - GRANT_CHECK_MS; elapsed += GRANT_CHECK_MS) {
      agent.clock.advance(GRANT_CHECK_MS);
      agent.env.checkGrants();
    }
    assert.equal(agent.env.grants().length, 1);
  });

  it('ends the grant and asks again when the command reads a different file', async () => {
    await openGrant(agent, set, repo, pixel);
    const changed = `${set.text}# edited\n`;
    fs.writeFileSync(repo.setPath, changed);
    const call = callSocket(agent.socketPath, 'release', releaseParams(repo, changed, oneTimeKey().xPublic));
    const { request } = await nthEvent(pixel, 'env.request', 1);
    assert.equal((await endedOn(pixel)).ended.reason, 'set-changed');
    await pixel.request('env.request.answer', { requestId: request.requestId, answer: { kind: 'deny' } });
    assert.equal((await call.reply).error.code, 'denied');
  });

  it('answers not_found to End now for a grant that already ended', async () => {
    const reply = await pixel.request('env.grant.end', { grantId: 'no-such-grant' });
    assert.equal(reply.error?.code, 'not_found');
    assert.equal(agent.env.endGrant('no-such-grant'), false);
  });

  it('keeps nothing across a restart: the next run asks again', async () => {
    await openGrant(agent, set, repo, pixel);
    const home = agent.home;
    await agent.stop();
    agent = await startEnvAgent({ home });
    assert.deepEqual(agent.env.grants(), []);
    pixel = await agent.phone('Pixel 8', [set.owner.deviceId]);
    const call = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic));
    const { request } = await nthEvent(pixel, 'env.request');
    await pixel.request('env.request.answer', { requestId: request.requestId, answer: { kind: 'deny' } });
    assert.equal((await call.reply).error.code, 'denied');
  });
});
