/**
 * SecureCapture over the real expo-screen-capture JS, with the native calls queued one at a time
 * after a random delay as both platforms run them (test/stubs/expo-queued.cjs, from link review 8).
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'expo') return { url: pathToFileURL(path.join(__dirname, 'stubs/expo-queued.cjs')).href, format: 'commonjs', shortCircuit: true };
    return next(spec, ctx);
  },
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SC = require('expo-screen-capture/src/ScreenCapture.ts') as typeof import('expo-screen-capture');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SecureCapture } = require('../src/ui/secureCapture') as typeof import('../src/ui/secureCapture');
const state = (globalThis as { __capture?: { blocked: boolean; snapshotHidden: boolean; failNext: number } }).__capture!;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newCapture = () =>
  new SecureCapture({
    prevent: (k) => SC.preventScreenCaptureAsync(k),
    allow: (k) => SC.allowScreenCaptureAsync(k),
    hideSnapshot: () => SC.enableAppSwitcherProtectionAsync(),
    showSnapshot: () => SC.disableAppSwitcherProtectionAsync(),
  });

describe('SecureCapture with queued native calls (I8-1)', () => {
  it('a second sheet opening while the first one’s hide is queued waits for it too', async () => {
    for (let round = 0; round < 50; round++) {
      const capture = newCapture();
      const first = capture.block();
      const second = capture.block();
      const seen: string[] = [];
      await Promise.all(
        [first, second].map((block, i) =>
          block.ready.then((ok) => {
            assert.equal(ok, true);
            seen.push(`${i}:${state.blocked && state.snapshotHidden}`);
          }),
        ),
      );
      assert.deepEqual(seen.sort(), ['0:true', '1:true'], `round ${round}`);
      first.release(0);
      second.release(0);
      await sleep(40);
      assert.equal(state.snapshotHidden, false);
      assert.equal(state.blocked, false);
    }
  });

  it('randomised: no secret is ever shown while capture or the snapshot is unprotected', async () => {
    let violations = 0;
    for (let round = 0; round < 40; round++) {
      const capture = newCapture();
      const showing = new Set<number>();
      let next = 0;
      const watch = setInterval(() => {
        if (showing.size > 0 && (!state.blocked || !state.snapshotHidden)) violations++;
      }, 1);
      const sheet = async () => {
        const id = next++;
        if (Math.random() < 0.15) state.failNext++;
        const block = capture.block();
        let released = false;
        void block.ready.then((ok) => {
          if (!released && ok) showing.add(id);
        });
        await sleep(Math.random() * 30);
        released = true;
        setTimeout(() => showing.delete(id), 18);
        block.release(20);
      };
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let i = 0; i < 3; i++) await sheet();
      }));
      await sleep(80);
      clearInterval(watch);
      assert.equal(state.blocked || state.snapshotHidden, false, `round ${round} left something blocked`);
      state.failNext = 0;
    }
    assert.equal(violations, 0);
  });
});
