import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { PlatformActions, ShellInvocation } from '../src/actions/context';
import { linuxActions } from '../src/actions/linux';
import { macActions } from '../src/actions/mac';
import { ActionRunner } from '../src/actions/runner';
import { windowsActions } from '../src/actions/windows';
import { AppCatalog } from '../src/apps/catalog';
import type { InstalledApp } from '../src/apps/types';
import { AgentError } from '../src/errors';
import { describePlan, type OsStep, type Plan } from '../src/plan';
import type { Platform } from '../src/protocol';
import { buildContext, linuxCode, macSafari, winCalculator, winCode } from './helpers/context';

const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-runner-'));
fs.mkdirSync(path.join(realHome, 'project'));
fs.writeFileSync(path.join(realHome, 'notes.txt'), '');

function setup(platform: Platform, apps: InstalledApp[], actions: PlatformActions, tools: string[] = [], env: NodeJS.ProcessEnv = { XDG_SESSION_TYPE: 'x11' }) {
  const plans: Plan[] = [];
  const background: { shell: ShellInvocation; cwd: string; timeoutSec: number }[] = [];
  const logs: string[] = [];
  const catalog = new AppCatalog(async () => apps);
  const runner = new ActionRunner({
    ctx: buildContext(platform, { home: realHome, tools, env }),
    actions,
    catalog,
    executor: { execute: async (plan) => void plans.push(plan) },
    runBackground: async (shell, cwd, timeoutSec) => {
      background.push({ shell, cwd, timeoutSec });
      return { exitCode: 2, output: 'boom' };
    },
    log: (line) => logs.push(line),
  });
  return { runner, plans, background, logs };
}

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err as AgentError;
  }
  assert.fail('expected an error');
};

