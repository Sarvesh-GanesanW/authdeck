import './native';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, describe, it } from 'node:test';
import { expectedAccept, MAX_UPGRADE_HEAD_BYTES } from '../src/net/linkSocket';
import { CLOSE_CODE, FrameParser, OPCODE, type FrameEvent } from '../src/net/wsFrames';
import { type Conversation, type RawServer, clientFrames, frame, rawServer, runSocket, until, upgradeResponse } from './rawServer';

const LIMIT = 8 * 1024;
const servers: RawServer[] = [];
after(() => Promise.all(servers.map((s) => s.close())));

async function serve(script: (talk: Conversation) => void): Promise<RawServer> {
  const server = await rawServer(script);
  servers.push(server);
  return server;
}

/** Upgrades, then sends `frames` in one write; the server keeps what the client sends after. */
async function framesAfterUpgrade(frames: Buffer[], limit = LIMIT) {
  let talk: Conversation | null = null;
  const server = await serve((t) => {
    talk = t;
    t.socket.write(Buffer.concat([Buffer.from(upgradeResponse(t.key)), ...frames]));
  });
  const run = await runSocket(server.port, limit);
  // The client's close frame may land just after the close event.
  await new Promise((r) => setTimeout(r, 30));
  return { run, sent: clientFrames(talk!.received()) };
}

/** The close code the client sent the server, if it sent one. */
const sentClose = (sent: { opcode: number; payload: Buffer }[]): number | null => {
  const close = sent.find((f) => f.opcode === OPCODE.close);
  return close ? close.payload.readUInt16BE(0) : null;
};

async function refusedUpgrade(answer: (key: string) => string) {
  const server = await serve((t) => t.socket.write(answer(t.key)));
  const run = await runSocket(server.port, LIMIT);
  assert.equal(run.opened, false);
  assert.equal(run.errors[0]?.code, CLOSE_CODE.protocolError);
  return run;
}

