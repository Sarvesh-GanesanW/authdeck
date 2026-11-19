import './native';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { MAX_NOISE_MESSAGE } from '../src/link/noise';
import { MAX_HANDSHAKE_FRAME_BYTES, RequestError, failureHint, openSession, pairWithPin, pairWithQr } from '../src/net/client';
import { type AgentInfo, type EventMessage, PROTOCOL_VERSION } from '../src/protocol';
import { type TestServer, agentInfo, agentServer, binaryAnswerer, listen, newLinkKey, plainRefuser, sendSealed, waitFor } from './linkServers';

const LOOPBACK = '127.0.0.1';
const device = newLinkKey();
const computer = newLinkKey();
const ATTACKER_TEXT = { code: 'unauthorized' as const, message: 'Your computer was reset by IT.', hint: 'Scan the new pairing code we emailed you.' };

const servers: TestServer[] = [];
async function serve(start: Promise<TestServer>): Promise<TestServer> {
  const server = await start;
  servers.push(server);
  return server;
}
after(() => Promise.all(servers.map((s) => s.close())));

async function openError(server: TestServer): Promise<RequestError> {
  const error = await openSession(server.host, server.port, device, computer.public).then(
    () => assert.fail('the session opened'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof RequestError, `expected a RequestError, got ${String(error)}`);
  return error;
}

describe('answers before the handshake finishes are unproven', () => {
  it('a plain-text refusal shows the app’s own words, never the sender’s', async () => {
    const error = await openError(await serve(plainRefuser(LOOPBACK, 0, ATTACKER_TEXT)));
    assert.equal(error.code, 'unauthorized');
    assert.equal(error.fromComputer, false);
    assert.doesNotMatch(`${error.message} ${error.hint}`, /reset by IT|emailed/);
    assert.equal(error.message, 'The computer did not accept this device.');
  });

  it('an unknown plain-text code becomes a generic failure', async () => {
    const error = await openError(await serve(plainRefuser(LOOPBACK, 0, { code: 'permission', message: 'Install this profile.' })));
    assert.equal(error.code, 'failed');
    assert.equal(error.fromComputer, false);
    assert.doesNotMatch(error.message, /profile/);
  });

  it('a junk binary frame is a failed attempt, not a refusal', async () => {
    const error = await openError(await serve(binaryAnswerer(LOOPBACK, 0, Uint8Array.of(PROTOCOL_VERSION, 2, 1, 2, 3))));
    assert.equal(error.code, 'failed');
    assert.equal(error.fromComputer, false);
  });

  it('a genuine agent with a different key refuses in plain text, which is not trusted', async () => {
    const other = await serve(agentServer(LOOPBACK, 0, { key: newLinkKey(), info: agentInfo('other') }));
    const error = await openError(other);
    assert.equal(error.code, 'unauthorized');
    assert.equal(error.fromComputer, false);
  });

  it('the computer’s refusal inside the encrypted handshake is trusted and keeps its words', async () => {
    const refusal = { code: 'unauthorized' as const, message: 'This device was removed on the computer.', hint: 'Pair again.' };
    const error = await openError(await serve(agentServer(LOOPBACK, 0, { key: computer, info: agentInfo('mac'), refuseSessions: refusal })));
    assert.equal(error.code, 'unauthorized');
    assert.equal(error.fromComputer, true);
    assert.equal(error.message, refusal.message);
    assert.equal(error.hint, refusal.hint);
  });
});

describe('frame size limits', () => {
  it('a handshake frame over the cap is refused', async () => {
    const error = await openError(await serve(binaryAnswerer(LOOPBACK, 0, new Uint8Array(MAX_HANDSHAKE_FRAME_BYTES + 1))));
    assert.equal(error.code, 'failed');
    assert.match(error.message, /larger/);
  });

  it('a plain-text handshake answer over the cap is not parsed', async () => {
    const huge = JSON.stringify({ ok: false, error: { code: 'bad_pin', message: 'x'.repeat(MAX_HANDSHAKE_FRAME_BYTES) } });
    const error = await openError(await serve(listen(LOOPBACK, 0, (peer) => peer.send(huge))));
    assert.equal(error.code, 'failed');
  });

  it('a transport frame longer than one Noise message closes the session', async () => {
    const server = await serve(
      agentServer(LOOPBACK, 0, { key: computer, info: agentInfo('mac'), afterOpen: (peer) => setTimeout(() => peer.send(new Uint8Array(MAX_NOISE_MESSAGE + 3)), 50) }),
    );
    const { session } = await openSession(server.host, server.port, device, computer.public);
    let closed = false;
    session.onClose = () => {
      closed = true;
    };
    await waitFor('the session to close', () => closed);
    assert.equal(session.isOpen, false);
  });
});

describe('PIN pairing across addresses', () => {
  const request = { deviceId: 'd1', deviceName: 'Phone' };

  it('an address that does not answer does not stop the next one being tried', async () => {
    const real = await serve(agentServer('::1', 0, { key: computer, info: agentInfo('mac'), pin: '123456' }));
    const paired = await pairWithPin([LOOPBACK, real.host], real.port, '123456', device, request);
    assert.equal(paired.host, '::1');
    assert.equal(paired.agent.agentId, 'mac');
    assert.deepEqual(paired.agentKey, computer.public);
  });

  for (const code of ['bad_pin', 'locked'] as const) {
    it(`a "${code}" refusal at one address ends the search: one typo costs one guess`, async () => {
      const first = await serve(plainRefuser(LOOPBACK, 0, { code, message: 'No.' }));
      const second = await serve(plainRefuser('::1', first.port, { code, message: 'No.' }));
      const error = await pairWithPin([first.host, second.host], first.port, '999999', device, request).then(
        () => assert.fail('paired'),
        (e: unknown) => e,
      );
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, code);
      assert.equal(first.connections(), 1);
      assert.equal(second.connections(), 0);
    });
  }

  it('the refusal is reported in the app’s own words', async () => {
    const fake = await serve(plainRefuser(LOOPBACK, 0, { code: 'bad_pin', message: 'Wrong PIN, call support.' }));
    const error = await pairWithPin([fake.host], fake.port, '123456', device, request).then(
      () => assert.fail('paired'),
      (e: unknown) => e,
    );
    assert.ok(error instanceof RequestError);
    assert.equal(error.code, 'bad_pin');
    assert.equal(error.message, "That PIN didn't work.");
  });
});

