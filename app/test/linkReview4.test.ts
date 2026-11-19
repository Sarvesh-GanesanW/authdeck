/**
 * The app-side findings of link review 4, as regression tests against real agents on loopback:
 * F2 (a computer's data checked again where it is stored, reloaded and drawn), F4 and F6 (every
 * pairing route and every reconnect checks the computer's id), and F7 (limits on a paired peer).
 * F3 (names that read the same) is in trust.test.ts.
 */
import { Platform } from './native';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage') as {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};
import { ConnectionManager, FOCUS_REDRAW_MS } from '../src/net/connection';
import { drawableIcon } from '../src/net/iconData';
import { MAX_ICON_BASE64_CHARS, isMethodResult } from '../src/net/messages';
import { checkedComputers, checkedDecks, checkedIconCache } from '../src/net/storedData';
import { PairFlowController } from '../src/screens/pair/pairFlow';
import { NO_SAVED_KEY_WORDS, type PairTarget, targetFromComputer } from '../src/screens/pair/pairing';
import { keyWordsOf } from '../src/net/linkState';
import { useLive } from '../src/state/live';
import type { Computer, Deck } from '../src/state/model';
import { useStore } from '../src/state/store';
import { toBase64Url } from '../src/vault/bytes';
import { type TestServer, agentInfo, agentServer, newLinkKey, sendSealed, waitFor } from './linkServers';
import { pngBase64 } from './pngFixture';

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
const PNG = pngBase64(16, 16);
const BAD_ICONS: [string, string][] = [
  ['not base64 at all', 'not base64!'],
  ['a length that is not a multiple of 4', 'PHN2Zz4'],
  ['padding in the middle', 'PH=2Zz48'],
  ['three padding characters', 'PHN2Z==='],
  ['the base64url alphabet', 'PHN2Zz4-_A=='],
  ['an empty string', ''],
  ['over the size cap', 'A'.repeat(MAX_ICON_BASE64_CHARS + 4)],
  ['the PNG signature alone, without its IHDR', 'iVBORw0KGgo='],
];

let server: TestServer | null = null;
let stop: (() => void) | null = null;
beforeEach(() => {
  Platform.OS = 'web';
});
afterEach(async () => {
  stop?.();
  stop = null;
  await server?.close();
  server = null;
});

const pairedComputer = (agentId: string, port: number, key: Uint8Array, name = 'Mac'): Computer => ({
  agentId,
  name,
  platform: 'macos',
  hosts: ['127.0.0.1'],
  port,
  linkKey: toBase64Url(key),
  pairedAt: 1,
});
const answer = (id: string, result: unknown) => JSON.stringify({ id, ok: true, result });

describe('F2: icons the computer sends', () => {
  for (const [what, data] of BAD_ICONS) {
    it(`apps.icons with ${what} fails its check, and draws the placeholder`, () => {
      const icon = { mime: 'image/png', data };
      assert.equal(isMethodResult('apps.icons', { icons: { app: icon } }), false);
      assert.equal(drawableIcon(icon), null);
    });
  }

  it('well-formed PNG icons pass and draw', () => {
    assert.equal(isMethodResult('apps.icons', { icons: { b: { mime: 'image/png', data: PNG }, c: null } }), true);
    assert.deepEqual(drawableIcon({ mime: 'image/png', data: PNG }), { kind: 'png', base64: PNG });
  });

  it('a computer answering with an invalid icon, or icons nobody asked for, stores neither', async () => {
    const key = newLinkKey();
    server = await agentServer('127.0.0.1', 0, {
      key,
      info: agentInfo('icons-mac'),
      answerRequest: ({ id, method, params }, reply) => {
        if (method === 'apps.list') reply(answer(id, { apps: [] }));
        if (method !== 'apps.icons') return;
        const [asked] = (params as { ids: string[] }).ids;
        const data = asked === 'com.bad' ? 'not base64!' : PNG;
        reply(answer(id, { icons: { [asked!]: { mime: 'image/png', data }, 'com.extra': { mime: 'image/png', data: PNG } } }));
      },
    });
    useStore.setState({ computers: [pairedComputer('icons-mac', server.port, key.public)], activeId: 'icons-mac', decks: {} });
    const manager = new ConnectionManager(async () => [], async () => null);
    stop = manager.init();
    await waitFor('online', () => useLive.getState().status === 'online');
    await manager.loadIcons(['com.bad']);
    await manager.loadIcons(['com.good']);
    const icons = useLive.getState().icons;
    assert.equal('com.bad' in icons, false);
    assert.equal(icons['com.good']?.data, PNG);
    assert.equal('com.extra' in icons, false);
  });
});

