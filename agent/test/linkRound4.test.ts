/**
 * The fourth review of the link: an emitter with no 'error' listener stopped the agent (a reset
 * during a refused upgrade), and one paired device could open connections without limit.
 */
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ActionRunner } from '../src/actions/runner';
import { startAgent } from '../src/agent';
import { AppCatalog } from '../src/apps/catalog';
import { friendlyHostname, loadConfig, MAX_COMPUTER_NAME_CHARS, updateConfig, watchConfig } from '../src/config';
import { LINK_KEY_WORD_COUNT, linkKeyWords } from '../src/link/keys';
import { keyWords } from '../src/vault/crypto';
import type { AgentEvent } from '../src/events';
import type { FocusTracker } from '../src/focus';
import type { IconService } from '../src/icons/service';
import { MAX_CAPTURE_CHARS, runProcess } from '../src/proc';
import { WinHelper } from '../src/platform/winHelper';
import { isServableIcon, MAX_ICON_PIXELS, MAX_ICON_PNG_BYTES, pngSize } from '../src/icons/png';
import { printableName } from '../src/pairing';
import { clip, RESULT_LIMITS, sendableApps, sendableFocus, sendableListing } from '../src/resultLimits';
import { AgentError } from '../src/errors';
import { isFocusInfo, isMethodResult, isProtocolError, LIMITS as APP_LIMITS } from '../../app/src/net/messages';
import { PROTOCOL_VERSION, WS_PATH, type RunParams } from '../src/protocol';
import { AgentServer, logSafe, MAX_PENDING_CONNECTIONS, MAX_SESSIONS_PER_DEVICE, MAX_SIGNED_IN, RESERVED_FOR_KNOWN } from '../src/server';
import { connectDevice, newDeviceKey, pairByQr, type LinkedDevice } from './helpers/link';
import { agentLinkKey, testConfig, testPairing } from './helpers/server';

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer() {
  const catalog = new AppCatalog(async () => []);
  await catalog.rescan();
  const linkKey = agentLinkKey();
  const store = testPairing(testConfig());
  const events: AgentEvent[] = [];
  const server = new AgentServer({
    agentInfo: { agentId: 'agent', name: 'Mac', platform: 'macos', version: '0.0.0', protocol: PROTOCOL_VERSION },
    port: 0,
    home: os.tmpdir(),
    platform: 'macos',
    pairing: store.pairing,
    linkKey,
    catalog,
    icons: {} as IconService,
    runner: { run: async (_params: RunParams) => ({ durationMs: 1 }) } as unknown as ActionRunner,
    focus: { clientConnected() {}, clientDisconnected() {}, current: async () => ({ supported: false, appId: null, name: '' }) } as unknown as FocusTracker,
    vaults: {} as never,
    log: () => {},
    emit: (event) => events.push(event),
  });
  const port = await server.listen();
  return { server, port, linkKey, store, events };
}

function watchProcess() {
  const escaped: unknown[] = [];
  const onError = (err: unknown) => escaped.push(err);
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
  return {
    escaped,
    stop: () => {
      process.off('uncaughtException', onError);
      process.off('unhandledRejection', onError);
    },
  };
}