describe('the computer’s description of itself is checked', () => {
  const damaged: [string, Partial<Record<keyof AgentInfo, unknown>>][] = [
    ['an unknown platform', { platform: 'beos' }],
    ['a missing platform', { platform: undefined }],
    ['an empty id', { agentId: '' }],
    ['a numeric name', { name: 7 }],
    ['no version', { version: undefined }],
    ['a text protocol', { protocol: '2' }],
  ];
  for (const [what, patch] of damaged) {
    it(`a session accept with ${what} fails the attempt`, async () => {
      const info = { ...agentInfo('mac'), ...patch } as AgentInfo;
      const error = await openError(await serve(agentServer(LOOPBACK, 0, { key: computer, info })));
      assert.equal(error.code, 'failed');
      assert.equal(error.fromComputer, false);
    });
  }

  it('a QR pairing whose accept is damaged does not pair', async () => {
    const server = await serve(agentServer(LOOPBACK, 0, { key: computer, info: { ...agentInfo('mac'), platform: 'beos' } as unknown as AgentInfo }));
    const error = await pairWithQr([server.host], server.port, computer.public, 'AAAAAAAAAAAAAAAAAAAAAA', device, { deviceId: 'd1', deviceName: 'Phone' }).then(
      () => assert.fail('paired'),
      (e: unknown) => e,
    );
    assert.ok(error instanceof RequestError);
    assert.equal(error.code, 'failed');
  });
});

