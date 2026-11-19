import { Platform } from './native';
import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';
import { linkFingerprint } from '../src/link/keys';
import { ConnectionManager, type FindComputer, type ReadHello } from '../src/net/connection';
import { type HelloResponse, PROTOCOL_VERSION } from '../src/protocol';
import { useLive } from '../src/state/live';
import type { Computer } from '../src/state/model';
import { useStore } from '../src/state/store';
import { toBase64Url } from '../src/vault/bytes';
import { type TestServer, agentInfo, agentServer, binaryAnswerer, newLinkKey, plainRefuser, sendSealed, waitFor } from './linkServers';

// Loopback counts as the local network only in the web build, and these servers are on loopback.
Platform.OS = 'web';

const V4 = '127.0.0.1';
const V6 = '::1';
const computerKey = newLinkKey();
const AGENT_ID = 'mac';
const LIES = { code: 'unauthorized' as const, message: 'Your computer was reset by IT.', hint: 'Scan the new code we emailed you.' };

const servers: TestServer[] = [];
async function serve(start: Promise<TestServer>): Promise<TestServer> {
  const server = await start;
  servers.push(server);
  return server;
}
after(() => Promise.all(servers.map((s) => s.close())));

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

function savedComputer(): Computer {
  return useStore.getState().computers.find((c) => c.agentId === AGENT_ID)!;
}

/** Saves the computer at these addresses and starts a connection manager on it. */
function connect(hosts: string[], port: number, find: FindComputer = async () => [], readHello: ReadHello = async () => null): ConnectionManager {
  const computer: Computer = { agentId: AGENT_ID, name: 'Mac', platform: 'macos', hosts, port, linkKey: toBase64Url(computerKey.public), pairedAt: 1 };
  useStore.setState({ computers: [computer], activeId: AGENT_ID });
  useLive.setState({ toast: null, focus: null });
  const manager = new ConnectionManager(find, readHello);
  stop = manager.init();
  return manager;
}

const status = () => useLive.getState().status;

describe('reconnecting to a paired computer', () => {
  it('waking while the first attempt is under way (a cold start) opens one session, not two', async () => {
    const real = await serve(agentServer(V4, 0, { key: computerKey, info: agentInfo(AGENT_ID) }));
    const manager = connect([V4], real.port);
    manager.wake();
    manager.wake();
    await waitFor('online', () => status() === 'online');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(real.connections(), 1);
  });

  it('a hostile first address does not stop the loop: the next address is tried and kept first', async () => {
    const real = await serve(agentServer(V6, 0, { key: computerKey, info: agentInfo(AGENT_ID) }));
    await serve(plainRefuser(V4, real.port, LIES));
    connect([V4, V6], real.port);
    await waitFor('online', () => status() === 'online');
    assert.equal(useLive.getState().host, V6);
    assert.deepEqual(savedComputer().hosts, [V6, V4]);
  });

  it('a plain-text refusal never marks the computer as needing pairing again, and retries go on', async () => {
    const fake = await serve(plainRefuser(V4, 0, LIES));
    const seen: string[] = [];
    const unsubscribe = useLive.subscribe((s) => seen.push(s.status));
    connect([V4], fake.port);
    await waitFor('a second attempt', () => fake.connections() >= 2);
    unsubscribe();
    assert.equal(seen.includes('unauthorized'), false);
    assert.equal(status(), 'offline');
  });

  it('junk binary frames are failed attempts that are retried', async () => {
    const junk = await serve(binaryAnswerer(V4, 0, Uint8Array.of(9, 9, 9)));
    connect([V4], junk.port);
    await waitFor('a second attempt', () => junk.connections() >= 2);
    assert.notEqual(status(), 'unauthorized');
  });

  it('another genuine agent at the address (a different key) is not sticky either', async () => {
    const other = await serve(agentServer(V4, 0, { key: newLinkKey(), info: agentInfo('other') }));
    connect([V4], other.port);
    await waitFor('a second attempt', () => other.connections() >= 2);
    assert.notEqual(status(), 'unauthorized');
  });

  it('only the computer’s encrypted refusal asks for pairing again, and the loop stops', async () => {
    const refusing = await serve(
      agentServer(V4, 0, { key: computerKey, info: agentInfo(AGENT_ID), refuseSessions: { code: 'unauthorized', message: 'This device was removed.' } }),
    );
    connect([V4], refusing.port);
    await waitFor('unauthorized', () => status() === 'unauthorized');
    const attempts = refusing.connections();
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(refusing.connections(), attempts);
  });
});

describe('finding a computer whose address changed', () => {
  it('a found address is not saved when the handshake there fails', async () => {
    const fake = await serve(plainRefuser(V6, 0, LIES));
    let searches = 0;
    connect([V4], fake.port, async () => {
      searches++;
      return [V6];
    });
    await waitFor('a search and an attempt at the found address', () => searches >= 1 && fake.connections() >= 1);
    assert.deepEqual(savedComputer().hosts, [V4]);
    assert.notEqual(status(), 'online');
  });

  it('a found address is saved, first, once the handshake there succeeds', async () => {
    const real = await serve(agentServer(V6, 0, { key: computerKey, info: agentInfo(AGENT_ID) }));
    connect([V4], real.port, async () => [V6]);
    await waitFor('online', () => status() === 'online');
    assert.deepEqual(savedComputer().hosts, [V6, V4]);
  });
});

