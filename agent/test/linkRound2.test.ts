/**
 * The second review of the link: a peer holding the one PIN run, events reaching a device unpaired
 * on disk, connections that never finish their HTTP request, and pages from other sites.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import WebSocket from 'ws';
import type { ActionRunner } from '../src/actions/runner';
import { AppCatalog } from '../src/apps/catalog';
import type { AgentEvent } from '../src/events';
import type { FocusTracker } from '../src/focus';
import type { IconService } from '../src/icons/service';
import { CpaceInitiator } from '../src/link/cpace';
import { FRAME, encodeFrame } from '../src/link/frames';
import { PIN_SID_BYTES } from '../src/link/handshakes';
import { HELLO_PATH, PROTOCOL_VERSION, WS_PATH, type RunParams } from '../src/protocol';
import {
  AgentServer,
  CLOSE_LINK_BROKEN,
  MAX_PENDING_CONNECTIONS,
  MAX_PENDING_PER_ADDRESS,
  PIN_GUESS_TIMEOUT_MS,
  RESERVED_FOR_KNOWN,
  isLoopbackOrigin,
  type ServerDeps,
} from '../src/server';
import { concatBytes, utf8Encode } from '../src/vault/bytes';
import { newDeviceKey, pairByPin, pairByQr, random, RawSocket } from './helpers/link';
import { agentLinkKey, testConfig, testPairing } from './helpers/server';

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const PAD = { deviceId: 'pad', deviceName: 'Pad' };

/** Another address of this computer, so a test can be a second LAN peer; null when there is none. */
function otherAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return null;
}

async function startServer(options: Partial<ServerDeps> = {}) {
  const catalog = new AppCatalog(async () => []);
  await catalog.rescan();
  const linkKey = agentLinkKey();
  const store = testPairing(testConfig());
  const events: AgentEvent[] = [];
  const logLines: string[] = [];
  const server = new AgentServer({
    agentInfo: { agentId: 'agent', name: 'Mac', platform: 'macos', version: '0.0.0', protocol: PROTOCOL_VERSION },
    port: 0,
    home: '/Users/ada',
    platform: 'macos',
    pairing: store.pairing,
    linkKey,
    catalog,
    icons: {} as IconService,
    runner: { run: async (_params: RunParams) => ({ durationMs: 1 }) } as unknown as ActionRunner,
    focus: { clientConnected() {}, clientDisconnected() {}, current: async () => ({ supported: false, appId: null, name: '' }) } as unknown as FocusTracker,
    vaults: {} as never,
    log: (line) => logLines.push(line),
    emit: (event) => events.push(event),
    ...options,
  });
  const port = await server.listen();
  return { server, port, linkKey, store, events, logLines };
}

/** Sends pinStart and never a guess: what a peer does to hold the one PIN run. */
async function startPinRunAndWait(port: number, host = '127.0.0.1'): Promise<{ raw: RawSocket; started: boolean }> {
  const raw = new RawSocket(port, host);
  await raw.opened();
  const sid = random(PIN_SID_BYTES);
  const cpace = new CpaceInitiator({ prs: utf8Encode('000000'), ci: utf8Encode('authdeck/link/pin/v2'), sid, random });
  raw.send(encodeFrame(FRAME.pinStart, concatBytes(sid, cpace.ya)));
  const reply = await raw.next();
  return { raw, started: !!reply && 'binary' in reply };
}

const refusalCode = (attempt: Promise<unknown>) =>
  attempt.then(
    () => 'paired',
    (err: { refusal?: { code: string } }) => err.refusal?.code ?? String(err),
  );

