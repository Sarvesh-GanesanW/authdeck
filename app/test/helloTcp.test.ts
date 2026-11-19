import { nodeTcp } from './native';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { after, describe, it } from 'node:test';
import { MAX_HELLO_BYTES, fetchHello } from '../src/net/discovery';
import { getTextOverTcp } from '../src/net/helloTcp';
import { HELLO_PATH, type HelloResponse } from '../src/protocol';
import { agentInfo } from './linkServers';
import { type RawServer, LOOPBACK, rawServer } from './rawServer';
import { startAgent } from './realAgent';

const hello: HelloResponse = { app: 'authdeck-agent', ...agentInfo('mac-id'), port: 1, fingerprint: 'F'.repeat(22) };
const body = JSON.stringify(hello);

const servers: { close: () => Promise<void> }[] = [];
after(() => Promise.all(servers.map((s) => s.close())));

async function answering(response: (head: string) => Buffer | string | null): Promise<RawServer & { heads: string[] }> {
  const heads: string[] = [];
  const server = await rawServer((t) => {
    heads.push(t.head);
    const answer = response(t.head);
    if (answer !== null) t.socket.end(answer);
  });
  servers.push(server);
  return { ...server, heads };
}

const ok = (headers: string[], content: Buffer | string) => Buffer.concat([Buffer.from(['HTTP/1.1 200 OK', ...headers, '', ''].join('\r\n')), Buffer.from(content)]);

