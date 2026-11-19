import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CaptureApi, CAPTURE_TEST_MODES_OFF, captureTestModes, readCaptureTestModes, SecureCapture, withCaptureTestModes } from '../src/ui/secureCapture';

/** expo-screen-capture's own rule: capture is blocked while any key is held. */
function fakeApi(opts: { failPrevent?: boolean; ios?: boolean } = {}) {
  const keys = new Set<string>();
  const state = { snapshotHidden: false, calls: [] as string[] };
  const api: CaptureApi = {
    prevent: async (key) => {
      if (opts.failPrevent) throw new Error('no');
      keys.add(key);
    },
    allow: async (key) => {
      keys.delete(key);
    },
    ...(opts.ios
      ? {
          hideSnapshot: async () => {
            state.calls.push('hide');
            state.snapshotHidden = true;
          },
          showSnapshot: async () => {
            state.calls.push('show');
            state.snapshotHidden = false;
          },
        }
      : {}),
  };
  return { api, keys, state, blocked: () => keys.size > 0 };
}

/** A clock the test moves by hand. */
function manualTimers() {
  let now = 0;
  const pending: { at: number; run: () => void }[] = [];
  return {
    schedule: (run: () => void, ms: number) => void pending.push({ at: now + ms, run }),
    advance: async (ms: number) => {
      now += ms;
      for (const t of pending.filter((p) => p.at <= now)) {
        pending.splice(pending.indexOf(t), 1);
        t.run();
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe('SecureSheet capture blocking', () => {
  it('L-A: closing and reopening within the release delay keeps the block', async () => {
    const fake = fakeApi();
    const timers = manualTimers();
    const capture = new SecureCapture(fake.api, timers.schedule);
    const first = capture.block();
    assert.equal(await first.ready, true);
    first.release(800);
    await timers.advance(200);
    const second = capture.block(); // reopened 200 ms after closing
    assert.equal(await second.ready, true);
    await timers.advance(5000); // the first release has run
    assert.equal(fake.blocked(), true);
    second.release(800);
    await timers.advance(800);
    assert.equal(fake.blocked(), false);
  });

  it('reports a failed block, so the sheet can ask before showing the secret', async () => {
    const capture = new SecureCapture(fakeApi({ failPrevent: true }).api, manualTimers().schedule);
    assert.equal(await capture.block().ready, false);
  });

  it('iOS: hides the app-switcher snapshot while any secure sheet is open, once', async () => {
    const fake = fakeApi({ ios: true });
    const timers = manualTimers();
    const capture = new SecureCapture(fake.api, timers.schedule);
    const a = capture.block();
    const b = capture.block();
    await Promise.all([a.ready, b.ready]);
    assert.equal(fake.state.snapshotHidden, true);
    a.release(800);
    await timers.advance(800);
    assert.equal(fake.state.snapshotHidden, true);
    b.release(800);
    b.release(800); // a second release is ignored
    await timers.advance(800);
    assert.deepEqual(fake.state.calls, ['hide', 'show']);
  });

  it('a failed block never releases another sheet’s snapshot hold', async () => {
    const good = fakeApi({ ios: true });
    let fail = false;
    const api: CaptureApi = { ...good.api, prevent: async (key) => (fail ? Promise.reject(new Error('no')) : good.api.prevent(key)) };
    const timers = manualTimers();
    const capture = new SecureCapture(api, timers.schedule);
    const held = capture.block();
    await held.ready;
    fail = true;
    const failed = capture.block();
    assert.equal(await failed.ready, false);
    failed.release(0);
    await timers.advance(0);
    assert.equal(good.state.snapshotHidden, true);
  });
});

describe('the dev-only capture test modes', () => {
  it('are both off unless the test switch is on', () => {
    assert.deepEqual(readCaptureTestModes(false, '1', '1'), CAPTURE_TEST_MODES_OFF);
    assert.deepEqual(readCaptureTestModes(true, undefined, undefined), CAPTURE_TEST_MODES_OFF);
  });

  it('are off here: no __DEV__, so no test switch, whatever the variables say', () => {
    process.env.EXPO_PUBLIC_AUTHDECK_TEST_ALLOW_CAPTURE = '1';
    process.env.EXPO_PUBLIC_AUTHDECK_TEST_CAPTURE_FAILS = '1';
    assert.deepEqual(captureTestModes, CAPTURE_TEST_MODES_OFF);
  });

  it('take only "1", each on its own', () => {
    assert.deepEqual(readCaptureTestModes(true, '1', undefined), { allowCapture: true, failBlock: false });
    assert.deepEqual(readCaptureTestModes(true, 'true', '1'), { allowCapture: false, failBlock: true });
  });

  it('leave the real api alone when off', () => {
    const api = { prevent: async () => undefined, allow: async () => undefined };
    assert.equal(withCaptureTestModes(api, CAPTURE_TEST_MODES_OFF), api);
  });

  it('allow capture: the block never reaches the platform and still counts as ready', async () => {
    let calls = 0;
    const api = { prevent: async () => void calls++, allow: async () => void calls++ };
    const block = new SecureCapture(withCaptureTestModes(api, { allowCapture: true, failBlock: false })).block();
    assert.equal(await block.ready, true);
    assert.equal(calls, 0);
  });

  it('a failing block wins, so the fail-closed sheet shows', async () => {
    const api = { prevent: async () => undefined, allow: async () => undefined };
    const block = new SecureCapture(withCaptureTestModes(api, { allowCapture: true, failBlock: true })).block();
    assert.equal(await block.ready, false);
  });
});
