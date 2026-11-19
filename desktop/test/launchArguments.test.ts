import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHROMIUM_LAUNCH_SWITCHES, launchMode, refusedSwitches, refusedWords, type LaunchContext } from '../src/main/launchArguments.ts';

const APP = '/Applications/AuthDeck Agent.app/Contents/MacOS/AuthDeck Agent';
const mac: LaunchContext = { platform: 'darwin', defaultApp: false };
const linux: LaunchContext = { platform: 'linux', defaultApp: false };
const windows: LaunchContext = { platform: 'win32', defaultApp: false };

describe('launch arguments', () => {
  it('starts the app with no arguments, or with what the sign-in entries and macOS add', () => {
    for (const context of [mac, linux, windows]) {
      assert.deepEqual(launchMode([APP], context), { mode: 'app' });
      assert.deepEqual(launchMode([APP, '--hidden'], context), { mode: 'app' });
    }
    assert.deepEqual(launchMode([APP, '-psn_0_1234567'], mac), { mode: 'app' });
  });

  it('skips the app folder under `electron .` in development', () => {
    assert.deepEqual(launchMode(['/dev/electron', '.', '--hidden'], { platform: 'darwin', defaultApp: true }), { mode: 'app' });
    assert.deepEqual(launchMode(['/dev/electron', '.', '--gpu-launcher=x'], { platform: 'darwin', defaultApp: true }), { mode: 'refused', argument: '--gpu-launcher=x' });
  });

  it('runs the command for exactly --authdeck-cli -- and passes anything after it', () => {
    assert.deepEqual(launchMode([APP, '--authdeck-cli', '--', 'env', 'ls', '--gpu-launcher=x'], mac), { mode: 'cli', args: ['env', 'ls', '--gpu-launcher=x'] });
    assert.deepEqual(launchMode([APP, '--authdeck-cli', '--'], linux), { mode: 'cli', args: [] });
  });

  it("refuses Chromium's launcher, debugging and sandbox switches, in any spelling", () => {
    for (const name of CHROMIUM_LAUNCH_SWITCHES) {
      for (const argument of [`--${name}`, `--${name}=/tmp/evil`, `-${name}=1`]) {
        assert.deepEqual(launchMode([APP, argument], mac), { mode: 'refused', argument }, argument);
        assert.deepEqual(launchMode([APP, '--hidden', argument], windows), { mode: 'refused', argument }, argument);
      }
    }
  });

  it('takes --no-sandbox on Linux only, where AppImages may need it', () => {
    assert.deepEqual(launchMode([APP, '--no-sandbox'], linux), { mode: 'app' });
    assert.deepEqual(launchMode([APP, '--hidden', '--no-sandbox'], linux), { mode: 'app' });
    assert.ok(!refusedSwitches('linux').includes('no-sandbox'));
    assert.ok(refusedSwitches('darwin').includes('no-sandbox'));
    assert.ok(refusedSwitches('linux').includes('gpu-launcher'));
  });

  it('refuses any other argument, and CLI mode spelled any other way', () => {
    for (const argument of ['--inspect=9229', '--enable-logging', 'evil.js', '.', '--', '-psn_x', '--HIDDEN', '--hidden=1']) {
      assert.deepEqual(launchMode([APP, argument], mac), { mode: 'refused', argument }, argument);
    }
    assert.deepEqual(launchMode([APP, '-psn_0_1234567'], linux), { mode: 'refused', argument: '-psn_0_1234567' });
    assert.deepEqual(launchMode([APP, '--authdeck-cli', 'env', 'ls'], mac), { mode: 'refused', argument: '--authdeck-cli' });
    assert.deepEqual(launchMode([APP, '--gpu-launcher=x', '--authdeck-cli', '--'], mac), { mode: 'refused', argument: '--gpu-launcher=x' });
  });

  it('names a refused argument in one short line', () => {
    assert.equal(refusedWords('--gpu-launcher=/usr/bin/true'), 'AuthDeck Agent doesn\'t take the argument "--gpu-launcher=/usr/bin/true", so it didn\'t start. Open it from its app icon, or run the authdeck command.');
    assert.ok(refusedWords(`--x=${'a'.repeat(500)}`).length < 220);
  });
});