describe('F2: what was saved from a computer is checked again on load', () => {
  it('the icon cache keeps good entries and drops bad ones, not the whole cache', async () => {
    const key = newLinkKey();
    const cached = {
      'com.good': { mime: 'image/png', data: PNG },
      'com.none': null,
      'com.bad': { mime: 'image/png', data: 'not base64!' },
      'com.svg': { mime: 'image/svg+xml', data: SVG },
      'com.wrong-mime': { mime: 'text/html', data: PNG },
      'com.number': 5,
    };
    assert.deepEqual(checkedIconCache(cached), { 'com.good': cached['com.good'], 'com.none': null });
    const protoKeyed = `{"__proto__": {"mime": "image/png", "data": "${PNG}"}}`;
    assert.deepEqual(checkedIconCache(JSON.parse(protoKeyed)), JSON.parse(protoKeyed));
    assert.deepEqual(checkedIconCache([1, 2]), {});

    await AsyncStorage.setItem('authdeck-icons-v1:cached-mac', JSON.stringify(cached));
    // Offline: only the cache can fill the icons.
    useStore.setState({ computers: [{ ...pairedComputer('cached-mac', 9, key.public), hosts: [] }], activeId: 'cached-mac', decks: {} });
    stop = new ConnectionManager(async () => [], async () => null).init();
    await waitFor('the cached icons', () => 'com.good' in useLive.getState().icons);
    assert.deepEqual(Object.keys(useLive.getState().icons).sort(), ['com.good', 'com.none']);
  });

  it('saved computers: a damaged entry or key is dropped, names are cleaned, addresses stay local', () => {
    const key = toBase64Url(newLinkKey().public);
    const good = { agentId: 'ada-mac', name: 'Ada’s​ MacBook', platform: 'macos', hosts: ['192.168.1.5', '203.0.113.9', 7], port: 47474, linkKey: key, pairedAt: 1 };
    const computers = checkedComputers([
      good,
      { ...good, agentId: 'bad-platform', platform: 'amiga' },
      { ...good, agentId: 'bad-key', linkKey: 'not a key' },
      { ...good, agentId: 'bad-port', port: 0 },
      { ...good, agentId: 'ada-mac', name: 'A second ada-mac' },
      { ...good, agentId: 'legacy', linkKey: undefined },
      'junk',
    ]);
    assert.deepEqual(
      computers.map((c) => c.agentId),
      ['ada-mac', 'legacy'],
    );
    assert.equal(computers[0]!.name, 'Ada’s MacBook');
    assert.deepEqual(computers[0]!.hosts, ['192.168.1.5']);
    assert.equal(computers[1]!.linkKey, undefined);
  });

  it('saved decks: a damaged key becomes an empty slot, a damaged page or deck is dropped', () => {
    const goodKey = { id: 'k1', label: 'Chrome', icon: { kind: 'app', appId: 'com.google.Chrome' }, color: 'amber', action: { type: 'launch', appId: 'com.google.Chrome', appName: 'Chrome' } };
    const decks = checkedDecks({
      mac: {
        pages: [
          { id: 'p1', name: 'Work', slots: [goodKey, null, { ...goodKey, icon: { kind: 'app', appId: 5 } }, { ...goodKey, action: { type: 'launch', appId: 'x' } }], focusApp: { appId: 7 } },
          { id: 'p2', name: 'Broken', slots: 'nope' },
        ],
      },
      empty: { pages: [{ id: 'p', name: 1, slots: [] }] },
      junk: 'nope',
    }) as Record<string, Deck>;
    assert.deepEqual(Object.keys(decks), ['mac']);
    assert.equal(decks.mac!.pages.length, 1);
    assert.deepEqual(decks.mac!.pages[0]!.slots, [goodKey, null, null, null]);
    assert.equal(decks.mac!.pages[0]!.focusApp, null);
  });

  it('the persisted store is checked when it loads: bad computers go, the active one falls back, decks stay', async () => {
    const key = toBase64Url(newLinkKey().public);
    const good = { agentId: 'ada-mac', name: 'Ada’s MacBook', platform: 'macos', hosts: ['192.168.1.5'], port: 47474, linkKey: key, pairedAt: 1 };
    const deck = { pages: [{ id: 'p1', name: 'Work', slots: [null] }] };
    await AsyncStorage.setItem(
      'authdeck-v1',
      JSON.stringify({ version: 3, state: { deviceId: 'd1', computers: [good, { ...good, agentId: 'evil', linkKey: 'damaged' }], activeId: 'evil', decks: { 'ada-mac': deck, evil: deck } } }),
    );
    await useStore.persist.rehydrate();
    const s = useStore.getState();
    assert.deepEqual(s.computers.map((c) => c.agentId), ['ada-mac']);
    assert.equal(s.activeId, 'ada-mac');
    assert.deepEqual(Object.keys(s.decks).sort(), ['ada-mac', 'evil']);
    await AsyncStorage.removeItem('authdeck-v1');
  });

  it("clearing a computer's cached display data leaves its pairing and deck", async () => {
    const key = newLinkKey();
    const computer = { ...pairedComputer('clear-mac', 9, key.public), hosts: [] };
    const deck = { pages: [{ id: 'p1', name: 'Work', slots: [null] }] } as Deck;
    await AsyncStorage.setItem('authdeck-icons-v1:clear-mac', JSON.stringify({ 'com.good': { mime: 'image/png', data: PNG } }));
    await AsyncStorage.setItem('authdeck-icons-v1:other-mac', JSON.stringify({}));
    useStore.setState({ computers: [computer], activeId: 'clear-mac', decks: { 'clear-mac': deck } });
    const manager = new ConnectionManager(async () => [], async () => null);
    stop = manager.init();
    await waitFor('the cached icons', () => 'com.good' in useLive.getState().icons);
    await manager.clearDisplayCache('clear-mac');
    assert.equal(await AsyncStorage.getItem('authdeck-icons-v1:clear-mac'), null);
    assert.equal(await AsyncStorage.getItem('authdeck-icons-v1:other-mac'), '{}');
    assert.deepEqual(useLive.getState().icons, {});
    assert.deepEqual(useStore.getState().computers, [computer]);
    assert.deepEqual(useStore.getState().decks['clear-mac'], deck);
  });
});

