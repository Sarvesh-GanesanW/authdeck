import { Platform } from './native';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MAX_HELLO_BYTES, MAX_LINK_HOSTS, fetchHello, findAgent, parsePairLink } from '../src/net/discovery';
import type { HelloResponse } from '../src/protocol';
import { agentInfo } from './linkServers';

/** Shaped like linkFingerprint's: 16 bytes in base64url. */
const FINGERPRINT = 'F'.repeat(22);
const OTHER_FINGERPRINT = 'O'.repeat(22);
const hello = (agentId: string, fingerprint = FINGERPRINT): HelloResponse => ({ app: 'authdeck-agent', ...agentInfo(agentId), port: 47474, fingerprint });

const realFetch = globalThis.fetch;
// These stand in for fetch, which /hello uses on the web build; on a phone it goes over TCP
// (helloTcp.test.ts).
beforeEach(() => {
  Platform.OS = 'web';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Platform.OS = 'ios';
});

/** Stands in for the network: the hosts named answer /hello (with JSON, or the body given), every other address does not. */
function network(answers: Record<string, HelloResponse | Response>): void {
  globalThis.fetch = (async (url: string) => {
    const answer = answers[new URL(url).hostname];
    if (!answer) throw new Error('no answer');
    return answer instanceof Response ? answer : new Response(JSON.stringify(answer));
  }) as typeof fetch;
}

describe('finding a computer whose address changed', () => {
  it('returns every address that answers as the computer, not just the first (a squatter may answer first)', async () => {
    // The stubbed device is 192.168.1.50; .7 is a squatter copying the public id and fingerprint.
    network({ '192.168.1.7': hello('mac-id'), '192.168.1.20': hello('mac-id'), '192.168.1.30': hello('other-id') });
    const found = await findAgent('mac-id', 47474, FINGERPRINT);
    assert.deepEqual([...found].sort(), ['192.168.1.20', '192.168.1.7']);
  });

  it('skips answers with another fingerprint', async () => {
    network({ '192.168.1.7': hello('mac-id', OTHER_FINGERPRINT), '192.168.1.20': hello('mac-id') });
    assert.deepEqual(await findAgent('mac-id', 47474, FINGERPRINT), ['192.168.1.20']);
  });

  it('finds nothing when nothing answers', async () => {
    network({});
    assert.deepEqual(await findAgent('mac-id', 47474, FINGERPRINT), []);
  });
});

describe('what anything on the network says in /hello is checked before it is shown', () => {
  it('an answer with a field of the wrong type is ignored', async () => {
    for (const broken of [{ name: { x: 1 } }, { platform: 'amiga' }, { port: '80' }, { port: 70000 }, { fingerprint: 5 }, { version: null }]) {
      network({ '192.168.1.7': { ...hello('mac-id'), ...broken } as unknown as HelloResponse });
      assert.equal(await fetchHello('192.168.1.7', 47474, 100), null, JSON.stringify(broken));
    }
  });

  it('a name loses characters that draw nothing; an empty one shows the address', async () => {
    network({ '192.168.1.7': { ...hello('mac-id'), name: 'Ada\u200B’s Mac\u2060' }, '192.168.1.8': { ...hello('mac-id'), name: '\u200B' } });
    assert.equal((await fetchHello('192.168.1.7', 47474, 100))?.name, 'Ada’s Mac');
    assert.equal((await fetchHello('192.168.1.8', 47474, 100))?.name, '192.168.1.8');
  });

  it('N8: a body past MAX_HELLO_BYTES is not read, whether its length is declared or streamed', async () => {
    const padded = JSON.stringify({ ...hello('mac-id'), padding: 'x'.repeat(MAX_HELLO_BYTES) });
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
      },
    });
    network({
      '192.168.1.7': new Response(padded),
      '192.168.1.8': new Response(endless),
      '192.168.1.9': new Response(JSON.stringify(hello('mac-id'))),
    });
    assert.equal(await fetchHello('192.168.1.7', 47474, 1000), null);
    assert.equal(await fetchHello('192.168.1.8', 47474, 1000), null);
    assert.ok(pulled <= Math.ceil(MAX_HELLO_BYTES / 1024) + 2, `stopped reading after ${pulled} chunks`);
    assert.equal((await fetchHello('192.168.1.9', 47474, 1000))?.agentId, 'mac-id');
  });

  it('N6: a pairing link keeps at most MAX_LINK_HOSTS addresses', () => {
    const many = Array.from({ length: 20000 }, (_, i) => `10.${(i >> 8) & 255}.${i & 255}.1`).join(',');
    const link = parsePairLink(`authdeck://pair?v=2&n=Desk&p=47474&h=${many}&k=${'A'.repeat(43)}&s=${'s'.repeat(22)}`);
    assert.equal(link?.hosts.length, MAX_LINK_HOSTS);
    assert.deepEqual(link?.hosts.slice(0, 2), ['10.0.0.1', '10.0.1.1']);
  });

  it('a pairing link’s name loses them too', () => {
    const link = parsePairLink(`authdeck://pair?v=2&n=${encodeURIComponent('Ada\u00AD’s Mac\u202E')}&p=47474&h=192.168.1.5&k=${'A'.repeat(43)}&s=AAAAAAAAAAAAAAAAAAAAAA`);
    assert.equal(link?.name, 'Ada’s Mac');
  });
});
