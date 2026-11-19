/**
 * The app-side findings of link review 4b, as regression tests: F1 (agentIds that name
 * Object.prototype members), F3 (control characters and U+FFFC in names, the small k with stroke)
 * and F4 (a computer that accepts each session and closes it at once).
 */
import { Platform } from './native';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage') as {
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};
import { ConnectionManager, STABLE_SESSION_MS } from '../src/net/connection';
import { parsePairLink } from '../src/net/discovery';
import { isAgentInfo, isHelloResponse, isSafeAgentId } from '../src/net/messages';
import { checkedComputers, checkedDecks, checkedPageIndex } from '../src/net/storedData';
import { inTwoLines, keyWordsOf } from '../src/net/linkState';
import { cleanName, decidePairing, isSameComputerName, MAX_COMPUTER_NAME_CHARS, mixesAlphabets } from '../src/net/trust';
import { PairFlowController } from '../src/screens/pair/pairFlow';
import { useLive } from '../src/state/live';
import type { Computer, Deck } from '../src/state/model';
import { entryFor, useStore } from '../src/state/store';
import { toBase64Url } from '../src/vault/bytes';
import { type TestServer, agentInfo, agentServer, newLinkKey, waitFor } from './linkServers';

const PROTOTYPE_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__'];
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAA';
const DECK: Deck = { pages: [{ id: 'p1', name: 'Work', slots: [null] }] } as Deck;

let server: TestServer | null = null;
let stop: (() => void) | null = null;
beforeEach(() => {
  Platform.OS = 'web';
  useStore.setState({ computers: [], decks: {}, activeId: null, pageIndex: {} });
});
afterEach(async () => {
  stop?.();
  stop = null;
  await server?.close();
  server = null;
});

function pairedComputer(agentId: string, port: number, key: Uint8Array): Computer {
  return { agentId, name: 'Mac', platform: 'macos', hosts: ['127.0.0.1'], port, linkKey: toBase64Url(key), pairedAt: 1 };
}

