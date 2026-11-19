import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseArgs, UsageError } from '../src/args';
import { normalizeUrl } from '../src/actions/url';
import { summarizeAction } from '../src/actions/summary';
import { autostartFile, launchAgentPlist, legacyAutostartFile, linuxAutostartDesktop, windowsStartupScript } from '../src/autostart';
import { expandExecArgs, parseDesktopEntry, tokenizeExec } from '../src/apps/desktopFile';
import { parsePlistXmlStrings, macAppName } from '../src/apps/mac';
import { lanAddresses, pairUrl, qrModules } from '../src/banner';
import { carryOverLegacyHome, configPath, friendlyHostname, generatePin, linkKeyPath, loadConfig, loadLinkKey, saveConfig, authdeckHome } from '../src/config';
import { AgentError } from '../src/errors';
import { classifyFailure, macHostAppName } from '../src/failures';
import { resolveUserPath } from '../src/host';

describe('url validation', () => {
  it('accepts web and app links and normalises them', () => {
    assert.equal(normalizeUrl('https://example.com/a b?q="x"'), 'https://example.com/a%20b?q=%22x%22');
    assert.equal(normalizeUrl('vscode://file/home/a'), 'vscode://file/home/a');
    assert.equal(normalizeUrl('slack://open'), 'slack://open');
    assert.equal(normalizeUrl('mailto:a@b.c'), 'mailto:a@b.c');
  });

  it('rejects file links, drive letters and text without a scheme', () => {
    for (const bad of ['file:///etc/passwd', 'FILE:///x', 'C:\\Windows\\notepad.exe', 'example.com', '']) {
      assert.throws(() => normalizeUrl(bad), (err: AgentError) => err.code === 'bad_request', bad);
    }
  });
});

describe('pairing banner', () => {
  it('encodes the pairing link as a square QR matrix with finder patterns', () => {
    const modules = qrModules(pairUrl({ name: 'MacBook Pro', port: 47474, hosts: ['192.168.1.24'], linkKey: new Uint8Array(32).fill(7), pairSecret: 'c2VjcmV0LXNlY3JldC0xMg' }));
    assert.ok(modules.length >= 21);
    assert.ok(modules.every((row) => row.length === modules.length));
    assert.deepEqual(modules[0]!.slice(0, 7), Array(7).fill(true));
    assert.equal(modules[1]![1], false);
  });

  it('lists LAN IPv4 addresses, physical interfaces first, skipping internal and link-local', () => {
    const iface = (address: string, internal = false, family: 'IPv4' | 'IPv6' = 'IPv4') => ({ address, internal, family, netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo;
    const addresses = lanAddresses({
      lo0: [iface('127.0.0.1', true)],
      bridge100: [iface('192.168.64.1')],
      en0: [iface('fe80::1', false, 'IPv6'), iface('192.168.1.20')],
      'vEthernet (WSL)': [iface('172.20.0.1')],
      'Wi-Fi': [iface('10.0.0.5')],
      en5: [iface('169.254.3.3')],
    });
    assert.deepEqual(addresses, ['192.168.1.20', '10.0.0.5', '192.168.64.1', '172.20.0.1']);
  });

  it('builds the pairing link with URL-encoded values, the link key and the secret, and no PIN', () => {
    const url = pairUrl({ name: "Ada's Mac & PC", port: 47474, hosts: ['192.168.1.2', '10.0.0.5'], linkKey: new Uint8Array(32), pairSecret: 'abc-_' });
    assert.equal(url, `authdeck://pair?v=2&n=Ada's%20Mac%20%26%20PC&p=47474&h=192.168.1.2,10.0.0.5&k=${'A'.repeat(43)}&s=abc-_`);
  });
});

describe('config', () => {
  it('creates config once with a random id and a 6-digit PIN, owner-only', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-config-'));
    const first = loadConfig(home);
    assert.match(first.pin, /^\d{6}$/);
    assert.equal(first.port, 47474);
    assert.deepEqual(loadConfig(home), first);
    if (process.platform !== 'win32') assert.equal(fs.statSync(configPath(home)).mode & 0o777, 0o600);
    saveConfig(home, { ...first, terminal: 'iTerm' });
    assert.equal(loadConfig(home).terminal, 'iTerm');
  });

  it('makes the link key once, owner-only, apart from agent.json', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-config-'));
    const first = loadLinkKey(home);
    assert.equal(first.public.length, 32);
    assert.deepEqual(loadLinkKey(home), first);
    if (process.platform !== 'win32') assert.equal(fs.statSync(linkKeyPath(home)).mode & 0o777, 0o600);
    assert.match(loadConfig(home).pairSecret, /^[A-Za-z0-9_-]{22}$/);
    assert.ok(!fs.readFileSync(configPath(home), 'utf8').includes(fs.readFileSync(linkKeyPath(home), 'utf8').trim()));
    fs.writeFileSync(linkKeyPath(home), 'short');
    assert.throws(() => loadLinkKey(home), /damaged.*pair again/);
  });

  it('explains how to recover from a broken config file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-config-'));
    fs.writeFileSync(configPath(home), '{ nope');
    assert.throws(() => loadConfig(home), /not valid JSON.*delete it/);
  });

  it('PINs are 6 digits with leading zeros kept', () => {
    for (let i = 0; i < 200; i++) assert.match(generatePin(), /^\d{6}$/);
  });

  it('friendly hostnames drop .local', () => {
    assert.equal(friendlyHostname('Adas-MacBook-Pro.local'), 'Adas-MacBook-Pro');
    assert.equal(friendlyHostname('build-box'), 'build-box');
  });
});

