import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { PlatformActions } from '../src/actions/context';
import { macActions } from '../src/actions/mac';
import { ActionRunner } from '../src/actions/runner';
import { AppCatalog } from '../src/apps/catalog';
import { DryRunExecutor, PlanExecutor } from '../src/executor';
import type { OsStep } from '../src/plan';
import { buildContext } from './helpers/context';
import { startTestServer, type TestServer } from './helpers/server';

const SECRET = '492039';
const SNIPPET = 'correct horse battery staple';

/** A node one-liner standing in for a typing tool: reads stdin, echoes it to stdout and stderr, fails. */
function echoingTool(stderrPrefix: string): OsStep[] {
  const script = `let s='';process.stdin.on('data',(d)=>{s+=d}).on('end',()=>{process.stdout.write(s);process.stderr.write(${JSON.stringify(stderrPrefix)}+s+'\\n');process.exit(3)})`;
  return [{ kind: 'run', cmd: process.execPath, args: ['-e', script], purpose: 'type the text', failure: 'mac-keystrokes' }];
}

describe('typed text and stdin', () => {
  it('the executor hands a step its input on stdin', async () => {
    const executor = new PlanExecutor({ hostAppName: 'AuthDeck', winHelper: null });
    const check = `let s='';process.stdin.on('data',(d)=>{s+=d}).on('end',()=>process.exit(s===${JSON.stringify(SNIPPET)}?0:1))`;
    await executor.execute([{ kind: 'run', cmd: process.execPath, args: ['-e', check], input: SNIPPET, purpose: 'type', failure: 'plain' }]);
  });

  it('a dry run describes a typing step without its input', async () => {
    const lines: string[] = [];
    await new DryRunExecutor((line) => lines.push(line)).execute(macActions.text(SNIPPET, false, buildContext('macos')));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^ {2}\[dry-run\] run: osascript {2}< \(input not shown\)$/);
  });
});

describe('a typing tool that fails and echoes its stdin', () => {
  let t: TestServer;
  const runnerLog: string[] = [];
  let stderrPrefix = 'error: ';

  before(async () => {
    const actions: PlatformActions = {
      ...macActions,
      text: (text) => echoingTool(stderrPrefix).map((step) => ({ ...step, input: text }) as OsStep),
    };
    const runner = new ActionRunner({
      ctx: buildContext('macos'),
      actions,
      catalog: new AppCatalog(async () => []),
      executor: new PlanExecutor({ hostAppName: 'AuthDeck', winHelper: null }),
      runBackground: async () => ({ exitCode: 0, output: '' }),
      log: (line) => runnerLog.push(line),
    });
    t = await startTestServer({ runner });
  });

  after(() => t.server.close());

  const cases: { name: string; params: unknown; typed: string; message: RegExp }[] = [
    { name: 'a secret code', params: { action: { type: 'text', text: SECRET, secret: true }, label: 'Typed a code for GitHub' }, typed: SECRET, message: /^Could not type the code\.$/ },
    { name: 'a plain snippet', params: { action: { type: 'text', text: SNIPPET, pressEnter: true } }, typed: SNIPPET, message: /^Could not type the text\.$/ },
    {
      name: 'a secret inside a macro',
      params: { action: { type: 'macro', steps: [{ action: { type: 'text', text: SECRET, secret: true }, delayMs: 0 }] } },
      typed: SECRET,
      message: /^Step 1 of 1 \(text\) failed: Could not type the code\.$/,
    },
  ];

  for (const { name, params, typed, message } of cases) {
    it(`keeps ${name} out of the reply, events, activity and logs`, async () => {
      const phone = await t.connect('phone');
      t.events.length = 0;
      t.logLines.length = 0;
      runnerLog.length = 0;
      const reply = await phone.request('run', params);
      assert.equal(reply.ok, false);
      assert.match(reply.error!.message, message);
      const finished = t.events.find((e) => e.type === 'action.finished');
      assert.ok(finished && !finished.ok, 'the activity list shows the failure');
      const everything = JSON.stringify([reply, t.events, t.logLines, runnerLog, phone.events]);
      assert.equal(everything.includes(typed), false, everything);
      phone.close();
    });
  }

  it('keeps the fixed permission hint but not the echoed text when macOS refuses', async () => {
    stderrPrefix = 'execution error: osascript is not allowed to send keystrokes. (1002) ';
    try {
      const phone = await t.connect('phone');
      t.events.length = 0;
      t.logLines.length = 0;
      const reply = await phone.request('run', { action: { type: 'text', text: SECRET, secret: true } });
      assert.equal(reply.error?.code, 'permission');
      assert.match(reply.error!.hint!, /Accessibility/);
      assert.equal(JSON.stringify([reply, t.events, t.logLines]).includes(SECRET), false);
      phone.close();
    } finally {
      stderrPrefix = 'error: ';
    }
  });
});
