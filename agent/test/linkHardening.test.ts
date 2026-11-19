/**
 * The holes a review of the link found around its (correct) crypto, each as the attack it showed:
 * revocation that didn't cut a device off, replayed hellos counted as sign-ins, PIN lockout and
 * stuck PIN runs, endless empty chunks, and unlimited unfinished handshakes.
 */
import assert from 'node:assert/strict';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { ActionRunner } from '../src/actions/runner';
import { AppCatalog } from '../src/apps/catalog';
import type { AgentEvent } from '../src/events';
import type { FocusTracker } from '../src/focus';
import type { IconService } from '../src/icons/service';
import { SecureChannel } from '../src/link/channel';
import { CpaceInitiator } from '../src/link/cpace';
import { LinkError } from '../src/link/errors';
import { FRAME, encodeFrame, expectFrame, frameHeader } from '../src/link/frames';
import { PIN_SID_BYTES, SessionClient } from '../src/link/handshakes';
import { HandshakeState, IK, MAX_NOISE_MESSAGE, XX_PSK0 } from '../src/link/noise';
import { PROTOCOL_VERSION, type RunParams } from '../src/protocol';
import { ABANDONED_PIN_PAUSE_MS, AgentServer, CLOSE_LINK_BROKEN, MAX_ABANDONED_PIN_RUNS, MAX_PENDING_PER_ADDRESS } from '../src/server';
import { concatBytes, utf8Encode } from '../src/vault/bytes';
import { connectDevice, newDeviceKey, pairByPin, pairByQr, random, RawSocket, type LinkedDevice } from './helpers/link';
import { agentLinkKey, testConfig, testPairing } from './helpers/server';

const HANDSHAKE_DEADLINE_MS = 300;
const PAD = { deviceId: 'pad', deviceName: 'Pad' };
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const runRequest = (id: number) => JSON.stringify({ id: String(id), method: 'run', params: { action: { type: 'text', text: `typed #${id}` } } });

/** Resolves with how a refused attempt was refused (in the clear, or inside the handshake). */
const refusalOf = (attempt: Promise<unknown>) =>
  attempt.then(
    () => assert.fail('expected a refusal'),
    (err: { refusal?: { code: string }; error?: { code: string } }) => err.refusal ?? err.error ?? assert.fail(String(err)),
  );

