/**
 * Link review round 7, the transport: the head parser has no backtracking regex, empty and endless
 * fragments are refused before and inside a session, the parser stops after every frame, and the
 * session's ping budget runs on a clock that never jumps.
 */
import './native';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { isLocalNetworkHost } from '../src/net/addresses';
import { getTextOverTcp } from '../src/net/helloTcp';
import { readResponseHead } from '../src/net/httpHead';
import { LinkSocket, SESSION_PING_BURST } from '../src/net/linkSocket';
import { CLOSE_CODE, FrameParser, MAX_FRAGMENTS_PER_MESSAGE, OPCODE } from '../src/net/wsFrames';
import { HELLO_PATH } from '../src/protocol';
import { nodeTcp } from './native';
import { LOOPBACK, frame, rawServer, runSocket, upgradeResponse } from './rawServer';

const LIMIT = 8 * 1024;
const HEAD_LIMIT = 8 * 1024;
const FAST_MS = 50;

const servers: { close: () => Promise<void> }[] = [];
after(() => Promise.all(servers.map((s) => s.close())));

/** A head of `status` and `headers`, ended by the blank line. */
const head = (status: string, headers: string[]): Uint8Array => new Uint8Array(Buffer.from([status, ...headers, '', ''].join('\r\n'), 'latin1'));
/** A header line built to make a backtracking parser try every split of its spaces before failing. */
const spacesThenControl = (spaces: number): string => `x:${' '.repeat(spaces)}\x01`;

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

describe('the response head parser', () => {
  it('refuses 8 KB of spaces followed by a control byte in well under 50 ms', () => {
    const bytes = head('HTTP/1.1 101 Switching Protocols', [spacesThenControl(HEAD_LIMIT - 100)]);
    const started = performance.now();
    const read = readResponseHead(bytes, HEAD_LIMIT);
    assert.ok(performance.now() - started < FAST_MS, `took ${performance.now() - started} ms`);
    assert.deepEqual(read, { kind: 'refused', reason: 'it has a malformed header' });
  });

  it('trims spaces and tabs around a value and keeps the ones inside', () => {
    const read = readResponseHead(head('HTTP/1.1 200 OK', ['X-Name: \t a \t b \t ', 'Empty:', 'Spaced:   ']), HEAD_LIMIT);
    assert.equal(read.kind, 'head');
    if (read.kind !== 'head') return;
    assert.deepEqual(read.head.headers.get('x-name'), ['a \t b']);
    assert.deepEqual(read.head.headers.get('empty'), ['']);
    assert.deepEqual(read.head.headers.get('spaced'), ['']);
  });

  it('splits at the first colon, so a value may hold more', () => {
    const read = readResponseHead(head('HTTP/1.1 200 OK', ['Host: [::1]:47592']), HEAD_LIMIT);
    assert.equal(read.kind === 'head' && read.head.headers.get('host')?.[0], '[::1]:47592');
  });

  for (const line of ['no colon', ': no name', 'Bad Name: x', 'X : space before colon', 'X: control \x01 byte', 'X: high \xe9 byte', 'X: trailing control\x7f']) {
    it(`refuses the header line ${JSON.stringify(line)}`, () => {
      assert.equal(readResponseHead(head('HTTP/1.1 200 OK', [line]), HEAD_LIMIT).kind, 'refused');
    });
  }

  it('the /hello reader refuses the same line without holding the thread', async () => {
    const server = await rawServer((t) => t.socket.write(Buffer.from(`HTTP/1.1 200 OK\r\n${spacesThenControl(4000)}\r\n\r\n`, 'latin1')));
    servers.push(server);
    const { value, blockedMs } = await longestBlock(() => getTextOverTcp(nodeTcp, LOOPBACK, server.port, HELLO_PATH, 1500, 4096));
    assert.equal(value, null);
    assert.ok(blockedMs < FAST_MS, `the event loop was blocked for ${blockedMs} ms`);
  });

  it('the WebSocket upgrade refuses the same line without holding the thread', async () => {
    const server = await rawServer((t) => t.socket.write(Buffer.from(`HTTP/1.1 101 Switching Protocols\r\n${spacesThenControl(HEAD_LIMIT - 100)}\r\n\r\n`, 'latin1')));
    servers.push(server);
    const { value, blockedMs } = await longestBlock(() => runSocket(server.port, LIMIT));
    assert.equal(value.opened, false);
    assert.equal(value.errors[0]?.code, CLOSE_CODE.protocolError);
    assert.match(value.errors[0]!.message, /malformed header/);
    assert.ok(blockedMs < FAST_MS, `the event loop was blocked for ${blockedMs} ms`);
  });
});

const fragment = (opcode: number, payload: string, fin = false): Buffer => frame(opcode, payload, { fin });
/** A message split into `count` one-byte fragments, the last one final. */
const fragmented = (count: number): Buffer[] =>
  Array.from({ length: count }, (_, i) => fragment(i === 0 ? OPCODE.binary : OPCODE.continuation, 'a', i === count - 1));

/** Feeds `frames` to a fresh parser, one consume call per frame, and returns the events. */
function parseAll(frames: Buffer[]): ReturnType<FrameParser['consume']>['event'][] {
  const parser = new FrameParser(LIMIT);
  let bytes = new Uint8Array(Buffer.concat(frames));
  const events = [];
  while (bytes.length > 0) {
    const { used, event } = parser.consume(bytes);
    events.push(event);
    if (event?.kind === 'fail') break;
    bytes = bytes.subarray(used);
  }
  return events;
}