describe('carrying settings over from the old name', () => {
  function userHomeWithLegacyConfig(): { userHome: string; legacyHome: string } {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-userhome-'));
    const legacyHome = path.join(userHome, '.devdeck');
    saveConfig(legacyHome, { ...loadConfig(legacyHome), name: 'Old pairing' });
    fs.mkdirSync(path.join(legacyHome, 'icons'));
    fs.writeFileSync(path.join(legacyHome, 'icons', 'safari.png'), 'png');
    return { userHome, legacyHome };
  }

  it('copies ~/.devdeck to ~/.authdeck and leaves the old folder in place', () => {
    const { userHome, legacyHome } = userHomeWithLegacyConfig();
    assert.equal(carryOverLegacyHome({}, userHome), legacyHome);
    const home = authdeckHome({}, userHome);
    assert.equal(home, path.join(userHome, '.authdeck'));
    assert.deepEqual(loadConfig(home), loadConfig(legacyHome));
    assert.equal(fs.readFileSync(path.join(home, 'icons', 'safari.png'), 'utf8'), 'png');
    assert.ok(fs.existsSync(configPath(legacyHome)));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(home).mode & 0o777, 0o700);
      assert.equal(fs.statSync(configPath(home)).mode & 0o777, 0o600);
    }
    assert.deepEqual(fs.readdirSync(userHome).sort(), ['.authdeck', '.devdeck']);
  });

  it('never overwrites an existing ~/.authdeck', () => {
    const { userHome } = userHomeWithLegacyConfig();
    const home = authdeckHome({}, userHome);
    saveConfig(home, { ...loadConfig(home), name: 'New pairing' });
    assert.equal(carryOverLegacyHome({}, userHome), null);
    assert.equal(loadConfig(home).name, 'New pairing');
  });

  it('does nothing without an old folder or when AUTHDECK_HOME is set', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-userhome-'));
    assert.equal(carryOverLegacyHome({}, empty), null);
    assert.deepEqual(fs.readdirSync(empty), []);
    const { userHome } = userHomeWithLegacyConfig();
    assert.equal(carryOverLegacyHome({ AUTHDECK_HOME: path.join(userHome, 'elsewhere') }, userHome), null);
    assert.ok(!fs.existsSync(path.join(userHome, '.authdeck')));
  });
});

