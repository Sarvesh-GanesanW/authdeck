/**
 * The third review of the link: nothing a peer sends may throw out of a handler (a paired device
 * crashed the agent with one bad UTF-8 frame), refused upgrades must close and count, and a
 * stranger on the owner's own address must not keep the owner's paired phone out.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import type { ActionRunner } from '../src/actions/runner';
import { AppCatalog } from '../src/apps/catalog';
import type { AgentEvent } from '../src/events';
import type { FocusTracker } from '../src/focus';
import type { IconService } from '../src/icons/service';
import { FRAME, encodeFrame, frameHeader } from '../src/link/frames';
import { SessionClient } from '../src/link/handshakes';
import { PROTOCOL_VERSION, WS_PATH, type RunParams } from '../src/protocol';
import { AgentServer, CLOSE_LINK_BROKEN, MAX_PENDING_PER_ADDRESS, MAX_UNSIGNED_PER_KEY, type ServerDeps } from '../src/server';
import { concatBytes } from '../src/vault/bytes';
import { VaultStore } from '../src/vaultStore';
import { connectDevice, newDeviceKey, pairByQr, random, RawSocket, type LinkedDevice } from './helpers/link';
import { agentLinkKey, testConfig, testPairing } from './helpers/server';

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every method the agent dispatches. */
const METHODS = [
  'ping',
  'apps.list',
  'apps.icons',
  'fs.list',
  'focus.get',
  'run',
  'vault.list',
  'vault.read',
  'vault.append',
  'vault.beacons.read',
  'vault.forks.read',
  'vault.forks.write',
  'vault.beacons.write',
  'vault.retire',
  'vault.join.request',
  'vault.join.challenge',
  'vault.join.reveal',
  'vault.join.finish',
  'vault.join.cancel',
];

/** Values of every JSON type, plus the shapes that trip careless code. */
function junkValue(depth = 0): unknown {
  const pick = crypto.randomInt(14);
  switch (pick) {
    case 0:
      return null;
    case 1:
      return crypto.randomInt(-1e9, 1e9);
    case 2:
      return Number.MAX_SAFE_INTEGER * 2;
    case 3:
      return '';
    case 4:
      return 'x'.repeat(crypto.randomInt(1, 5000));
    case 5:
      return crypto.randomBytes(crypto.randomInt(1, 40)).toString('latin1');
    case 6:
      return true;
    case 7:
      return depth > 2 ? [] : Array.from({ length: crypto.randomInt(0, 5) }, () => junkValue(depth + 1));
    case 8:
      return { __proto__: { polluted: true }, constructor: 'x', toString: 1 };
    case 9:
      return '../../../../etc/passwd';
    case 10:
      return { length: -1 };
    case 11:
      return depth > 2 ? {} : Object.fromEntries(['id', 'vaultId', 'path', 'action', 'ids', 'since', 'entries', 'requestId', 'type', 'text'].map((k) => [k, junkValue(depth + 1)]));
    case 12:
      return '𐏿\u0000‮';
    default:
      return { type: 'text', text: junkValue(depth + 1) };
  }
}

async function startServer(options: Partial<ServerDeps> = {}) {
  const catalog = new AppCatalog(async () => []);
  await catalog.rescan();
  const linkKey = agentLinkKey();
  const store = testPairing(testConfig());
  const events: AgentEvent[] = [];
  const logLines: string[] = [];
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-fuzz-'));
  const server = new AgentServer({
    agentInfo: { agentId: 'agent', name: 'Mac', platform: 'macos', version: '0.0.0', protocol: PROTOCOL_VERSION },
    port: 0,
    home: vaultRoot,
    platform: 'macos',
    pairing: store.pairing,
    linkKey,
    catalog,
    icons: {} as IconService,
    runner: { run: async (_params: RunParams) => ({ durationMs: 1 }) } as unknown as ActionRunner,
    focus: { clientConnected() {}, clientDisconnected() {}, current: async () => ({ supported: false, appId: null, name: '' }) } as unknown as FocusTracker,
    vaults: new VaultStore({ personal: path.join(vaultRoot, 'vaults'), team: () => null }),
    log: (line) => logLines.push(line),
    emit: (event) => events.push(event),
    ...options,
  });
  const port = await server.listen();
  const stop = async () => {
    await server.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  };
  return { server, port, linkKey, store, events, logLines, stop };
}