describe('/hello over TCP on a phone', () => {
  it('sends a plain GET asking for no encoding, and reads a Content-Length answer', async () => {
    const server = await answering(() => ok([`Content-Length: ${Buffer.byteLength(body)}`, 'Content-Type: application/json'], body));
    const answer = await fetchHello(LOOPBACK, server.port, 1400);
    assert.equal(answer?.agentId, 'mac-id');
    const lines = server.heads[0]!.split('\r\n');
    assert.equal(lines[0], `GET ${HELLO_PATH} HTTP/1.1`);
    assert.ok(lines.includes(`Host: 127.0.0.1:${server.port}`));
    assert.ok(lines.includes('Connection: close'));
    assert.ok(lines.includes('Accept-Encoding: identity'));
  });

  it('refuses gzip, and any other Content-Encoding, even identity', async () => {
    const gz = zlib.gzipSync(body);
    for (const answer of [ok(['Content-Encoding: gzip', `Content-Length: ${gz.length}`], gz), ok(['Content-Encoding: identity', `Content-Length: ${Buffer.byteLength(body)}`], body)]) {
      const server = await answering(() => answer);
      assert.equal(await fetchHello(LOOPBACK, server.port, 1400), null);
    }
  });

  it('reads a strictly chunked answer, as Node sends the agent’s', async () => {
    const half = Math.floor(body.length / 2);
    const chunked = `${half.toString(16)}\r\n${body.slice(0, half)}\r\n${(body.length - half).toString(16)}\r\n${body.slice(half)}\r\n0\r\n\r\n`;
    const server = await answering(() => ok(['Transfer-Encoding: chunked'], chunked));
    assert.equal((await fetchHello(LOOPBACK, server.port, 1400))?.agentId, 'mac-id');
  });

  it('refuses any other Transfer-Encoding, and chunking that is malformed or has extras', async () => {
    const whole = `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n`;
    const gz = zlib.gzipSync(body);
    const answers = [
      ok(['Transfer-Encoding: gzip, chunked'], `${gz.length.toString(16)}\r\n${gz.toString('latin1')}\r\n0\r\n\r\n`),
      ok(['Transfer-Encoding: gzip'], gz),
      ok(['Transfer-Encoding: chunked', 'Transfer-Encoding: chunked'], `${whole}0\r\n\r\n`),
      ok(['Transfer-Encoding: chunked', `Content-Length: ${Buffer.byteLength(body)}`], `${whole}0\r\n\r\n`),
      ok(['Transfer-Encoding: chunked'], `${Buffer.byteLength(body).toString(16)};ext=1\r\n${body}\r\n0\r\n\r\n`),
      ok(['Transfer-Encoding: chunked'], `${whole}0\r\nX-Trailer: 1\r\n\r\n`),
      ok(['Transfer-Encoding: chunked'], `${(Buffer.byteLength(body) + 1).toString(16)}\r\n${body}\r\n0\r\n\r\n`),
      ok(['Transfer-Encoding: chunked'], `${whole}0\r\n\r\nextra`),
    ];
    for (const answer of answers) {
      const server = await answering(() => answer);
      assert.equal(await fetchHello(LOOPBACK, server.port, 600), null, answer.toString('latin1').split('\r\n\r\n')[0]);
    }
  });

  it('a chunked answer counts against the cap like any other', async () => {
    const pad = 'x'.repeat(1000);
    const chunks = Array.from({ length: 6 }, () => `${pad.length.toString(16)}\r\n${pad}\r\n`).join('');
    const server = await answering(() => ok(['Transfer-Encoding: chunked'], `${chunks}0\r\n\r\n`));
    assert.equal(await fetchHello(LOOPBACK, server.port, 1400), null);
  });

  it('refuses an answer with no Content-Length, or a body longer than it says', async () => {
    for (const answer of [ok([], body), ok(['Content-Length: 5'], body)]) {
      const server = await answering(() => answer);
      assert.equal(await fetchHello(LOOPBACK, server.port, 1400), null);
    }
  });

  it('refuses a status other than 200', async () => {
    const server = await answering(() => `HTTP/1.1 203 Non-Authoritative\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    assert.equal(await fetchHello(LOOPBACK, server.port, 1400), null);
  });

  it('reads at most MAX_HELLO_BYTES in all, headers included', async () => {
    const padded = JSON.stringify({ ...hello, pad: 'x'.repeat(MAX_HELLO_BYTES) });
    const declaredBig = await answering(() => ok([`Content-Length: ${padded.length}`], padded));
    assert.equal(await fetchHello(LOOPBACK, declaredBig.port, 1400), null);
    // Fits as a body, not with its headers.
    const justOver = JSON.stringify({ ...hello, pad: 'x'.repeat(MAX_HELLO_BYTES - body.length - 20) });
    const withHeaders = await answering(() => ok([`Content-Length: ${justOver.length}`], justOver));
    assert.equal(await fetchHello(LOOPBACK, withHeaders.port, 1400), null);
  });

  it('stops reading an endless answer at the cap and closes the connection', async () => {
    let written = 0;
    let closed = false;
    const server = await rawServer((t) => {
      t.socket.on('close', () => (closed = true));
      t.socket.write(ok([`Content-Length: 99999999`], ''));
      const pump = () => {
        while (!closed && written < 50 * 1024 * 1024 && t.socket.write(Buffer.alloc(16 * 1024, 120))) written += 16 * 1024;
        if (!closed && written < 50 * 1024 * 1024) t.socket.once('drain', pump);
      };
      pump();
    });
    servers.push(server);
    assert.equal(await fetchHello(LOOPBACK, server.port, 1400), null);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(closed, 'the connection was closed');
  });

  it('gives up at the deadline when the answer never comes', async () => {
    const server = await answering(() => null);
    const started = Date.now();
    assert.equal(await fetchHello(LOOPBACK, server.port, 300), null);
    const took = Date.now() - started;
    assert.ok(took >= 250 && took < 1000, `took ${took} ms`);
  });

  it('gives up at the deadline when the answer stops halfway', async () => {
    const server = await rawServer((t) => t.socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 10)}`));
    servers.push(server);
    const started = Date.now();
    assert.equal(await fetchHello(LOOPBACK, server.port, 300), null);
    assert.ok(Date.now() - started < 1000);
  });

  it('reads the real agent’s /hello (Node sends it chunked)', async () => {
    const agent = await startAgent();
    servers.push(agent);
    // fetchHello would refuse this answer only because the agent's test config listens on port 0.
    const text = await getTextOverTcp(nodeTcp, LOOPBACK, agent.port, HELLO_PATH, 1400, MAX_HELLO_BYTES);
    const answer = JSON.parse(text!) as HelloResponse;
    assert.equal(answer.agentId, 'agent');
    assert.equal(answer.app, 'authdeck-agent');
  });
});