describe('several addresses answering discovery as the computer', () => {
  it('a squatter answering first does not hide the real computer: every match is tried', async () => {
    const real = await serve(agentServer(V6, 0, { key: computerKey, info: agentInfo(AGENT_ID) }));
    const squatter = await serve(plainRefuser(V4, real.port, LIES));
    // No saved address works, so the computer can only be found by discovery.
    connect([], real.port, async () => [V4, V6]);
    await waitFor('online', () => status() === 'online');
    assert.equal(useLive.getState().host, V6);
    assert.ok(squatter.connections() >= 1);
    assert.deepEqual(savedComputer().hosts, [V6]);
  });
});

describe('a computer that sends something malformed', () => {
  it('bad focus data is not stored, and the session ends without crashing', async () => {
    let sessions = 0;
    const server = await serve(
      agentServer(V4, 0, {
        key: computerKey,
        info: agentInfo(AGENT_ID),
        afterOpen: (peer, channel) => {
          sessions++;
          setTimeout(() => sendSealed(peer, channel, '{"event":"focus","data":{"supported":true,"appId":7}}'), 30);
        },
      }),
    );
    connect([V4], server.port);
    await waitFor('the first session', () => sessions === 1 && status() === 'online');
    await waitFor('the session to end', () => status() !== 'online');
    assert.equal(useLive.getState().focus, null);
    // It waits before trying again, so a misbehaving computer is not reconnected to in a tight loop.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(sessions, 1);
  });
});

describe('the "different version" message', () => {
  const VERSION = { code: 'version' as const, message: 'Install version 9 from evil.example.', hint: 'Now.' };
  const fingerprint = linkFingerprint(computerKey.public);
  const hello = (patch: Partial<HelloResponse>): ReadHello => async () => ({
    app: 'authdeck-agent',
    ...agentInfo(AGENT_ID),
    protocol: PROTOCOL_VERSION + 1,
    port: 47474,
    fingerprint,
    ...patch,
  });
  const toast = () => useLive.getState().toast;

  it('a plain-text "version" code alone, from any host, never shows it', async () => {
    const fake = await serve(plainRefuser(V4, 0, VERSION));
    connect([V4], fake.port);
    await waitFor('two rounds', () => fake.connections() >= 2);
    assert.equal(toast(), null);
  });

  it('a /hello naming another computer, or another key, does not count as evidence', async () => {
    for (const patch of [{ agentId: 'someone-else' }, { fingerprint: 'AAAAAAAAAAAAAAAAAAAAAA' }, { protocol: PROTOCOL_VERSION }]) {
      const fake = await serve(plainRefuser(V4, 0, VERSION));
      connect([V4], fake.port, async () => [], hello(patch));
      await waitFor('two rounds', () => fake.connections() >= 2);
      assert.equal(toast(), null, JSON.stringify(patch));
      stop?.();
      stop = null;
    }
  });

  it('shows the app’s words after a failed round when /hello names this computer at another version', async () => {
    const fake = await serve(plainRefuser(V4, 0, VERSION));
    connect([V4], fake.port, async () => [], hello({}));
    await waitFor('the message', () => toast() !== null);
    assert.equal(toast()!.title, 'This computer runs a different version of AuthDeck Agent.');
    assert.doesNotMatch(`${toast()!.title} ${toast()!.detail}`, /evil/);
  });

  it('waits for the whole round: a later address that connects means no message', async () => {
    const real = await serve(agentServer(V6, 0, { key: computerKey, info: agentInfo(AGENT_ID) }));
    await serve(plainRefuser(V4, real.port, VERSION));
    connect([V4, V6], real.port, async () => [], hello({}));
    await waitFor('online', () => status() === 'online');
    assert.equal(toast(), null);
  });

  it('the computer’s own refusal inside the encrypted handshake shows it', async () => {
    const refusal = { code: 'version' as const, message: 'This app is older than the AuthDeck agent on the computer.', hint: 'Update the AuthDeck app.' };
    const refusing = await serve(agentServer(V4, 0, { key: computerKey, info: agentInfo(AGENT_ID), refuseSessions: refusal }));
    connect([V4], refusing.port);
    await waitFor('the message', () => toast() !== null);
    assert.equal(toast()!.title, refusal.message);
  });
});

describe('L5: looking for a computer whose address changed', () => {
  it('the search stops when the computer changes', async () => {
    const gone = await serve(plainRefuser(V4, 0, LIES));
    let searching: AbortSignal | undefined;
    connect([V4], gone.port, async (_id, _port, _fingerprint, signal) => {
      searching = signal;
      // Like a sweep still under way: settles only when aborted.
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
      return [];
    });
    await waitFor('the search', () => searching !== undefined);
    assert.equal(searching!.aborted, false);
    stop?.();
    stop = null;
    assert.equal(searching!.aborted, true);
  });
});