describe('fragments', () => {
  it('an empty first fragment that does not end its message is refused', () => {
    const events = parseAll([fragment(OPCODE.binary, '')]);
    assert.deepEqual(events, [{ kind: 'fail', code: CLOSE_CODE.protocolError, reason: 'an empty fragment that does not end its message' }]);
  });

  it('an empty continuation that does not end its message is refused', () => {
    const events = parseAll([fragment(OPCODE.binary, 'a'), fragment(OPCODE.continuation, '')]);
    assert.deepEqual(events.at(-1), { kind: 'fail', code: CLOSE_CODE.protocolError, reason: 'an empty fragment that does not end its message' });
  });

  it('an empty final continuation still ends its message', () => {
    const events = parseAll([fragment(OPCODE.text, 'hi'), fragment(OPCODE.continuation, '', true)]);
    assert.deepEqual(events, [null, { kind: 'message', data: 'hi' }]);
  });

  it(`takes a message in ${MAX_FRAGMENTS_PER_MESSAGE} fragments, twice in a row`, () => {
    const events = parseAll([...fragmented(MAX_FRAGMENTS_PER_MESSAGE), ...fragmented(MAX_FRAGMENTS_PER_MESSAGE)]);
    const messages = events.filter((e) => e?.kind === 'message');
    assert.equal(messages.length, 2);
    assert.ok(events.every((e) => e === null || e.kind === 'message'));
  });

  it(`refuses fragment ${MAX_FRAGMENTS_PER_MESSAGE + 1} of one message with 1008`, () => {
    const events = parseAll(fragmented(MAX_FRAGMENTS_PER_MESSAGE + 1));
    assert.equal(events.length, MAX_FRAGMENTS_PER_MESSAGE + 1);
    assert.deepEqual(events.at(-1), { kind: 'fail', code: CLOSE_CODE.policyViolation, reason: 'a message in more fragments than AuthDeck accepts' });
  });

  it('consume stops after every frame, so each fragment is one call', () => {
    const parser = new FrameParser(LIMIT);
    const first = fragment(OPCODE.binary, 'a');
    const bytes = new Uint8Array(Buffer.concat([first, fragment(OPCODE.continuation, 'b'), fragment(OPCODE.continuation, 'c', true)]));
    assert.deepEqual(parser.consume(bytes), { used: first.length, event: null });
  });
});

/** A server that upgrades and then sends `frames`, and the LinkSocket run against it. */
async function upgradeThen(frames: Buffer[], inSession: boolean) {
  const server = await rawServer((t) => t.socket.write(Buffer.concat([Buffer.from(upgradeResponse(t.key)), ...frames])));
  servers.push(server);
  return runSocket(server.port, LIMIT, inSession ? (socket: LinkSocket) => socket.setMessageLimit(LIMIT) : undefined);
}

const emptyFragmentFlood = (): Buffer[] => [fragment(OPCODE.binary, ''), ...Array.from({ length: 50_000 }, () => fragment(OPCODE.continuation, ''))];
const oneByteFragmentFlood = (): Buffer[] => [fragment(OPCODE.binary, 'a'), ...Array.from({ length: 50_000 }, () => fragment(OPCODE.continuation, 'b'))];

for (const inSession of [false, true]) {
  describe(`a fragment flood ${inSession ? 'inside a session' : 'before the link handshake ends'}`, () => {
    it('empty fragments end the socket with 1002 at the first one', async () => {
      const run = await upgradeThen(emptyFragmentFlood(), inSession);
      assert.equal(run.errors[0]?.code, CLOSE_CODE.protocolError);
      assert.match(run.errors[0]!.message, /empty fragment/);
      assert.deepEqual(run.messages, []);
    });

    it(`one-byte fragments end the socket with 1008 past ${MAX_FRAGMENTS_PER_MESSAGE}`, async () => {
      const run = await upgradeThen(oneByteFragmentFlood(), inSession);
      assert.equal(run.errors[0]?.code, CLOSE_CODE.policyViolation);
      assert.deepEqual(run.messages, []);
    });
  });
}

describe('the session ping budget', () => {
  it('a wall-clock jump does not refill it', async () => {
    const realNow = Date.now;
    const server = await rawServer((t) => {
      t.socket.write(Buffer.concat([Buffer.from(upgradeResponse(t.key)), ...Array.from({ length: SESSION_PING_BURST }, () => frame(OPCODE.ping))]));
      setTimeout(() => {
        Date.now = () => realNow() + 3_600_000;
        t.socket.write(frame(OPCODE.ping));
      }, 10);
    });
    servers.push(server);
    try {
      const run = await runSocket(server.port, LIMIT, (socket) => socket.setMessageLimit(LIMIT));
      assert.equal(run.errors[0]?.code, CLOSE_CODE.policyViolation);
      assert.match(run.errors[0]!.message, /pings far faster/);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('.local names, checked without a backtracking pattern', () => {
  const rules = { allowLoopback: false };
  const label63 = 'a'.repeat(63);
  for (const host of ['a.local', `${label63}.local`, 'a-b.c-d.local.', '0.local']) {
    it(`takes ${host.length > 40 ? 'a 63-character label' : host}`, () => assert.equal(isLocalNetworkHost(host, rules), true));
  }
  for (const host of [`${label63}a.local`, '-a.local', 'a-.local', 'a_b.local', 'a..local', 'local.', 'a.local..', 'a.local.x']) {
    it(`refuses ${host.length > 40 ? 'a 64-character label' : host}`, () => assert.equal(isLocalNetworkHost(host, rules), false));
  }
  it('a long run of hyphens is refused quickly', () => {
    const started = performance.now();
    assert.equal(isLocalNetworkHost(`a${'-'.repeat(50_000)}.local`, rules), false);
    assert.ok(performance.now() - started < FAST_MS);
  });
});