const UPGRADE = (pathname: string, origin?: string) =>
  `GET ${pathname} HTTP/1.1\r\nHost: x\r\n${origin ? `Origin: ${origin}\r\n` : ''}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;

/** Sends `request` and resets the connection (RST), at once or as the answer starts arriving. */
async function sendAndReset(port: number, request: string, count: number): Promise<void> {
  const done: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    done.push(
      new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.on('error', () => {});
        socket.on('close', () => resolve());
        socket.on('connect', () => {
          socket.write(request);
          if (i % 2 === 0) socket.resetAndDestroy();
          else socket.once('data', () => socket.resetAndDestroy());
        });
      }),
    );
    if (i % 25 === 0) await settle(5);
  }
  await Promise.all(done);
}

describe('a peer resetting a refused connection', () => {
  for (const [name, request] of [
    ['404 (wrong path)', UPGRADE('/nope')],
    ['403 (a web page from another site)', UPGRADE(WS_PATH, 'http://evil.example')],
    ['plain GET', 'GET /authdeck/hello HTTP/1.1\r\nHost: x\r\n\r\n'],
  ] as const) {
    it(`never stops the agent: ${name} (the review PoC)`, async () => {
      const t = await startServer();
      const watch = watchProcess();
      try {
        await sendAndReset(t.port, request, 300);
        await settle(300);
        const hello = await fetch(`http://127.0.0.1:${t.port}/authdeck/hello`);
        assert.equal(hello.status, 200);
        await hello.body?.cancel();
        assert.deepEqual(watch.escaped, []);
      } finally {
        watch.stop();
        await t.server.close();
      }
    });
  }

  it('never stops the agent: 503 (over the overall limit)', async () => {
    const t = await startServer();
    const watch = watchProcess();
    const unfinished = (t.server as unknown as { unfinishedRequests: Map<object, { address: string; since: number }> }).unfinishedRequests;
    try {
      // Strangers elsewhere fill the slots strangers may use; 127.0.0.1 has never signed in.
      for (let i = 0; i < MAX_PENDING_CONNECTIONS - RESERVED_FOR_KNOWN; i++) unfinished.set({ destroy() {} }, { address: `10.1.${Math.floor(i / 4)}.${i % 4}`, since: Date.now() + 60_000 });
      await sendAndReset(t.port, UPGRADE(WS_PATH), 200);
      await settle(300);
      assert.deepEqual(watch.escaped, []);
    } finally {
      unfinished.clear();
      watch.stop();
      await t.server.close();
    }
  });
});

describe('child processes', () => {
  it('a program that cannot be started rejects; nothing is left unheard', async () => {
    const watch = watchProcess();
    try {
      await assert.rejects(runProcess('/nonexistent/authdeck-test-program', []), /ENOENT/);
      await settle(100);
      assert.deepEqual(watch.escaped, []);
    } finally {
      watch.stop();
    }
  });

  it('a program that exits without reading its input is not an error', async () => {
    const outcome = await runProcess(process.execPath, ['-e', 'process.exit(3)'], { input: 'x'.repeat(1_000_000) });
    assert.equal(outcome.exitCode, 3);
  });
});

describe('capturing a chatty program', () => {
  it(`keeps at most ${MAX_CAPTURE_CHARS} characters of its output`, async () => {
    const script = `const line = 'y'.repeat(1 << 16) + '\\n'; let left = ${2 * MAX_CAPTURE_CHARS}; (function more() { while (left > 0) { left -= line.length; if (!process.stdout.write(line)) return process.stdout.once('drain', more); } })();`;
    const outcome = await runProcess(process.execPath, ['-e', script]);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.stdout.length, MAX_CAPTURE_CHARS);
  });
});

describe('the config watch', () => {
  it('falls back to checking the file when the folder cannot be watched', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-watch-'));
    const realWatch = fs.watch;
    (fs as { watch: unknown }).watch = () => {
      throw Object.assign(new Error('too many watches'), { code: 'ENOSPC' });
    };
    let changes = 0;
    let stop: () => void;
    try {
      stop = watchConfig(home, () => changes++);
    } finally {
      (fs as { watch: unknown }).watch = realWatch;
    }
    try {
      fs.writeFileSync(path.join(home, 'agent.json'), '{}');
      await settle(2500);
      fs.writeFileSync(path.join(home, 'agent.json'), '{"name":"x"}');
      await settle(2500);
      assert.ok(changes >= 1);
    } finally {
      stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the Windows input helper', () => {
  it('tries to start again after a start that failed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-helper-'));
    const blocked = path.join(dir, 'file');
    fs.writeFileSync(blocked, '');
    const helper = new WinHelper(path.join(blocked, 'scripts'));
    try {
      await assert.rejects(helper.request({ op: 'ping' } as never), /could not start/);
      fs.rmSync(blocked);
      // The second try gets past the script write: it now fails (or works) on PowerShell itself.
      await assert.rejects(helper.request({ op: 'ping' } as never), (err: Error) => !/could not start: .*(ENOTDIR|EEXIST)/.test(err.message));
    } finally {
      helper.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a paired device opening many connections', () => {
  it(`keeps at most ${MAX_SESSIONS_PER_DEVICE}: the newest win`, async () => {
    const t = await startServer();
    try {
      const key = newDeviceKey();
      (await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, key, { deviceId: 'pad', deviceName: 'Pad' })).close();
      const sessions: LinkedDevice[] = [];
      for (let i = 0; i < MAX_SESSIONS_PER_DEVICE + 3; i++) sessions.push(await connectDevice(t.port, key, t.linkKey.public));
      await settle(200);
      const open = sessions.filter((s) => s.raw.socket.readyState === s.raw.socket.OPEN);
      assert.equal(open.length, MAX_SESSIONS_PER_DEVICE);
      assert.deepEqual(open, sessions.slice(-MAX_SESSIONS_PER_DEVICE));
      assert.equal((await open.at(-1)!.request('ping', {})).ok, true);
      for (const s of open) s.close();
    } finally {
      await t.server.close();
    }
  });
});

describe('many paired devices at once', () => {
  it(`signs in at most ${MAX_SIGNED_IN} connections in all: the next is refused, the others keep working`, async () => {
    const t = await startServer();
    const devices: LinkedDevice[] = [];
    try {
      for (let i = 0; i < MAX_SIGNED_IN; i++) {
        devices.push(await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, newDeviceKey(), { deviceId: `pad-${i}`, deviceName: `Pad ${i}` }));
      }
      const extra = await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, newDeviceKey(), { deviceId: 'one-too-many', deviceName: 'Pad' }, { signIn: false });
      const answer = await Promise.race([extra.request('ping', {}).then(() => 'answered'), extra.closed.then(() => 'closed'), settle(3000).then(() => 'no reply')]);
      assert.equal(answer, 'closed');
      await settle(100);
      assert.equal(devices.filter((d) => d.raw.socket.readyState === d.raw.socket.OPEN).length, MAX_SIGNED_IN);
      assert.equal((await devices[0]!.request('ping', {})).ok, true);
      assert.equal((await devices.at(-1)!.request('ping', {})).ok, true);
    } finally {
      for (const d of devices) d.close();
      await t.server.close();
    }
  });
});

