/**
 * The socket's framing and versioning, rate limits on the socket and on join requests, own-device
 * joins relayed under env names, a 0.3 phone left untouched, and ENV_FEATURE listed only when
 * env sets run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { startAgent } from '../../src/agent';
import { ENV_ASK_RATE, ENV_SOCKET_RATE, MAX_WAITING_ASKS } from '../../src/env/commands';
import { EnvAgent, registryPath } from '../../src/env/envAgent';
import { ENV_JOIN_REQUEST_RATE } from '../../src/env/joins';
import { loadConfig } from '../../src/config';
import { ENV_EXIT_FOR, ENV_SOCKET_MAX_LINE_BYTES, ENV_SOCKET_VERSION, envSocketPath } from '../../src/envSocketContract';
import { ENV_FEATURE } from '../../src/protocol';
import { createJoinRequest } from '../../src/vault/approval';
import { generateDeviceKeys } from '../../src/vault/crypto';
import {
  callSocket,
  makeRepo,
  makeSet,
  nthEvent,
  oneTimeKey,
  phoneRelease,
  random,
  releaseParams,
  removeTemps,
  sleep,
  startEnvAgent,
  tempDir,
  type Repo,
  type TestAgent,
  type TestSet,
} from './harness';

after(removeTemps);

/** Sends raw bytes on the socket and collects every line until the agent closes. */
function rawSocket(socketPath: string, bytes: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let text = '';
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', (chunk) => (text += chunk.toString('utf8')));
    socket.on('error', reject);
    socket.on('close', () => resolve(text.split('\n').filter(Boolean).map((line) => JSON.parse(line))));
  });
}

describe('env socket protocol', () => {
  let agent: TestAgent;
  beforeEach(async () => (agent = await startEnvAgent()));
  afterEach(() => agent.stop());

  it('listens on a socket only its user can open', { skip: process.platform === 'win32' }, () => {
    assert.equal(fs.statSync(agent.socketPath).mode & 0o777, 0o600);
  });

  it('answers another socket version with agent-version (exit 69)', async () => {
    const [reply] = await rawSocket(agent.socketPath, `${JSON.stringify({ v: ENV_SOCKET_VERSION + 1, id: 'abcdefgh-1', method: 'ls', params: {} })}\n`);
    assert.deepEqual(reply, { id: 'abcdefgh-1', ok: false, error: { code: 'agent-version', agentVersion: '0.4.0-test', socketVersion: ENV_SOCKET_VERSION } });
  });

  it('refuses a line that is not JSON, an unknown method and a bad id, then closes', async () => {
    assert.equal((await rawSocket(agent.socketPath, 'not json\n'))[0].error.code, 'failed');
    assert.equal((await rawSocket(agent.socketPath, `${JSON.stringify({ v: ENV_SOCKET_VERSION, id: 'abcdefgh-2', method: 'rm', params: {} })}\n`))[0].error.code, 'agent-version');
    assert.equal((await rawSocket(agent.socketPath, `${JSON.stringify({ v: ENV_SOCKET_VERSION, id: 'x y', method: 'ls', params: {} })}\n`))[0].error.code, 'failed');
  });

  it('refuses a line longer than the socket allows', async () => {
    const lines = await rawSocket(agent.socketPath, 'x'.repeat(ENV_SOCKET_MAX_LINE_BYTES + 10));
    assert.equal(lines[0].error.code, 'failed');
  });

  it('answers one request per connection with a reply line and closes', async () => {
    const set = makeSet();
    const repo = makeRepo(set);
    const request = { v: ENV_SOCKET_VERSION, id: 'abcdefgh-3', method: 'ls', params: { repoRoot: repo.root, remote: null, files: [{ path: repo.setPath, file: set.text }] } };
    const lines = await rawSocket(agent.socketPath, `${JSON.stringify(request)}\n${JSON.stringify({ ...request, id: 'abcdefgh-4' })}\n`);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id, 'abcdefgh-3');
    assert.equal(lines[0].ok, true);
  });

  it('refuses to start a second agent on a socket another agent listens on', async () => {
    const second = new EnvAgent({ home: agent.home, socketPath: agent.socketPath, platform: process.platform, agentVersion: 'x', log: () => {}, grantCheckMs: 0 });
    await assert.rejects(second.start(), /already listening/);
  });
});

