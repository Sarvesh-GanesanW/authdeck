/**
 * Integration pass 3: native secure-storage failures reach the person as a plain message (the
 * raw text goes to the log only), and the QR scanner never asks for the camera on open.
 */
import './native';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cameraStep } from '../src/screens/vault/cameraStep';
import { deviceUnlockWords } from '../src/auth/engine/lockWords';
import { generateDeviceKeys } from '../src/vault/crypto';
import { seededRandom } from './helpers';

// secrets.ts also needs expo-local-authentication (as in rememberedHeads.test.ts).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-secure-store') return { url: pathToFileURL(path.join(__dirname, 'stubs', 'securestore.cjs')).href, format: 'commonjs', shortCircuit: true };
    if (specifier === 'expo-local-authentication') return { url: pathToFileURL(path.join(__dirname, 'stubs', 'localauth.cjs')).href, format: 'commonjs', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
/* eslint-disable @typescript-eslint/no-require-imports */
const { loadDeviceKeys, saveDeviceKeys, SECURE_READ_FAILED, SECURE_WRITE_FAILED } = require('../src/auth/engine/secrets') as typeof import('../src/auth/engine/secrets');
const store = require('expo-secure-store') as Record<string, unknown>;
const link = require('../src/net/linkIdentity') as typeof import('../src/net/linkIdentity');
/* eslint-enable @typescript-eslint/no-require-imports */
const RAW = "Calling the 'getValueWithKeyAsync' function has failed\n→ Caused by: User interaction is not allowed.";

describe('secure storage failures', () => {
  it('a failed read or write says what failed and what to do, never the native text', async () => {
    const get = store.getItemAsync;
    const set = store.setItemAsync;
    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (...args: unknown[]) => void logged.push(args.join(' '));
    store.getItemAsync = async () => {
      throw new Error(RAW);
    };
    store.setItemAsync = async () => {
      throw new Error(RAW);
    };
    try {
      await assert.rejects(loadDeviceKeys(), (err: Error) => err.message === SECURE_READ_FAILED && !err.message.includes('getValueWithKeyAsync'));
      await assert.rejects(saveDeviceKeys(generateDeviceKeys(seededRandom('i3'))), (err: Error) => err.message === SECURE_WRITE_FAILED);
      assert.ok(logged.some((line) => line.includes('getValueWithKeyAsync')), 'the raw text is in the log');
      // The link key (net/linkIdentity.ts) the same way.
      await assert.rejects(link.deviceLinkKey(), (err: Error) => err.message === link.LINK_KEY_READ_FAILED && !err.message.includes('getValueWithKeyAsync'));
      store.getItemAsync = async () => null;
      await assert.rejects(link.deviceLinkKey(), (err: Error) => err.message === link.LINK_KEY_WRITE_FAILED);
      assert.ok(logged.filter((line) => line.startsWith('link key storage:')).length === 2, 'both raw texts are in the log');
    } finally {
      store.getItemAsync = get;
      store.setItemAsync = set;
      console.warn = warn;
    }
  });
});

describe('the QR scanner and the camera permission', () => {
  it('never asks on open: before the person was asked, it offers scanning or typing the key', () => {
    assert.equal(cameraStep({ granted: false, status: 'undetermined' }), 'ask');
    assert.equal(cameraStep({ granted: false, status: 'denied' }), 'blocked');
    assert.equal(cameraStep({ granted: true, status: 'granted' }), 'camera');
    assert.equal(cameraStep(null), 'loading');
  });
});

describe('unlock wording per platform', () => {
  it('names Face ID on iOS and the fingerprint, face or screen lock on Android', () => {
    assert.equal(deviceUnlockWords('ios'), 'Face ID or your passcode');
    assert.equal(deviceUnlockWords('android'), 'your fingerprint, face or screen lock');
  });
});