describe('a peer holding the PIN run', () => {
  it('is cut off when it sends no guess in time, and the run frees at once', async () => {
    const t = await startServer({ pinGuessTimeoutMs: 300 });
    try {
      const started = Date.now();
      const { raw, started: ok } = await startPinRunAndWait(t.port);
      assert.equal(ok, true);
      assert.equal(await raw.closed, CLOSE_LINK_BROKEN);
      assert.ok(Date.now() - started < 1500, 'well before the handshake deadline');
      assert.equal(t.store.config().pinGuard?.failuresOnPin ?? 0, 0, 'no guess was charged');
      await pairByPin(t.port, t.store.config().pin, newDeviceKey(), PAD);
    } finally {
      await t.server.close();
    }
  });

  it('a slow phone still pairs: a guess sent 1.5 s after the reply is in time', async () => {
    assert.ok(PIN_GUESS_TIMEOUT_MS >= 2500);
    const t = await startServer();
    try {
      const paired = await pairByPin(t.port, t.store.config().pin, newDeviceKey(), PAD, { guessDelayMs: 1500 });
      assert.equal(paired.agent.agentId, 'agent');
      paired.raw.close();
    } finally {
      await t.server.close();
    }
  });

  it('a few runs left without a guess pause PIN pairing from that address only', { skip: otherAddress() === null && 'no second address on this computer' }, async () => {
    const lan = otherAddress()!;
    const t = await startServer({ pinGuessTimeoutMs: 200 });
    try {
      // The attacker on the LAN address keeps starting runs and never guessing.
      const holds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const { raw, started } = await startPinRunAndWait(t.port, lan);
        holds.push(started ? 'held' : 'refused');
        raw.close();
        await raw.closed;
        await settle(20);
      }
      assert.deepEqual(holds, ['held', 'held', 'held', 'refused', 'refused']);
      assert.ok(t.logLines.some((line) => line.includes(`paused PIN pairing from ${lan}`)));
      // The owner's phone, from another address, pairs at once and no guess was charged.
      assert.equal(t.store.config().pinGuard?.failuresOnPin ?? 0, 0);
      await pairByPin(t.port, t.store.config().pin, newDeviceKey(), PAD);
    } finally {
      await t.server.close();
    }
  });

  it('the review attack: a holder reconnecting at once no longer starves the owner', { skip: otherAddress() === null && 'no second address on this computer' }, async () => {
    const lan = otherAddress()!;
    const t = await startServer({ pinGuessTimeoutMs: 200 });
    const stop = { now: false };
    const hold = (async () => {
      while (!stop.now) {
        const { raw } = await startPinRunAndWait(t.port, lan).catch(() => ({ raw: null }));
        if (raw) await raw.closed;
        else await settle(5);
      }
    })();
    try {
      await settle(100);
      // The owner tries every 100 ms. Before the fix the holder won all but one of 30 tries; now it
      // holds the run for three short deadlines, then its address is paused.
      const outcomes: string[] = [];
      for (let i = 0; i < 20; i++) {
        outcomes.push(await refusalCode(pairByPin(t.port, t.store.config().pin, newDeviceKey(), { deviceId: `real-${i}`, deviceName: 'Phone' }).then((paired) => paired.raw.close())));
        t.store.pairing.openWindow();
        await settle(100);
      }
      assert.deepEqual(outcomes.slice(-10), Array(10).fill('paired'), outcomes.join(', '));
    } finally {
      stop.now = true;
      await hold;
      await t.server.close();
    }
  });
});

describe('a device unpaired on disk, with no file event', () => {
  it('gets no broadcast and is cut off; the server says it was revoked', async () => {
    const t = await startServer();
    try {
      const phone = await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, newDeviceKey(), { deviceId: 'stolen', deviceName: 'Phone' });
      t.store.setConfig({ ...t.store.config(), devices: [] });
      for (let i = 0; i < 3; i++) t.server.broadcast('focus', { supported: true, appId: `com.secret.app${i}`, name: `Secret ${i}` });
      assert.equal(await phone.closed, 1006);
      await settle();
      assert.deepEqual(phone.events.filter((e) => e.event === 'focus' && String(e.data.appId).startsWith('com.secret')), []);
      assert.deepEqual(t.events.filter((e) => e.type === 'device.revoked'), [{ type: 'device.revoked', deviceId: 'stolen' }]);
    } finally {
      await t.server.close();
    }
  });

  it('the keepalive check drops it even if nothing is broadcast', async () => {
    const t = await startServer();
    try {
      const phone = await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, newDeviceKey(), { deviceId: 'stolen', deviceName: 'Phone' });
      const kept = await pairByQr(t.port, t.linkKey.public, t.store.config().pairSecret, newDeviceKey(), { deviceId: 'kept', deviceName: 'Kept' });
      t.store.setConfig({ ...t.store.config(), devices: t.store.config().devices.filter((d) => d.deviceId !== 'stolen') });
      (t.server as unknown as { checkAlive(): void }).checkAlive();
      assert.equal(await phone.closed, 1006);
      assert.equal((await kept.request('ping', {})).ok, true);
      assert.deepEqual(t.events.filter((e) => e.type === 'device.revoked').map((e) => (e as { deviceId: string }).deviceId), ['stolen']);
      kept.raw.close();
    } finally {
      await t.server.close();
    }
  });
});

