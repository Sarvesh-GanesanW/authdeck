import { Platform, nodeTcp } from './native';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { openSession, pairWithPin, pairWithQr } from '../src/net/client';
import { newLinkKey } from './linkServers';
import { type RealAgent, startAgent } from './realAgent';

const LOOPBACK = '127.0.0.1';
/** The PIN the agent's test config starts with (agent/test/helpers/server.ts). */
const AGENT_TEST_PIN = '123456';

let agent: RealAgent;
before(async () => {
  Platform.OS = 'ios';
  agent = await startAgent();
});
after(() => agent.close());

describe('the whole client over LinkSocket and TCP, against the real agent', () => {
  const pinDevice = newLinkKey();
  const qrDevice = newLinkKey();

  it('pairs by PIN, then opens a session and makes requests', async () => {
    const streamsBefore = nodeTcp.streams.length;
    const paired = await pairWithPin([LOOPBACK], agent.port, AGENT_TEST_PIN, pinDevice, { deviceId: 'pin-phone', deviceName: 'PIN phone' });
    assert.equal(paired.agent.agentId, 'agent');
    assert.deepEqual(paired.agentKey, agent.linkKey);
    assert.ok(agent.pairedDeviceIds().includes('pin-phone'));

    const { session, agent: info } = await openSession(LOOPBACK, agent.port, pinDevice, paired.agentKey);
    assert.equal(info.name, 'Mac');
    assert.equal(typeof (await session.request('ping', {})).time, 'number');
    const { apps } = await session.request('apps.list', { refresh: false });
    assert.ok(Array.isArray(apps));
    session.close();
    assert.equal(session.isOpen, false);
    // Both connections went over the TCP transport, not a WebSocket.
    assert.equal(nodeTcp.streams.length, streamsBefore + 2);
  });

  it('pairs by QR code, then keeps a session through many requests', async () => {
    const paired = await pairWithQr([LOOPBACK], agent.port, agent.linkKey, agent.pairSecret(), qrDevice, { deviceId: 'qr-phone', deviceName: 'QR phone' });
    assert.equal(paired.host, LOOPBACK);
    const { session } = await openSession(LOOPBACK, agent.port, qrDevice, agent.linkKey);
    const answers = await Promise.all(Array.from({ length: 40 }, () => session.request('ping', {})));
    assert.equal(answers.length, 40);
    assert.equal(session.isOpen, true);
    session.close();
  });

  it('an unpaired device is refused by the agent, and the link says so', async () => {
    const error = await openSession(LOOPBACK, agent.port, newLinkKey(), agent.linkKey).then(
      () => assert.fail('opened'),
      (e: unknown) => e as { code: string },
    );
    assert.equal(error.code, 'unauthorized');
  });
});
