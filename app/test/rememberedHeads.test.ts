// Remembered heads read back from secure storage (secrets.ts): only device ids with a (seq, hash)
// head are kept, at most MAX_REMEMBERED_HEADS; anything else is dropped and counted, never thrown.
import './native';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

// secrets.ts also needs expo-local-authentication, and here a secure store that keeps values.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-secure-store') return { url: pathToFileURL(path.join(__dirname, 'stubs', 'securestore.cjs')).href, format: 'commonjs', shortCircuit: true };
    if (specifier === 'expo-local-authentication') return { url: pathToFileURL(path.join(__dirname, 'stubs', 'localauth.cjs')).href, format: 'commonjs', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
/* eslint-disable @typescript-eslint/no-require-imports */
const secrets = require('../src/auth/engine/secrets') as typeof import('../src/auth/engine/secrets');
const secureStore = require('expo-secure-store') as { __secure: Map<string, string> };
/* eslint-enable @typescript-eslint/no-require-imports */
const { loadRememberedHeads, MAX_REMEMBERED_HEADS, parseRememberedHeads, saveRememberedHeads } = secrets;

const VAULT = 'abcdefghijklmnopqrstuv';
const HASH = 'A'.repeat(43);
const id = (n: number) => `dev${String(n).padStart(19, '0')}`;

afterEach(() => {
  secureStore.__secure.clear();
  mock.restoreAll();
});

describe('remembered heads read from secure storage', () => {
  it('keeps well-formed heads as they were saved', async () => {
    await saveRememberedHeads(VAULT, { [id(1)]: { seq: 3, hash: HASH }, [id(2)]: { seq: 0, hash: HASH } });
    assert.deepEqual(await loadRememberedHeads(VAULT), { [id(1)]: { seq: 3, hash: HASH }, [id(2)]: { seq: 0, hash: HASH } });
  });

  it('drops keys that are not device ids, __proto__ among them, and heads of the wrong shape', () => {
    const stored = JSON.parse(
      `{"__proto__":{"seq":1,"hash":"${HASH}"},"constructor":{"seq":1,"hash":"${HASH}"},"short":{"seq":1,"hash":"${HASH}"},` +
        `"${id(1)}":{"seq":1,"hash":"${HASH}"},"${id(2)}":{"seq":-1,"hash":"${HASH}"},"${id(3)}":{"seq":1.5,"hash":"${HASH}"},` +
        `"${id(4)}":{"seq":1,"hash":"nope"},"${id(5)}":null,"${id(6)}":7}`,
    ) as unknown;
    const { heads, dropped } = parseRememberedHeads(stored);
    assert.deepEqual(Object.keys(heads), [id(1)]);
    assert.equal(dropped, 8);
    assert.equal(Object.getPrototypeOf(heads), Object.prototype);
  });

  it('keeps at most MAX_REMEMBERED_HEADS and counts the rest', () => {
    const stored = Object.fromEntries(Array.from({ length: MAX_REMEMBERED_HEADS + 10 }, (_, n) => [id(n), { seq: n, hash: HASH }]));
    const { heads, dropped } = parseRememberedHeads(stored);
    assert.equal(Object.keys(heads).length, MAX_REMEMBERED_HEADS);
    assert.equal(dropped, 10);
  });

  it('reads a value that is not an object as no heads', () => {
    for (const value of [[], 'x', 7, true]) assert.deepEqual(parseRememberedHeads(value), { heads: {}, dropped: 1 });
    assert.deepEqual(parseRememberedHeads(null), { heads: {}, dropped: 0 });
  });

  it('loads what it can, logs only a count, and never throws on a damaged entry', async () => {
    const warn = mock.method(console, 'warn', () => {});
    secureStore.__secure.set(`authdeck_heads_${VAULT}`, JSON.stringify({ [id(1)]: { seq: 2, hash: HASH }, bad: { seq: 'x' } }));
    assert.deepEqual(await loadRememberedHeads(VAULT), { [id(1)]: { seq: 2, hash: HASH } });
    assert.equal(warn.mock.callCount(), 1);
    const text = String(warn.mock.calls[0]!.arguments[0]);
    assert.match(text, /Dropped 1 /);
    assert.ok(!text.includes(HASH) && !text.includes('bad'));
  });
});