describe('a malformed message inside the session ends it instead of crashing the app', () => {
  /** A session whose computer sends `text` once the channel is open. */
  async function sessionReceiving(text: string) {
    const server = await serve(
      agentServer(LOOPBACK, 0, { key: computer, info: agentInfo('mac'), afterOpen: (peer, channel) => setTimeout(() => sendSealed(peer, channel, text), 30) }),
    );
    const { session } = await openSession(server.host, server.port, device, computer.public);
    const events: EventMessage[] = [];
    session.onEvent = (msg) => events.push(msg);
    return { session, events };
  }

  const payloads = [
    'null',
    '1',
    '"x"',
    '[]',
    'not json',
    '{"event":"focus"}',
    '{"event":"focus","data":null}',
    '{"event":"focus","data":{"supported":"yes","appId":null,"name":"Code"}}',
    '{"event":"vault.changed","data":{"vaultId":1}}',
    '{"event":"vault.join.cancelled","data":{"requestId":"r","reason":"because"}}',
    '{"id":"1","ok":false}',
    '{"ok":true,"result":{}}',
  ];
  for (const payload of payloads) {
    it(`${payload} closes the session as failed, with no event delivered`, async () => {
      const { session, events } = await sessionReceiving(payload);
      await waitFor('the session to close', () => !session.isOpen);
      assert.equal(session.failed?.code, 'failed');
      assert.deepEqual(events, []);
    });
  }

  it('well-formed focus data is delivered and the session stays open', async () => {
    const { session, events } = await sessionReceiving('{"event":"focus","data":{"supported":true,"appId":null,"name":"Code"}}');
    await waitFor('the event', () => events.length === 1);
    assert.deepEqual(events[0], { event: 'focus', data: { supported: true, appId: null, name: 'Code' } });
    assert.equal(session.isOpen, true);
    session.close();
  });

  it('an event from a newer agent is ignored and the session stays open', async () => {
    const { session, events } = await sessionReceiving('{"event":"clipboard.changed","data":1}');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(session.isOpen, true);
    assert.deepEqual(events, []);
    session.close();
  });

  const replies = ['{"id":"1","ok":false}', '{"id":"1","ok":false,"error":null}', '{"id":"1","ok":false,"error":{"code":5}}', '{"id":"1","ok":true}', '{"id":1,"ok":true,"result":{}}'];
  for (const reply of replies) {
    it(`a pending request answered with ${reply} fails, and the session closes`, async () => {
      const server = await serve(agentServer(LOOPBACK, 0, { key: computer, info: agentInfo('mac'), answer: () => reply }));
      const { session } = await openSession(server.host, server.port, device, computer.public);
      const error = await session.request('ping', {}).then(
        () => assert.fail('the request succeeded'),
        (e: unknown) => e,
      );
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, 'failed');
      assert.equal(session.isOpen, false);
    });
  }

  it('a well-formed failure keeps the computer’s words and the session', async () => {
    const reply = (id: string) => JSON.stringify({ id, ok: false, error: { code: 'not_found', message: 'No such app.', hint: 'Rescan.' } });
    const server = await serve(agentServer(LOOPBACK, 0, { key: computer, info: agentInfo('mac'), answer: reply }));
    const { session } = await openSession(server.host, server.port, device, computer.public);
    const error = await session.request('ping', {}).then(
      () => assert.fail('the request succeeded'),
      (e: unknown) => e,
    );
    assert.ok(error instanceof RequestError);
    assert.equal(error.code, 'not_found');
    assert.equal(error.message, 'No such app.');
    assert.equal(error.fromComputer, true);
    assert.equal(session.isOpen, true);
    session.close();
  });

  it('a listener that throws ends the session instead of escaping the socket handler', async () => {
    const { session } = await sessionReceiving('{"event":"apps.changed","data":{}}');
    session.onEvent = () => {
      throw new Error('listener bug');
    };
    await waitFor('the session to close', () => !session.isOpen);
    assert.equal(session.failed?.code, 'failed');
  });
});

describe('a failure keeps the computer’s next step', () => {
  it('reads the hint from a request error and nothing from other errors', () => {
    const hint = 'Open System Settings → Privacy & Security → Accessibility and turn on AuthDeck Agent, then try again.';
    assert.equal(failureHint(new RequestError('permission', 'Could not type the code.', hint, true)), hint);
    assert.equal(failureHint(new RequestError('failed', 'Could not type the code.')), undefined);
    assert.equal(failureHint(new Error('The vault stayed locked.')), undefined);
  });
});