/** Fails the test if anything escapes to the process: an uncaught error or an unhandled rejection. */
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

/** Seals raw bytes as one transport message, so the agent decrypts exactly these bytes. */
function sealBytes(device: LinkedDevice, plaintext: Uint8Array): Uint8Array {
  const keys = (device.channel as unknown as { keys: { send: { encryptWithAd: (ad: Uint8Array, p: Uint8Array) => Uint8Array } } }).keys;
  const header = frameHeader(FRAME.transport);
  return concatBytes(header, keys.send.encryptWithAd(header, plaintext));
}

describe('a paired device sending junk', () => {
  it('invalid UTF-8 inside an authenticated frame closes that link; the agent keeps running (the review PoC)', async () => {
    const t = await startServer();
    const watch = watchProcess();
    try {
      const device = await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, newDeviceKey(), { deviceId: 'pad', deviceName: 'Pad' });
      device.raw.send(sealBytes(device, Uint8Array.of(0x01, 0xff)));
      assert.equal(await device.closed, CLOSE_LINK_BROKEN);
      const again = await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, newDeviceKey(), { deviceId: 'pad2', deviceName: 'Pad 2' });
      assert.equal((await again.request('ping', {})).ok, true);
      again.close();
      assert.deepEqual(watch.escaped, []);
    } finally {
      watch.stop();
      await t.stop();
    }
  });

  it('fuzz: random and wrongly typed params to every method never escape, and each gets an answer', async () => {
    const t = await startServer();
    const watch = watchProcess();
    try {
      const device = await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, newDeviceKey(), { deviceId: 'pad', deviceName: 'Pad' });
      for (let round = 0; round < 6; round++) {
        for (const method of METHODS) {
          const reply = await device.request(method, junkValue());
          assert.equal(typeof reply.ok, 'boolean', method);
          if (!reply.ok) assert.equal(typeof reply.error?.message, 'string', method);
        }
      }
      // Requests that aren't requests.
      for (const junk of ['null', '1', '"x"', '[]', '{}', '{"id":1,"method":"ping"}', '{"id":"a","method":{}}', '{"id":"a","method":"nope"}', '{"id":"a","method":"ping","params":"x"}', 'not json']) {
        for (const frame of device.channel.seal(junk)) device.raw.send(frame);
      }
      await settle(200);
      assert.equal((await device.request('ping', {})).ok, true, 'the link survives bad requests');
      device.close();
      assert.deepEqual(watch.escaped, []);
    } finally {
      watch.stop();
      await t.stop();
    }
  });

  it('fuzz: random frames at every stage close only that link', async () => {
    const t = await startServer();
    const watch = watchProcess();
    try {
      for (let i = 0; i < 60; i++) {
        const kind = i % 6;
        if (kind === 0) {
          // Before the handshake: random binary, random frame types, random text.
          const raw = new RawSocket(t.port);
          await raw.opened();
          raw.send(crypto.randomBytes(crypto.randomInt(0, 300)));
          raw.socket.send(crypto.randomBytes(20).toString('latin1'));
          raw.close();
        } else if (kind === 1) {
          const raw = new RawSocket(t.port);
          await raw.opened();
          raw.send(encodeFrame(crypto.randomInt(0, 16) as Parameters<typeof encodeFrame>[0], crypto.randomBytes(crypto.randomInt(0, 200))));
          raw.close();
        } else if (kind === 2) {
          // A handshake to the agent with a random device key: refused, never thrown.
          const raw = new RawSocket(t.port);
          await raw.opened();
          raw.send(new SessionClient(newDeviceKey(), t.linkKey.public, random).hello());
          await raw.next();
          raw.close();
        } else {
          // A paired device sending random plaintexts, flags and lengths.
          const device = await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, newDeviceKey(), { deviceId: `pad-${i}`, deviceName: 'Pad' });
          const plaintext = kind === 3 ? crypto.randomBytes(crypto.randomInt(0, 64)) : kind === 4 ? concatBytes(Uint8Array.of(1), crypto.randomBytes(30)) : Uint8Array.of(0);
          device.raw.send(sealBytes(device, plaintext));
          device.raw.send(crypto.randomBytes(40));
          await Promise.race([device.closed, settle(500)]);
          device.close();
        }
      }
      await settle(200);
      const check = await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, newDeviceKey(), { deviceId: 'last', deviceName: 'Last' });
      assert.equal((await check.request('ping', {})).ok, true);
      check.close();
      assert.deepEqual(watch.escaped, []);
    } finally {
      watch.stop();
      await t.stop();
    }
  });

  it('fuzz: garbage HTTP, bad upgrades and odd headers never escape', async () => {
    const t = await startServer();
    const watch = watchProcess();
    try {
      const sends = [
        'GARBAGE\r\n\r\n',
        `GET ${WS_PATH} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
        `GET ${WS_PATH} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: !!\r\nSec-WebSocket-Version: 99\r\n\r\n`,
        `GET /%%%% HTTP/1.1\r\nHost: x\r\n\r\n`,
        `GET ${WS_PATH} HTTP/1.1\r\nHost: x\r\nOrigin: %%%\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
        `POST /authdeck/hello HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello`,
        `OPTIONS /authdeck/hello HTTP/1.1\r\nHost: x\r\nOrigin: http://localhost:1\r\n\r\n`,
        crypto.randomBytes(500).toString('latin1'),
      ];
      for (const text of sends) {
        await new Promise<void>((resolve) => {
          const socket = net.connect(t.port, '127.0.0.1', () => socket.write(text, 'latin1'));
          socket.on('error', () => {});
          socket.resume();
          socket.on('close', () => resolve());
          setTimeout(() => socket.destroy(), 1500);
        });
      }
      const hello = await fetch(`http://127.0.0.1:${t.port}/authdeck/hello`);
      assert.equal(hello.status, 200);
      await hello.body?.cancel();
      assert.deepEqual(watch.escaped, []);
    } finally {
      watch.stop();
      await t.stop();
    }
  });

  it('a pairing check that throws (agent.json unreadable) or a listener that throws breaks one link, not the agent', async () => {
    const t = await startServer();
    const watch = watchProcess();
    try {
      const key = newDeviceKey();
      (await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, key, { deviceId: 'pad', deviceName: 'Pad' })).close();
      const isPaired = t.store.pairing.isPaired.bind(t.store.pairing);
      t.store.pairing.isPaired = () => {
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      };
      const device = await connectDevice(t.port, key, t.linkKey.public, { signIn: false });
      void device.request('ping', {});
      assert.notEqual(await device.closed, undefined);
      t.store.pairing.isPaired = isPaired;
      t.server.broadcast('apps.changed', {});
      assert.ok(t.logLines.some((line) => /failed unexpectedly \(Error\)/.test(line)));
      assert.equal(t.logLines.some((line) => line.includes('EMFILE')), false, 'only the error name is logged');
      const again = await connectDevice(t.port, key, t.linkKey.public);
      assert.equal((await again.request('ping', {})).ok, true);
      again.close();
      assert.deepEqual(watch.escaped, []);
    } finally {
      watch.stop();
      await t.stop();
    }
  });
});

