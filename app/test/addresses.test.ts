import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLocalNetworkHost } from '../src/net/addresses';

const PHONE = { allowLoopback: false };
const WEB = { allowLoopback: true };

describe('which addresses count as the local network', () => {
  const local = [
    '10.0.0.5',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.24',
    '100.64.0.1',
    '100.101.102.103',
    '100.127.255.254',
    '169.254.10.20',
    'fe80::1',
    'fe80::1c2b:3aff:fe4d:5e6f%en0',
    '[fe80::1]',
    'febf::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fd7a:115c:a1e0::1',
    'my-mac.local',
    'My-MacBook.Local',
    'studio.lan.local.',
  ];
  for (const host of local) {
    it(`allows ${host}`, () => assert.equal(isLocalNetworkHost(host, PHONE), true));
  }

  const outside = [
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.1.1',
    '100.63.255.255',
    '100.128.0.1',
    'my-mac.tail1234.ts.net',
    '0.0.0.0',
    '255.255.255.255',
    '192.168.1',
    '192.168.001.1',
    '3232235777',
    '0xc0a80101',
    '2001:4860:4860::8888',
    'fec0::1',
    '::ffff:192.168.1.1',
    'example.com',
    'local',
    '.local',
    'evil.com.local.example',
    'a..local',
    '',
  ];
  for (const host of outside) {
    it(`refuses ${JSON.stringify(host)}`, () => assert.equal(isLocalNetworkHost(host, WEB), false));
  }

  it('allows loopback only where asked (the web build)', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost']) {
      assert.equal(isLocalNetworkHost(host, PHONE), false, host);
      assert.equal(isLocalNetworkHost(host, WEB), true, host);
    }
  });
});
