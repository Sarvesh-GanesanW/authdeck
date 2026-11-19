import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FocusTracker, focusSupported, matchLinuxApp, matchMacApp, matchWindowsApp, parseLsappinfo, parseWmClass } from '../src/focus';
import type { FocusInfo } from '../src/protocol';
import { linuxCode, macSafari, winCalculator, winCode } from './helpers/context';

describe('focus parsing and matching', () => {
  it('parses lsappinfo output', () => {
    const output = `"Google Chrome" ASN:0x0-0x49049: (in front) \n    bundleID="com.google.Chrome"\n    bundle path="/Applications/Google Chrome.app"\n    executable path=[ NULL ] \n`;
    assert.deepEqual(parseLsappinfo(output), { name: 'Google Chrome', bundleId: 'com.google.Chrome', bundlePath: '/Applications/Google Chrome.app' });
    assert.deepEqual(parseLsappinfo('[ NULL ]  ASN:0x0-0x1:\n    bundleID=[ NULL ] \n'), { name: '', bundleId: null, bundlePath: null });
  });

  it('matches macOS apps by bundle path, then bundle id (Safari lives behind a symlink)', () => {
    assert.deepEqual(matchMacApp([macSafari], { name: 'Safari', bundleId: null, bundlePath: '/Applications/Safari.app' }), { supported: true, appId: macSafari.entry.id, name: 'Safari' });
    assert.equal(matchMacApp([macSafari], { name: 'Safari', bundleId: 'com.apple.Safari', bundlePath: '/System/Cryptexes/App/System/Applications/Safari.app' }).appId, macSafari.entry.id);
    assert.deepEqual(matchMacApp([macSafari], { name: 'Ghostty', bundleId: 'x', bundlePath: '/Applications/Ghostty.app' }), { supported: true, appId: null, name: 'Ghostty' });
  });

  it('matches Windows apps by AUMID, then by link target exe (case-insensitive)', () => {
    assert.equal(matchWindowsApp([winCode, winCalculator], { exe: 'C:\\Program Files\\WindowsApps\\calc.exe', aumid: 'microsoft.windowscalculator_8wekyb3d8bbwe!app', name: 'Calculator' }).appId, winCalculator.entry.id);
    assert.equal(matchWindowsApp([winCode], { exe: 'c:\\users\\ada\\appdata\\local\\programs\\microsoft vs code\\code.exe', aumid: null, name: 'Visual Studio Code' }).appId, winCode.entry.id);
    assert.deepEqual(matchWindowsApp([winCode], { exe: 'C:\\x.exe', aumid: null, name: 'X Tool' }), { supported: true, appId: null, name: 'X Tool' });
  });

  it('parses xprop WM_CLASS', () => {
    assert.deepEqual(parseWmClass('WM_CLASS(STRING) = "code", "Code"\n'), ['code', 'Code']);
    assert.deepEqual(parseWmClass('WM_CLASS:  not found.\n'), []);
  });

  it('matches Linux apps by StartupWMClass, then Exec name, then process exe', () => {
    assert.equal(matchLinuxApp([linuxCode], { wmClass: ['code', 'Code'], exeName: null }).appId, linuxCode.entry.id);
    const noClass = { ...linuxCode, desktop: { ...(linuxCode as { desktop: object }).desktop, startupWMClass: null } } as typeof linuxCode;
    assert.equal(matchLinuxApp([noClass], { wmClass: ['code', 'Code'], exeName: null }).appId, linuxCode.entry.id);
    assert.equal(matchLinuxApp([noClass], { wmClass: [], exeName: 'code' }).appId, linuxCode.entry.id);
    assert.deepEqual(matchLinuxApp([noClass], { wmClass: ['xterm', 'XTerm'], exeName: 'xterm' }), { supported: true, appId: null, name: 'XTerm' });
  });

  it('is unsupported on Wayland or without xdotool, supported elsewhere', () => {
    assert.equal(focusSupported({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' }, hasTool: () => true }), false);
    assert.equal(focusSupported({ platform: 'linux', env: {}, hasTool: () => false }), false);
    assert.equal(focusSupported({ platform: 'linux', env: {}, hasTool: () => true }), true);
    assert.equal(focusSupported({ platform: 'macos', env: {}, hasTool: () => false }), true);
  });
});

describe('FocusTracker', () => {
  it('polls only while clients are connected and broadcasts changes', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const answers: FocusInfo[] = [
      { supported: true, appId: 'a', name: 'A' },
      { supported: true, appId: 'a', name: 'A' },
      { supported: true, appId: 'b', name: 'B' },
    ];
    let probes = 0;
    const sent: FocusInfo[] = [];
    const tracker = new FocusTracker(async () => answers[Math.min(probes++, answers.length - 1)]!, (info) => sent.push(info), true, () => {});
    t.mock.timers.tick(5000);
    assert.equal(probes, 0, 'no polling without clients');
    tracker.clientConnected();
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(1000);
      await new Promise((r) => setImmediate(r));
    }
    assert.deepEqual(sent.map((s) => s.appId), ['a', 'b']);
    tracker.clientDisconnected();
    const before = probes;
    t.mock.timers.tick(5000);
    assert.equal(probes, before, 'polling stopped');
  });

  it('reports a probe failure as unknown focus instead of throwing', async () => {
    const errors: unknown[] = [];
    const tracker = new FocusTracker(async () => { throw new Error('boom'); }, () => {}, true, (e) => errors.push(e));
    assert.deepEqual(await tracker.current(), { supported: true, appId: null, name: '' });
    assert.equal(errors.length, 1);
  });
});
