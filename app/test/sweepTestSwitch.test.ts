import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TcpTransport } from '../src/net/tcp';

describe('the dev test switch with the shared sweep', () => {
  it('a sweep asks only the listed test hosts', async () => {
    // Set before discovery loads: the switch is read once, when testOverrides.ts is first imported.
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_AUTHDECK_TEST_PORT = '47592';
    process.env.EXPO_PUBLIC_AUTHDECK_TEST_HOSTS = '127.0.0.1,127.0.0.2';
    const { setTcpTransport } = await import('../src/net/tcp');
    const { findAgent, scanNetwork } = await import('../src/net/discovery');
    const asked: string[] = [];
    const refuseAll: TcpTransport = {
      async connect(host) {
        asked.push(host);
        throw new Error('refused');
      },
    };
    setTcpTransport(refuseAll);
    await Promise.all([scanNetwork(() => undefined, new AbortController().signal), findAgent('mac-id', 47592, null)]);
    assert.deepEqual(asked.sort(), ['127.0.0.1', '127.0.0.2']);
  });
});
