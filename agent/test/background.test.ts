import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { OUTPUT_TAIL_CHARS, runBackgroundCommand } from '../src/actions/background';
import { macActions } from '../src/actions/mac';
import { AgentError } from '../src/errors';
import { buildContext } from './helpers/context';

const posix = process.platform !== 'win32';
const shell = (command: string) => macActions.background(command, buildContext('macos', { env: { SHELL: '/bin/sh' }, tools: ['/bin/sh'] }));

describe('background commands (real, harmless)', { skip: !posix }, () => {
  it('returns exit code and output', async () => {
    const outcome = await runBackgroundCommand(shell('echo hi'), os.tmpdir(), 5);
    assert.deepEqual(outcome, { exitCode: 0, output: 'hi\n' });
  });

  it('runs in the given folder', async () => {
    const dir = fs.realpathSync(os.tmpdir());
    const outcome = await runBackgroundCommand(shell('pwd'), dir, 5);
    assert.equal(outcome.output.trim(), dir);
  });

  it('reports a nonzero exit as a result, with stderr interleaved', async () => {
    const outcome = await runBackgroundCommand(shell('echo out; echo err >&2; exit 3'), os.tmpdir(), 5);
    assert.equal(outcome.exitCode, 3);
    assert.match(outcome.output, /out\n/);
    assert.match(outcome.output, /err\n/);
  });

  it('keeps only the last 8000 characters', async () => {
    const outcome = await runBackgroundCommand(shell(`i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done`), os.tmpdir(), 10);
    assert.equal(outcome.output.length, OUTPUT_TAIL_CHARS);
    assert.ok(outcome.output.endsWith('line-1999\n'));
  });

  it('kills the whole process tree on timeout and returns partial output', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-bg-')), 'child.pid');
    const started = Date.now();
    await assert.rejects(
      runBackgroundCommand(shell(`echo started; sleep 30 & echo $! > '${pidFile}'; wait`), os.tmpdir(), 1),
      (err: AgentError) => err.code === 'timeout' && /after 1 seconds/.test(err.message) && /started/.test(err.hint ?? ''),
    );
    assert.ok(Date.now() - started < 2500, 'timed out promptly');
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' }, 'background grandchild was not killed');
  });

  it('reports a missing shell as missing_tool', async () => {
    await assert.rejects(runBackgroundCommand({ cmd: '/nonexistent/shell', args: ['-c', 'true'] }, os.tmpdir(), 5), (err: AgentError) => err.code === 'missing_tool');
  });
});
