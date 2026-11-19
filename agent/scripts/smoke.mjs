// End-to-end check against a real agent in --dry-run mode, with its config in a temp folder.
// Usage: npm run build && node scripts/smoke.mjs [--port 47999] [--show-log] [--keep]
// Real calls: apps.list, apps.icons, fs.list, focus.get. Every `run` is dry (nothing is pressed or opened).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const agentDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const portFlag = process.argv.indexOf('--port');
const port = portFlag > 0 ? Number(process.argv[portFlag + 1]) : 47999;
const authdeckHome = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-smoke-'));
const base = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/authdeck/ws`;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${!condition && detail ? ` (${detail})` : ''}`);
}

// Agent process
let agentLog = '';
const agent = spawn(process.execPath, [path.join(agentDir, 'dist/authdeck-agent.cjs'), '--dry-run', '--port', String(port)], {
  env: { ...process.env, AUTHDECK_HOME: authdeckHome },
  stdio: ['ignore', 'pipe', 'pipe'],
});
agent.stdout.on('data', (d) => (agentLog += d));
agent.stderr.on('data', (d) => (agentLog += d));

async function waitFor(predicate, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}. Agent output:\n${agentLog}`);
}

// WebSocket client
class Client {
  constructor() {
    this.events = [];
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, { headers: { Origin: 'http://localhost:8081' } });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('close', () => (this.closed = true));
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event) this.events.push(msg);
        else this.pending.get(msg.id)?.(msg);
      });
    });
  }
  call(method, params = {}) {
    const id = `r${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.ws.close();
  }
}

const errCode = (resp) => (resp.ok ? 'ok' : resp.error.code);
const run = (client, action, cwd) => client.call('run', { action, ...(cwd ? { cwd } : {}) });

