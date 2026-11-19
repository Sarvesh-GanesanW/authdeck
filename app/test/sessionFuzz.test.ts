/**
 * Nothing a paired computer sends may crash the app: every method's result is checked before a
 * request resolves, and random or wrongly typed messages fail cleanly. Uses a stand-in socket and
 * channel, so thousands of messages run in well under a second.
 */
import './native';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { SecureChannel } from '../src/link/channel';
import { AgentSession, RequestError } from '../src/net/client';
import type { FrameSocket } from '../src/net/linkSocket';
import { LIMITS, isMethodResult, readSessionMessage } from '../src/net/messages';
import type { Method } from '../src/protocol';
import { pngBase64 } from './pngFixture';

const ICON = pngBase64(32, 32);
const long = (chars: number) => 'x'.repeat(chars + 1);

/** A valid result for every method; typed over Method, so a new method needs one here to compile. */
const VALID: Record<Method, Record<string, unknown>> = {
  ping: { time: 1 },
  'apps.list': { apps: [{ id: 'mac:/A.app', name: 'A', detail: '/A.app', hasIcon: true }] },
  'apps.icons': { icons: { a: null, b: { mime: 'image/png', data: ICON } } },
  'fs.list': { path: '/h', parent: '/', entries: [{ name: 'a', path: '/h/a', kind: 'dir' }], roots: [{ name: 'h', path: '/h', kind: 'dir' }], home: '/h', sep: '/' },
  'focus.get': { supported: true, appId: null, name: 'Code' },
  run: { durationMs: 3, exitCode: 0, output: 'ok', note: 'Used a fallback.' },
  'vault.list': {
    vaults: [
      { vaultId: 'v', kind: 'personal', location: 'personal', path: '/v', lengths: { d: 2 } },
      { vaultId: 'w', kind: 'solo', location: 'personal', path: '/w', lengths: {}, retired: { at: 1, keptUntil: 2, newVaultId: 'abcdefghijklmnopqrstuv', byDevice: 'Phone' } },
    ],
    teamFolder: null,
  },
  'vault.read': { vaultId: 'v', location: 'team', logs: { d: { from: 0, lines: ['x'] } }, lengths: { d: 1 } },
  'vault.append': { lengths: { d: 3 } },
  'vault.beacons.read': { beacons: { d: '{}' } },
  'vault.beacons.write': {},
  'vault.forks.read': { forks: [{ deviceId: 'd', seq: 4, lines: ['a', 'b'] }], sealProofs: [] },
  'vault.forks.write': {},
  'vault.retire': { keptUntil: 1 },
  'vault.join.request': { requestId: 'r', expiresAt: 5 },
  'vault.join.challenge': {},
  'vault.join.reveal': {},
  'vault.join.finish': {},
  'vault.join.cancel': {},
};
const METHODS = Object.keys(VALID) as Method[];
/** A vault a phone replaced (vault.retire), as vault.list reports it. */
const RETIRED_VAULT = { vaultId: 'v', kind: 'solo', location: 'personal', path: '/v', lengths: {}, retired: { at: 1, keptUntil: 2, newVaultId: 'abcdefghijklmnopqrstuv', byDevice: null } };