describe('the link under attack', () => {
  const linkKey = agentLinkKey();
  let store: ReturnType<typeof testPairing>;
  let server: AgentServer;
  let port: number;
  let now: number;
  let events: AgentEvent[];
  let runs: RunParams[];

  before(async () => {
    const catalog = new AppCatalog(async () => []);
    await catalog.rescan();
    now = 1_000_000;
    store = testPairing(testConfig(), () => now);
    server = new AgentServer({
      agentInfo: { agentId: 'agent', name: 'Mac', platform: 'macos', version: '0.0.0', protocol: PROTOCOL_VERSION },
      port: 0,
      home: '/Users/ada',
      platform: 'macos',
      pairing: store.pairing,
      linkKey,
      catalog,
      icons: {} as IconService,
      runner: { run: async (params: RunParams) => (runs.push(params), { durationMs: 1 }) } as unknown as ActionRunner,
      focus: { clientConnected() {}, clientDisconnected() {}, current: async () => ({ supported: false, appId: null, name: '' }) } as unknown as FocusTracker,
      vaults: {} as never,
      log: () => {},
      emit: (event) => events.push(event),
      handshakeTimeoutMs: HANDSHAKE_DEADLINE_MS,
      now: () => now,
    });
    port = await server.listen();
  });

  after(() => server.close());

  /** Every connection a test opened; closed after it, so each test starts with none. */
  let opened: RawSocket[] = [];

  beforeEach(() => {
    events = [];
    runs = [];
    store.pairing.openWindow(Number.MAX_SAFE_INTEGER - now);
  });

  afterEach(async () => {
    for (const raw of opened) raw.close();
    await Promise.all(opened.map((raw) => raw.closed));
    opened = [];
    await settle();
  });

  const track = <T extends { raw: RawSocket }>(device: T): T => {
    opened.push(device.raw);
    return device;
  };
  const openRaw = async () => {
    const raw = new RawSocket(port);
    opened.push(raw);
    await raw.opened();
    return raw;
  };
  const pair = async (deviceId = 'pad', device = newDeviceKey()) => track(await pairByQr(port, linkKey.public, store.config().pairSecret, device, { deviceId, deviceName: deviceId }));
  const sendRun = (device: LinkedDevice, id: number) => {
    for (const frame of device.channel.seal(runRequest(id))) device.raw.send(frame);
  };

  describe('revoking cuts a device off at once', () => {
    it('unpairing from the desktop: frames already on their way are never handled', async () => {
      const device = await pair();
      assert.equal((await device.request('run', { action: { type: 'text', text: 'before' } })).ok, true);
      sendRun(device, 100);
      store.pairing.revoke('pad');
      server.disconnectDevice('pad');
      for (let id = 101; id < 105; id++) sendRun(device, id);
      await device.closed;
      await settle();
      assert.equal(runs.length, 1);
    });

    it('devices --revoke-all in another process: the next request is not run, even before anyone tells the server', async () => {
      const device = await pair();
      store.setConfig({ ...store.config(), devices: [] });
      sendRun(device, 1);
      await device.closed;
      await settle();
      assert.deepEqual(runs, []);
    });

    it('a change on disk drops idle sessions of unpaired devices, and only those', async () => {
      const pad = await pair('pad');
      const phone = await pair('phone');
      store.setConfig({ ...store.config(), devices: store.config().devices.filter((d) => d.deviceId !== 'pad') });
      assert.deepEqual([...server.dropUnpaired()], ['pad']);
      await pad.closed;
      assert.equal((await phone.request('ping', {})).ok, true);
      phone.close();
    });

    it('pairing the same device again with a new key cuts off the old key', async () => {
      const old = await pair('pad');
      await pair('pad');
      sendRun(old, 1);
      await old.closed;
      await settle();
      assert.deepEqual(runs, []);
    });
  });

  describe('a replayed hello is not a sign-in', () => {
    it('answers it once, but signs nothing in, writes nothing, and drops it at the handshake deadline', async () => {
      const device = newDeviceKey();
      (await pair('pad', device)).close();
      await settle();
      const recorded = new SessionClient(device, linkKey.public, random).hello();
      now += 60 * 60_000;
      events = [];
      const lastSeen = store.config().devices.find((d) => d.deviceId === 'pad')!.lastSeenAt;
      const ghosts: RawSocket[] = [];
      for (let i = 0; i < 5; i++) {
        const raw = await openRaw();
        raw.send(recorded);
        await raw.next();
        ghosts.push(raw);
      }
      await settle();
      const open = ghosts.filter((raw) => raw.socket.readyState === raw.socket.OPEN);
      assert.deepEqual(open, [ghosts[0]], 'a byte-identical hello is let in only the first time; the rest are refused');
      assert.deepEqual(events, []);
      assert.equal(server.connectedDeviceIds().has('pad'), false);
      assert.equal(store.config().devices.find((d) => d.deviceId === 'pad')!.lastSeenAt, lastSeen);
      assert.equal(await ghosts[0]!.closed, CLOSE_LINK_BROKEN);
      for (const ghost of ghosts.slice(1)) await ghost.closed;
    });

    it('the real device signs in with its first frame and is seen', async () => {
      const device = newDeviceKey();
      (await pair('pad', device)).close();
      now += 60 * 60_000;
      events = [];
      track(await connectDevice(port, device, linkKey.public));
      assert.deepEqual(events.filter((e) => e.type === 'device.connected').length, 1);
      assert.equal(store.config().devices.find((d) => d.deviceId === 'pad')!.lastSeenAt, new Date(now).toISOString());
    });
  });

  describe('PIN pairing', () => {
    /** Starts a PIN run with a junk guess, then hangs up before sending anything PIN-keyed. */
    const hangUpAfterStart = async () => {
      const raw = await openRaw();
      const cpace = new CpaceInitiator({ prs: utf8Encode('000000'), ci: utf8Encode('authdeck/link/pin/v2'), sid: random(PIN_SID_BYTES), random });
      raw.send(encodeFrame(FRAME.pinStart, concatBytes(random(PIN_SID_BYTES), cpace.ya)));
      await raw.nextBinary();
      raw.close();
      await raw.closed;
    };

    it('runs abandoned before a guess never replace the PIN; a few pause only their address, for a minute', async () => {
      const pin = store.config().pin;
      const guard = store.config().pinGuard;
      for (let i = 0; i < MAX_ABANDONED_PIN_RUNS; i++) await hangUpAfterStart();
      await settle();
      assert.equal((await refusalOf(pairByPin(port, pin, newDeviceKey(), PAD))).code, 'locked');
      assert.equal(store.config().pin, pin);
      assert.deepEqual(store.config().pinGuard, guard, 'no wrong guess was counted');
      now += ABANDONED_PIN_PAUSE_MS;
      track(await pairByPin(port, pin, newDeviceKey(), PAD));
    });

    it('a run that ends with another protocol version does not block the next one', async () => {
      const pin = store.config().pin;
      const raw = await openRaw();
      const sid = random(PIN_SID_BYTES);
      const cpace = new CpaceInitiator({ prs: utf8Encode(pin), ci: utf8Encode('authdeck/link/pin/v2'), sid, random });
      raw.send(encodeFrame(FRAME.pinStart, concatBytes(sid, cpace.ya)));
      const yb = expectFrame(await raw.nextBinary(), FRAME.pinReply);
      const psk = hkdf(sha256, cpace.finish(yb), undefined, utf8Encode('authdeck/link/pin-psk/v2'), 32);
      const app = new HandshakeState({ pattern: XX_PSK0, initiator: true, prologue: concatBytes(utf8Encode('authdeck/link/pin/v2'), sid, cpace.ya, yb), staticKey: newDeviceKey(), psk, random });
      raw.send(encodeFrame(FRAME.pinHello, app.writeMessage(new Uint8Array(0))));
      app.readMessage(expectFrame(await raw.nextBinary(), FRAME.pinAccept));
      raw.send(encodeFrame(FRAME.pinFinish, app.writeMessage(utf8Encode(JSON.stringify({ protocol: PROTOCOL_VERSION + 1, pair: { deviceId: 'z', deviceName: 'Z' } })))));
      await raw.closed;
      track(await pairByPin(port, store.config().pin, newDeviceKey(), PAD));
    });

    it('a PIN works for one pairing: the next device needs the new one', async () => {
      const pin = store.config().pin;
      track(await pairByPin(port, pin, newDeviceKey(), PAD));
      assert.notEqual(store.config().pin, pin);
      const refusal = await refusalOf(pairByPin(port, pin, newDeviceKey(), { deviceId: 'later', deviceName: 'Later' }));
      assert.equal(refusal.code, 'bad_pin');
    });

    it('while pairing is closed, neither the PIN nor the QR code works', async () => {
      const { pin, pairSecret } = store.pairing.openWindow(60_000);
      store.pairing.closeWindow();
      assert.equal((await refusalOf(pairByPin(port, pin, newDeviceKey(), PAD))).code, 'locked');
      assert.equal((await refusalOf(pairByQr(port, linkKey.public, pairSecret, newDeviceKey(), PAD))).code, 'unauthorized');
      const window = store.pairing.openWindow(60_000);
      now += 60_000;
      assert.equal((await refusalOf(pairByQr(port, linkKey.public, window.pairSecret, newDeviceKey(), PAD))).code, 'unauthorized', 'a window runs out by itself');
      assert.deepEqual(store.config().devices.filter((d) => d.deviceId === 'pad').length, 1, 'only earlier pairings');
    });
  });

  describe('unfinished handshakes', () => {
    it(`keeps at most ${MAX_PENDING_PER_ADDRESS} at once from one address: a new one replaces the oldest; idle ones go at the deadline`, async () => {
      const idle = await Promise.all(Array.from({ length: MAX_PENDING_PER_ADDRESS }, openRaw));
      const newest = await openRaw();
      assert.equal(await idle[0]!.closed, CLOSE_LINK_BROKEN, 'the oldest made room');
      for (const raw of [...idle.slice(1), newest]) assert.equal(await raw.closed, CLOSE_LINK_BROKEN);
      await settle();
      await pair();
    });

    it('a signed-in device no longer counts against the limit', async () => {
      for (let i = 0; i < MAX_PENDING_PER_ADDRESS + 2; i++) await pair(`device-${i}`);
    });
  });

  it('an endless stream of empty "more follows" chunks closes the connection', async () => {
    const device = await pair();
    // The device's own sending keys, used the wrong way round: chunks that never finish a message.
    const header = frameHeader(FRAME.transport);
    const keys = (device.channel as unknown as { keys: { send: { encryptWithAd: (ad: Uint8Array, p: Uint8Array) => Uint8Array } } }).keys;
    for (let i = 0; i < 3; i++) device.raw.send(concatBytes(header, keys.send.encryptWithAd(header, Uint8Array.of(0))));
    assert.equal(await device.closed, CLOSE_LINK_BROKEN);
  });
});