describe('F4: a PIN pairing with a computer saved before link keys', () => {
  const NAME = 'Ada’s MacBook';
  const legacy: Computer = { agentId: 'ada-mac', name: NAME, platform: 'macos', hosts: ['192.168.1.5'], port: 47474, pairedAt: 1 };

  async function pairByPin(target: (port: number) => PairTarget, answeringId = 'ada-mac') {
    useStore.setState({ computers: [legacy], decks: { 'ada-mac': { pages: [] } as never }, activeId: null });
    const agentKey = newLinkKey();
    server = await agentServer('127.0.0.1', 0, { key: agentKey, info: agentInfo(answeringId, NAME), pin: '000000' });
    const paired: string[] = [];
    const flow = new PairFlowController(target(server.port), { onPaired: (name) => paired.push(name) });
    for (const digit of '000000') flow.typeDigit(digit);
    await waitFor('the pairing to settle', () => flow.getState().paired || !!flow.getState().problem || !!flow.getState().keyChange);
    return { flow, paired, agentKey };
  }

  it('from the network list, answering with its id: asks to compare key words, saves nothing (the PoC)', async () => {
    const { flow, paired } = await pairByPin((port) => ({ name: 'Meeting room TV', platform: 'linux', hosts: ['127.0.0.1'], port, agentId: 'ada-mac', startedFrom: 'network' }));
    assert.equal(flow.getState().keyChange?.conflict, 'legacy');
    assert.match(flow.getState().keyChange!.message, /Do these words match/);
    assert.deepEqual(useStore.getState().computers, [legacy]);
    assert.equal(useStore.getState().activeId, null);
    assert.deepEqual(paired, []);
  });

  it('from a typed address: asks too', async () => {
    const { flow } = await pairByPin((port) => ({ name: '127.0.0.1', platform: 'linux', hosts: ['127.0.0.1'], port, agentId: 'ada-mac', startedFrom: 'address' }));
    assert.equal(flow.getState().keyChange?.conflict, 'legacy');
    assert.deepEqual(useStore.getState().computers, [legacy]);
  });

  it('from the network list, answering with another id than the list gave: refused in the app’s words', async () => {
    const { flow, paired } = await pairByPin((port) => ({ name: 'Meeting room TV', platform: 'linux', hosts: ['127.0.0.1'], port, agentId: 'meeting-tv', startedFrom: 'network' }));
    assert.equal(flow.getState().problem?.title, "This isn't Meeting room TV.");
    assert.match(flow.getState().problem!.detail!, /not the one you picked/);
    assert.equal(flow.getState().keyChange, null);
    assert.deepEqual(useStore.getState().computers, [legacy]);
    assert.deepEqual(paired, []);
  });

  it('from its own saved entry (Re-pair): takes the key without a question', async () => {
    const { flow, paired } = await pairByPin((port) => ({ ...targetFromComputer(legacy), hosts: ['127.0.0.1'], port }));
    assert.equal(flow.getState().paired, true);
    assert.deepEqual(paired, [NAME]);
    assert.ok(useStore.getState().computers[0]!.linkKey);
  });

  it('a Re-pair answered by another id is refused', async () => {
    const { flow, agentKey } = await pairByPin((port) => ({ ...targetFromComputer(legacy), hosts: ['127.0.0.1'], port }), 'someone-else');
    assert.equal(flow.getState().problem?.title, `Did not pair with ${NAME}.`);
    const detail = flow.getState().problem?.detail ?? '';
    // N4: a guess, not a fact: another computer may have answered. Both computers' key words show,
    // each as two lines of three.
    assert.ok(detail.startsWith(`A computer with a different id answered. If you reset AuthDeck Agent on ${NAME}, forget it and pair it again.`), detail);
    assert.match(detail, new RegExp(`Key words saved for ${NAME}:\\n${NO_SAVED_KEY_WORDS.replace(/[()]/g, '\\$&')}\\n`));
    const answered = detail.split('Key words of the computer that answered:\n')[1]!.split('\n');
    assert.equal(answered.length, 2);
    assert.equal(answered.join(' · '), keyWordsOf(toBase64Url(agentKey.public)));
    assert.deepEqual(useStore.getState().computers, [legacy]);
  });
});