/** Results each method must refuse, the review's PoC cases among them. */
const WRONG: Partial<Record<Method, unknown[]>> = {
  ping: [{}, { time: '1' }, { time: null }],
  'apps.list': [
    { apps: {} },
    { apps: [{ id: 1, name: 'A', hasIcon: true }] },
    { apps: [null] },
    { apps: [{ id: 'a', name: 'A', hasIcon: 'yes' }] },
    // Round 5 N2: past the limits (a 120 KB id made the saved state unloadable on Android).
    { apps: [{ id: long(LIMITS.appId), name: 'Visual Studio Code', hasIcon: false }] },
    { apps: [{ id: 'a', name: long(LIMITS.appName), hasIcon: false }] },
    { apps: [{ id: 'a', name: 'A', detail: long(LIMITS.appDetail), hasIcon: false }] },
  ],
  'apps.icons': [
    { icons: [] },
    { icons: { a: { mime: 'image/gif', data: 'x' } } },
    { icons: { a: 'png' } },
    // Round 5 N1: SVG, and more icons than one call asks for. (Larger cases: linkReview5.test.ts.)
    { icons: { a: { mime: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') } } },
    { icons: Object.fromEntries(Array.from({ length: LIMITS.iconsPerReply + 1 }, (_, i) => [`a${i}`, null])) },
  ],
  'fs.list': [
    { ...VALID['fs.list'], entries: {} },
    { ...VALID['fs.list'], sep: ':' },
    { ...VALID['fs.list'], parent: 1 },
    { ...VALID['fs.list'], entries: [{ name: long(LIMITS.fsName), path: '/h/a', kind: 'file' }] },
    { ...VALID['fs.list'], path: long(LIMITS.fsPath) },
  ],
  'focus.get': [
    { supported: true, appId: 7, name: 'x' },
    { supported: 'yes', appId: null, name: 'x' },
    { supported: true, appId: null, name: long(LIMITS.focusName) },
    { supported: true, appId: long(LIMITS.appId), name: 'x' },
  ],
  run: [
    { durationMs: 1, note: { x: 1 } },
    { durationMs: '1' },
    { durationMs: 1, output: ['x'] },
    { durationMs: 1, exitCode: '0' },
    { durationMs: 1, output: long(LIMITS.runOutput) },
    { durationMs: 1, note: long(LIMITS.runNote) },
  ],
  'vault.list': [
    { vaults: {} },
    { vaults: [], teamFolder: 3 },
    { vaults: [{ vaultId: 'v', kind: 'evil', location: 'personal', path: '/', lengths: {} }], teamFolder: null },
    { vaults: [{ ...RETIRED_VAULT, retired: { ...RETIRED_VAULT.retired, newVaultId: 'not an id' } }], teamFolder: null },
    { vaults: [{ ...RETIRED_VAULT, retired: { ...RETIRED_VAULT.retired, keptUntil: '1' } }], teamFolder: null },
    // I9-2: a time past what a Date can show, or before 1970, or not whole.
    { vaults: [{ ...RETIRED_VAULT, retired: { ...RETIRED_VAULT.retired, at: 1e300 } }], teamFolder: null },
    { vaults: [{ ...RETIRED_VAULT, retired: { ...RETIRED_VAULT.retired, at: 8.64e15 + 1 } }], teamFolder: null },
    { vaults: [{ ...RETIRED_VAULT, retired: { ...RETIRED_VAULT.retired, at: -1 } }], teamFolder: null },
    { vaults: [{ ...RETIRED_VAULT, retired: { ...RETIRED_VAULT.retired, keptUntil: 1.5 } }], teamFolder: null },
    { vaults: [{ ...RETIRED_VAULT, retired: { ...RETIRED_VAULT.retired, byDevice: long(LIMITS.retiredBy) } }], teamFolder: null },
    { vaults: [{ ...RETIRED_VAULT, retired: 'yes' }], teamFolder: null },
  ],
  'vault.read': [{ ...VALID['vault.read'], logs: { d: { from: 0, lines: [1] } } }, { ...VALID['vault.read'], lengths: { d: 'x' } }],
  'vault.append': [{ lengths: [] }, { lengths: { d: null } }],
  'vault.beacons.read': [{ beacons: { d: {} } }],
  'vault.forks.read': [
    { forks: [{ deviceId: 'd', seq: 1, lines: ['a'] }], sealProofs: [] },
    { forks: {}, sealProofs: [] },
    { forks: [] },
    { forks: [], sealProofs: [{ entry: 1 }] },
    { forks: [], sealProofs: Array.from({ length: 257 }, () => ({})) },
  ],
  'vault.retire': [{}, { keptUntil: '1' }, { keptUntil: null }, { keptUntil: 1, extra: true }, { keptUntil: -1 }, { keptUntil: 1.5 }],
  'vault.join.request': [{ requestId: 'r' }, { requestId: 1, expiresAt: 1 }],
};
const NOT_OBJECTS = [null, 1, 'x', true, [], [{}]];

/** A small seeded generator, so a failure reproduces. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['apps', 'icons', 'note', 'time', 'path', 'entries', 'vaults', 'lengths', 'logs', 'forks', 'requestId', '__proto__', 'constructor', 'toString', 'x'];

function randomValue(rand: () => number, depth = 0): unknown {
  const pick = Math.floor(rand() * (depth > 2 ? 6 : 8));
  switch (pick) {
    case 0:
      return null;
    case 1:
      return rand() < 0.5;
    case 2:
      return [0, -1, 1e308, 0.5, 2 ** 53][Math.floor(rand() * 5)];
    case 3:
      return ['', 'x', '\u0000', '‮', 'a'.repeat(200)][Math.floor(rand() * 5)];
    case 4:
      return {};
    case 5:
      return [];
    case 6:
      return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(rand, depth + 1));
    default: {
      const fields: Record<string, unknown> = {};
      for (let i = Math.floor(rand() * 5); i > 0; i--) fields[KEYS[Math.floor(rand() * KEYS.length)]!] = randomValue(rand, depth + 1);
      return fields;
    }
  }
}

/** Every copy of `value` with one field, at any depth, swapped for a value of another type. */
function typeSwaps(value: unknown): unknown[] {
  const swaps = [null, 0, 'x', true, [], {}, { x: 1 }];
  if (typeof value !== 'object' || value === null) return swaps.filter((s) => typeof s !== typeof value);
  const out: unknown[] = [];
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v] as const) : Object.entries(value);
  for (const [key, child] of entries) {
    for (const swapped of typeSwaps(child)) {
      const copy = (Array.isArray(value) ? [...(value as unknown[])] : { ...value }) as Record<string | number, unknown>;
      copy[key] = swapped;
      out.push(copy);
    }
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A session over a stand-in socket. Frames are plain UTF-8: the channel's crypto is tested elsewhere. */
function standInSession(open: (frame: Uint8Array) => string | null = (frame) => decoder.decode(frame)) {
  const sent: { id: string; method: string }[] = [];
  const ws = {
    readyState: WebSocket.OPEN as number,
    setMessageLimit() {},
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    send(frame: Uint8Array) {
      sent.push(JSON.parse(decoder.decode(frame)) as { id: string; method: string });
    },
    close() {
      ws.readyState = WebSocket.CLOSED;
      ws.onclose?.();
    },
  };
  const channel = { seal: (text: string) => [encoder.encode(text)], open } as unknown as SecureChannel;
  const session = new AgentSession(ws as unknown as FrameSocket, 'stand-in', channel);
  /** Delivers one frame; true if it threw out of the socket handler. */
  const deliver = (data: unknown): boolean => {
    try {
      ws.onmessage!({ data });
      return false;
    } catch {
      return true;
    }
  };
  const reply = (result: unknown) => deliver(encoder.encode(JSON.stringify({ id: sent[sent.length - 1]!.id, ok: true, result })).buffer);
  return { session, sent, deliver, reply };
}

const uncaught: unknown[] = [];
const onUncaught = (e: unknown) => uncaught.push(e);
before(() => {
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
});
after(() => {
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUncaught);
  assert.deepEqual(uncaught, [], 'nothing escaped');
});

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Sends `method`, answers it with `result`, and reports how the request settled. */
async function answer(method: Method, result: unknown): Promise<{ settled: Settled; threw: boolean; open: boolean }> {
  const { session, reply } = standInSession();
  const pending = session.request(method, {} as never, 1000).then(
    (value): Settled => ({ ok: true, value }),
    (error: unknown): Settled => ({ ok: false, error }),
  );
  const threw = reply(result);
  const settled = await pending;
  const open = session.isOpen;
  session.close();
  return { settled, threw, open };
}

function assertCleanRejection(settled: Settled, what: string): void {
  assert.equal(settled.ok, false, `${what} resolved`);
  if (settled.ok) return;
  assert.ok(settled.error instanceof RequestError, what);
  assert.equal(settled.error.code, 'failed');
  assert.equal(settled.error.message, 'The computer sent something AuthDeck does not understand.');
}

describe('every method’s result is checked before the request resolves', () => {
  for (const method of METHODS) {
    it(`${method}: a well-formed result resolves`, async () => {
      const { settled, threw } = await answer(method, VALID[method]);
      assert.equal(threw, false);
      assert.deepEqual(settled, { ok: true, value: VALID[method] });
    });

    if (WRONG[method]) {
      it(`${method}: wrongly typed results fail the request in the app’s words; the session stays`, async () => {
        for (const wrong of WRONG[method]!) {
          const { settled, threw, open } = await answer(method, wrong);
          assert.equal(threw, false);
          assertCleanRejection(settled, `${method} ${JSON.stringify(wrong)}`);
          assert.equal(open, true, 'a wrong result fails only its request');
        }
      });
    }

    it(`${method}: a result that is not an object fails the request and ends the session`, async () => {
      for (const wrong of NOT_OBJECTS) {
        const { settled, threw, open } = await answer(method, wrong);
        assert.equal(threw, false);
        assert.equal(settled.ok, false);
        assert.ok(!settled.ok && settled.error instanceof RequestError && settled.error.code === 'failed', JSON.stringify(wrong));
        assert.equal(open, false);
      }
    });

    it(`${method}: every one-field type swap and 300 random results settle cleanly, and only checked shapes resolve`, async () => {
      const rand = prng(METHODS.indexOf(method) + 1);
      const payloads = [...typeSwaps(VALID[method]), ...Array.from({ length: 300 }, () => randomValue(rand))];
      for (const payload of payloads) {
        const { settled, threw } = await answer(method, payload);
        assert.equal(threw, false);
        if (settled.ok) assert.ok(isMethodResult(method, settled.value), JSON.stringify(payload));
        else assert.ok(settled.error instanceof RequestError, JSON.stringify(payload));
      }
    });
  }

  it('a result for a method the app never sent cannot pass', () => {
    assert.equal(isMethodResult('clipboard.read', {}), false);
    assert.equal(isMethodResult('__proto__', {}), false);
    assert.equal(isMethodResult('toString', {}), false);
  });
});

describe('random messages never escape the session', () => {
  it('readSessionMessage reads 5000 random texts and JSON values without throwing', () => {
    const rand = prng(99);
    for (let i = 0; i < 5000; i++) {
      const text = i % 2 ? JSON.stringify(randomValue(rand)) : String.fromCharCode(...Array.from({ length: Math.floor(rand() * 40) }, () => Math.floor(rand() * 0xffff)));
      assert.doesNotThrow(() => readSessionMessage(text));
    }
    for (const text of ['{"event":"focus","data":{"__proto__":1}}', '{"id":"1","ok":true,"result":{"__proto__":{}}}', '{"event":"__proto__"}', '{"event":"toString","data":{}}']) {
      assert.doesNotThrow(() => readSessionMessage(text));
    }
  });

  it('receive takes random frames, text and other junk without throwing', () => {
    const rand = prng(7);
    const junk: unknown[] = ['plain text', null, undefined, 42, {}, new ArrayBuffer(0), new Uint8Array(70000)];
    for (let i = 0; i < 2000; i++) junk.push(encoder.encode(JSON.stringify(randomValue(rand))).buffer);
    for (const data of junk) {
      const { session, deliver } = standInSession();
      assert.equal(deliver(data), false, String(data));
      session.close();
    }
  });

  it('a channel that throws, or opens to junk, ends the session without throwing', () => {
    const throwing = standInSession(() => {
      throw new Error('bad tag');
    });
    assert.equal(throwing.deliver(new Uint8Array([1, 2]).buffer), false);
    assert.equal(throwing.session.isOpen, false);
    const junk = standInSession(() => '�{');
    assert.equal(junk.deliver(new Uint8Array([1]).buffer), false);
    assert.equal(junk.session.isOpen, false);
  });

  it('a wrong result while other requests wait fails only that request', async () => {
    const { session, sent, deliver } = standInSession();
    const first = session.request('ping', {}, 1000);
    const second = session.request('apps.list', {}, 1000);
    const [ping, list] = sent;
    deliver(encoder.encode(JSON.stringify({ id: list!.id, ok: true, result: { apps: {} } })).buffer);
    deliver(encoder.encode(JSON.stringify({ id: ping!.id, ok: true, result: { time: 9 } })).buffer);
    assert.deepEqual(await first, { time: 9 });
    await assert.rejects(second, RequestError);
    assert.equal(session.isOpen, true);
    session.close();
  });
});
