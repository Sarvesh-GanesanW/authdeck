// Security review of env sets (0.4), round 2, env core and CLI. Each test is a proof of concept for
// one finding: it fails while the weakness is there and passes once it is fixed. Ids match the report.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { envLoadsCode } from '../../src/envcore';
import { runChild } from '../../src/envcli/child';

describe('ENV-13: names that run code but envLoadsCode lets through', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'envattacks-r2-')));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('GIT_DIR from the set does not point the child\'s git at a repo whose config runs a program', async () => {
    // A member sets GIT_DIR to a folder in the repo (or anywhere the child can read) whose config names
    // core.fsmonitor: any git the child runs (npm scripts, husky, lint-staged, build tools) runs it.
    const marker = path.join(dir, 'ran');
    const hook = path.join(dir, 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho\n`, { mode: 0o755 });
    const evil = path.join(dir, 'evil');
    execFileSync('git', ['init', '-q', evil]);
    execFileSync('git', ['-C', evil, 'config', 'core.fsmonitor', hook]);
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    const values = [{ name: 'GIT_DIR', value: path.join(evil, '.git') }];
    await runChild({ command: ['git', 'status'], cwd: work, env: { PATH: process.env.PATH ?? '' }, values, hasTerminal: false, stderr: { write: () => true } }).catch(() => undefined);
    assert.equal(fs.existsSync(marker), false, 'a program named by the repo the set pointed git at ran inside the child');
  });

  it('build and runtime hooks are flagged as code-loading', () => {
    const missed = [
      'GIT_DIR', // core.fsmonitor, hooks and filters of another repo
      'GIT_WORK_TREE',
      'GOFLAGS', // -toolexec=<program>
      'CC', // make, node-gyp, cargo build scripts run it
      'CXX',
      'RUSTC_WRAPPER',
      'CARGO_BUILD_RUSTC_WRAPPER',
      'DOTNET_STARTUP_HOOKS', // .NET loads the named assembly
      'CORECLR_PROFILER_PATH',
      'COR_PROFILER_PATH',
      'MAVEN_OPTS', // -javaagent:
      'GRADLE_OPTS',
      'JAVA_OPTS',
      'ERL_AFLAGS', // -eval
      'PSMODULEPATH', // PowerShell autoloads modules from it
      'PROMPT', // cmd.exe expands it on Windows, where run uses a shell
      'NODE_TLS_REJECT_UNAUTHORIZED', // not code, but turns off TLS checks for every request the child makes
      'NODE_EXTRA_CA_CERTS',
    ].filter((name) => !envLoadsCode(name));
    assert.deepEqual(missed, [], `envLoadsCode lets these through: ${missed.join(', ')}`);
  });
});
