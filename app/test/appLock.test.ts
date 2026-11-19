/**
 * App lock never locks anyone out (0.3.0 emulator finding): every combination of app lock on or
 * off, what the device can authenticate with, and whether the vault is open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appLockChange, canAuthenticate, SCREEN_LOCK_NEEDED, unlockGate, unlockRoute, type DeviceAuth } from '../src/auth/engine/appLock';

const AUTHS: DeviceAuth[] = [];
for (const hardware of [false, true]) for (const enrolled of [false, true]) for (const passcode of [false, true]) AUTHS.push({ hardware, enrolled, passcode });

const label = (a: DeviceAuth) => `hardware ${a.hardware}, enrolled ${a.enrolled}, passcode ${a.passcode}`;

test('the device can authenticate with enrolled biometrics or a passcode, and nothing else', () => {
  for (const auth of AUTHS) assert.equal(canAuthenticate(auth), (auth.hardware && auth.enrolled) || auth.passcode, label(auth));
});

test('unlocking: no app lock opens at once; with it, the prompt when the device can, else only the phrase', () => {
  for (const auth of AUTHS) {
    assert.deepEqual(unlockRoute(false, auth), { kind: 'open' }, label(auth));
    assert.deepEqual(unlockRoute(true, auth), canAuthenticate(auth) ? { kind: 'device' } : { kind: 'phrase', message: SCREEN_LOCK_NEEDED }, label(auth));
  }
});

test('turning app lock on needs a device that can authenticate, and is refused with the reason otherwise', () => {
  for (const auth of AUTHS) {
    for (const open of [false, true]) {
      const change = appLockChange({ on: true, current: false, auth, open });
      if (canAuthenticate(auth)) assert.deepEqual(change, { kind: 'prompt' }, label(auth));
      else {
        assert.equal(change.kind, 'refuse', label(auth));
        assert.match((change as { message: string }).message, /screen lock/);
      }
    }
  }
});

test('turning app lock off always works once the person has authenticated, by the prompt or the phrase', () => {
  for (const auth of AUTHS) {
    for (const open of [false, true]) {
      const change = appLockChange({ on: false, current: true, auth, open });
      if (canAuthenticate(auth)) assert.deepEqual(change, { kind: 'prompt' }, `${label(auth)}, open ${open}`);
      else if (open) assert.deepEqual(change, { kind: 'allow' }, `${label(auth)}, open`);
      else {
        assert.equal(change.kind, 'refuse');
        assert.match((change as { message: string }).message, /recovery phrase/);
      }
    }
  }
});

test('asking for the setting it already has changes nothing', () => {
  for (const auth of AUTHS) for (const on of [false, true]) for (const open of [false, true]) assert.deepEqual(appLockChange({ on, current: on, auth, open }), { kind: 'nothing' });
});

test('a guarded change outside the vault: free without a vault, app lock or while open; else the prompt, or the phrase first', () => {
  for (const auth of AUTHS) {
    for (const open of [false, true]) {
      assert.deepEqual(unlockGate({ hasVault: false, appLock: true, open, auth }), { kind: 'allow' }, label(auth));
      assert.deepEqual(unlockGate({ hasVault: true, appLock: false, open, auth }), { kind: 'allow' }, label(auth));
      const gate = unlockGate({ hasVault: true, appLock: true, open, auth });
      if (open) assert.deepEqual(gate, { kind: 'allow' }, label(auth));
      else if (canAuthenticate(auth)) assert.deepEqual(gate, { kind: 'prompt' }, label(auth));
      else {
        assert.equal(gate.kind, 'refuse', label(auth));
        assert.match((gate as { message: string }).message, /recovery phrase/);
      }
    }
  }
});