describe('the upgrade request', () => {
  it('offers no extension and no Origin, with a fresh key and version 13', async () => {
    let head = '';
    const server = await serve((t) => {
      head = t.head;
      t.socket.end();
    });
    await runSocket(server.port, LIMIT);
    const lines = head.split('\r\n');
    assert.equal(lines[0], 'GET /authdeck/ws HTTP/1.1');
    assert.ok(lines.includes(`Host: 127.0.0.1:${server.port}`));
    assert.ok(lines.includes('Upgrade: websocket'));
    assert.ok(lines.includes('Connection: Upgrade'));
    assert.ok(lines.includes('Sec-WebSocket-Version: 13'));
    assert.match(head, /^Sec-WebSocket-Key: [A-Za-z0-9+/]{22}==$/m);
    assert.doesNotMatch(head, /extensions|origin|deflate/i);
  });

  it('computes the accept value RFC 6455 gives for its sample key', () => {
    assert.equal(expectedAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('the upgrade response is refused unless it is a plain 101', () => {
  it('ws-bomb: a server that answers with permessage-deflate is refused before any frame is read', async () => {
    const deflated = frame(OPCODE.binary, crypto.randomBytes(64), { rsv: 4 });
    const run = await refusedUpgrade((key) => upgradeResponse(key, ['Sec-WebSocket-Extensions: permessage-deflate']) + deflated.toString('latin1'));
    assert.match(run.errors[0]!.message, /extension/);
    assert.equal(run.messages.length, 0);
  });

  it('any other extension too', async () => {
    await refusedUpgrade((key) => upgradeResponse(key, ['sec-websocket-extensions: x-anything']));
  });

  it('a wrong Sec-WebSocket-Accept', async () => {
    const run = await refusedUpgrade((key) => upgradeResponse(key, [], expectedAccept(`${key}x`)));
    assert.match(run.errors[0]!.message, /Accept/);
  });

  it('a status other than 101', async () => {
    await refusedUpgrade(() => 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
  });

  it('a missing or wrong Upgrade header', async () => {
    await refusedUpgrade((key) => upgradeResponse(key).replace('Upgrade: websocket\r\n', ''));
    await refusedUpgrade((key) => upgradeResponse(key).replace('Upgrade: websocket', 'Upgrade: h2c'));
  });

  it('a missing or wrong Connection header', async () => {
    await refusedUpgrade((key) => upgradeResponse(key).replace('Connection: Upgrade\r\n', ''));
    await refusedUpgrade((key) => upgradeResponse(key).replace('Connection: Upgrade', 'Connection: keep-alive'));
  });

  it('a subprotocol the client never asked for', async () => {
    await refusedUpgrade((key) => upgradeResponse(key, ['Sec-WebSocket-Protocol: chat']));
  });

  it('headers past 8 KB before the blank line, even when they never end', async () => {
    await refusedUpgrade((key) => upgradeResponse(key, [`X-Pad: ${'a'.repeat(MAX_UPGRADE_HEAD_BYTES)}`]));
    const run = await refusedUpgrade(() => `HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${'a'.repeat(MAX_UPGRADE_HEAD_BYTES * 4)}`);
    assert.match(run.errors[0]!.message, /too long/);
  });
});

describe('frames from the server', () => {
  it('delivers binary as an ArrayBuffer copy and text as a string', async () => {
    const { run } = await framesAfterUpgrade([frame(OPCODE.binary, Buffer.from([1, 2, 3])), frame(OPCODE.text, 'héllo'), frame(OPCODE.close, Buffer.from([0x03, 0xe8]))]);
    assert.deepEqual(run.messages, [Uint8Array.of(1, 2, 3), 'héllo']);
    assert.equal(run.close.code, 1000);
    assert.equal(run.close.wasClean, true);
  });

  it('answers a ping with a pong carrying the same payload, and a close with a close', async () => {
    const { run, sent } = await framesAfterUpgrade([frame(OPCODE.ping, 'are you there'), frame(OPCODE.close, Buffer.from([0x03, 0xe8]))]);
    assert.equal(run.errors.length, 0);
    assert.deepEqual(
      sent.map((f) => f.opcode),
      [OPCODE.pong, OPCODE.close],
    );
    assert.equal(sent[0]!.payload.toString(), 'are you there');
    assert.equal(sentClose(sent), 1000);
  });

  it('assembles a fragmented message with control frames between the fragments', async () => {
    const { run, sent } = await framesAfterUpgrade([
      frame(OPCODE.binary, Buffer.from([1, 2]), { fin: false }),
      frame(OPCODE.ping, 'p'),
      frame(OPCODE.continuation, Buffer.from([3]), { fin: false }),
      frame(OPCODE.pong, ''),
      frame(OPCODE.continuation, Buffer.from([4]), { fin: true }),
      frame(OPCODE.close),
    ]);
    assert.deepEqual(run.messages, [Uint8Array.of(1, 2, 3, 4)]);
    assert.deepEqual(sent[0]?.payload.toString(), 'p');
    assert.equal(run.close.code, CLOSE_CODE.noStatus);
  });

  it('a close in the middle of a message ends the socket and drops the fragments', async () => {
    const { run, sent } = await framesAfterUpgrade([frame(OPCODE.binary, Buffer.from([1]), { fin: false }), frame(OPCODE.close, Buffer.from([0x03, 0xe9]))]);
    assert.deepEqual(run.messages, []);
    assert.equal(run.close.code, 1001);
    assert.equal(sentClose(sent), 1000);
  });

  it('the client masks every frame it sends, with a fresh key each time', async () => {
    let talk: Conversation | null = null;
    const server = await serve((t) => {
      talk = t;
      t.socket.write(upgradeResponse(t.key));
    });
    const payload = new Uint8Array(64);
    await runSocket(server.port, LIMIT, (socket) => {
      socket.send(payload);
      socket.send(payload);
      socket.close();
    });
    await until('the frames to arrive', () => clientFrames(talk!.received()).length === 3);
    const raw = talk!.received();
    const frames = clientFrames(raw);
    assert.ok(frames.every((f) => f.masked));
    assert.deepEqual([...frames[0]!.payload], [...payload]);
    // The same zero payload masked twice shows each frame's key: they differ.
    const firstKey = raw.subarray(2, 6);
    const secondKey = raw.subarray(2 + 4 + 64 + 2, 2 + 4 + 64 + 6);
    assert.notDeepEqual([...firstKey], [...secondKey]);
  });

  it('send after close does nothing and does not throw', async () => {
    const server = await serve((t) => t.socket.write(upgradeResponse(t.key)));
    await runSocket(server.port, LIMIT, (socket) => {
      socket.close();
      socket.send(new Uint8Array(4));
      socket.close();
    });
  });

  it('frames sent right behind the upgrade, and a limit raised in the consumer’s continuation, are honoured', async () => {
    const big = crypto.randomBytes(LIMIT * 2);
    const server = await serve((t) => t.socket.write(Buffer.concat([Buffer.from(upgradeResponse(t.key)), frame(OPCODE.binary, 'hi'), frame(OPCODE.binary, big), frame(OPCODE.close)])));
    const got: Uint8Array[] = [];
    await new Promise<void>((resolve) => {
      void runSocket(server.port, LIMIT, (socket) => {
        socket.onmessage = (ev) => {
          got.push(new Uint8Array(ev.data as ArrayBuffer));
          // As client.ts does: the next limit is set after an await, not inside the handler.
          void Promise.resolve().then(() => socket.setMessageLimit(LIMIT * 4));
        };
      }).then(() => resolve());
    });
    assert.equal(got.length, 2);
    assert.equal(got[1]!.length, big.length);
  });
});

describe('protocol errors end the socket with a close', () => {
  const cases: [string, Buffer[], number][] = [
    ['a masked frame from the server', [frame(OPCODE.binary, 'x', { mask: true })], CLOSE_CODE.protocolError],
    ['RSV1 set', [frame(OPCODE.binary, 'x', { rsv: 4 })], CLOSE_CODE.protocolError],
    ['RSV2 set', [frame(OPCODE.binary, 'x', { rsv: 2 })], CLOSE_CODE.protocolError],
    ['RSV3 set', [frame(OPCODE.binary, 'x', { rsv: 1 })], CLOSE_CODE.protocolError],
    ['an unknown data opcode', [frame(0x3, 'x')], CLOSE_CODE.protocolError],
    ['an unknown control opcode', [frame(0xb, 'x')], CLOSE_CODE.protocolError],
    ['a ping over 125 bytes', [frame(OPCODE.ping, Buffer.alloc(126))], CLOSE_CODE.protocolError],
    ['a close over 125 bytes', [frame(OPCODE.close, Buffer.alloc(200))], CLOSE_CODE.protocolError],
    ['a fragmented ping', [frame(OPCODE.ping, 'x', { fin: false })], CLOSE_CODE.protocolError],
    ['a fragmented close', [frame(OPCODE.close, Buffer.from([3, 232]), { fin: false })], CLOSE_CODE.protocolError],
    ['a continuation with nothing started', [frame(OPCODE.continuation, 'x')], CLOSE_CODE.protocolError],
    ['a new message inside a fragmented one', [frame(OPCODE.binary, 'a', { fin: false }), frame(OPCODE.binary, 'b')], CLOSE_CODE.protocolError],
    ['a 16-bit length under 126', [frame(OPCODE.binary, 'x', { form: 16 })], CLOSE_CODE.protocolError],
    ['a 64-bit length under 65536', [frame(OPCODE.binary, 'x', { form: 64 })], CLOSE_CODE.protocolError],
    ['a 64-bit length with its top bit set', [frame(OPCODE.binary, '', { declared: 1n << 63n })], CLOSE_CODE.protocolError],
    ['text that is not UTF-8', [frame(OPCODE.text, Buffer.from([0xc3, 0x28]))], CLOSE_CODE.invalidData],
    ['a close frame with a one-byte status', [frame(OPCODE.close, Buffer.from([3]))], CLOSE_CODE.protocolError],
  ];
  for (const [what, frames, code] of cases) {
    it(what, async () => {
      const { run, sent } = await framesAfterUpgrade(frames);
      assert.deepEqual(run.messages, []);
      assert.equal(run.errors[0]?.code, code);
      assert.equal(run.close.code, code);
      assert.equal(sentClose(sent), code);
    });
  }
});

describe('size limits are checked from the frame header', () => {
  it('a frame one byte over the limit is refused with 1009', async () => {
    const { run, sent } = await framesAfterUpgrade([frame(OPCODE.binary, Buffer.alloc(LIMIT + 1))]);
    assert.equal(run.errors[0]?.code, CLOSE_CODE.tooBig);
    assert.equal(sentClose(sent), CLOSE_CODE.tooBig);
    assert.deepEqual(run.messages, []);
  });

  it('a frame exactly at the limit is accepted', async () => {
    const { run } = await framesAfterUpgrade([frame(OPCODE.binary, Buffer.alloc(LIMIT)), frame(OPCODE.close)]);
    assert.equal(run.messages.length, 1);
  });

  it('ws-bomb: a 200 MB declared frame is refused from its header, with nothing sent after it', async () => {
    const { run, sent } = await framesAfterUpgrade([frame(OPCODE.binary, '', { declared: 200n * 1024n * 1024n })]);
    assert.equal(run.errors[0]?.code, CLOSE_CODE.tooBig);
    assert.equal(sentClose(sent), CLOSE_CODE.tooBig);
  });

  it('ws-bomb: the parser allocates nothing for a 200 MB or 2^62-byte header', () => {
    for (const declared of [200n * 1024n * 1024n, 1n << 62n, 0xffffffffn]) {
      const parser = new FrameParser(LIMIT);
      const { event } = parser.consume(new Uint8Array(frame(OPCODE.binary, '', { declared })));
      assert.equal(event?.kind, 'fail');
      assert.equal((event as { code: number }).code, CLOSE_CODE.tooBig);
      assert.equal(parser.heldBytes, 0);
    }
  });

  it('fragments that pass the limit together are refused, though each is under it', async () => {
    const half = Buffer.alloc(LIMIT / 2 + 1);
    const { run, sent } = await framesAfterUpgrade([frame(OPCODE.binary, half, { fin: false }), frame(OPCODE.continuation, half)]);
    assert.equal(run.errors[0]?.code, CLOSE_CODE.tooBig);
    assert.equal(sentClose(sent), CLOSE_CODE.tooBig);
    assert.deepEqual(run.messages, []);
  });

  it('the over-limit fragment is refused from its header: its payload never arrives', () => {
    const parser = new FrameParser(LIMIT);
    assert.equal(parser.consume(new Uint8Array(frame(OPCODE.binary, Buffer.alloc(LIMIT - 10), { fin: false }))).event, null);
    const { event } = parser.consume(new Uint8Array(frame(OPCODE.continuation, '', { declared: 11n })));
    assert.equal(event?.kind, 'fail');
  });

  it('control frames have their own 125-byte cap whatever the message limit', () => {
    const parser = new FrameParser(1 << 20);
    const { event } = parser.consume(new Uint8Array(frame(OPCODE.pong, '', { declared: 126n, form: 16 })));
    assert.equal(event?.kind, 'fail');
  });
});

/** Seeded so a failure can be replayed. */
function seededBytes(seed: number): (n: number) => Buffer {
  let counter = 0;
  return (n) => {
    const out = Buffer.alloc(n);
    for (let at = 0; at < n; at += 32) crypto.createHash('sha256').update(`${seed}/${counter++}`).digest().copy(out, at);
    return out;
  };
}

/** Random frames, valid or not, and random bytes. */
function randomStream(seed: number): Buffer {
  const bytes = seededBytes(seed);
  const parts: Buffer[] = [];
  const count = 1 + (bytes(1)[0]! % 12);
  for (let i = 0; i < count; i++) {
    const [kind, a, b] = bytes(3);
    const opcode = [0, 1, 2, 3, 8, 9, 10, 15][a! % 8]!;
    const size = [0, 1, 125, 126, 200, LIMIT - 1, LIMIT, LIMIT + 1][b! % 8]!;
    if (kind! % 4 === 0) parts.push(bytes(1 + (a! % 64)));
    else if (kind! % 4 === 1) parts.push(frame(opcode, '', { declared: BigInt.asUintN(64, bytes(8).readBigUInt64BE()) }));
    else parts.push(frame(opcode, bytes(size), { fin: b! % 3 !== 0, rsv: kind! % 7 === 0 ? 4 : 0, mask: a! % 11 === 0 }));
  }
  return Buffer.concat(parts);
}

describe('fuzz', () => {
  it('the parser never throws and never holds more than the limit, fed in random pieces', () => {
    for (let seed = 0; seed < 3000; seed++) {
      const stream = new Uint8Array(randomStream(seed));
      const cuts = seededBytes(seed + 1_000_000);
      const parser = new FrameParser(LIMIT);
      let at = 0;
      let ended: FrameEvent | null = null;
      while (at < stream.length && !ended) {
        const piece = stream.subarray(at, at + 1 + (cuts(2).readUInt16BE() % 300));
        const { used, event } = parser.consume(piece);
        assert.ok(used <= piece.length);
        at += used;
        assert.ok(parser.heldBytes <= LIMIT + 10, `seed ${seed}: held ${parser.heldBytes}`);
        if (event?.kind === 'close' || event?.kind === 'fail') ended = event;
        // consume stops after each frame, event or not, so it may leave bytes; it always makes progress.
        else if (!event) assert.ok(used > 0, `seed ${seed}: used nothing of ${piece.length} bytes`);
      }
    }
  });

  it('a socket fed random frames and bytes always ends in a close, without throwing', async () => {
    for (let seed = 0; seed < 60; seed++) {
      const server = await serve((t) => {
        t.socket.write(Buffer.concat([Buffer.from(upgradeResponse(t.key)), randomStream(seed)]));
        t.socket.end();
      });
      const run = await runSocket(server.port, LIMIT);
      assert.ok(run.opened, `seed ${seed}`);
      for (const message of run.messages) assert.ok((typeof message === 'string' ? Buffer.byteLength(message) : message.length) <= LIMIT);
      if (run.errors.length > 0) assert.notEqual(run.close.wasClean, true);
    }
  });

  it('random bytes in place of the upgrade response always end in an error', async () => {
    for (let seed = 0; seed < 30; seed++) {
      const server = await serve((t) => {
        t.socket.write(seededBytes(seed)(1 + (seed * 97) % 9000));
        t.socket.end();
      });
      const run = await runSocket(server.port, LIMIT);
      assert.equal(run.opened, false);
      assert.ok(run.errors.length > 0);
    }
  });
});