describe('F1: agentIds that name Object.prototype members', () => {
  it('isSafeAgentId takes a UUID and refuses prototype names, empty, long and unusual ids', () => {
    assert.equal(isSafeAgentId('6f1c1c2e-3b7a-4d47-9a51-0d8f0b2f3c11'), true);
    assert.equal(isSafeAgentId('ada-mac'), true);
    for (const id of [...PROTOTYPE_NAMES, '', 'a'.repeat(65), 'has space', 'dot.ted', 'Cyrillic-а', 42, null]) {
      assert.equal(isSafeAgentId(id), false, JSON.stringify(id));
    }
  });

  it('the handshake and /hello refuse a computer giving such an id', () => {
    for (const id of PROTOTYPE_NAMES) {
      assert.equal(isAgentInfo(agentInfo(id)), false, id);
      assert.equal(isHelloResponse({ ...agentInfo(id), app: 'authdeck-agent' }), false, id);
    }
  });

  for (const id of ['__proto__', 'constructor', 'toString']) {
    it(`a pairing link answered by a computer with agentId ${id} is refused and saves nothing`, async () => {
      const key = newLinkKey();
      server = await agentServer('127.0.0.1', 0, { key, info: agentInfo(id, 'Meeting room TV') });
      const link = parsePairLink(`authdeck://pair?v=2&n=Meeting%20room%20TV&p=${server.port}&h=127.0.0.1&k=${toBase64Url(key.public)}&s=${SECRET}`)!;
      // A pairing link carries no agentId: the id only ever comes from the handshake.
      assert.equal('agentId' in link, false);
      const paired: string[] = [];
      const flow = new PairFlowController(null, { onPaired: (name) => paired.push(name) });
      flow.offerLink(link);
      flow.confirmLink();
      await waitFor('the pairing to settle', () => flow.getState().paired || !!flow.getState().problem || !!flow.getState().keyChange);
      assert.ok(flow.getState().problem);
      assert.deepEqual(paired, []);
      assert.deepEqual(useStore.getState().computers, []);
      assert.equal(useStore.getState().activeId, null);
    });
  }

  it('persisted computers, decks and page numbers under such ids are dropped on load', async () => {
    const key = toBase64Url(newLinkKey().public);
    const good = { agentId: 'ada-mac', name: 'Ada’s MacBook', platform: 'macos', hosts: ['192.168.1.5'], port: 47474, linkKey: key, pairedAt: 1 };
    const hostileDecks = Object.fromEntries([['ada-mac', DECK], ...PROTOTYPE_NAMES.map((id) => [id, DECK])]);
    const hostilePages = Object.fromEntries([['ada-mac', 1], ...PROTOTYPE_NAMES.map((id) => [id, 2])]);
    await AsyncStorage.setItem(
      'authdeck-v1',
      JSON.stringify({
        version: 3,
        state: {
          deviceId: 'd1',
          computers: [...PROTOTYPE_NAMES.map((agentId) => ({ ...good, agentId })), good],
          activeId: '__proto__',
          decks: hostileDecks,
          pageIndex: hostilePages,
        },
      }),
    );
    await useStore.persist.rehydrate();
    const s = useStore.getState();
    assert.deepEqual(s.computers.map((c) => c.agentId), ['ada-mac']);
    assert.equal(s.activeId, 'ada-mac');
    assert.deepEqual(Object.keys(s.decks), ['ada-mac']);
    assert.deepEqual(Object.keys(s.pageIndex), ['ada-mac']);
    await AsyncStorage.removeItem('authdeck-v1');
  });

  it('the stored-data checks drop such ids on their own too', () => {
    const computers = checkedComputers(PROTOTYPE_NAMES.map((agentId) => ({ agentId, name: 'x', platform: 'macos', hosts: [], port: 1 })));
    assert.deepEqual(computers, []);
    assert.deepEqual(checkedDecks(JSON.parse('{"__proto__":{"pages":[{"id":"p","name":"p","slots":[]}]}}')), {});
    assert.deepEqual(checkedPageIndex({ toString: 1, mac: -1, pc: 1.5, ok: 2 }), { ok: 2 });
  });

  it('record lookups read own entries only: the active deck of a "__proto__" computer is null', () => {
    // As useActiveDeck reads it, with state that got past every check.
    useStore.setState({ computers: [{ agentId: '__proto__' } as Computer], activeId: '__proto__', decks: {} });
    const s = useStore.getState();
    assert.equal(s.activeId ? (entryFor(s.decks, s.activeId) ?? null) : null, null);
    for (const id of PROTOTYPE_NAMES) {
      assert.equal(entryFor({}, id), undefined, id);
      assert.equal(entryFor({ ...{} }, id), undefined, id);
    }
  });

  it('a starter deck for a "toString" computer is stored, and pages can be added to it', () => {
    useStore.getState().addComputer({ agentId: 'toString', name: 'x', platform: 'macos', hosts: [], port: 1, pairedAt: 1 }, DECK);
    assert.deepEqual(entryFor(useStore.getState().decks, 'toString'), DECK);
    useStore.getState().addPage('toString', 'Second');
    assert.equal(entryFor(useStore.getState().decks, 'toString')?.pages.length, 2);
    useStore.getState().removeComputer('toString');
    assert.equal(entryFor(useStore.getState().decks, 'toString'), undefined);
    assert.deepEqual(useStore.getState().computers, []);
  });
});

describe('F3: control characters and U+FFFC in names', () => {
  const CONTROLS = ['\u0000', '\u0001', '\u001F', '\u007F', '\u0080', '\u0085', '\u009F', '￼'];

  it('cleanName removes them, and keeps a tab or line break as a space', () => {
    for (const cc of CONTROLS) assert.equal(cleanName(`Work${cc}Mac`), 'WorkMac', JSON.stringify(cc));
    assert.equal(cleanName('Work\tMac\n'), 'Work Mac');
  });

  it('a name with one inside reads the same as the name without it', () => {
    assert.equal(isSameComputerName('Work\u0000Mac', 'WorkMac'), true);
    for (const cc of CONTROLS) assert.equal(isSameComputerName(`Ada’s Mac${cc}Book`, 'Ada’s MacBook'), true, JSON.stringify(cc));
  });

  it('a QR pairing borrowing a saved name with a control character inside asks first', () => {
    const saved: Computer = { agentId: 'ada-mac', name: 'Ada’s MacBook', platform: 'macos', hosts: ['192.168.1.5'], port: 47474, linkKey: 'A'.repeat(43), pairedAt: 1 };
    for (const cc of CONTROLS) {
      const fake = `Ada’s Mac${cc}Book`;
      const decision = decidePairing({ route: 'qr', startedFrom: 'qr', named: fake, expectedAgentId: null, agentId: 'evil', agentName: fake, linkKey: 'B'.repeat(43) }, [saved]);
      assert.deepEqual(decision, { kind: 'ask', conflict: 'name', saved }, JSON.stringify(cc));
    }
  });

  it('the small k with stroke reads as k, like its capital in confusables.txt', () => {
    assert.equal(isSameComputerName('Ada’s MacBooꝁ', 'Ada’s MacBook'), true);
    assert.equal(isSameComputerName('Ꝁ', 'k'), true);
    assert.equal(mixesAlphabets('Ada’s MacBooꝁ'), false);
  });
});

