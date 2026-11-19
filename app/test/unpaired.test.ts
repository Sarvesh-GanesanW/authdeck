/**
 * The computer unpairs this device while it is connected: the app notices at once, keeps the
 * computer and its pages, and opens the pairing screen for it, saying why.
 */
import { Platform } from './native';
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { RequestError } from '../src/net/client';
import { ConnectionManager } from '../src/net/connection';
import type { ProtocolError } from '../src/protocol';
import { describePairError, targetFromComputer, unpairedNotice } from '../src/screens/pair/pairing';
import { PairFlowController } from '../src/screens/pair/pairFlow';
import { useLive } from '../src/state/live';
import type { Computer } from '../src/state/model';
import { useStore } from '../src/state/store';
import { useUi } from '../src/state/ui';
import { toBase64Url } from '../src/vault/bytes';
import { type AgentOptions, type TestServer, agentInfo, agentServer, newLinkKey, waitFor } from './linkServers';

const AGENT_ID = 'mac';
const UNPAIRED: ProtocolError = { code: 'unauthorized', message: 'This device is not paired with the computer anymore.' };
const computerKey = newLinkKey();

const servers: TestServer[] = [];
after(() => Promise.all(servers.map((s) => s.close())));

let stop: (() => void) | null = null;
beforeEach(() => {
  Platform.OS = 'web';
  useUi.getState().finishPairing();
});
afterEach(() => {
  stop?.();
  stop = null;
});

const status = () => useLive.getState().status;

function computerAt(port: number): Computer {
  return { agentId: AGENT_ID, name: 'Mac', platform: 'macos', hosts: ['127.0.0.1'], port, linkKey: toBase64Url(computerKey.public), pairedAt: 1 };
}

/**
 * A computer this device is paired with and connected to. `unpair` does what AuthDeck Agent's
 * Unpair does: later sessions are refused, and the open connection is cut with no word.
 */
async function connectedComputer(answerPings = true) {
  const peers: { close: () => void }[] = [];
  let pinging = answerPings;
  const options: AgentOptions = {
    key: computerKey,
    info: agentInfo(AGENT_ID),
    afterOpen: (peer) => peers.push(peer),
    answerRequest: (request, reply) => {
      if (request.method !== 'ping' || pinging) reply(JSON.stringify({ id: request.id, ok: true, result: request.method === 'apps.list' ? { apps: [] } : {} }));
    },
  };
  const server = await agentServer('127.0.0.1', 0, options);
  servers.push(server);
  useStore.setState({ computers: [computerAt(server.port)], decks: { [AGENT_ID]: { pages: [] } as never }, activeId: AGENT_ID });
  useLive.setState({ toast: null });
  const manager = new ConnectionManager(async () => [], async () => null);
  stop = manager.init();
  await waitFor('online', () => status() === 'online');
  return {
    manager,
    server,
    unpair: (cut = true) => {
      options.refuseSessions = UNPAIRED;
      if (cut) peers.forEach((peer) => peer.close());
    },
    pairAgain: () => {
      delete options.refuseSessions;
    },
    stopAnsweringPings: () => {
      pinging = false;
    },
  };
}

describe('the computer unpairs this device', () => {
  it('opens the pairing screen for that computer, saying it was unpaired, and keeps it and its pages', async () => {
    const { unpair } = await connectedComputer();
    unpair();
    await waitFor('the pairing screen', () => useUi.getState().pairing, 4000);
    assert.equal(status(), 'unauthorized');
    const ui = useUi.getState();
    assert.equal(ui.repairAgentId, AGENT_ID);
    assert.equal(ui.repairReason, 'unpaired');
    assert.equal(ui.pairLink, null);
    assert.equal(useStore.getState().activeId, AGENT_ID);
    assert.ok(useStore.getState().computers.some((c) => c.agentId === AGENT_ID));
    assert.ok(useStore.getState().decks[AGENT_ID]);
  });

  it('opens it once: back on the deck, coming to the foreground again does not reopen it', async () => {
    const { manager, server, unpair } = await connectedComputer();
    unpair();
    await waitFor('the pairing screen', () => useUi.getState().pairing, 4000);
    useUi.getState().finishPairing();
    const tries = server.connections();
    manager.wake();
    await waitFor('another refusal', () => server.connections() > tries && status() === 'unauthorized');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(useUi.getState().pairing, false);
  });

  it('opens it again after the computer was paired again and unpaired once more', async () => {
    const { manager, unpair, pairAgain } = await connectedComputer();
    unpair();
    await waitFor('the pairing screen', () => useUi.getState().pairing, 4000);
    // Paired again: the computer accepts sessions, and the pairing screen restarts the connection.
    pairAgain();
    useUi.getState().finishPairing();
    manager.restart();
    await waitFor('online again', () => status() === 'online');
    unpair();
    await waitFor('the pairing screen again', () => useUi.getState().pairing, 4000);
    assert.equal(useUi.getState().repairReason, 'unpaired');
  });

  it('leaves a pairing the person already started alone', async () => {
    const { unpair } = await connectedComputer();
    useUi.getState().startPairing(null, null);
    unpair();
    await waitFor('the refusal', () => status() === 'unauthorized', 4000);
    assert.equal(useUi.getState().repairAgentId, null);
    assert.equal(useUi.getState().repairReason, null);
  });

  it('a session that went quiet while the app was away is checked on the way back, and the refusal found', async () => {
    const { manager, unpair, stopAnsweringPings } = await connectedComputer();
    // The connection end never reached the phone: the session still looks open.
    stopAnsweringPings();
    unpair(false);
    const started = Date.now();
    manager.wake();
    await waitFor('the pairing screen', () => useUi.getState().pairing, 6000);
    assert.ok(Date.now() - started < 6000);
    assert.equal(status(), 'unauthorized');
  });
});

describe('the pairing screen after an unpair', () => {
  const target = targetFromComputer(computerAt(47474));

  it('says the computer unpaired this device until the person starts typing the PIN', () => {
    const flow = new PairFlowController(target, { onPaired: () => {} }, unpairedNotice('Mac'));
    assert.equal(flow.getState().problem?.title, 'Mac unpaired this device.');
    assert.match(flow.getState().problem?.detail ?? '', /Open pairing in AuthDeck Agent on Mac/);
    flow.typeDigit('1');
    assert.equal(flow.getState().problem, null);
  });

  it('a computer whose pairing window is closed is named, with how to open it', () => {
    const problem = describePairError(new RequestError('locked', 'any', 'any', true), target);
    assert.equal(problem.kind, 'locked');
    assert.equal(problem.title, "Mac isn't taking a PIN right now.");
    assert.match(problem.detail ?? '', /^Open pairing in AuthDeck Agent on Mac/);
  });

  it('a reason never outlives the pairing it was given for', () => {
    useUi.getState().startPairing(null, null, 'unpaired');
    assert.equal(useUi.getState().repairReason, null);
    useUi.getState().startPairing(null, AGENT_ID, 'unpaired');
    useUi.getState().finishPairing();
    assert.equal(useUi.getState().repairReason, null);
  });
});
