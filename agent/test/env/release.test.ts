/**
 * run and pull over the socket, end to end with fake phones on the real link: who gets the
 * request, the first answer winning, Allow once, deny, no answer (exit 75), and Ctrl-C.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { ENV_EXIT_FOR } from '../../src/envSocketContract';
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

describe('env release over the socket', () => {
  let agent: TestAgent;
  let set: TestSet;
  let repo: Repo;

  beforeEach(async () => {
    agent = await startEnvAgent();
    set = makeSet();
    repo = makeRepo(set);
  });
  afterEach(() => agent.stop());

  it('sends the request to member phones only, and Allow once releases to the command alone', async () => {
    const pixel = await agent.phone('Pixel 8', [set.owner.deviceId]);
    const stranger = await agent.phone('Other phone', ['AAAAAAAAAAAAAAAAAAAAAA']);
    const key = oneTimeKey();
    const call = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, key.xPublic));
    const progress = await call.progress(1);
    assert.deepEqual(progress.progress.devices, ['Pixel 8']);
    const { request } = await nthEvent(pixel, 'env.request');
    assert.equal(request.kind, 'run');
    assert.equal(request.setId, set.setId);
    assert.equal(request.remote, 'github.com/acme/api', 'credentials never leave the computer');
    assert.deepEqual(request.command, ['npm', 'run', 'dev']);
    assert.equal(request.expiresAt - request.askedAt, 5_000);
    assert.notEqual(request.requestId, call.lines[0].id, "the agent picks the link request id, not the command");
    assert.equal(stranger.events.some((e) => e.event === 'env.request'), false, 'a phone holding no member of the set is not asked');

    const answered = await pixel.request('env.request.answer', { requestId: request.requestId, answer: phoneRelease(set, request, 'once') });
    assert.equal(answered.ok, true);
    const reply = await call.reply;
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.result.via, 'once');
    assert.equal(reply.result.by, 'Pixel 8');
    assert.equal(reply.result.grantEndsAt, null);
    assert.equal(reply.result.requestId, request.requestId);
    assert.deepEqual(openReleased(reply.result, set.setId, key), VALUES);
    assert.deepEqual(agent.env.grants(), [], 'Allow once opens no grant');

    const activity = agent.envEvents.find((event) => event.type === 'env.activity');
    assert.ok(activity && activity.type === 'env.activity');
    assert.equal(activity.entry.title, 'Ran with acme-api');
    assert.equal(activity.entry.detail, 'npm run dev · 2 variables');
    assert.equal(activity.entry.outcome.text, 'Allowed once on Pixel 8');
    for (const { value } of VALUES) assert.equal(agent.logLines.join('\n').includes(value), false, 'no value reaches the log');
  });

  it('closes the request on the other phones when one answers, and refuses a late second answer', async () => {
    const pixel = await agent.phone('Pixel 8', [set.owner.deviceId]);
    const ipad = await agent.phone('iPad mini', [set.owner.deviceId]);
    const call = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic));
    await call.progress(2);
    const { request } = await nthEvent(pixel, 'env.request');
    await nthEvent(ipad, 'env.request');
    assert.equal((await pixel.request('env.request.answer', { requestId: request.requestId, answer: { kind: 'deny' } })).ok, true);
    const closed = await nthEvent(ipad, 'env.request.closed');
    assert.deepEqual(closed, { requestId: request.requestId, reason: 'answered', by: 'Pixel 8' });
    const late = await ipad.request('env.request.answer', { requestId: request.requestId, answer: phoneRelease(set, request, 'once') });
    assert.equal(late.error?.code, 'not_found');
    const reply = await call.reply;
    assert.deepEqual(reply.error, { code: 'denied', kind: 'run', set: 'acme-api', by: 'Pixel 8', command: 'npm run dev', target: null });
    assert.equal(ENV_EXIT_FOR[reply.error.code as 'denied'], 77);
  });

  it('keeps waiting after an answer that does not fit, and takes the next good one', async () => {
    const pixel = await agent.phone('Pixel 8', [set.owner.deviceId]);
    const key = oneTimeKey();
    const call = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, key.xPublic));
    const { request } = await nthEvent(pixel, 'env.request');
    const wrongKind = await pixel.request('env.request.answer', { requestId: request.requestId, answer: { kind: 'created', file: set.text } });
    assert.equal(wrongKind.error?.code, 'bad_request');
    // Sealed to the one-time key but claimed as a grant: the agent can't open it.
    const misSealed = { ...phoneRelease(set, request, 'once'), scope: 'grant' };
    assert.equal((await pixel.request('env.request.answer', { requestId: request.requestId, answer: misSealed })).error?.code, 'bad_request');
    assert.equal((await pixel.request('env.request.answer', { requestId: request.requestId, answer: phoneRelease(set, request, 'once') })).ok, true);
    assert.equal((await call.reply).result.via, 'once');
  });

  it('gives a phone that starts watching while a request waits the request, and tells the command', async () => {
    const call = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic));
    const first = await call.progress(0);
    assert.deepEqual(first.progress.devices, [], 'no member device is connected yet');
    const pixel = await agent.phone('Pixel 8');
    const watched = await pixel.request('env.watch', { members: [set.owner.deviceId] });
    assert.equal(watched.result.requests.length, 1);
    assert.equal(watched.result.requests[0].kind, 'run');
    await call.progress(1);
    await pixel.request('env.request.answer', { requestId: watched.result.requests[0].requestId, answer: { kind: 'deny' } });
    assert.equal((await call.reply).error.code, 'denied');
  });

  it('ends with no-answer (exit 75) after the wait, naming the member phones paired here', async () => {
    const short = await startEnvAgent({ requestTtlMs: 200 });
    try {
      const pixel = await short.phone('Pixel 8', [set.owner.deviceId]);
      const call = callSocket(short.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic));
      const { request } = await nthEvent(pixel, 'env.request');
      const reply = await call.reply;
      assert.deepEqual(reply.error, { code: 'no-answer', set: 'acme-api', devices: ['Pixel 8'], waitedSec: 0 });
      assert.equal(ENV_EXIT_FOR['no-answer'], 75);
      assert.deepEqual(await nthEvent(pixel, 'env.request.closed'), { requestId: request.requestId, reason: 'expired' });
    } finally {
      await short.stop();
    }
  });

  it('cancels the request on every phone when the command closes the connection', async () => {
    const pixel = await agent.phone('Pixel 8', [set.owner.deviceId]);
    const call = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic));
    const { request } = await nthEvent(pixel, 'env.request');
    call.close();
    assert.deepEqual(await nthEvent(pixel, 'env.request.closed'), { requestId: request.requestId, reason: 'cancelled' });
    const answer = await pixel.request('env.request.answer', { requestId: request.requestId, answer: { kind: 'deny' } });
    assert.equal(answer.error?.code, 'not_found');
    const last = agent.envEvents.filter((event) => event.type === 'env.activity').at(-1) as any;
    assert.equal(last.entry.outcome.text, 'Stopped before an answer');
  });

  it('asks for a pull with its target, and words the activity row by where .env goes', async () => {
    const pixel = await agent.phone('Pixel 8', [set.owner.deviceId]);
    const key = oneTimeKey();
    const target = { path: `${repo.root}/.env`, gitignored: false };
    const call = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, key.xPublic, { kind: 'pull', command: null, target, invocation: 'authdeck env pull' }));
    const { request } = await nthEvent(pixel, 'env.request');
    assert.equal(request.kind, 'pull');
    assert.deepEqual(request.target, target);
    await pixel.request('env.request.answer', { requestId: request.requestId, answer: phoneRelease(set, request, 'once') });
    assert.equal((await call.reply).ok, true);
    const row = agent.envEvents.find((event) => event.type === 'env.activity') as any;
    assert.equal(row.entry.title, 'Wrote .env for acme-api');
    assert.equal(row.entry.outcome.text, 'Allowed once · not ignored by git');
  });

  it('refuses a release request whose paths are not a set file in a git working tree', async () => {
    const outside = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic, { project: { repoRoot: repo.root, remote: null, path: `${repo.root}/.authdeck/../secrets.env` } }));
    assert.equal((await outside.reply).error.code, 'failed');
    const noRepo = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic, { project: { repoRoot: `${repo.root}/.authdeck`, remote: null, path: `${repo.root}/.authdeck/.authdeck/acme-api.env` } }));
    assert.equal((await noRepo.reply).error.code, 'no-repo');
  });
});