describe('transport chunks', () => {
  function channels(maxMessageBytes: number) {
    const app = newDeviceKey();
    const agent = newDeviceKey();
    const initiator = new HandshakeState({ pattern: IK, initiator: true, prologue: new Uint8Array(0), staticKey: app, remoteStatic: agent.public, random });
    const responder = new HandshakeState({ pattern: IK, initiator: false, prologue: new Uint8Array(0), staticKey: agent, random });
    responder.readMessage(initiator.writeMessage(new Uint8Array(0)));
    initiator.readMessage(responder.writeMessage(new Uint8Array(0)));
    const sender = initiator.transportKeys();
    return { send: (flag: number, chunk: Uint8Array) => concatBytes(frameHeader(FRAME.transport), sender.send.encryptWithAd(frameHeader(FRAME.transport), concatBytes(Uint8Array.of(flag), chunk))), receiver: new SecureChannel(responder.transportKeys(), maxMessageBytes) };
  }

  it('refuses an empty chunk that says more follow', () => {
    const { send, receiver } = channels(1024 * 1024);
    assert.throws(() => receiver.open(send(0, new Uint8Array(0))), (err: LinkError) => err instanceof LinkError && err.reason === 'malformed');
  });

  it('refuses more chunks than any message of the allowed size needs', () => {
    const { send, receiver } = channels(1024 * 1024);
    // 1 MiB fits in 17 full chunks; tiny ones stop at that count instead of growing a list.
    let accepted = 0;
    assert.throws(() => {
      for (;;) {
        receiver.open(send(0, Uint8Array.of(1)));
        accepted += 1;
      }
    }, LinkError);
    assert.ok(accepted <= 18, `accepted ${accepted} chunks`);
  });

  it('a handshake message longer than a Noise message is refused before it is read', () => {
    const responder = new HandshakeState({ pattern: IK, initiator: false, prologue: new Uint8Array(0), staticKey: newDeviceKey(), random });
    assert.throws(() => responder.readMessage(new Uint8Array(MAX_NOISE_MESSAGE + 1)), (err: LinkError) => err instanceof LinkError && err.reason === 'malformed');
  });
});
