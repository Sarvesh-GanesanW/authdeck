import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PORT } from '../src/protocol';
import { defaultPort, readTestOverrides, testOverrides } from '../src/net/testOverrides';

describe('the dev-only test switch', () => {
  it('is ignored completely outside a development build', () => {
    assert.equal(readTestOverrides(false, '47592', '127.0.0.1'), null);
  });

  it('is off here: no __DEV__, so the real default port', () => {
    process.env.EXPO_PUBLIC_AUTHDECK_TEST_PORT = '47592';
    assert.equal(testOverrides, null);
    assert.equal(defaultPort(), DEFAULT_PORT);
  });

  it('in a development build: the test port, and at most 8 listed hosts', () => {
    assert.deepEqual(readTestOverrides(true, '47592', ' 127.0.0.1 , ::1,'), { port: 47592, hosts: ['127.0.0.1', '::1'] });
    assert.deepEqual(readTestOverrides(true, '47592', undefined), { port: 47592, hosts: [] });
    assert.equal(readTestOverrides(true, '47592', Array.from({ length: 20 }, (_, i) => `10.0.0.${i}`).join(','))!.hosts.length, 8);
  });

  it('needs a valid port, or it is off', () => {
    for (const port of [undefined, '', '0', '65536', '47592x', '-1']) assert.equal(readTestOverrides(true, port, '127.0.0.1'), null, String(port));
  });
});
