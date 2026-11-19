import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentConfig } from '../src/config';
import { AgentError } from '../src/errors';
import { FIRST_PIN_LOCKOUT_MS, LAST_SEEN_WRITE_MS, MAX_PIN_FAILURES, MAX_PIN_LOCKOUT_MS, PAIRING_WINDOW_MS, Pairing } from '../src/pairing';
import { toBase64Url } from '../src/vault/bytes';

const key = (fill: number) => new Uint8Array(32).fill(fill);
const START = 1_000_000;

/** A Pairing over an in-memory agent.json, with pairing open and PIN 123456, QR secret qr-1. */
function setup() {
  let config: AgentConfig = { agentId: 'a', name: 'n', port: 1, pin: '123456', pairSecret: 'qr-1', pairingOpenUntil: START + PAIRING_WINDOW_MS, devices: [], terminal: 'Terminal' };
  let now = START;
  let pins = 0;
  let secrets = 1;
  let writes = 0;
  let changes = 0;
  const deps = {
    load: () => structuredClone(config),
    update: (change: (c: AgentConfig) => void) => {
      const updated = structuredClone(config);
      change(updated);
      config = structuredClone(updated);
      writes += 1;
      return updated;
    },
    newPin: () => `65432${pins++}`,
    newPairSecret: () => `qr-${++secrets}`,
    onPairingChanged: () => (changes += 1),
    now: () => now,
  };
  return {
    pairing: new Pairing(deps),
    /** The same agent.json after a restart: a new Pairing, nothing kept in memory. */
    restart: () => new Pairing(deps),
    config: () => config,
    setConfig: (c: AgentConfig) => (config = c),
    advance: (ms: number) => (now += ms),
    writes: () => writes,
    changes: () => changes,
  };
}

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return (err as AgentError).code;
  }
};

/** One PIN run that tested a wrong PIN. */
const wrongGuess = (pairing: Pairing) => {
  pairing.beginPin();
  pairing.endPin('wrong-pin');
};

const PAD = { deviceId: 'pad', deviceName: 'Pad' };

