/**
 * The command as its own process: run's child gets the values and the terminal, signals reach it,
 * exit codes come back, and Ctrl-C while waiting cancels the request and exits 130.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { EnvReleaseParams } from '../../src/envSocketContract';
import { FakeAgent, release } from './helpers/fakeAgent';
import { makeRepo, type TestRepo } from './helpers/repo';
import { spawnCli } from './helpers/subprocess';

let agent: FakeAgent;
let repo: TestRepo;

beforeEach(async () => {
  agent = await FakeAgent.start();
  repo = makeRepo();
  repo.addSet('acme-api');
});
afterEach(async () => {
  await agent.stop();
  repo.remove();
});

const cli = (argv: string[], env: NodeJS.ProcessEnv = {}) => spawnCli(['env', ...argv], { cwd: repo.root, home: agent.home, env });
const node = (script: string) => ['run', '--', process.execPath, '-e', script];

describe('authdeck env run', () => {
  it("puts the values in the child's environment only, gives it stdout, and exits with its code", async () => {
    agent.answer = release('new-grant', { progress: ['Pixel 8'] });
    const run = cli(node('console.log(JSON.stringify({ db: process.env.DATABASE_URL, pem: process.env.PEM, home: !!process.env.HOME })); process.exit(3)'));
    const { code } = await run.exit;
    assert.equal(code, 3, run.stderr());
    assert.deepEqual(JSON.parse(run.stdout()), { db: 'postgres://u:p@db/app', pem: '-----BEGIN-----\nabc\n-----END-----', home: true });
    assert.equal(
      run.stderr(),
      'acme-api: 12 variables, signatures check out (rev 7, epoch 3)\nAsking Pixel 8 to release them…\n✔ Pixel 8 allowed acme-api for 15 minutes (until 11:58).\n  No file written.\n',
    );
    const params = agent.lastParams<EnvReleaseParams>();
    assert.equal(params.kind, 'run');
    assert.deepEqual(params.command?.slice(0, 2), [process.execPath, '-e']);
    assert.equal(params.target, null);
    assert.equal(repo.exists('.env'), false);
  });

  it('skips variables that change how programs start, saying how to allow one', async () => {
    const values = [
      { name: 'A', value: 'a' },
      { name: 'NODE_OPTIONS', value: '--require ./evil.cjs' },
      { name: 'DYLD_INSERT_LIBRARIES', value: '/tmp/evil.dylib' },
    ];
    agent.answer = release('once', { values });
    const run = cli(node('console.log(JSON.stringify({ a: process.env.A, node: process.env.NODE_OPTIONS ?? null, dyld: process.env.DYLD_INSERT_LIBRARIES ?? null }))'));
    assert.equal((await run.exit).code, 0, run.stderr());
    assert.deepEqual(JSON.parse(run.stdout()), { a: 'a', node: null, dyld: null });
    assert.match(
      run.stderr(),
      /Skipped NODE_OPTIONS: it changes how programs start\. Add --allow NODE_OPTIONS to use it\.\nSkipped DYLD_INSERT_LIBRARIES: it changes how programs start\. Add --allow DYLD_INSERT_LIBRARIES to use it\.\n/,
    );
  });

  it('injects a name the person allows with --allow, and only that one', async () => {
    const values = [
      { name: 'NODE_OPTIONS', value: '--max-old-space-size=64' },
      { name: 'BASH_ENV', value: '/tmp/x' },
    ];
    agent.answer = release('once', { values });
    const run = cli(['run', '--allow', 'NODE_OPTIONS', '--', process.execPath, '-e', 'console.log(JSON.stringify([process.env.NODE_OPTIONS ?? null, process.env.BASH_ENV ?? null]))']);
    assert.equal((await run.exit).code, 0, run.stderr());
    assert.deepEqual(JSON.parse(run.stdout()), ['--max-old-space-size=64', null]);
    assert.doesNotMatch(run.stderr(), /Skipped NODE_OPTIONS/);
    assert.match(run.stderr(), /Skipped BASH_ENV/);
    assert.equal(agent.lastParams<EnvReleaseParams>().invocation.includes('--allow NODE_OPTIONS'), true);
  });

  it('says "Running" inside a grant, with no check line since no device is asked', async () => {
    agent.answer = release('grant');
    const run = cli(['run', '--', 'true']);
    assert.equal((await run.exit).code, 0);
    assert.equal(run.stderr(), '✔ acme-api allowed until 11:58 by Pixel 8. Running true.\n');
  });

  it('reports a child stopped by a signal as 128 + the signal', async () => {
    agent.answer = release('once');
    const run = cli(node("process.kill(process.pid, 'SIGKILL')"));
    assert.equal((await run.exit).code, 137);
  });

  it('passes SIGTERM and SIGHUP to the child and ends with its code', async () => {
    for (const [signal, code] of [['SIGTERM', 21], ['SIGHUP', 22]] as const) {
      agent.answer = release('once');
      const run = cli(node(`process.on('${signal}', () => { console.log('child got ${signal}'); process.exit(${code}); }); console.log('ready'); setInterval(() => {}, 1000);`));
      await run.waitFor('ready');
      run.child.kill(signal);
      assert.equal((await run.exit).code, code);
      assert.match(run.stdout(), new RegExp(`child got ${signal}`));
    }
  });

  it('passes SIGINT to the child when there is no terminal to send it', async () => {
    agent.answer = release('once');
    const run = cli(node("process.on('SIGINT', () => { console.log('child got SIGINT'); process.exit(4); }); console.log('ready'); setInterval(() => {}, 1000);"));
    await run.waitFor('ready');
    run.child.kill('SIGINT');
    assert.equal((await run.exit).code, 4);
    assert.match(run.stdout(), /child got SIGINT/);
  });

  it('exits 127 for a command that does not exist', async () => {
    agent.answer = release('once');
    const run = cli(['run', '--', 'authdeck-no-such-command-xyz']);
    assert.equal((await run.exit).code, 127);
    assert.match(run.stderr(), /✗ authdeck-no-such-command-xyz: command not found\./);
  });
});

describe('Ctrl-C while waiting', () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    it(`${signal} closes the socket, which cancels the request, and exits ${code}`, async () => {
      agent.answer = (c) => c.send({ progress: { stage: 'asking', devices: ['Pixel 8'], expiresAt: Date.now() + 60_000 } });
      const run = cli(node("require('fs').writeFileSync('started', '')"));
      await run.waitFor('Asking Pixel 8 to release them…');
      run.child.kill(signal);
      assert.equal((await run.exit).code, code);
      assert.match(run.stderr(), /✗ Cancelled\. Nothing was released or changed\./);
      await waitUntil(() => agent.cancelled.length === 1);
      assert.deepEqual(agent.cancelled, [agent.requests[0]!.id]);
      assert.equal(repo.exists('started'), false);
    });
  }

  it('cancels a push the same way', async () => {
    repo.write('.env', 'A=1\n');
    agent.answer = (c) => c.send({ progress: { stage: 'asking', devices: [], expiresAt: Date.now() + 60_000 } });
    const run = cli(['push']);
    await run.waitFor('Asking a member device to sign the change…');
    run.child.kill('SIGINT');
    assert.equal((await run.exit).code, 130);
    await waitUntil(() => agent.cancelled.length === 1);
  });
});

describe('the binary', () => {
  it('prints help on bad usage and exits 64', async () => {
    const run = cli(['bogus']);
    assert.equal((await run.exit).code, 64);
    assert.match(run.stderr(), /✗ Unknown command "authdeck env bogus"\.\n  Run authdeck env --help\.\n\nauthdeck env: your project's \.env/);
    assert.match(run.stderr(), /authdeck env run \[--set <name>\] \[--allow <NAME>\]\.\.\. -- <command>/);
  });

  it('prints help on --help and exits 0', async () => {
    const run = cli(['--help']);
    assert.equal((await run.exit).code, 0);
    assert.match(run.stdout(), /^authdeck env: /);
  });

  it('exits 69 when no agent is listening', async () => {
    await agent.stop();
    const run = cli(['run', '--', 'true']);
    assert.equal((await run.exit).code, 69);
    assert.match(run.stderr(), /✗ AuthDeck Agent isn't running on this computer\.\n  Open AuthDeck Agent, or run authdeck-agent, then try again\./);
    agent = await FakeAgent.start();
  });
});

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