describe('F6: reconnecting checks the id the computer gives', () => {
  it('another id under the pinned key is a failed attempt: never online, nothing saved from it', async () => {
    const key = newLinkKey();
    server = await agentServer('127.0.0.1', 0, { key, info: agentInfo('someone-else', 'Evil Mac') });
    const saved = pairedComputer('ada-mac', server.port, key.public, 'Ada’s MacBook');
    useStore.setState({ computers: [saved], activeId: 'ada-mac' });
    stop = new ConnectionManager(async () => [], async () => null).init();
    await waitFor('an attempt', () => server!.connections() >= 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.notEqual(useLive.getState().status, 'online');
    assert.equal(useLive.getState().agent, null);
    assert.deepEqual(useStore.getState().computers, [saved]);
  });
});

describe('F7: limits on a paired computer', () => {
  it('a burst of apps.changed gets at most one apps.list in flight and one after it', async () => {
    const key = newLinkKey();
    let lists = 0;
    let inFlight = 0;
    let mostInFlight = 0;
    server = await agentServer('127.0.0.1', 0, {
      key,
      info: agentInfo('busy-mac'),
      afterOpen: (peer, channel) => {
        setTimeout(() => {
          for (let i = 0; i < 50; i++) sendSealed(peer, channel, JSON.stringify({ event: 'apps.changed', data: {} }));
        }, 20);
      },
      answerRequest: ({ id, method }, reply) => {
        if (method !== 'apps.list') return;
        lists++;
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        setTimeout(() => {
          inFlight--;
          reply(answer(id, { apps: [] }));
        }, 150);
      },
    });
    useStore.setState({ computers: [pairedComputer('busy-mac', server.port, key.public)], activeId: 'busy-mac', decks: {} });
    stop = new ConnectionManager(async () => [], async () => null).init();
    await waitFor('online', () => useLive.getState().status === 'online');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(mostInFlight, 1);
    assert.ok(lists <= 2, `${lists} apps.list requests`);
  });

  it(`focus redraws at most every ${FOCUS_REDRAW_MS} ms, ending on the newest`, async () => {
    const key = newLinkKey();
    const BURST = 40;
    server = await agentServer('127.0.0.1', 0, {
      key,
      info: agentInfo('focus-mac'),
      answer: (id) => answer(id, { apps: [] }),
      afterOpen: (peer, channel) => {
        setTimeout(() => {
          for (let i = 0; i < BURST; i++) sendSealed(peer, channel, JSON.stringify({ event: 'focus', data: { supported: true, appId: `app-${i}`, name: `App ${i}` } }));
        }, 20);
      },
    });
    useStore.setState({ computers: [pairedComputer('focus-mac', server.port, key.public)], activeId: 'focus-mac', decks: {} });
    let redraws = 0;
    const unsubscribe = useLive.subscribe((s, before) => {
      if (s.focus !== before.focus && s.focus !== null) redraws++;
    });
    try {
      stop = new ConnectionManager(async () => [], async () => null).init();
      await waitFor('the last focus', () => useLive.getState().focus?.appId === `app-${BURST - 1}`);
      await new Promise((r) => setTimeout(r, FOCUS_REDRAW_MS * 2));
      assert.ok(redraws <= 2, `${redraws} redraws for ${BURST} focus events`);
      assert.equal(useLive.getState().focus?.appId, `app-${BURST - 1}`);
    } finally {
      unsubscribe();
    }
  });
});