describe('refused upgrades', () => {
  it('are closed once refused, even if the peer never reads, and counted until then (the review PoC)', async () => {
    const t = await startServer();
    const sockets: net.Socket[] = [];
    const serverConnections = () =>
      new Promise<number>((resolve) => (t.server as unknown as { http: net.Server }).http.getConnections((_err, count) => resolve(count)));
    try {
      for (let i = 0; i < 40; i++) {
        const socket = net.connect(t.port, '127.0.0.1', () =>
          socket.write(`GET ${WS_PATH} HTTP/1.1\r\nHost: x\r\nOrigin: http://evil.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`),
        );
        socket.on('error', () => {});
        socket.pause(); // never reads, never ends: the agent must close it anyway
        sockets.push(socket);
      }
      await settle(300);
      const started = Date.now();
      while ((await serverConnections()) > 0 && Date.now() - started < 3000) await settle(50);
      assert.equal(await serverConnections(), 0, 'every refused upgrade is closed on the agent side');
      assert.equal((t.server as unknown as { unfinishedRequests: Map<unknown, unknown> }).unfinishedRequests.size, 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await t.stop();
    }
  });

  it('a refused upgrade counts against the limits until it is closed', async () => {
    const t = await startServer();
    try {
      const server = t.server as unknown as { http: net.Server; unfinishedRequests: Map<unknown, unknown> };
      let counted = -1;
      server.http.prependListener('upgrade', () => {
        counted = server.unfinishedRequests.size;
      });
      const refused = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${t.port}${WS_PATH}`, { origin: 'http://evil.example' });
        ws.once('error', (err) => resolve(err.message));
      });
      assert.match(refused, /403/);
      assert.equal(counted, 1);
    } finally {
      await t.stop();
    }
  });
});

describe('a stranger on the owner’s address', () => {
  let t: Awaited<ReturnType<typeof startServer>>;
  let idle: RawSocket[] = [];
  before(async () => {
    t = await startServer();
  });
  after(() => t.stop());
  afterEach(async () => {
    for (const raw of idle) raw.close();
    idle = [];
    await settle();
  });

  it(`can't keep the paired phone out with ${MAX_PENDING_PER_ADDRESS} idle connections (the review PoC)`, async () => {
    const phone = newDeviceKey();
    (await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, phone, { deviceId: 'phone', deviceName: 'Phone' })).close();
    await settle();
    // The attacker keeps 8 idle connections open and reopens each one that drops.
    const stop = { now: false };
    const keepEight = (async () => {
      while (!stop.now) {
        idle = idle.filter((raw) => raw.socket.readyState === raw.socket.OPEN || raw.socket.readyState === raw.socket.CONNECTING);
        while (idle.length < MAX_PENDING_PER_ADDRESS) {
          const raw = new RawSocket(t.port);
          raw.socket.on('error', () => {});
          idle.push(raw);
        }
        await settle(20);
      }
    })();
    try {
      await settle(200);
      let connected = 0;
      for (let i = 0; i < 5; i++) {
        const device = await connectDevice(t.port, phone, t.linkKey.public).catch(() => null);
        if (device && (await device.request('ping', {})).ok) connected += 1;
        device?.close();
        await settle(50);
      }
      assert.equal(connected, 5);
    } finally {
      stop.now = true;
      await keepEight;
    }
  });

  it(`a proven key no longer counts, but one key may have only ${MAX_UNSIGNED_PER_KEY} connections waiting to sign in`, async () => {
    const phone = newDeviceKey();
    (await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, phone, { deviceId: 'phone2', deviceName: 'Phone' })).close();
    await settle();
    const waiting: RawSocket[] = [];
    for (let i = 0; i < 5; i++) {
      const raw = new RawSocket(t.port);
      await raw.opened();
      raw.send(new SessionClient(phone, t.linkKey.public, random).hello());
      await raw.next();
      waiting.push(raw);
    }
    await settle();
    assert.equal(waiting.filter((raw) => raw.socket.readyState === raw.socket.OPEN).length, MAX_UNSIGNED_PER_KEY, 'the newest ones stay');
    assert.equal(waiting.at(-1)!.socket.readyState, waiting.at(-1)!.socket.OPEN);
    for (const raw of waiting) raw.close();
  });

  it('a recorded hello replayed is refused: each one can be answered only once', async () => {
    const phone = newDeviceKey();
    (await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, phone, { deviceId: 'phone3', deviceName: 'Phone' })).close();
    await settle();
    const hello = new SessionClient(phone, t.linkKey.public, random).hello();
    const replays: RawSocket[] = [];
    for (let i = 0; i < 4; i++) {
      const raw = new RawSocket(t.port);
      await raw.opened();
      raw.send(hello);
      await raw.next();
      replays.push(raw);
    }
    await settle();
    assert.equal(replays.filter((raw) => raw.socket.readyState === raw.socket.OPEN).length, 1, 'only the first is answered');
    for (const raw of replays) raw.close();
    const fresh = await connectDevice(t.port, phone, t.linkKey.public);
    assert.equal((await fresh.request('ping', {})).ok, true, 'the owner connects as usual');
    fresh.close();
  });
});
