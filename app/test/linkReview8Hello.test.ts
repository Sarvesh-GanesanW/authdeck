/**
 * Link review round 8, /hello over TCP: a chunked body is decoded as it arrives (never again from
 * its start), an answer may take at most MAX_HELLO_READS reads, and a sweep where every address
 * drips a chunked /hello one byte per read leaves the JS thread free.
 */
import { nodeTcp } from './native';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { MAX_HELLO_BYTES, findAgent } from '../src/net/discovery';
import { ChunkedDecoder, MAX_HELLO_READS, getTextOverTcp } from '../src/net/helloTcp';
import { type ByteStream, type TcpTransport, setTcpTransport } from '../src/net/tcp';
import { HELLO_PATH } from '../src/protocol';

const STALL_LIMIT_MS = 50;
const HEAD_CHUNKED = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n';

afterEach(() => setTcpTransport(nodeTcp));

/** A chunked body of `count` one-byte chunks, final chunk included. */
const oneByteChunks = (count: number): Uint8Array => new Uint8Array(Buffer.from('1\r\nx\r\n'.repeat(count) + '0\r\n\r\n', 'latin1'));

/** The largest /hello answer that fits the cap, as a chunked body of one-byte chunks. */
function drippedAnswer(): Uint8Array {
  let body = '';
  while (HEAD_CHUNKED.length + body.length + 6 + 5 <= MAX_HELLO_BYTES) body += '1\r\nx\r\n';
  return new Uint8Array(Buffer.from(HEAD_CHUNKED + body + '0\r\n\r\n', 'latin1'));
}

/** Milliseconds to decode `body` fed to one decoder a byte at a time, as a dripping peer sends it. */
function decodeByteByByte(body: Uint8Array): { ms: number; decoded: Uint8Array | 'incomplete' | null } {
  const decoder = new ChunkedDecoder();
  let decoded: Uint8Array | 'incomplete' | null = 'incomplete';
  const started = performance.now();
  for (let n = 1; n <= body.length && decoded === 'incomplete'; n++) decoded = decoder.read(body.subarray(0, n));
  return { ms: performance.now() - started, decoded };
}

/** Runs `work` while measuring the longest stretch the event loop was blocked. */
async function longestBlock<T>(work: () => Promise<T>): Promise<{ value: T; blockedMs: number }> {
  let blockedMs = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    blockedMs = Math.max(blockedMs, now - last);
    last = now;
  }, 1);
  try {
    const value = await work();
    blockedMs = Math.max(blockedMs, performance.now() - last);
    return { value, blockedMs };
  } finally {
    clearInterval(probe);
  }
}

type Delivery = 'a read per task' | 'queued reads in one task';

/**
 * Every address answers with `answer`, one byte per read. 'a read per task' is a peer pacing its
 * bytes; 'queued reads in one task' is what a busy JS thread finds waiting: every read at once.
 */
function drippingNetwork(answer: Uint8Array, delivery: Delivery) {
  const stats = { connects: 0, reads: 0, mostReads: 0 };
  const transport: TcpTransport = {
    async connect() {
      stats.connects++;
      let closed = false;
      let reads = 0;
      const readOne = (at: number) => {
        stats.reads++;
        stats.mostReads = Math.max(stats.mostReads, ++reads);
        stream.onData?.(answer.subarray(at, at + 1));
      };
      const stream: ByteStream = {
        onData: null,
        onClose: null,
        onError: null,
        ack() {},
        close: () => (closed = true),
        write() {
          if (delivery === 'queued reads in one task') {
            setImmediate(() => {
              for (let at = 0; at < answer.length && !closed; at++) readOne(at);
              if (!closed) stream.onClose?.();
            });
            return;
          }
          const step = (at: number) => {
            if (closed) return;
            if (at >= answer.length) return stream.onClose?.();
            readOne(at);
            setImmediate(() => step(at + 1));
          };
          setImmediate(() => step(0));
        },
      };
      return stream;
    },
  };
  return { transport, stats };
}

