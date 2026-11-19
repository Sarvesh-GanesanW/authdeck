// Security review of env sets (0.4), round 7: the ENV-26 fix (CLI mode, fuses, launch arguments).
// Each test is a proof of concept for one finding: it fails while the weakness is there and passes
// once it is fixed. Ids match the report.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { findRepo } from '../../src/envcli/git';

const desktop = path.resolve(process.cwd(), '../desktop');

describe('ENV-28: AuthDeck Agent runs programs by name from the PATH it was started with, so the starter picks the program', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'envattacks-r7-')));
  const savedPath = process.env.PATH;
  after(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Accepted for 0.4: a program running as the person can already edit ~/.authdeck (its pairings
  // included) and drive the agent directly, so a clean PATH alone protects nothing. It stays open
  // until pairings are kept in the system keychain; then this check must pass.
  it('the app resets PATH (and git\'s and other inherited program variables) before CLI mode or the agent runs anything', { todo: 'open in 0.4: same-user programs are out of scope until pairings are keychain-protected' }, async () => {
    // The mechanism: the bundled authdeck command's first step, findRepo, runs `git` by name. A local
    // process that starts `AuthDeck Agent --authdeck-cli -- env ls` with PATH=<its folder>:… (through
    // launchd or LaunchServices, so the app is the responsible process) gets its own `git` run as a
    // child of AuthDeck Agent. The agent itself runs `osascript` by name the same way (actions/mac.ts).
    const marker = path.join(dir, 'ran');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${savedPath}`;
    await findRepo(dir).catch(() => undefined);
    process.env.PATH = savedPath;
    assert.ok(fs.existsSync(marker), 'control: the command runs whichever git the PATH names first');

    // The fix belongs where the app starts: start.ts (or cliMode.ts / main.ts) sets a known PATH.
    const sources = ['src/main/start.ts', 'src/main/cliMode.ts', 'src/main/main.ts'].map((f) => fs.readFileSync(path.join(desktop, f), 'utf8')).join('\n');
    const resetsPath = /process\.env\.PATH\s*=|process\.env\s*=|delete process\.env\.PATH|safeEnvironment|cleanEnvironment|systemPath/.test(sources);
    assert.ok(resetsPath, 'neither start.ts, cliMode.ts nor main.ts sets PATH: CLI mode and the agent run git, osascript and others from whatever PATH the starter chose, under AuthDeck Agent\'s grants');
  });
});