describe('unpairing when agent.json is busy', () => {
  it('cuts the device off even if the write fails', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-revoke-'));
    process.env.AUTHDECK_HOME = home;
    const agent = await startAgent({ port: 0, dryRun: true }, () => {});
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    try {
      const window = agent.openPairing();
      const linkKey = (await import('../src/config')).loadLinkKey(home).public;
      const device = await pairByQr(agent.port, linkKey, window.pairSecret, newDeviceKey(), { deviceId: 'pad', deviceName: 'Pad' });
      // Another, live process holds the lock: the write must fail.
      fs.writeFileSync(path.join(home, 'agent.json.lock'), JSON.stringify({ pid: holder.pid, nonce: 'theirs' }));
      assert.throws(() => agent.revokeDevice('pad'), /Another AuthDeck process/);
      assert.notEqual(await device.closed, undefined);
      assert.equal(agent.connectedDeviceIds().has('pad'), false);
      fs.rmSync(path.join(home, 'agent.json.lock'));
      assert.equal(loadConfig(home).devices.length, 1, 'still paired: the desktop says so and the user tries again');
    } finally {
      holder.kill();
      await agent.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the pairing check reads the cached config', () => {
  it('a revoke from another process still cuts the device off within the 2-second check when agent.json cannot be watched', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-cached-'));
    process.env.AUTHDECK_HOME = home;
    const realWatch = fs.watch;
    (fs as { watch: unknown }).watch = () => {
      throw Object.assign(new Error('too many watches'), { code: 'ENOSPC' });
    };
    let agent: Awaited<ReturnType<typeof startAgent>>;
    try {
      agent = await startAgent({ port: 0, dryRun: true }, () => {});
    } finally {
      (fs as { watch: unknown }).watch = realWatch;
    }
    const reads = { count: 0 };
    const realRead = fs.readFileSync;
    try {
      const window = agent.openPairing();
      const linkKey = (await import('../src/config')).loadLinkKey(home).public;
      const device = await pairByQr(agent.port, linkKey, window.pairSecret, newDeviceKey(), { deviceId: 'pad', deviceName: 'Pad' });
      // Requests no longer read agent.json.
      (fs as { readFileSync: unknown }).readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (String(file).endsWith('agent.json')) reads.count++;
        return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
      }) as typeof fs.readFileSync;
      for (let i = 0; i < 5; i++) assert.equal((await device.request('ping', {})).ok, true);
      assert.equal(reads.count, 0);
      (fs as { readFileSync: unknown }).readFileSync = realRead;
      // `devices --revoke-all` from a terminal: another writer, not the agent's own update.
      updateConfig(home, (latest) => (latest.devices = []));
      const started = Date.now();
      const code = await Promise.race([device.closed, settle(3000).then(() => 'still open')]);
      assert.notEqual(code, 'still open');
      assert.ok(Date.now() - started < 3000);
      assert.equal(agent.connectedDeviceIds().has('pad'), false);
    } finally {
      (fs as { readFileSync: unknown }).readFileSync = realRead;
      await agent.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('computer names', () => {
  it(`a name over ${MAX_COMPUTER_NAME_CHARS} characters in agent.json is not given out: the host name is`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-name-'));
    try {
      const first = loadConfig(home);
      fs.writeFileSync(path.join(home, 'agent.json'), JSON.stringify({ ...first, name: 'x'.repeat(MAX_COMPUTER_NAME_CHARS + 1) }));
      assert.equal(loadConfig(home).name, friendlyHostname());
      fs.writeFileSync(path.join(home, 'agent.json'), JSON.stringify({ ...first, name: '🖥'.repeat(MAX_COMPUTER_NAME_CHARS) }));
      assert.equal(loadConfig(home).name, '🖥'.repeat(MAX_COMPUTER_NAME_CHARS));
      fs.writeFileSync(path.join(home, 'agent.json'), JSON.stringify({ ...first, name: '   ' }));
      assert.equal(loadConfig(home).name, friendlyHostname());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it(`a long host name is trimmed to ${MAX_COMPUTER_NAME_CHARS} characters`, () => {
    assert.equal(Array.from(friendlyHostname('h'.repeat(200) + '.local')).length, MAX_COMPUTER_NAME_CHARS);
  });
});

describe('key words', () => {
  it(`are ${LINK_KEY_WORD_COUNT} words (66 bits), the first three the same as before`, () => {
    const key = newDeviceKey().public;
    const words = linkKeyWords(key);
    assert.equal(words.length, 6);
    assert.deepEqual(words.slice(0, 3), keyWords(key));
  });
});

describe('a config watch that never fires', () => {
  it('the 15-second keepalive reads agent.json again and cuts off a device revoked by another process', { timeout: 40_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-silent-'));
    process.env.AUTHDECK_HOME = home;
    const realWatch = fs.watch;
    // Started fine, never reports a change: a network or synced volume, or a missed event.
    (fs as { watch: unknown }).watch = () => Object.assign(new EventEmitter(), { close() {}, unref() { return this; }, ref() { return this; } });
    let agent: Awaited<ReturnType<typeof startAgent>>;
    try {
      agent = await startAgent({ port: 0, dryRun: true }, () => {});
    } finally {
      (fs as { watch: unknown }).watch = realWatch;
    }
    try {
      const window = agent.openPairing();
      const linkKey = (await import('../src/config')).loadLinkKey(home).public;
      const device = await pairByQr(agent.port, linkKey, window.pairSecret, newDeviceKey(), { deviceId: 'lost-phone', deviceName: 'Lost phone' });
      updateConfig(home, (latest) => (latest.devices = []));
      const code = await Promise.race([device.closed, settle(17_000).then(() => 'still open')]);
      assert.notEqual(code, 'still open');
      assert.equal(agent.connectedDeviceIds().has('lost-phone'), false);
    } finally {
      await agent.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('icons the agent sends', () => {
  const header = (width: number, height: number, length = 33) => {
    const bytes = new Uint8Array(length);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  };

  it(`are PNGs of at most ${MAX_ICON_PIXELS}×${MAX_ICON_PIXELS} and ${MAX_ICON_PNG_BYTES / 1024} KB`, () => {
    assert.deepEqual(pngSize(header(128, 64)), { width: 128, height: 64 });
    assert.equal(isServableIcon(header(128, 128)), true);
    assert.equal(isServableIcon(header(256, 256)), true);
    assert.equal(isServableIcon(header(257, 16)), false);
    assert.equal(isServableIcon(header(20000, 20000)), false, 'a small file that decodes to a huge bitmap');
    assert.equal(isServableIcon(header(16, 16, MAX_ICON_PNG_BYTES + 1)), false);
    assert.equal(isServableIcon(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><use href="#a" id="a"/></svg>')), false);
    assert.equal(isServableIcon(header(0, 16)), false);
  });
});

describe('the Windows input helper output pipe', () => {
  it('a read error ends the helper and fails its requests; the agent keeps running', async () => {
    const fake = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    const realSpawn = childProcess.spawn;
    (childProcess as { spawn: unknown }).spawn = () => fake;
    syncBuiltinESMExports();
    const watch = watchProcess();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-helper-pipe-'));
    try {
      const helper = new WinHelper(dir);
      const answer = helper.request({ op: 'focus' } as never).then(
        () => 'answered',
        (err: Error) => err.message,
      );
      await settle(30);
      fake.stdout.write('{"ready":true}\n');
      await settle(30);
      fake.stdout.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      assert.match(await answer, /stopped: read ECONNRESET/);
      await settle(30);
      assert.deepEqual(watch.escaped, []);
    } finally {
      watch.stop();
      (childProcess as { spawn: unknown }).spawn = realSpawn;
      syncBuiltinESMExports();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('server log lines', () => {
  it('carry no control or format characters from what a device sent', () => {
    assert.equal(logSafe('[12:00:00] Pad\u001b[2J\nforged line\u202e  run x  ok'), '[12:00:00] Pad [2J forged line   run x  ok');
  });
});

describe('device names in logs', () => {
  it('lose control and format characters, ESC included', () => {
    assert.equal(printableName('Pad\u001b[2J\u001b]0;owned\u0007 one‮'), 'Pad[2J]0;owned one');
    assert.equal(printableName('Ada\tPad\n'), 'Ada Pad');
  });
});

describe('answers stay within what the app accepts', () => {
  it('uses the same numbers as the app', () => {
    for (const [name, value] of Object.entries(RESULT_LIMITS)) assert.equal(value, (APP_LIMITS as Record<string, number>)[name], name);
  });

  it('leaves out apps the app could not take, cuts long names, and keeps at most 2,000', () => {
    const app = (id: string, name = 'App') => ({ id, name, hasIcon: false });
    const apps = sendableApps([app('x'.repeat(RESULT_LIMITS.appId + 1)), app('ok', 'n'.repeat(500)), app(''), ...Array.from({ length: 2500 }, (_, i) => app(`a${i}`))]);
    assert.equal(apps.length, RESULT_LIMITS.apps);
    assert.deepEqual(apps[0], app('ok', 'n'.repeat(RESULT_LIMITS.appName)));
    assert.ok(isMethodResult('apps.list', { apps }));
  });

  it('leaves out folder entries past the caps and keeps at most 10,000', () => {
    const entry = (name: string) => ({ name, path: `/home/me/${name}`, kind: 'dir' as const });
    const listing = sendableListing({
      path: '/home/me',
      parent: '/home',
      home: '/home/me',
      sep: '/',
      roots: [entry('Home')],
      entries: [entry('n'.repeat(RESULT_LIMITS.fsName + 1)), ...Array.from({ length: 12_000 }, (_, i) => entry(`d${i}`))],
    });
    assert.equal(listing.entries.length, RESULT_LIMITS.fsEntries);
    assert.equal(listing.entries[0]!.name, 'd0');
    assert.ok(isMethodResult('fs.list', listing));
  });

  it('cuts focus names and error text, never inside a surrogate pair', () => {
    assert.deepEqual(sendableFocus({ supported: true, appId: 'x'.repeat(300), name: '😀'.repeat(100) }).appId, null);
    assert.equal(sendableFocus({ supported: true, appId: null, name: '😀'.repeat(100) }).name.length, RESULT_LIMITS.focusName);
    const error = new AgentError('failed', 'e'.repeat(5000), 'h'.repeat(5000)).toProtocol();
    assert.equal(error.message.length, RESULT_LIMITS.errorText);
    assert.equal(error.hint!.length, RESULT_LIMITS.errorText);
    assert.equal(clip('a😀', 2), 'a');
    assert.ok(isProtocolError(error));
    assert.ok(isFocusInfo(sendableFocus({ supported: true, appId: 'x'.repeat(300), name: 'n'.repeat(999) })));
  });
});

describe('WebSocket compression', () => {
  it('is never negotiated, even when the client offers it', async () => {
    const t = await startServer();
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(t.port, '127.0.0.1', () => {
          socket.write(
            `GET ${WS_PATH} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n` +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n',
          );
        });
        let text = '';
        socket.on('data', (chunk) => {
          text += chunk.toString('latin1');
          if (text.includes('\r\n\r\n')) {
            socket.destroy();
            resolve(text);
          }
        });
        socket.on('error', reject);
      });
      assert.match(answer, /^HTTP\/1\.1 101/);
      assert.doesNotMatch(answer, /sec-websocket-extensions/i);
    } finally {
      await t.server.close();
    }
  });
});