describe('ActionRunner', () => {
  it('focuses the app before pressing keys', async () => {
    const t = setup('macos', [macSafari], macActions);
    await t.runner.run({ action: { type: 'hotkey', modifiers: ['mod'], key: 'l', focusAppId: macSafari.entry.id } });
    const lines = describePlan(t.plans[0]!);
    assert.deepEqual(lines.slice(0, 2), ['run: open -a /Applications/Safari.app', 'wait 150 ms']);
    const press = t.plans[0]![2]!;
    assert.ok(press.kind === 'run' && press.cmd === 'osascript' && /keystroke/.test(press.input ?? ''));
  });

  it('runs background commands in action.cwd, else params.cwd, else home, with the default timeout', async () => {
    const t = setup('macos', [], macActions);
    const result = await t.runner.run({ action: { type: 'command', command: 'make', mode: 'background' }, cwd: '~/project' });
    assert.equal(result.exitCode, 2);
    assert.equal(result.output, 'boom');
    assert.equal(typeof result.durationMs, 'number');
    await t.runner.run({ action: { type: 'command', command: 'make', mode: 'background', cwd: realHome, timeoutSec: 9 }, cwd: '~/nope' });
    await t.runner.run({ action: { type: 'command', command: 'make', mode: 'background' } });
    assert.deepEqual(t.background.map((b) => [b.cwd, b.timeoutSec]), [[path.join(realHome, 'project'), 120], [realHome, 9], [realHome, 120]]);
  });

  it('says which folder is missing', async () => {
    const t = setup('macos', [], macActions);
    const err = await errorOf(t.runner.run({ action: { type: 'command', command: 'ls', mode: 'terminal', cwd: '~/gone' } }));
    assert.equal(err.code, 'not_found');
    assert.ok(err.message.includes(path.join(realHome, 'gone')));
    const fileAsCwd = await errorOf(t.runner.run({ action: { type: 'command', command: 'ls', mode: 'background', cwd: '~/notes.txt' } }));
    assert.equal(fileAsCwd.code, 'not_found');
  });

  it('reports unknown apps by the name saved on the key', async () => {
    const t = setup('macos', [], macActions);
    const err = await errorOf(t.runner.run({ action: { type: 'launch', appId: 'mac:/Applications/Gone.app', appName: 'Gone' } }));
    assert.equal(err.code, 'not_found');
    assert.equal(err.message, 'Gone is not installed on this computer anymore.');
    const focusErr = await errorOf(t.runner.run({ action: { type: 'hotkey', modifiers: [], key: 'a', focusAppId: 'mac:/x.app' } }));
    assert.equal(focusErr.code, 'not_found');
  });

  it('opens a file with an app on Linux by Exec', async () => {
    const t = setup('linux', [linuxCode], linuxActions, ['xdg-open']);
    await t.runner.run({ action: { type: 'open', path: '~/project', withAppId: linuxCode.entry.id } });
    assert.deepEqual(describePlan(t.plans[0]!), [`detach: /usr/share/code/code --unity-launch ${path.join(realHome, 'project')}`]);
  });

  it('logs when Windows has to fall back to the default app for open-with', async () => {
    const t = setup('windows', [winCode, winCalculator], windowsActions);
    await t.runner.run({ action: { type: 'open', path: '~', withAppId: winCalculator.entry.id } });
    assert.match(t.logs[0]!, /Calculator can't be handed a file directly/);
    await t.runner.run({ action: { type: 'open', path: '~', withAppId: winCode.entry.id } });
    assert.equal(t.logs.length, 1);
  });

  it('runs macro steps in order and waits between them', async () => {
    const t = setup('macos', [macSafari], macActions);
    const started = Date.now();
    await t.runner.run({
      action: {
        type: 'macro',
        steps: [
          { action: { type: 'launch', appId: macSafari.entry.id, appName: 'Safari' }, delayMs: 120 },
          { action: { type: 'url', url: 'https://example.com' }, delayMs: 5000 },
        ],
      },
    });
    assert.ok(Date.now() - started >= 110, 'waited after step 1');
    assert.ok(Date.now() - started < 2000, 'no wait after the last step');
    assert.deepEqual(t.plans.map((p) => describePlan(p)[0]), ['run: open -a /Applications/Safari.app', 'run: open https://example.com/']);
  });

  it('stops a macro at the first failing step and names it', async () => {
    const t = setup('macos', [], macActions);
    const err = await errorOf(
      t.runner.run({
        action: {
          type: 'macro',
          steps: [
            { action: { type: 'text', text: 'x' }, delayMs: 0 },
            { action: { type: 'open', path: '~/missing-file' }, delayMs: 0 },
            { action: { type: 'text', text: 'never' }, delayMs: 0 },
          ],
        },
      }),
    );
    assert.equal(err.code, 'not_found');
    assert.match(err.message, /^Step 2 of 3 \(open\) failed: The file or folder .*missing-file does not exist/);
    assert.equal(t.plans.length, 1);
  });

  it('rejects bad actions before doing anything', async () => {
    const t = setup('macos', [], macActions);
    assert.equal((await errorOf(t.runner.run({ action: { type: 'url', url: 'file:///x' } }))).code, 'bad_request');
    assert.equal((await errorOf(t.runner.run({}))).code, 'bad_request');
    assert.equal(t.plans.length, 0);
  });

  describe('typed text never reaches a command line', () => {
    const typed = 'p@ss "word" -x\\n 😀 123456';
    const commandLines = (plan: Plan): string[] =>
      plan.flatMap((step: OsStep): string[] => {
        if (step.kind === 'run' || step.kind === 'detach') return [step.cmd, ...step.args];
        if (step.kind === 'either') return step.attempts.flatMap(commandLines);
        return [];
      });
    const cases: [string, ReturnType<typeof setup>][] = [
      ['macOS', setup('macos', [], macActions)],
      ['X11 xdotool', setup('linux', [], linuxActions, ['xdotool'])],
      ['Wayland wtype', setup('linux', [], linuxActions, ['wtype'], { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' })],
      ['Wayland ydotool', setup('linux', [], linuxActions, ['ydotool'], { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' })],
      ['Windows helper', setup('windows', [], windowsActions)],
    ];
    for (const [name, t] of cases) {
      it(`${name}: secrets and plain snippets alike`, async () => {
        await t.runner.run({ action: { type: 'text', text: typed, pressEnter: true, secret: true } });
        await t.runner.run({ action: { type: 'macro', steps: [{ action: { type: 'text', text: typed }, delayMs: 0 }] } });
        assert.equal(t.plans.length, 2);
        for (const plan of t.plans) {
          const argv = commandLines(plan);
          for (const piece of [typed, 'p@ss', '123456']) assert.ok(!argv.some((arg) => arg.includes(piece)), `${name} argv: ${JSON.stringify(argv)}`);
          assert.ok(!describePlan(plan).join('\n').includes('123456'), 'the dry-run description leaves stdin out');
        }
      });
    }
  });
});