describe('F4: a computer that accepts each session and closes it at once', () => {
  /** A paired computer that closes each session `closeAfterMs(n)` after the n-th one opens. */
  async function hangUpAgent(closeAfterMs: (opens: number) => number = () => 5) {
    const key = newLinkKey();
    let opens = 0;
    server = await agentServer('127.0.0.1', 0, {
      key,
      info: agentInfo('paired-mac', 'Mac'),
      afterOpen: (peer) => {
        opens++;
        setTimeout(() => peer.close(), closeAfterMs(opens));
      },
      answerRequest: () => undefined,
    });
    // Its deck exists already, so the only store writes left would be the connection's own.
    useStore.setState({ computers: [pairedComputer('paired-mac', server.port, key.public)], activeId: 'paired-mac', decks: { 'paired-mac': DECK } });
    return { opens: () => opens };
  }

  it('is reconnected to with a growing backoff, and the saved store is not rewritten', async () => {
    const agent = await hangUpAgent();
    let writes = 0;
    const realSet = AsyncStorage.setItem;
    AsyncStorage.setItem = (k: string, v: string) => {
      if (k === 'authdeck-v1') writes++;
      return realSet(k, v);
    };
    try {
      stop = new ConnectionManager(async () => [], async () => null).init();
      await new Promise((r) => setTimeout(r, 3500));
      // Opens at about 0, 1 and 3 s; the old loop opened about 300 in this time.
      assert.ok(agent.opens() >= 2 && agent.opens() <= 4, `sessions opened: ${agent.opens()}`);
      assert.equal(writes, 0);
    } finally {
      AsyncStorage.setItem = realSet;
    }
  });

  it('waits before reconnecting even after a clean close', async () => {
    const agent = await hangUpAgent();
    stop = new ConnectionManager(async () => [], async () => null).init();
    await waitFor('the first session', () => agent.opens() === 1);
    await waitFor('the close', () => useLive.getState().status === 'offline');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(agent.opens(), 1);
  });

  it('a session that stayed up resets the backoff', async () => {
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      // The second session stays open long enough to move the clock past STABLE_SESSION_MS.
      const agent = await hangUpAgent((opens) => (opens === 2 ? 400 : 5));
      stop = new ConnectionManager(async () => [], async () => null).init();
      await waitFor('the second session', () => agent.opens() === 2 && useLive.getState().status === 'online', 4000);
      skew = STABLE_SESSION_MS;
      await waitFor('the close', () => useLive.getState().status !== 'online');
      const closedAt = realNow();
      await waitFor('the third session', () => agent.opens() === 3, 4000);
      const waited = realNow() - closedAt;
      // Without the reset this wait would be the third backoff step, 2 s.
      assert.ok(waited < 1000, `reconnected after ${waited} ms`);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('round 5: names and key words', () => {
  it('a cleaned name keeps at most 64 characters, counted as characters, not UTF-16 units', () => {
    assert.equal(cleanName('a'.repeat(100)), 'a'.repeat(MAX_COMPUTER_NAME_CHARS));
    assert.equal(Array.from(cleanName('🖥'.repeat(80))).length, MAX_COMPUTER_NAME_CHARS);
    assert.equal(cleanName(`${'a'.repeat(63)} b`), 'a'.repeat(63));
  });

  it('a computer is shown by six key words, in two lines of three where space is tight', () => {
    const words = keyWordsOf(toBase64Url(newLinkKey().public));
    assert.equal(words.split(' · ').length, 6);
    const [first, second] = inTwoLines(words).split('\n');
    assert.equal(first!.split(' · ').length, 3);
    assert.equal(second!.split(' · ').length, 3);
  });
});