describe('connections that never finish their request', () => {
  let t: Awaited<ReturnType<typeof startServer>>;
  let sockets: net.Socket[] = [];
  before(async () => {
    t = await startServer();
  });
  after(() => t.server.close());
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets = [];
    await settle();
  });

  /** A TCP connection that sends half an upgrade request and stops. */
  const halfRequest = (host = '127.0.0.1') =>
    new Promise<net.Socket>((resolve) => {
      const socket = net.connect(t.port, host, () => {
        socket.write(`GET ${WS_PATH} HTTP/1.1\r\nHost: x\r\n`);
        resolve(socket);
      });
      socket.on('error', () => {});
      socket.resume(); // read what the server sends, so its close is seen
      sockets.push(socket);
    });

  it(`counts them from their first byte: the ${MAX_PENDING_PER_ADDRESS + 1}th from one address replaces the oldest`, async () => {
    const halves: net.Socket[] = [];
    for (let i = 0; i < MAX_PENDING_PER_ADDRESS; i++) halves.push(await halfRequest());
    await settle();
    const oldestClosed = new Promise((resolve) => halves[0]!.once('close', resolve));
    const opened = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${t.port}${WS_PATH}`);
      socket.once('open', () => (socket.close(), resolve('opened')));
      socket.once('error', (err) => resolve(err.message));
    });
    assert.equal(opened, 'opened');
    await oldestClosed;
  });

  it('closes one that has not upgraded within the request deadline', async () => {
    const socket = await halfRequest();
    const started = Date.now();
    await new Promise((resolve) => socket.once('close', resolve));
    const waited = Date.now() - started;
    assert.ok(waited < 12_000, `closed after ${waited} ms`);
  });

  it('keeps the last slots for addresses a device signed in from', () => {
    const fresh = t.server as unknown as {
      unfinishedRequests: Map<object, { address: string; since: number }>;
      knownAddresses: Map<string, number>;
      makeRoomForConnection(address: string): boolean;
    };
    const fill = (count: number) => {
      for (let i = 0; i < count; i++) fresh.unfinishedRequests.set({ destroy() {} }, { address: `10.0.${Math.floor(i / 4)}.${i % 4}`, since: i });
    };
    try {
      fill(MAX_PENDING_CONNECTIONS - RESERVED_FOR_KNOWN);
      assert.equal(fresh.makeRoomForConnection('10.9.9.9'), false, 'a stranger finds no room');
      fresh.knownAddresses.set('192.168.1.20', Date.now());
      assert.equal(fresh.makeRoomForConnection('192.168.1.20'), true, 'the owner’s phone still gets in');
      fill(RESERVED_FOR_KNOWN);
      assert.equal(fresh.makeRoomForConnection('192.168.1.20'), false, 'up to the overall cap');
    } finally {
      fresh.unfinishedRequests.clear();
      fresh.knownAddresses.clear();
    }
  });
});

describe('pages from other sites', () => {
  let t: Awaited<ReturnType<typeof startServer>>;
  before(async () => {
    t = await startServer();
  });
  after(() => t.server.close());
  beforeEach(() => settle(20));

  const openWith = (origin?: string) =>
    new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${t.port}${WS_PATH}`, origin ? { origin } : {});
      socket.once('open', () => {
        socket.close();
        resolve('opened');
      });
      socket.once('error', (err) => resolve(err.message));
    });

  it('accepts the native app (no Origin) and the web build on localhost, on any port', async () => {
    assert.equal(await openWith(), 'opened');
    for (const origin of ['http://localhost:8081', 'http://127.0.0.1:19006', 'https://localhost', 'http://[::1]:8081']) assert.equal(await openWith(origin), 'opened', origin);
  });

  it('refuses a WebSocket from any other site', async () => {
    for (const origin of ['http://evil.example', 'http://192.168.1.5:8081', 'null', 'http://localhost.evil.example', 'file://']) assert.match(await openWith(origin), /403/, origin);
  });

  it('answers /hello with CORS only for localhost pages', async () => {
    const evil = await fetch(`http://127.0.0.1:${t.port}${HELLO_PATH}`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    await evil.body?.cancel();
    const local = await fetch(`http://127.0.0.1:${t.port}${HELLO_PATH}`, { headers: { Origin: 'http://localhost:8081' } });
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:8081');
    assert.equal(((await local.json()) as { agentId: string }).agentId, 'agent');
    const preflight = await fetch(`http://127.0.0.1:${t.port}${HELLO_PATH}`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8081' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:8081');
    const native = await fetch(`http://127.0.0.1:${t.port}${HELLO_PATH}`);
    assert.equal(native.status, 200);
    await native.body?.cancel();
  });

  it('knows a loopback origin', () => {
    assert.equal(isLoopbackOrigin('http://127.1.2.3:80'), true);
    assert.equal(isLoopbackOrigin('ws://localhost'), false);
    assert.equal(isLoopbackOrigin('not a url'), false);
  });
});
