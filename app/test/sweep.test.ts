import { nodeTcp } from './native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { SWEEP_CONCURRENCY, type Found, findAgent, scanNetwork } from '../src/net/discovery';
import { type ByteStream, type TcpTransport, setTcpTransport } from '../src/net/tcp';
import { CONNECT_CANARY_KEY, readMark } from '../src/state/connectCanary';

const FINGERPRINT = 'F'.repeat(22);
const hello = { app: 'authdeck-agent', agentId: 'mac-id', name: 'Mac', platform: 'macos', version: '0.3.0', protocol: 2, port: 40001, fingerprint: FINGERPRINT };
const body = JSON.stringify(hello);
const ANSWER = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

/**
 * A network in memory: `answering` hosts give /hello, every other address refuses after `refuseMs`.
 * Counts the sockets open at once (connects in progress included), as the native module does.
 */
function fakeNetwork(answering: string[], refuseMs = 5) {
  const stats = { open: 0, mostOpen: 0, asked: [] as string[], marksSeen: [] as (string | null)[] };
  const opened = () => {
    stats.open++;
    stats.mostOpen = Math.max(stats.mostOpen, stats.open);
  };
  const transport: TcpTransport = {
    async connect(host) {
      stats.asked.push(host);
      stats.marksSeen.push(await AsyncStorage.getItem(CONNECT_CANARY_KEY));
      opened();
      await new Promise((r) => setTimeout(r, refuseMs));
      if (!answering.includes(host)) {
        stats.open--;
        throw new Error('refused');
      }
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        stats.open--;
      };
      const stream: ByteStream = {
        onData: null,
        onClose: null,
        onError: null,
        ack() {},
        close: finish,
        write() {
          setImmediate(() => {
            stream.onData?.(new TextEncoder().encode(ANSWER));
            finish();
            stream.onClose?.();
          });
        },
      };
      return stream;
    },
  };
  setTcpTransport(transport);
  return stats;
}

afterEach(() => setTcpTransport(nodeTcp));

describe('L5: one shared network sweep', () => {
  it('the pairing screen and a search for a moved computer share one sweep: each address is asked once', async () => {
    const stats = fakeNetwork(['192.168.1.7', '192.168.1.20']);
    const listed: Found[] = [];
    const [, moved] = await Promise.all([scanNetwork((f) => listed.push(f), new AbortController().signal, 40001), findAgent('mac-id', 40001, FINGERPRINT)]);
    assert.equal(stats.asked.length, 253, 'every other address on the /24, once');
    assert.deepEqual(listed.map((f) => f.host).sort(), ['192.168.1.20', '192.168.1.7']);
    assert.deepEqual([...moved].sort(), ['192.168.1.20', '192.168.1.7']);
  });

  it(`never holds more than ${SWEEP_CONCURRENCY} of the 64 sockets, with several looking on different ports`, async () => {
    const stats = fakeNetwork([], 20);
    await Promise.all([
      scanNetwork(() => undefined, new AbortController().signal, 40001),
      scanNetwork(() => undefined, new AbortController().signal, 40002),
      findAgent('mac-id', 40003, FINGERPRINT),
      findAgent('mac-id', 40001, FINGERPRINT),
    ]);
    assert.equal(stats.mostOpen, SWEEP_CONCURRENCY);
    assert.ok(SWEEP_CONCURRENCY <= 32);
    assert.equal(stats.asked.length, 3 * 253, 'one sweep per port, run one after another');
  });

  it('a search aborted when the computer changes stops asking addresses', async () => {
    const stats = fakeNetwork([], 20);
    const search = new AbortController();
    const looking = findAgent('mac-id', 40001, FINGERPRINT, search.signal);
    await new Promise((r) => setTimeout(r, 30));
    search.abort();
    assert.deepEqual(await looking, []);
    const askedAtAbort = stats.asked.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(askedAtAbort < 253, `asked ${askedAtAbort}`);
    assert.ok(stats.asked.length <= askedAtAbort + SWEEP_CONCURRENCY, 'only reads already started finish');
  });

  it('one looker leaving does not stop the sweep for another', async () => {
    fakeNetwork(['192.168.1.200'], 5);
    const leaving = new AbortController();
    const listed: string[] = [];
    const first = scanNetwork(() => undefined, leaving.signal, 40001);
    const second = scanNetwork((f) => listed.push(f.host), new AbortController().signal, 40001);
    leaving.abort();
    await Promise.all([first, second]);
    assert.deepEqual(listed, ['192.168.1.200']);
  });

  it('L4: swept addresses are never in the mark; the mark says a sweep is under way', async () => {
    const stats = fakeNetwork(['192.168.1.7']);
    await findAgent('mac-id', 40001, FINGERPRINT);
    for (const raw of stats.marksSeen) {
      const mark = readMark(raw);
      assert.deepEqual(mark.connecting, []);
      assert.equal(mark.sweeping, true);
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await AsyncStorage.getItem(CONNECT_CANARY_KEY), null, 'cleared once the sweep ends');
  });
});