try {
  await waitFor(() => fetch(`${base}/authdeck/hello`).then((r) => r.ok, () => false), 15_000, 'the agent to listen');
  const config = JSON.parse(fs.readFileSync(path.join(authdeckHome, 'agent.json'), 'utf8'));
  const pin = config.pin;
  const wrongPin = pin === '000000' ? '111111' : '000000';

  // Discovery
  const hello = await fetch(`${base}/authdeck/hello`, { headers: { Origin: 'http://example.test' } });
  const helloBody = await hello.json();
  check('hello returns agent info', helloBody.app === 'authdeck-agent' && helloBody.port === port && helloBody.protocol === 1 && helloBody.platform === 'macos');
  check('hello has no secrets', !JSON.stringify(helloBody).includes(pin));
  check('hello allows any origin', hello.headers.get('access-control-allow-origin') === '*');
  const preflight = await fetch(`${base}/authdeck/hello`, { method: 'OPTIONS', headers: { Origin: 'http://example.test', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'content-type' } });
  check('hello answers CORS preflight', preflight.status === 204 && /GET/.test(preflight.headers.get('access-control-allow-methods') ?? '') && /content-type/i.test(preflight.headers.get('access-control-allow-headers') ?? ''));
  check('other paths are 404', (await fetch(`${base}/nope`)).status === 404);

  // Auth gate
  const stranger = new Client();
  await stranger.open();
  const early = await stranger.call('apps.list');
  await waitFor(() => stranger.closed, 3000, 'unauthorized socket to close');
  check('request before pair/auth is unauthorized and closes the socket', errCode(early) === 'unauthorized' && stranger.closed);

  // Pairing
  const pairer = new Client();
  await pairer.open();
  const paired = await pairer.call('pair', { pin, deviceId: 'smoke-device', deviceName: 'Smoke Tablet' });
  const token = paired.result?.token;
  check('pair with right PIN returns a 32-byte hex token', paired.ok && /^[0-9a-f]{64}$/.test(token ?? ''));
  check('pair returns agent info', paired.result?.agent?.agentId === config.agentId);
  const storedConfig = JSON.parse(fs.readFileSync(path.join(authdeckHome, 'agent.json'), 'utf8'));
  check('config stores only the token hash', storedConfig.devices.length === 1 && !JSON.stringify(storedConfig).includes(token));
  check('config file is owner-only', (fs.statSync(path.join(authdeckHome, 'agent.json')).mode & 0o077) === 0);
  pairer.close();

  const guesser = new Client();
  await guesser.open();
  const wrong = [];
  for (let i = 0; i < 5; i++) wrong.push(errCode(await guesser.call('pair', { pin: wrongPin, deviceId: 'evil', deviceName: 'Evil' })));
  check('5 wrong PINs each return bad_pin', wrong.every((c) => c === 'bad_pin'), wrong.join(','));
  const afterLock = await guesser.call('pair', { pin, deviceId: 'evil', deviceName: 'Evil' });
  check('pairing is locked after 5 wrong PINs, even with the right PIN', errCode(afterLock) === 'locked', errCode(afterLock));
  guesser.close();

  // Auth
  const badAuth = new Client();
  await badAuth.open();
  check('auth with a wrong token is unauthorized', errCode(await badAuth.call('auth', { token: 'f'.repeat(64), deviceId: 'smoke-device' })) === 'unauthorized');
  badAuth.close();

  const client = new Client();
  await client.open();
  const authed = await client.call('auth', { token, deviceId: 'smoke-device' });
  check('auth with the token works while pairing is locked', authed.ok && authed.result.agent.name === config.name);
  await waitFor(() => client.events.some((e) => e.event === 'focus'), 5000, 'focus event after auth');
  const focusEvent = client.events.find((e) => e.event === 'focus');
  check('focus event arrives after auth', focusEvent.data.supported === true && typeof focusEvent.data.name === 'string');

  const ping = await client.call('ping');
  check('ping', ping.ok && typeof ping.result.time === 'number');

  // apps.list and apps.icons
  const apps = await client.call('apps.list');
  const list = apps.result?.apps ?? [];
  const finder = list.find((a) => a.id === 'mac:/System/Library/CoreServices/Finder.app');
  const safari = list.find((a) => a.name === 'Safari');
  check('apps.list finds Finder and Safari', Boolean(finder && safari), `${list.length} apps`);
  const names = list.map((a) => a.name);
  check('apps.list is sorted by name', names.every((n, i) => i === 0 || names[i - 1].localeCompare(n, undefined, { sensitivity: 'base' }) <= 0));
  check('apps.list has no duplicate ids', new Set(list.map((a) => a.id)).size === list.length);
  const refreshed = await client.call('apps.list', { refresh: true });
  check('apps.list refresh', refreshed.ok && refreshed.result.apps.length === list.length);

  const icons = await client.call('apps.icons', { ids: [finder.id, safari.id, 'mac:/nope.app'] });
  const isPng = (icon) => icon?.mime === 'image/png' && Buffer.from(icon.data, 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  check('apps.icons returns PNGs for Finder and Safari', isPng(icons.result?.icons[finder.id]) && isPng(icons.result?.icons[safari.id]));
  check('apps.icons maps unknown ids to null', icons.result?.icons['mac:/nope.app'] === null);
  for (const [name, app] of [['finder', finder], ['safari', safari]]) {
    fs.writeFileSync(path.join(authdeckHome, `${name}.png`), Buffer.from(icons.result.icons[app.id].data, 'base64'));
  }
  const cachedIcons = await client.call('apps.icons', { ids: [safari.id] });
  check('apps.icons serves from the disk cache', cachedIcons.result?.icons[safari.id]?.data === icons.result.icons[safari.id].data && fs.readdirSync(path.join(authdeckHome, 'icons')).length >= 2);
  check('apps.icons rejects more than 48 ids', errCode(await client.call('apps.icons', { ids: Array.from({ length: 49 }, (_, i) => `x${i}`) })) === 'bad_request');

  // fs.list
  const homeList = await client.call('fs.list');
  check('fs.list defaults to home, folders only, no dot-files', homeList.ok && homeList.result.path === os.homedir() && homeList.result.entries.every((e) => e.kind === 'dir' && !e.name.startsWith('.')));
  check('fs.list roots start with home', homeList.result.roots[0].path === os.homedir() && homeList.result.sep === '/');
  const withFiles = await client.call('fs.list', { path: agentDir, includeFiles: true });
  const kinds = withFiles.result.entries.map((e) => e.kind);
  check('fs.list includeFiles lists folders first, then files', kinds.includes('file') && kinds.indexOf('file') > kinds.lastIndexOf('dir') && withFiles.result.parent === path.dirname(agentDir));
  check('fs.list on a missing folder is not_found', errCode(await client.call('fs.list', { path: '~/definitely-not-here-authdeck' })) === 'not_found');
  const rootList = await client.call('fs.list', { path: '/' });
  check('fs.list at / has no parent', rootList.ok && rootList.result.parent === null);

  // focus.get
  const focus = await client.call('focus.get');
  check('focus.get', focus.ok && focus.result.supported === true && typeof focus.result.name === 'string', JSON.stringify(focus.result));

  // Run (dry)
  const runs = {
    launch: { type: 'launch', appId: safari.id, appName: 'Safari' },
    hotkey: { type: 'hotkey', modifiers: ['mod', 'shift'], key: 't', focusAppId: safari.id },
    'hotkey named key': { type: 'hotkey', modifiers: ['ctrl'], key: 'f5' },
    text: { type: 'text', text: 'say "hi" \\ there', pressEnter: true },
    'command terminal': { type: 'command', command: 'npm run dev', mode: 'terminal', cwd: '~' },
    'command background': { type: 'command', command: 'echo hi', mode: 'background', timeoutSec: 5 },
    url: { type: 'url', url: 'https://example.com/a b' },
    'app url': { type: 'url', url: 'vscode://file/tmp' },
    open: { type: 'open', path: '~' },
    'open with app': { type: 'open', path: agentDir, withAppId: finder.id },
    macro: { type: 'macro', steps: [{ action: { type: 'text', text: 'x' }, delayMs: 10 }, { action: { type: 'hotkey', modifiers: [], key: 'enter' }, delayMs: 0 }] },
  };
  for (const [name, action] of Object.entries(runs)) {
    const resp = await run(client, action, agentDir);
    check(`run ${name}`, resp.ok && typeof resp.result.durationMs === 'number', JSON.stringify(resp.error ?? ''));
  }
  const bg = await run(client, runs['command background']);
  check('background command result has exitCode and output', bg.result.exitCode === 0 && typeof bg.result.output === 'string');

  const bad = {
    'unknown action type': [{ type: 'explode' }, 'bad_request'],
    'invalid key': [{ type: 'hotkey', modifiers: ['mod'], key: 'T' }, 'bad_request'],
    'invalid modifier': [{ type: 'hotkey', modifiers: ['hyper'], key: 't' }, 'bad_request'],
    'unknown app': [{ type: 'launch', appId: 'mac:/Applications/Nope.app', appName: 'Nope' }, 'not_found'],
    'file url': [{ type: 'url', url: 'file:///etc/passwd' }, 'bad_request'],
    'not a url': [{ type: 'url', url: 'example.com' }, 'bad_request'],
    'missing file': [{ type: 'open', path: '~/no-such-file-authdeck.txt' }, 'not_found'],
    'missing cwd': [{ type: 'command', command: 'ls', mode: 'background', cwd: '~/no-such-dir-authdeck' }, 'not_found'],
    'nested macro': [{ type: 'macro', steps: [{ action: { type: 'macro', steps: [] }, delayMs: 0 }] }, 'bad_request'],
  };
  for (const [name, [action, code]] of Object.entries(bad)) {
    const resp = await run(client, action);
    check(`run rejects ${name} with ${code}`, errCode(resp) === code, `${errCode(resp)}: ${resp.error?.message}`);
  }
  const failingMacro = await run(client, { type: 'macro', steps: [{ action: { type: 'text', text: 'a' }, delayMs: 0 }, { action: { type: 'launch', appId: 'mac:/x.app', appName: 'Ghost' }, delayMs: 0 }] });
  check('macro failure names the step', errCode(failingMacro) === 'not_found' && /^Step 2 of 2/.test(failingMacro.error.message), failingMacro.error?.message);

  client.close();
  await new Promise((r) => setTimeout(r, 300));

  // Agent log
  check('log shows dry-run OS commands', /\[dry-run\] run: open -a \/Applications\/Safari\.app/.test(agentLog) && /\[dry-run\] run: osascript/.test(agentLog));
  check('log has one line per action with ok/error and duration', /Smoke Tablet {2}launch Safari {2}ok {2}\d+ ms/.test(agentLog) && /error not_found/.test(agentLog));
  check('log never contains the token', !agentLog.includes(token));
  check('log never contains typed text', !agentLog.includes('say "hi"'));
} catch (err) {
  failures.push(String(err?.stack ?? err));
  console.error(err);
} finally {
  agent.kill('SIGTERM');
}

await new Promise((resolve) => agent.once('exit', resolve));
console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length > 0 || process.argv.includes('--show-log')) {
  console.log(`\nAgent output:\n${agentLog}`);
  process.exit(1);
}
if (process.argv.includes('--keep')) console.log(`Config, icon cache and finder.png / safari.png kept in ${authdeckHome}`);
else fs.rmSync(authdeckHome, { recursive: true, force: true });