describe('pairing', () => {
  it('pairs by PIN and stores the device with its link key, no token', () => {
    const t = setup();
    assert.equal(t.pairing.beginPin(), '123456');
    const device = t.pairing.pairWithPin(key(1), { deviceId: 'pad', deviceName: '  Ada’s   Pad ', form: 'tablet' });
    t.pairing.endPin('paired');
    assert.deepEqual(t.config().devices, [device]);
    assert.equal(device.linkKey, toBase64Url(key(1)));
    assert.equal(device.deviceName, 'Ada’s Pad');
    assert.equal(device.tokenSha256, undefined);
  });

  it('allows one PIN run at a time, and every way a run ends frees it', () => {
    const t = setup();
    for (const end of ['wrong-pin', 'no-guess', 'pin-proven', 'paired'] as const) {
      t.pairing.beginPin();
      assert.equal(code(() => t.pairing.beginPin()), 'locked');
      t.pairing.endPin(end);
      assert.equal(code(() => t.pairing.beginPin()), 'ok', end);
      t.pairing.endPin('no-guess');
    }
  });

  it(`replaces the PIN after ${MAX_PIN_FAILURES} wrong guesses and pauses PIN pairing`, () => {
    const t = setup();
    for (let i = 0; i < MAX_PIN_FAILURES - 1; i++) wrongGuess(t.pairing);
    assert.equal(t.config().pin, '123456');
    wrongGuess(t.pairing);
    assert.equal(t.config().pin, '654320');
    assert.equal(t.config().pairSecret, 'qr-1', 'the QR code still works');
    assert.equal(code(() => t.pairing.beginPin()), 'locked');
    t.advance(FIRST_PIN_LOCKOUT_MS - 1);
    assert.equal(code(() => t.pairing.beginPin()), 'locked');
    t.advance(1);
    assert.equal(t.pairing.beginPin(), '654320');
  });

  it('only a tested guess counts: abandoned runs never replace the PIN or pause pairing', () => {
    const t = setup();
    for (let i = 0; i < 50; i++) {
      t.pairing.beginPin();
      t.pairing.endPin(i % 2 === 0 ? 'no-guess' : 'pin-proven');
    }
    assert.equal(t.config().pin, '123456');
    assert.equal(t.pairing.beginPin(), '123456');
  });

  it('keeps wrong guesses and the pause across restarts', () => {
    const t = setup();
    for (let i = 0; i < MAX_PIN_FAILURES - 1; i++) wrongGuess(t.restart());
    wrongGuess(t.restart());
    assert.equal(t.config().pin, '654320', 'guesses on one PIN add up across restarts');
    assert.equal(code(() => t.restart().beginPin()), 'locked', 'the pause survives a restart');
  });

  it('pauses longer after each replacement, up to the cap, until a pairing succeeds', () => {
    const t = setup();
    t.setConfig({ ...t.config(), pairingOpenUntil: Number.MAX_SAFE_INTEGER });
    /** Three wrong guesses, then how long PIN pairing is paused, and wait it out. */
    const pauseAfterRound = () => {
      for (let i = 0; i < MAX_PIN_FAILURES; i++) wrongGuess(t.pairing);
      let message = '';
      try {
        t.pairing.beginPin();
      } catch (err) {
        message = (err as Error).message;
      }
      const seconds = Number(/paused for (\d+) more seconds/.exec(message)?.[1]);
      t.advance(seconds * 1000);
      return seconds * 1000;
    };
    const pauses = Array.from({ length: 9 }, pauseAfterRound);
    assert.deepEqual(pauses, [1, 2, 4, 8, 16, 32, 64, 120, 120].map((n) => Math.min(MAX_PIN_LOCKOUT_MS, n * FIRST_PIN_LOCKOUT_MS)));
    t.pairing.beginPin();
    t.pairing.pairWithPin(key(2), PAD);
    t.pairing.endPin('paired');
    t.pairing.openWindow();
    assert.equal(pauseAfterRound(), FIRST_PIN_LOCKOUT_MS);
  });

  it('a right PIN resets the wrong-guess count and replaces the PIN and QR secret', () => {
    const t = setup();
    for (let i = 0; i < MAX_PIN_FAILURES - 1; i++) wrongGuess(t.pairing);
    t.pairing.beginPin();
    t.pairing.pairWithPin(key(1), { deviceId: 'd', deviceName: 'n' });
    t.pairing.endPin('paired');
    assert.notEqual(t.config().pin, '123456');
    assert.notEqual(t.config().pairSecret, 'qr-1');
    t.pairing.openWindow();
    const { pin } = t.config();
    for (let i = 0; i < MAX_PIN_FAILURES - 1; i++) wrongGuess(t.pairing);
    assert.equal(t.config().pin, pin);
  });

  it('a pairing closes the window, by QR code or by PIN', () => {
    const t = setup();
    t.pairing.pairWithSecret(key(1), PAD, 'qr-1');
    assert.equal(t.pairing.window(), null);
    assert.equal(t.config().pairingOpenUntil, 0);
    assert.equal(code(() => t.pairing.beginPin()), 'locked');
    t.pairing.openWindow();
    t.pairing.beginPin();
    t.pairing.pairWithPin(key(2), { deviceId: 'phone', deviceName: 'Phone' });
    t.pairing.endPin('paired');
    assert.equal(t.pairing.window(), null);
  });

  it('a wrong PIN that cannot be saved still counts: no PIN run starts until it is saved', () => {
    const t = setup();
    let busy = false;
    const deps = (t.pairing as unknown as { deps: { update: (c: (config: AgentConfig) => void) => AgentConfig } }).deps;
    const update = deps.update;
    deps.update = (change) => {
      if (busy) throw new Error('agent.json is locked');
      return update(change);
    };
    wrongGuess(t.pairing);
    busy = true;
    t.pairing.beginPin();
    assert.throws(() => t.pairing.endPin('wrong-pin'), /locked/);
    assert.equal(t.config().pinGuard?.failuresOnPin, 1, 'not saved yet');
    assert.equal(code(() => t.pairing.beginPin()), 'locked', 'no further guess while one is unsaved');
    busy = false;
    t.pairing.beginPin();
    t.pairing.endPin('no-guess');
    assert.equal(t.config().pinGuard?.failuresOnPin, 2, 'the unsaved guess was saved before the next run');
    wrongGuess(t.pairing);
    assert.notEqual(t.config().pin, '123456', 'three wrong guesses replaced the PIN');
  });

  it('QR pairing needs the current secret, which then changes', () => {
    const t = setup();
    assert.equal(code(() => t.pairing.pairWithSecret(key(1), PAD, 'qr-0')), 'unauthorized');
    t.pairing.pairWithSecret(key(1), PAD, 'qr-1');
    assert.equal(t.config().pairSecret, 'qr-2');
    assert.ok(t.changes() > 0);
    assert.equal(code(() => t.pairing.pairWithSecret(key(2), { deviceId: 'phone', deviceName: 'Phone' }, 'qr-1')), 'unauthorized');
  });

  it('refuses an empty QR secret and an empty stored PIN or secret', () => {
    const t = setup();
    assert.equal(code(() => t.pairing.pairWithSecret(key(1), PAD, '')), 'unauthorized');
    t.setConfig({ ...t.config(), pairSecret: '' });
    assert.equal(code(() => t.pairing.pairWithSecret(key(1), PAD, '')), 'unauthorized');
    t.setConfig({ ...t.config(), pin: '', pairSecret: 'qr-1' });
    assert.equal(code(() => t.pairing.beginPin()), 'locked');
  });

  describe('the pairing window', () => {
    it('neither the PIN nor the QR code works while pairing is closed', () => {
      const t = setup();
      t.pairing.closeWindow();
      const { pin, pairSecret } = t.config();
      assert.equal(t.pairing.window(), null);
      assert.equal(code(() => t.pairing.beginPin()), 'locked');
      assert.equal(code(() => t.pairing.pairWithSecret(key(1), PAD, pairSecret)), 'unauthorized');
      assert.ok(pin.length > 0);
    });

    it('closing replaces both secrets; opening makes new ones that last the window', () => {
      const t = setup();
      t.pairing.closeWindow();
      assert.notEqual(t.config().pin, '123456');
      assert.notEqual(t.config().pairSecret, 'qr-1');
      const window = t.pairing.openWindow();
      assert.equal(window.closesAt, START + PAIRING_WINDOW_MS);
      assert.equal(t.pairing.beginPin(), window.pin);
      t.pairing.endPin('no-guess');
      t.advance(PAIRING_WINDOW_MS);
      assert.equal(t.pairing.window(), null, 'the window runs out by itself');
      assert.equal(code(() => t.pairing.beginPin()), 'locked');
      assert.equal(code(() => t.pairing.pairWithSecret(key(1), PAD, window.pairSecret)), 'unauthorized');
    });

    it('a pairing that finishes after the window closed is refused', () => {
      const t = setup();
      t.pairing.beginPin();
      t.pairing.closeWindow();
      assert.equal(code(() => t.pairing.pairWithPin(key(1), PAD)), 'locked');
      t.pairing.endPin('pin-proven');
      assert.deepEqual(t.config().devices, []);
    });

    it('expiring closes only the window that ran out, not one opened since', () => {
      const t = setup();
      const first = t.pairing.openWindow();
      t.advance(1000);
      const second = t.pairing.openWindow();
      t.pairing.expireWindow(first.closesAt);
      assert.equal(t.pairing.window()?.pin, second.pin);
      t.pairing.expireWindow(second.closesAt);
      assert.equal(t.pairing.window(), null);
    });
  });

  it('signs in a paired device by its link key without writing to disk', () => {
    const t = setup();
    t.pairing.pairWithSecret(key(1), PAD, 'qr-1');
    const writes = t.writes();
    assert.equal(t.pairing.session(key(1)).deviceId, 'pad');
    assert.equal(t.writes(), writes);
    assert.equal(code(() => t.pairing.session(key(9))), 'unauthorized');
  });

  it('writes lastSeenAt at most once a minute per device', () => {
    const t = setup();
    t.pairing.pairWithSecret(key(1), PAD, 'qr-1');
    const writes = t.writes();
    t.advance(1000);
    t.pairing.touch('pad');
    assert.equal(t.writes(), writes, 'just paired: lastSeenAt is fresh');
    t.advance(LAST_SEEN_WRITE_MS);
    t.pairing.touch('pad');
    t.pairing.touch('pad');
    assert.equal(t.writes(), writes + 1);
    assert.equal(t.config().devices[0]!.lastSeenAt, new Date(START + 1000 + LAST_SEEN_WRITE_MS).toISOString());
  });

  it('touching a device revoked meanwhile does not bring it back', () => {
    const t = setup();
    t.pairing.pairWithSecret(key(1), PAD, 'qr-1');
    t.setConfig({ ...t.config(), devices: [] });
    t.advance(LAST_SEEN_WRITE_MS);
    t.pairing.touch('pad');
    assert.deepEqual(t.config().devices, []);
  });

  it('never signs in a protocol 1 pairing, which has a token hash and no link key', () => {
    const t = setup();
    t.setConfig({ ...t.config(), devices: [{ deviceId: 'old', deviceName: 'Old', tokenSha256: 'ab'.repeat(32), pairedAt: '', lastSeenAt: '' }] });
    assert.equal(code(() => t.pairing.session(key(0))), 'unauthorized');
  });

  it('re-pairing a device replaces its old key', () => {
    const t = setup();
    t.pairing.pairWithSecret(key(1), PAD, 'qr-1');
    t.pairing.pairWithSecret(key(2), { deviceId: 'pad', deviceName: 'Pad renamed' }, t.pairing.openWindow().pairSecret);
    assert.equal(t.config().devices.length, 1);
    assert.equal(code(() => t.pairing.session(key(1))), 'unauthorized');
    assert.equal(t.pairing.isPaired('pad', toBase64Url(key(1))), false);
    assert.equal(t.pairing.isPaired('pad', toBase64Url(key(2))), true);
    assert.equal(t.pairing.session(key(2)).deviceName, 'Pad renamed');
  });

  it('sees a revocation made on disk while running', () => {
    const t = setup();
    t.pairing.pairWithSecret(key(1), PAD, 'qr-1');
    t.setConfig({ ...t.config(), devices: [] });
    assert.equal(code(() => t.pairing.session(key(1))), 'unauthorized');
    assert.equal(t.pairing.isPaired('pad', toBase64Url(key(1))), false);
  });

  it('revoking one device leaves the others paired', () => {
    const t = setup();
    t.pairing.pairWithSecret(key(1), PAD, 'qr-1');
    t.pairing.pairWithSecret(key(2), { deviceId: 'phone', deviceName: 'Phone' }, t.pairing.openWindow().pairSecret);
    assert.equal(t.pairing.revoke('pad'), true);
    assert.equal(code(() => t.pairing.session(key(1))), 'unauthorized');
    assert.equal(t.pairing.session(key(2)).deviceName, 'Phone');
    assert.equal(t.pairing.revoke('pad'), false);
  });
});