describe('env rate limits', () => {
  let agent: TestAgent;
  let set: TestSet;
  let repo: Repo;
  beforeEach(async () => {
    agent = await startEnvAgent();
    set = makeSet();
    repo = makeRepo(set);
  });
  afterEach(() => agent.stop());

  it('limits socket requests from local processes', async () => {
    const ls = { repoRoot: repo.root, remote: null, files: [] };
    const replies = await Promise.all(Array.from({ length: ENV_SOCKET_RATE.burst + 1 }, () => callSocket(agent.socketPath, 'ls', ls).reply));
    const refused = replies.filter((reply) => !reply.ok);
    assert.equal(refused.length, 1);
    assert.deepEqual(refused[0].error, { code: 'rate-limited', retryAfterSec: Math.ceil(ENV_SOCKET_RATE.refillMs / 1000) });
    assert.equal(ENV_EXIT_FOR['rate-limited'], 75);
    agent.clock.advance(ENV_SOCKET_RATE.refillMs);
    assert.equal((await callSocket(agent.socketPath, 'ls', ls).reply).ok, true);
  });

  it('limits requests that reach the phone: a few waiting at once, and a few per minute', async () => {
    const pixel = await agent.phone('Pixel 8', [set.owner.deviceId]);
    const waiting = Array.from({ length: MAX_WAITING_ASKS }, () => callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic)));
    await nthEvent(pixel, 'env.request', MAX_WAITING_ASKS - 1);
    const over = await callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic)).reply;
    // A slot frees up when the first waiting request runs out (the harness waits 5 s).
    assert.deepEqual(over.error, { code: 'rate-limited', retryAfterSec: 5 });
    for (const call of waiting) call.close();
    await sleep(50);
    const requests = pixel.events.filter((e) => e.event === 'env.request').length;
    assert.equal(requests, MAX_WAITING_ASKS, 'the refused request never reached the phone');
    // The burst is spent apart from what the four used.
    for (let i = MAX_WAITING_ASKS; i < ENV_ASK_RATE.burst; i++) {
      const call = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic));
      await nthEvent(pixel, 'env.request', i);
      call.close();
    }
    await sleep(50);
    assert.deepEqual((await callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic)).reply).error, { code: 'rate-limited', retryAfterSec: ENV_ASK_RATE.refillMs / 1000 });
    agent.clock.advance(ENV_ASK_RATE.refillMs - 1_500);
    assert.deepEqual((await callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic)).reply).error, { code: 'rate-limited', retryAfterSec: 2 }, 'the wait counts down');
  });

  it('limits own-device join requests per device', async () => {
    const ipad = await agent.phone('iPad mini', [set.owner.deviceId]);
    const fresh = await agent.phone('New phone', []);
    const request = () => createJoinRequest(generateDeviceKeys(random), 'New phone', random).request;
    for (let i = 0; i < ENV_JOIN_REQUEST_RATE.burst; i++) {
      const made = await fresh.request('env.join.request', { setId: set.setId, request: request() });
      assert.equal(made.ok, true, JSON.stringify(made.error));
      await fresh.request('env.join.cancel', { requestId: made.result.requestId });
    }
    const over = await fresh.request('env.join.request', { setId: set.setId, request: request() });
    assert.equal(over.error?.code, 'rate_limited');
    assert.ok(ipad.events.some((e) => e.event === 'env.join.requested'));
  });
});

