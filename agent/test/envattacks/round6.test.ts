// Security review of env sets (0.4), round 6: CLI and desktop. Each test is a proof of concept for
// one finding: it fails while the weakness is there and passes once it is fixed. Ids match the report.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { formatDotenv, parseDotenv } from '../../src/envcli/dotenv';

describe('ENV-25: a value written by `authdeck env pull` runs as a command when the .env is sourced by a shell', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'envattacks-r6-')));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a member's value with a quote and $(...) stays data under `set -a; . ./.env`", () => {
    // Mallory, a member, sets an ordinary name to this. It has a ' so pull writes it double-quoted,
    // escaping only \ and ": the $( ) is left for the shell.
    const marker = path.join(dir, 'ran');
    const value = `it's $(touch ${marker})`;
    const text = formatDotenv([{ name: 'GREETING', value }]);
    assert.deepEqual(parseDotenv(text), { ok: true, values: [{ name: 'GREETING', value }] }, 'control: dotenv readers get the value back exactly');
    fs.writeFileSync(path.join(dir, '.env'), text);
    // How many projects load a .env: Makefiles, scripts, `set -a; . ./.env; set +a`.
    execFileSync('/bin/sh', ['-c', 'set -a; . ./.env; set +a'], { cwd: dir });
    assert.equal(fs.existsSync(marker), false, `sourcing the pulled .env ran Mallory's command (line: ${text.trim().split('\n').pop()})`);
  });
});

describe('ENV-26: the packaged agent app is a general Node runtime for any local process (Electron RunAsNode fuse on)', () => {
  const desktop = path.resolve(process.cwd(), '../desktop');

  it('the build turns RunAsNode off and the hardened runtime on, and the authdeck launchers do not depend on ELECTRON_RUN_AS_NODE', () => {
    const pkg = fs.readFileSync(path.join(desktop, 'package.json'), 'utf8');
    const scripts = fs.readdirSync(path.join(desktop, 'scripts')).map((f) => fs.readFileSync(path.join(desktop, 'scripts', f), 'utf8')).join('\n');
    const fusesFlipped = /RunAsNode\]?\s*:\s*false/.test(pkg + scripts);
    const launchers = ['src/cli/authdeck', 'src/cli/authdeck.cmd', 'src/main/cliPath.ts'].filter((f) => fs.readFileSync(path.join(desktop, f), 'utf8').includes('ELECTRON_RUN_AS_NODE=1'));
    // Without the hardened runtime, DYLD_INSERT_LIBRARIES does the same, fuses or not.
    const hardened = (JSON.parse(pkg) as { build: { mac: { hardenedRuntime?: boolean } } }).build.mac.hardenedRuntime !== false;
    assert.ok(
      fusesFlipped && launchers.length === 0 && hardened,
      `RunAsNode fuse flipped off: ${fusesFlipped}; hardened runtime: ${hardened}; launchers that need it: ${launchers.join(', ') || 'none'}. Any local process can run ` +
        '`ELECTRON_RUN_AS_NODE=1 "AuthDeck Agent.app/Contents/MacOS/AuthDeck Agent" its.js` and act with the Accessibility and Automation grants the person gave AuthDeck Agent',
    );
  });
});
