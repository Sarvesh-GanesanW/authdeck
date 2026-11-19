import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAddress } from '../src/net/discovery';
import { defaultPort } from '../src/net/testOverrides';

describe('a typed address', () => {
  it('reads a host with or without a port', () => {
    assert.deepEqual(parseAddress('192.168.1.5'), { host: '192.168.1.5', port: defaultPort() });
    assert.deepEqual(parseAddress('192.168.1.5:47592'), { host: '192.168.1.5', port: 47592 });
    assert.deepEqual(parseAddress(' my-pc.local '), { host: 'my-pc.local', port: defaultPort() });
    assert.deepEqual(parseAddress('http://pc.local:9/x'), { host: 'pc.local', port: 9 });
  });

  it('refuses what the old pattern refused', () => {
    for (const t of ['', 'a:', 'host:abc', 'host:123456', ':80', 'x:0', 'x:65536', 'a:b:80', 'a b']) assert.equal(parseAddress(t), null, t);
  });

  it('reads a long line of colons and digits quickly', () => {
    const start = performance.now();
    parseAddress(`${'a:1'.repeat(20_000)}x`);
    assert.ok(performance.now() - start < 50);
  });
});