describe('paths', () => {
  it('expands ~ and resolves relative paths against home on each platform', () => {
    assert.equal(resolveUserPath('~', '/home/ada', 'linux'), '/home/ada');
    assert.equal(resolveUserPath('~/code/x', '/home/ada', 'linux'), '/home/ada/code/x');
    assert.equal(resolveUserPath('code', '/home/ada', 'linux'), '/home/ada/code');
    assert.equal(resolveUserPath('/etc', '/home/ada', 'linux'), '/etc');
    assert.equal(resolveUserPath('~\\code', 'C:\\Users\\Ada', 'windows'), 'C:\\Users\\Ada\\code');
    assert.equal(resolveUserPath('~/code', 'C:\\Users\\Ada', 'windows'), 'C:\\Users\\Ada\\code');
    assert.equal(resolveUserPath('D:\\work', 'C:\\Users\\Ada', 'windows'), 'D:\\work');
  });
});

describe('autostart files', () => {
  const target = { node: '/usr/local/bin/node', script: '/home/ada/My Tools/authdeck-agent.cjs' };

  it('macOS LaunchAgent runs node with the script at login', () => {
    const plist = launchAgentPlist({ node: '/opt/node & co/node', script: '/x.cjs' }, '/Users/ada/.authdeck/agent.log');
    assert.match(plist, /<string>\/opt\/node &amp; co\/node<\/string>\s*<string>\/x\.cjs<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<string>dev\.authdeck\.agent\.cli<\/string>/);
  });

  it('Windows startup script runs hidden with correctly doubled quotes', () => {
    const vbs = windowsStartupScript({ node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\Ada\\authdeck-agent.cjs' });
    assert.match(vbs, /CreateObject\("WScript\.Shell"\)\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\Ada\\authdeck-agent\.cjs""", 0, False/);
  });

  it('Linux autostart entry has an Exec line that parses back to node + script', () => {
    const fields = parseDesktopEntry(linuxAutostartDesktop(target));
    assert.equal(fields.get('Type'), 'Application');
    assert.deepEqual(expandExecArgs(tokenizeExec(fields.get('Exec')!)), [target.node, target.script]);
  });

  it('puts the file in the per-OS autostart location', () => {
    assert.equal(autostartFile('macos', '/Users/ada', {}), '/Users/ada/Library/LaunchAgents/dev.authdeck.agent.cli.plist');
    assert.equal(autostartFile('linux', '/home/ada', {}), '/home/ada/.config/autostart/authdeck-agent.desktop');
    assert.equal(autostartFile('windows', 'C:\\Users\\Ada', { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' }), 'C:\\Users\\Ada\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\AuthDeck Agent.vbs');
  });

  it('knows where the pre-rename agent put its sign-in file', () => {
    assert.equal(legacyAutostartFile('macos', '/Users/ada', {}), '/Users/ada/Library/LaunchAgents/com.devdeck.agent.plist');
    assert.equal(legacyAutostartFile('linux', '/home/ada', { XDG_CONFIG_HOME: '/home/ada/.cfg' }), '/home/ada/.cfg/autostart/devdeck-agent.desktop');
    assert.equal(legacyAutostartFile('windows', 'C:\\Users\\Ada', {}), 'C:\\Users\\Ada\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\DevDeck Agent.vbs');
  });
});

describe('error messages', () => {
  it('maps the macOS Accessibility refusal to permission with a fix naming the host app', () => {
    const err = classifyFailure('mac-keystrokes', 'osascript', 'press the keys', 'execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)', 'Terminal');
    assert.equal(err.code, 'permission');
    assert.equal(err.permission, 'accessibility');
    assert.equal(err.hint, 'Open System Settings → Privacy & Security → Accessibility and turn on Terminal, then try again.');
    assert.equal(classifyFailure('mac-keystrokes', 'osascript', 'x', 'error (-1719)', 'node').code, 'permission');
    assert.equal(classifyFailure('mac-keystrokes', 'osascript', 'x', 'error -25211', 'node').code, 'permission');
  });

  it('maps the macOS Automation refusal for terminal windows', () => {
    const err = classifyFailure('mac-terminal', 'osascript', 'open Terminal', 'Not authorized to send Apple events to Terminal. (-1743)', 'AuthDeck Agent');
    assert.equal(err.code, 'permission');
    assert.equal(err.permission, 'automation');
    assert.match(err.hint!, /allow AuthDeck Agent to control/);
    assert.match(err.hint!, /Automation/);
  });

  it('maps wtype on a compositor without virtual keyboards to unsupported, suggesting ydotool', () => {
    const err = classifyFailure('wtype', 'wtype', 'press the keys', 'Compositor does not support the virtual keyboard protocol', 'node');
    assert.equal(err.code, 'unsupported');
    assert.match(err.hint!, /ydotool/);
  });

  it('falls back to the tool and its last stderr line', () => {
    const err = classifyFailure('plain', 'open', 'open Safari', 'LSOpenURLsWithRole() failed\nUnable to find application named "X"\n', 'node');
    assert.equal(err.message, 'open could not open Safari: Unable to find application named "X"');
  });

  it('names the macOS host app from TERM_PROGRAM', () => {
    assert.equal(macHostAppName({ TERM_PROGRAM: 'iTerm.app' }), 'iTerm');
    assert.equal(macHostAppName({}), 'node');
  });
});

describe('cli args', () => {
  it('parses commands and options', () => {
    assert.deepEqual(parseArgs([]), { kind: 'run', port: undefined, dryRun: false });
    assert.deepEqual(parseArgs(['--port', '5000', '--dry-run']), { kind: 'run', port: 5000, dryRun: true });
    assert.deepEqual(parseArgs(['--port=5001']), { kind: 'run', port: 5001, dryRun: false });
    assert.deepEqual(parseArgs(['pair']), { kind: 'pair', port: undefined });
    assert.deepEqual(parseArgs(['pair', '--port', '5002']), { kind: 'pair', port: 5002 });
    assert.deepEqual(parseArgs(['devices']), { kind: 'devices', revokeAll: false });
    assert.deepEqual(parseArgs(['devices', '--revoke-all']), { kind: 'devices', revokeAll: true });
    assert.deepEqual(parseArgs(['autostart', 'disable']), { kind: 'autostart', enable: false });
    assert.deepEqual(parseArgs(['--help']), { kind: 'help' });
  });

  it('rejects bad input with usage errors', () => {
    for (const bad of [['--port', 'abc'], ['--port', '70000'], ['--bogus'], ['pin'], ['pin', '--new'], ['pair', '--dry-run'], ['autostart', 'maybe'], ['devices', '--all']]) {
      assert.throws(() => parseArgs(bad), UsageError, bad.join(' '));
    }
  });
});

describe('macOS bundle names', () => {
  it('prefers CFBundleDisplayName, then CFBundleName, then the folder name', () => {
    assert.equal(macAppName({ CFBundleDisplayName: 'Shown', CFBundleName: 'Name' }, '/A/x.app'), 'Shown');
    assert.equal(macAppName({ CFBundleDisplayName: ' ', CFBundleName: 'Name' }, '/A/x.app'), 'Name');
    assert.equal(macAppName({}, '/Applications/Folder Name.app'), 'Folder Name');
  });

  it('reads strings from XML plists (fallback for plists JSON cannot express)', () => {
    const xml = '<dict><key>CFBundleName</key>\n<string>Tom &amp; Jerry</string><key>CFBundleIdentifier</key><string>com.x</string><key>Date</key><date>2020</date></dict>';
    assert.deepEqual(parsePlistXmlStrings(xml), { CFBundleName: 'Tom & Jerry', CFBundleIdentifier: 'com.x' });
  });
});

describe('action log summaries', () => {
  it('never includes typed text', () => {
    assert.equal(summarizeAction({ type: 'text', text: 'hunter2', pressEnter: true }), 'type text (7 chars) + enter');
    assert.equal(summarizeAction({ type: 'macro', steps: [{}] }), 'macro (1 step)');
    assert.equal(summarizeAction(null), 'invalid action');
  });
});