describe('own-device joins of a set', () => {
  it('relays request, challenge, reveal and finish under env names, with the set id', async () => {
    const agent = await startEnvAgent();
    try {
      const set = makeSet();
      const owner = await agent.phone('Pixel 8', [set.owner.deviceId]);
      const fresh = await agent.phone('iPad mini', []);
      const vaultOnly = await agent.phone('Old app');
      const made = await fresh.request('env.join.request', { setId: set.setId, request: createJoinRequest(generateDeviceKeys(random), 'iPad mini', random).request });
      const requested = await nthEvent(owner, 'env.join.requested');
      assert.equal(requested.setId, set.setId);
      assert.equal(requested.requestId, made.result.requestId);
      const challenge = { ed: 'ed', x: 'x', vault: set.setId, vaultName: 'acme-api', name: 'Pixel 8', nonce: 'nonce' };
      assert.equal((await owner.request('env.join.challenge', { requestId: made.result.requestId, challenge })).ok, true);
      assert.deepEqual((await nthEvent(fresh, 'env.join.challenged')).challenge, challenge);
      await fresh.request('env.join.reveal', { requestId: made.result.requestId, reveal: { nonce: 'n' } });
      await nthEvent(owner, 'env.join.revealed');
      await owner.request('env.join.finish', { requestId: made.result.requestId, approved: true, vaultId: 'ignored' });
      assert.deepEqual(await nthEvent(fresh, 'env.join.finished'), { requestId: made.result.requestId, approved: true });
      assert.equal(vaultOnly.events.some((e) => e.event.startsWith('env.') || e.event.startsWith('vault.join')), false, 'a session not watching hears nothing');
    } finally {
      await agent.stop();
    }
  });
});

describe('a 0.3 phone', () => {
  it('never gets an env event and keeps working, beside a watching phone', async () => {
    const agent = await startEnvAgent();
    try {
      const set = makeSet();
      const repo = makeRepo(set);
      const old = await agent.phone('Old phone');
      const pixel = await agent.phone('Pixel 8', [set.owner.deviceId]);
      const call = callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic));
      const { request } = await nthEvent(pixel, 'env.request');
      await pixel.request('env.request.answer', { requestId: request.requestId, answer: phoneRelease(set, request, 'grant') });
      assert.equal((await call.reply).ok, true);
      agent.env.endAllGrants('computer-locked');
      await nthEvent(pixel, 'env.grants.changed', 1);
      assert.equal((await old.request('ping', {})).ok, true);
      assert.deepEqual(old.events.filter((e) => e.event.startsWith('env.')), []);
      assert.equal((await old.request('env.request.answer', { requestId: request.requestId, answer: { kind: 'deny' } })).error?.code, 'not_found');
    } finally {
      await agent.stop();
    }
  });

  it('meets an agent without env sets the way a 0.3 agent answers: env methods unknown', async () => {
    const agent = await startEnvAgent({ withEnv: false });
    try {
      const phone = await agent.phone('Pixel 8');
      assert.equal(phone.agent.features, undefined);
      const watched = await phone.request('env.watch', { members: [] });
      assert.equal(watched.error?.code, 'bad_request');
      assert.equal((await phone.request('ping', {})).ok, true);
    } finally {
      await agent.stop();
    }
  });
});

describe('ENV_FEATURE in startAgent', () => {
  const saved = process.env.AUTHDECK_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTHDECK_HOME;
    else process.env.AUTHDECK_HOME = saved;
  });

  async function hello(port: number): Promise<{ features?: string[] }> {
    return (await fetch(`http://127.0.0.1:${port}/authdeck/hello`)).json() as Promise<{ features?: string[] }>;
  }

  it('lists env-sets and listens on the env socket in the AuthDeck folder', async () => {
    const home = tempDir();
    loadConfig(home);
    process.env.AUTHDECK_HOME = home;
    const agent = await startAgent({ port: 0, dryRun: true }, () => {});
    try {
      assert.deepEqual((await hello(agent.port)).features, [ENV_FEATURE]);
      const socketPath = envSocketPath(home, process.platform, 'unused');
      if (process.platform !== 'win32') assert.ok(fs.statSync(socketPath).isSocket());
      assert.deepEqual(agent.env.grants(), []);
    } finally {
      await agent.stop();
    }
  });

  it('runs without env sets, and says why, when the remembered heads are unreadable', async () => {
    const home = tempDir();
    loadConfig(home);
    fs.mkdirSync(path.dirname(registryPath(home)), { recursive: true });
    fs.writeFileSync(registryPath(home), '{ not json');
    process.env.AUTHDECK_HOME = home;
    const lines: string[] = [];
    const agent = await startAgent({ port: 0, dryRun: true }, (line) => lines.push(line));
    try {
      assert.equal((await hello(agent.port)).features, undefined);
      assert.ok(lines.some((line) => line.startsWith('Env sets are off:')));
      assert.equal(agent.env.endGrant('x'), false);
    } finally {
      await agent.stop();
    }
  });
});
