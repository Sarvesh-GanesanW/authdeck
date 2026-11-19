/**
 * Link review round 6, the transport: ping floods before and inside a session, the pump's yield,
 * a FIN racing the deferred pump, the upgrade deadline and head scan, and the native transport's
 * early-event and pending-write bounds.
 */
import './native';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import type { AuthdeckSocketNative } from '../modules/authdeck-socket';
import { readResponseHead } from '../src/net/httpHead';
import { LinkSocket, MAX_HANDSHAKE_CONTROL_FRAMES, MAX_SESSION_PONGS, SESSION_PING_BURST, type SocketCloseEvent, type SocketErrorEvent } from '../src/net/linkSocket';
import { type ByteStream, MAX_EARLY_DATA_CHARS, MAX_EARLY_SOCKETS, MAX_PENDING_WRITES, nativeTransport } from '../src/net/tcp';
import { CLOSE_CODE, OPCODE } from '../src/net/wsFrames';
import { clientFrames, frame, upgradeResponse } from './rawServer';

const LIMIT = 8 * 1024;
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A ByteStream the test drives by hand, so deliveries and the FIN land exactly where it says. */
class ScriptedStream implements ByteStream {
  onData: ((bytes: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((message: string) => void) | null = null;
  readonly written: Uint8Array[] = [];
  closed = false;

  write(bytes: Uint8Array): void {
    if (!this.closed) this.written.push(bytes);
  }
  ack(): void {}
  close(): void {
    this.closed = true;
  }
}

interface ScriptedRun {
  socket: LinkSocket;
  stream: ScriptedStream;
  messages: (string | Uint8Array)[];
  errors: SocketErrorEvent[];
  closes: SocketCloseEvent[];
  /** The client's frames after its upgrade request, unmasked. */
  sent: () => ReturnType<typeof clientFrames>;
  /** Sends the 101 for the client's key, with `frames` right behind it in the same read. */
  upgrade: (frames?: Buffer[]) => void;
  deliver: (frames: Buffer[]) => void;
}

/** A LinkSocket over a ScriptedStream; `inSession` marks the link handshake done once it opens. */
async function scripted(options: { inSession?: boolean; connectTimeoutMs?: number; onOpen?: (socket: LinkSocket) => void } = {}): Promise<ScriptedRun> {
  const stream = new ScriptedStream();
  const random = (n: number) => new Uint8Array(crypto.randomBytes(n));
  const socket = new LinkSocket({
    transport: { connect: async () => stream },
    host: '127.0.0.1',
    port: 1,
    path: '/authdeck/ws',
    random,
    maxMessageBytes: LIMIT,
    connectTimeoutMs: options.connectTimeoutMs ?? 2000,
  });
  const run: ScriptedRun = {
    socket,
    stream,
    messages: [],
    errors: [],
    closes: [],
    sent: () => clientFrames(Buffer.concat(stream.written.slice(1))),
    upgrade: (frames = []) => {
      const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(Buffer.from(stream.written[0]!).toString())![1]!;
      stream.onData!(Buffer.concat([Buffer.from(upgradeResponse(key)), ...frames]));
    },
    deliver: (frames) => stream.onData!(Buffer.concat(frames)),
  };
  socket.onopen = () => {
    if (options.inSession) socket.setMessageLimit(LIMIT);
    options.onOpen?.(socket);
  };
  socket.onmessage = (ev) => run.messages.push(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  socket.onerror = (ev) => run.errors.push(ev);
  socket.onclose = (ev) => run.closes.push(ev);
  await tick();
  return run;
}

/** Lets the pump's deferred tasks run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await tick();
}

const pings = (count: number, payload = ''): Buffer[] => Array.from({ length: count }, () => frame(OPCODE.ping, payload));
const pongsSent = (run: ScriptedRun) => run.sent().filter((f) => f.opcode === OPCODE.pong);
const closeSent = (run: ScriptedRun) => run.sent().find((f) => f.opcode === OPCODE.close)?.payload.readUInt16BE(0) ?? null;

describe('ping flood before the link handshake ends', () => {
  it('answers the pings an honest computer sends with one pong, for the latest', async () => {
    const run = await scripted();
    run.upgrade([frame(OPCODE.ping, 'a'), frame(OPCODE.ping, 'b'), frame(OPCODE.ping, 'c'), frame(OPCODE.ping, 'd'), frame(OPCODE.binary, 'x')]);
    await settle();
    assert.equal(MAX_HANDSHAKE_CONTROL_FRAMES, 4);
    assert.deepEqual(run.messages, [Buffer.from('x')].map((b) => new Uint8Array(b)));
    assert.deepEqual(
      pongsSent(run).map((f) => f.payload.toString()),
      ['d'],
    );
    assert.equal(run.errors.length, 0);
  });

  it('a fifth ping or pong ends the socket with 1008', async () => {
    const run = await scripted();
    run.upgrade([...pings(3), frame(OPCODE.pong), frame(OPCODE.pong), frame(OPCODE.binary, 'never')]);
    await settle();
    assert.equal(run.errors[0]?.code, CLOSE_CODE.policyViolation);
    assert.equal(closeSent(run), CLOSE_CODE.policyViolation);
    assert.deepEqual(run.messages, []);
  });

  it('a flood of 100,000 pings costs one close frame and no pongs', async () => {
    const run = await scripted();
    const started = performance.now();
    run.upgrade(pings(100_000));
    await settle();
    assert.equal(run.errors[0]?.code, CLOSE_CODE.policyViolation);
    assert.equal(pongsSent(run).length, 0);
    assert.equal(run.stream.written.length, 2, 'the upgrade request and one close frame');
    assert.ok(performance.now() - started < 1000);
  });
});

describe('ping flood inside a session', () => {
  it('pings at the agent’s pace, and a burst of 20, are answered and keep the session', async () => {
    const run = await scripted({ inSession: true });
    run.upgrade(pings(SESSION_PING_BURST, 'burst'));
    await settle();
    await sleep(600); // refills 6
    run.deliver([...pings(5, 'later'), frame(OPCODE.binary, 'ok')]);
    await settle();
    assert.equal(run.errors.length, 0);
    assert.equal(run.messages.length, 1);
    assert.deepEqual(
      pongsSent(run).map((f) => f.payload.toString()),
      ['burst', 'later'],
    );
  });

  it('pings faster than 10 a second past the burst end the session with 1008', async () => {
    const run = await scripted({ inSession: true });
    run.upgrade(pings(SESSION_PING_BURST + 1));
    await settle();
    assert.equal(run.errors[0]?.code, CLOSE_CODE.policyViolation);
    assert.match(run.errors[0]!.message, /pings far faster/);
  });

  it('a flood of 100,000 pings ends it at once, with at most one pong', async () => {
    const run = await scripted({ inSession: true });
    run.upgrade(pings(100_000));
    await settle();
    assert.equal(run.errors[0]?.code, CLOSE_CODE.policyViolation);
    assert.ok(pongsSent(run).length <= 1);
    assert.ok(run.stream.written.length <= 3);
  });

  it(`takes ${MAX_SESSION_PONGS} pongs it never asked for, and closes on the next`, async () => {
    const run = await scripted({ inSession: true });
    run.upgrade(Array.from({ length: MAX_SESSION_PONGS }, () => frame(OPCODE.pong)));
    await settle();
    assert.equal(run.errors.length, 0);
    run.deliver([frame(OPCODE.pong)]);
    await settle();
    assert.equal(run.errors[0]?.code, CLOSE_CODE.policyViolation);
  });

  it('the pump yields after 64 frames even when none reaches the consumer', async () => {
    let deliveredBeforeProbe: boolean | null = null;
    const run = await scripted({
      inSession: true,
      // The pump's first task is queued right after this timer; the probe it queues lands between
      // that task and the next, so it sees the message only if the pump read all 81 frames at once.
      onOpen: () => setTimeout(() => setTimeout(() => (deliveredBeforeProbe = run.messages.length > 0), 0), 0),
    });
    run.upgrade([...pings(SESSION_PING_BURST), ...Array.from({ length: MAX_SESSION_PONGS }, () => frame(OPCODE.pong)), frame(OPCODE.binary, 'last')]);
    await settle();
    assert.equal(deliveredBeforeProbe, false);
    assert.equal(run.messages.length, 1);
    assert.equal(run.errors.length, 0);
  });
});

describe('a FIN racing the deferred pump', () => {
  it('frames that arrived before the FIN are read: the messages, then a clean close', async () => {
    const run = await scripted({ inSession: true });
    run.upgrade();
    run.deliver([frame(OPCODE.binary, 'a'), frame(OPCODE.binary, 'b'), frame(OPCODE.close, Buffer.from([0x03, 0xe8]))]);
    run.stream.onClose!();
    await settle();
    assert.equal(run.messages.length, 2);
    assert.deepEqual(run.errors, []);
    assert.equal(run.closes.length, 1);
    assert.equal(run.closes[0]!.code, 1000);
    assert.equal(run.closes[0]!.wasClean, true);
  });

  it('a FIN after a message with no close frame still reports 1006, once the message is read', async () => {
    const run = await scripted({ inSession: true });
    run.upgrade();
    run.deliver([frame(OPCODE.binary, 'a'), frame(OPCODE.binary, 'b')]);
    run.stream.onClose!();
    await settle();
    assert.equal(run.messages.length, 2);
    assert.equal(run.errors[0]?.code, CLOSE_CODE.abnormal);
    assert.equal(run.closes.length, 1);
    assert.equal(run.closes[0]!.wasClean, false);
  });
});

describe('the upgrade', () => {
  it('has its own deadline: a computer that never answers the upgrade is dropped', async () => {
    const run = await scripted({ connectTimeoutMs: 50 });
    await sleep(80);
    assert.equal(run.errors[0]?.code, CLOSE_CODE.abnormal);
    assert.match(run.errors[0]!.message, /upgrade in time/);
    assert.equal(run.stream.closed, true);
  });

  it('the deadline stops once the upgrade is done', async () => {
    const run = await scripted({ connectTimeoutMs: 50 });
    run.upgrade();
    await sleep(80);
    assert.deepEqual(run.errors, []);
    assert.equal(run.socket.readyState, 1);
    run.socket.close();
  });

  it('a head dripped one byte at a time is read once, not rescanned on every byte', async () => {
    const run = await scripted();
    const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(Buffer.from(run.stream.written[0]!).toString())![1]!;
    const head = Buffer.from(upgradeResponse(key, [`X-Pad: ${'a'.repeat(6000)}`]));
    for (const byte of head) run.stream.onData!(Uint8Array.of(byte));
    assert.equal(run.socket.readyState, 1);
    assert.deepEqual(run.errors, []);
    run.socket.close();
  });

  it('a resumed head scan finds a blank line split across reads at any point', () => {
    const text = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\nrest');
    const end = text.indexOf('\r\n\r\n');
    for (let cut = 1; cut < text.length; cut++) {
      const first = readResponseHead(text.subarray(0, cut), 8192);
      if (cut >= end + 4) continue;
      assert.equal(first.kind, 'incomplete');
      const resumed = readResponseHead(text, 8192, cut);
      assert.equal(resumed.kind, 'head', `cut at ${cut}`);
    }
  });
});

type Listener = (event: { id: number; data?: string; message?: string }) => void;

/** A native module stand-in whose ids are handed out at connect, as the real one does. */
function fakeModule() {
  const listeners = new Map<string, Listener[]>();
  const calls: string[] = [];
  let nextId = 1;
  const connects = new Map<number, () => void>();
  const module = {
    connect: () =>
      new Promise<number>((resolve) => {
        const id = nextId++;
        connects.set(id, () => resolve(id));
      }),
    write: () => new Promise<void>(() => undefined), // never taken: every write stays pending
    ack: () => undefined,
    close: (id: number) => void calls.push(`close ${id}`),
    addListener: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return { remove() {} };
    },
  };
  return {
    module: module as unknown as AuthdeckSocketNative,
    calls,
    emit: (event: string, payload: { id: number; data?: string; message?: string }) => listeners.get(event)?.forEach((l) => l(payload)),
    resolveConnect: (id: number) => connects.get(id)!(),
  };
}

const earlyOf = (transport: unknown) => (transport as { early: Map<number, unknown[]> }).early;

describe('the native transport’s bounds', () => {
  it('drops the late events of a socket JS closed, even while another connect is in flight', async () => {
    const fake = fakeModule();
    const transport = nativeTransport(fake.module);
    void transport.connect('sweep', 1, 100); // id 1 stays in flight
    const pending = transport.connect('h', 1, 100);
    fake.resolveConnect(2);
    const stream = await pending;
    stream.close();
    const chunk = Buffer.alloc(64 * 1024).toString('base64');
    for (let i = 0; i < 5; i++) fake.emit('onData', { id: 2, data: chunk });
    assert.equal(earlyOf(transport).size, 0);
    // Native's onClose ends the wait; a later id reusing nothing is unaffected.
    fake.emit('onClose', { id: 2 });
    fake.emit('onData', { id: 1, data: 'AQ==' });
    assert.equal(earlyOf(transport).size, 1);
  });

  it('a socket that sends more than the early limit before connect resolves is closed, and its stream fails', async () => {
    const fake = fakeModule();
    const transport = nativeTransport(fake.module);
    const pending = transport.connect('h', 1, 100);
    const chunk = Buffer.alloc(256 * 1024).toString('base64');
    for (let sent = 0; sent <= MAX_EARLY_DATA_CHARS; sent += chunk.length) fake.emit('onData', { id: 1, data: chunk });
    assert.ok(fake.calls.includes('close 1'));
    assert.equal(earlyOf(transport).size, 0);
    fake.emit('onClose', { id: 1 });
    fake.resolveConnect(1);
    const stream = await pending;
    const seen: string[] = [];
    stream.onData = () => seen.push('data');
    stream.onError = () => seen.push('error');
    stream.onClose = () => seen.push('close');
    await tick();
    assert.deepEqual(seen, ['error', 'close']);
  });

  it(`holds early events for at most ${MAX_EARLY_SOCKETS} sockets`, () => {
    const fake = fakeModule();
    const transport = nativeTransport(fake.module);
    for (let i = 0; i <= MAX_EARLY_SOCKETS; i++) void transport.connect('h', 1, 100);
    for (let id = 1; id <= MAX_EARLY_SOCKETS + 1; id++) fake.emit('onError', { id, message: 'reset' });
    assert.equal(earlyOf(transport).size, MAX_EARLY_SOCKETS);
    assert.deepEqual(fake.calls, [`close ${MAX_EARLY_SOCKETS + 1}`]);
  });

  it(`ends the connection past ${MAX_PENDING_WRITES} pending writes, however small`, async () => {
    const fake = fakeModule();
    const pending = nativeTransport(fake.module).connect('h', 1, 100);
    fake.resolveConnect(1);
    const stream = await pending;
    const seen: string[] = [];
    stream.onError = () => seen.push('error');
    stream.onClose = () => seen.push('close');
    for (let i = 0; i < MAX_PENDING_WRITES; i++) stream.write(Uint8Array.of(0x8a, 0x80, 0, 0, 0, 0));
    assert.deepEqual(seen, []);
    stream.write(Uint8Array.of(0x8a, 0x80, 0, 0, 0, 0));
    assert.deepEqual(seen, ['error', 'close']);
  });

  it('the largest request the agent accepts, 1 MiB sealed into 17 frames, never trips the pending caps', async () => {
    const fake = fakeModule();
    const pending = nativeTransport(fake.module).connect('h', 1, 100);
    fake.resolveConnect(1);
    const stream = await pending;
    let failed = false;
    stream.onError = () => (failed = true);
    // Three such requests at once, each frame a Noise message plus its link and WebSocket headers.
    for (let i = 0; i < 3 * 17; i++) stream.write(new Uint8Array(65535 + 2 + 14));
    assert.equal(failed, false);
  });
});
