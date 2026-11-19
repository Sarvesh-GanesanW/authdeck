import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { linuxActions } from '../src/actions/linux';
import { macActions } from '../src/actions/mac';
import { windowsActions } from '../src/actions/windows';
import type { InstalledApp } from '../src/apps/types';
import { AgentError } from '../src/errors';
import { PlanExecutor } from '../src/executor';
import type { OpenProbe, OsStep, Plan, WinHelperRequest } from '../src/plan';
import type { WinHelper, WinHelperResponse } from '../src/platform/winHelper';
import { buildContext, linuxCode, winCode } from './helpers/context';

/** A probe that runs a node one-liner in place of lsappinfo or xdotool. */
function nodeProbe(script: string): OpenProbe {
  return { kind: 'run', cmd: process.execPath, args: ['-e', script], purpose: 'check whether Code is open', failure: 'plain' };
}

const OPEN = nodeProbe("process.stdout.write('ASN:0x0-0x1-\"Code\":\\n')");
const CLOSED_QUIETLY = nodeProbe('process.exit(1)');

function requireOpen(probe: OpenProbe, waitMs = 0): OsStep {
  return { kind: 'requireOpen', appName: 'Visual Studio Code', probe, waitMs };
}

/** A Windows helper that answers focus requests from a script and records them. */
function fakeWinHelper(answers: WinHelperResponse[]): { helper: WinHelper; requests: WinHelperRequest[] } {
  const requests: WinHelperRequest[] = [];
  const helper = {
    request: async (request: WinHelperRequest) => {
      requests.push(request);
      return answers.shift() ?? { id: 'x', ok: false, error: 'not_found' };
    },
  } as unknown as WinHelper;
  return { helper, requests };
}

const executor = (winHelper: WinHelper | null = null) => new PlanExecutor({ hostAppName: 'Terminal', winHelper });

async function errorOf(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AgentError, String(err));
    return err;
  }
  assert.fail('expected an error');
}

describe('PlanExecutor requireOpen', () => {
  it('goes on when the probe finds the app', async () => {
    await executor().execute([requireOpen(OPEN)]);
  });

  it("fails with \"<app> isn't open\" and stops the plan when it isn't running", async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-exec-')), 'ran');
    const err = await errorOf(executor().execute([requireOpen(CLOSED_QUIETLY), { kind: 'writeFile', path: marker, content: '' }]));
    assert.equal(err.code, 'not_found');
    assert.equal(err.message, "Visual Studio Code isn't open.");
    assert.equal(err.hint, 'Open Visual Studio Code first, then press the key again.');
    assert.ok(!fs.existsSync(marker), 'nothing after the check ran');
  });

  it('reports a probe that could not look as that failure, not as a closed app', async () => {
    const err = await errorOf(executor().execute([requireOpen(nodeProbe("process.stderr.write(\"Error: Can't open display\\n\"); process.exit(1)"))]));
    assert.equal(err.code, 'failed');
    assert.match(err.message, /could not check whether Code is open: Error: Can't open display/);
  });

  it('waits for an app an earlier step is starting', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-exec-')), 'started');
    const probe = nodeProbe(`if (require('fs').existsSync(${JSON.stringify(marker)})) process.stdout.write('1')`);
    setTimeout(() => fs.writeFileSync(marker, ''), 300);
    const started = Date.now();
    await executor().execute([requireOpen(probe, 5000)]);
    assert.ok(Date.now() - started >= 300);
  });

  it('gives up after the wait and says it did not start', async () => {
    const started = Date.now();
    const err = await errorOf(executor().execute([requireOpen(CLOSED_QUIETLY, 400)]));
    assert.ok(Date.now() - started >= 400);
    assert.equal(err.message, "Visual Studio Code isn't open.");
    assert.match(err.hint ?? '', /^It didn't start within \d+ seconds\./);
  });
});

describe('focus never starts a closed app', () => {
  it('Windows: the helper finds no window, so nothing is launched and the key says the app is not open', async () => {
    const { helper, requests } = fakeWinHelper([{ id: 'x', ok: false, error: 'not_found' }]);
    const plan = windowsActions.focus(winCode, buildContext('windows'), 0);
    const err = await errorOf(executor(helper).execute(plan));
    assert.equal(err.message, "Visual Studio Code isn't open.");
    assert.deepEqual(requests.map((r) => r.op), ['focus']);
    assert.ok(!plan.some((step) => step.kind === 'detach'));
  });

  it('Windows: an app whose window shows up during the wait is focused', async () => {
    const { helper, requests } = fakeWinHelper([{ id: 'x', ok: false, error: 'not_found' }, { id: 'x', ok: true }]);
    await executor(helper).execute(windowsActions.focus(winCode, buildContext('windows'), 5000));
    assert.equal(requests.length, 2);
  });

  it('Windows: a helper error other than not_found is reported as it is', async () => {
    const { helper } = fakeWinHelper([{ id: 'x', ok: false, error: 'access denied' }]);
    const err = await errorOf(executor(helper).execute(windowsActions.focus(winCode, buildContext('windows'), 0)));
    assert.equal(err.message, 'Could not bring Visual Studio Code to the front: access denied');
  });

  it('Linux X11: xdotool search finding nothing stops before windowactivate', async () => {
    const plan = linuxActions.focus(linuxCode, buildContext('linux', { tools: ['xdotool'], env: { XDG_SESSION_TYPE: 'x11' } }), 0);
    // Same plan with xdotool's quiet "no windows" exit standing in for the real search.
    const check = plan[0]!;
    assert.ok(check.kind === 'requireOpen');
    const stubbed: Plan = [{ ...check, probe: CLOSED_QUIETLY }, ...plan.slice(1)];
    const err = await errorOf(executor().execute(stubbed));
    assert.equal(err.message, "Visual Studio Code isn't open.");
  });

  it('macOS: lsappinfo finds no running copy, so open -a is never run', { skip: process.platform !== 'darwin' }, async () => {
    // lsappinfo only reads LaunchServices; the bundle does not exist, so it can't be running.
    const missing: InstalledApp = {
      platform: 'macos',
      entry: { id: 'mac:/Applications/AuthDeck Missing Test.app', name: 'AuthDeck Missing Test', hasIcon: false },
      bundlePath: '/Applications/AuthDeck Missing Test.app',
      bundleId: null,
    };
    const plan = macActions.focus(missing, buildContext('macos'), 0);
    const err = await errorOf(executor().execute(plan));
    assert.equal(err.message, "AuthDeck Missing Test isn't open.");
  });
});