describe('the chunked /hello decoder', () => {
  it('decodes a body fed a byte at a time to the same text as all at once', () => {
    const body = new Uint8Array(Buffer.from('3\r\nabc\r\na\r\n0123456789\r\n1\r\nz\r\n0\r\n\r\n', 'latin1'));
    assert.equal(Buffer.from(new ChunkedDecoder().read(body) as Uint8Array).toString(), 'abc0123456789z');
    assert.equal(Buffer.from(decodeByteByByte(body).decoded as Uint8Array).toString(), 'abc0123456789z');
  });

  it('refuses malformed chunking whether it arrives at once or a byte at a time', () => {
    for (const text of ['3;x=1\r\nabc\r\n0\r\n\r\n', '3\r\nabcd\r\n0\r\n\r\n', 'g\r\n', '12345\r\n', '1\r\nx\r\n0\r\nX-Trailer: 1\r\n\r\n']) {
      const body = new Uint8Array(Buffer.from(text, 'latin1'));
      assert.equal(new ChunkedDecoder().read(body), null, JSON.stringify(text));
      assert.equal(decodeByteByByte(body).decoded, null, JSON.stringify(text));
    }
  });

  it('costs the same per byte for a 16 times larger body fed a byte at a time (linear, not quadratic)', () => {
    const small = oneByteChunks(4 * 1024);
    const large = oneByteChunks(64 * 1024);
    // The fastest of a few runs, so a pause from the rest of the machine doesn't count.
    const fastest = (body: Uint8Array) => Math.min(...Array.from({ length: 5 }, () => decodeByteByByte(body).ms)) / body.length;
    fastest(small);
    const ratio = fastest(large) / fastest(small);
    // Re-decoding from byte 0 on every read makes this about 16; a linear decoder keeps it near 1.
    assert.ok(ratio < 4, `cost per byte grew ${ratio.toFixed(1)} times`);
  });
});

describe('/hello reads', () => {
  it(`reads an answer that takes ${MAX_HELLO_READS} reads, and refuses one that takes more`, async () => {
    const answer = new TextEncoder().encode(`HTTP/1.1 200 OK\r\nContent-Length: ${MAX_HELLO_READS + 1}\r\n\r\n` + 'x'.repeat(MAX_HELLO_READS + 1));
    const headBytes = answer.length - (MAX_HELLO_READS + 1);
    for (const [reads, expected] of [
      [MAX_HELLO_READS, 'x'.repeat(MAX_HELLO_READS + 1)],
      [MAX_HELLO_READS + 1, null],
    ] as const) {
      // The head in one read, then the body split so the whole answer takes `reads` reads.
      const pieces = [answer.subarray(0, headBytes + MAX_HELLO_READS + 2 - reads)];
      for (let at = pieces[0]!.length; at < answer.length; at++) pieces.push(answer.subarray(at, at + 1));
      assert.equal(pieces.length, reads);
      let closed = false;
      const transport: TcpTransport = {
        async connect() {
          const stream: ByteStream = {
            onData: null,
            onClose: null,
            onError: null,
            ack() {},
            close: () => (closed = true),
            write: () => setImmediate(() => pieces.forEach((piece) => !closed && stream.onData?.(piece))),
          };
          return stream;
        },
      };
      closed = false;
      assert.equal(await getTextOverTcp(transport, '192.168.1.2', 40001, HELLO_PATH, 1000, MAX_HELLO_BYTES), expected);
      assert.ok(closed, 'the connection was closed');
    }
  });

  for (const delivery of ['a read per task', 'queued reads in one task'] as const) {
    it(`a sweep where every address drips a chunked /hello a byte per read (${delivery}) stops each at ${MAX_HELLO_READS} reads and never holds the thread ${STALL_LIMIT_MS} ms`, async () => {
      const { transport, stats } = drippingNetwork(drippedAnswer(), delivery);
      setTcpTransport(transport);
      const { value, blockedMs } = await longestBlock(() => findAgent('mac-id', 40001, 'F'.repeat(22)));
      assert.deepEqual(value, []);
      assert.ok(stats.connects > 200, `swept ${stats.connects} addresses`);
      assert.equal(stats.mostReads, MAX_HELLO_READS + 1, 'the read past the limit is the last one');
      assert.ok(blockedMs < STALL_LIMIT_MS, `the event loop was blocked for ${blockedMs.toFixed(0)} ms`);
    });
  }
});
