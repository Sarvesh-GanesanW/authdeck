/**
 * The app-side findings of link review 5: N1 (icons are checked PNGs, and a crash canary hides a
 * computer's icons after AuthDeck closed while drawing them), N2 (caps on what a computer sends,
 * the saved state's budget, and a load that always finishes), N4 (the reset refusal), N5 (names
 * that start alike, punctuation), N6 (link hosts and cancelling a PIN sweep) and the key words.
 * N8 (a capped /hello) is in discovery.test.ts.
 */
import { Platform } from './native';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storageModule = require('@react-native-async-storage/async-storage') as AsyncStorageStub & { default: AsyncStorageStub };
import { PairingCancelled, pairWithPin } from '../src/net/client';
import { ConnectionManager, MAX_ICON_CACHE_CHARS, withinIconBudget } from '../src/net/connection';
import { drawableIcon } from '../src/net/iconData';
import { keyWordLines, keyWordsOf } from '../src/net/linkState';
import { LIMITS, isAppIcon, isMethodResult, isProtocolError } from '../src/net/messages';
import { MAX_ICON_BYTES, isIconSizedPng } from '../src/net/pngIcon';
import { checkedDecks, checkedIconCache } from '../src/net/storedData';
import { acceptedIdentity, couldPassFor, decidePairing, isSameComputerName, nameSkeleton } from '../src/net/trust';
import { PairFlowController } from '../src/screens/pair/pairFlow';
import type { PairResult, PairTarget } from '../src/screens/pair/pairing';
import { ICON_CANARY_KEY, IconCanary, useIconCanary } from '../src/state/iconCanary';
import { useLive } from '../src/state/live';
import type { Computer, Deck } from '../src/state/model';
import { MAX_SAVED_STATE_BYTES, SAVED_STATE_KEY, launchScreen, savedStateStorage, useSavedStateLoad, utf8Length } from '../src/state/savedStorage';
import { resetSavedDecksAndComputers, retryLoad, useStore } from '../src/state/store';
import { starterDeck } from '../src/state/templates';
import { toBase64Url } from '../src/vault/bytes';
import { type TestServer, listen, newLinkKey, waitFor } from './linkServers';
import { pngBase64 } from './pngFixture';

interface AsyncStorageStub {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}
const storage = storageModule;
/** Waits until AsyncStorage no longer holds `key`. */
async function untilRemoved(key: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await storage.getItem(key)) === null) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`${key} was never removed`);
}

/** Makes AsyncStorage.getItem fail for one key, as Android does for a row over 2 MB. */
function failReads(key: string, error: Error): () => void {
  const targets = [storageModule, storageModule.default];
  const originals = targets.map((target) => target.getItem);
  targets.forEach((target, i) => {
    target.getItem = (asked: string) => (asked === key ? Promise.reject(error) : originals[i]!(asked));
  });
  return () => targets.forEach((target, i) => (target.getItem = originals[i]!));
}

const svg = (markup: string) => ({ mime: 'image/svg+xml', data: Buffer.from(markup).toString('base64') });
const png = (width: number, height: number) => ({ mime: 'image/png', data: pngBase64(width, height) });

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

describe('N1: computer icons are checked PNGs', () => {
  // The PoC's two SVGs: a <use> that contains itself, and 10^10 uses without a cycle.
  const loops = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="a"><rect width="1" height="1"/><use href="#a"/></g></svg>');
  let tree = '<svg xmlns="http://www.w3.org/2000/svg"><defs><rect id="l0" width="1" height="1"/>';
  for (let i = 1; i <= 10; i++) tree += `<g id="l${i}">${'<use href="#l' + (i - 1) + '"/>'.repeat(10)}</g>`;
  const laughs = svg(`${tree}</defs><use href="#l10"/></svg>`);

  it('refuses every SVG: in apps.icons, when drawn, and in the reloaded cache', () => {
    for (const icon of [loops, laughs, svg('<svg xmlns="http://www.w3.org/2000/svg"/>')]) {
      assert.equal(isMethodResult('apps.icons', { icons: { 'org.gnome.Terminal': icon } }), false);
      assert.equal(drawableIcon(icon), null);
      assert.deepEqual(checkedIconCache({ 'org.gnome.Terminal': icon }), {});
    }
  });

  it('refuses a PNG whose IHDR declares more than 256 pixels a side (the 48 KB, 20000 x 20000 bomb)', () => {
    for (const [width, height] of [
      [20000, 20000],
      [257, 1],
      [1, 257],
      [0, 16],
    ] as const) {
      const icon = png(width, height);
      assert.equal(isMethodResult('apps.icons', { icons: { 'com.apple.Terminal': icon } }), false, `${width} x ${height}`);
      assert.equal(drawableIcon(icon), null);
      assert.deepEqual(checkedIconCache({ 'com.apple.Terminal': icon }), {});
    }
  });

  it('refuses a file that is not a PNG, a PNG not starting with IHDR, and one over 256 KB', () => {
    const real = Buffer.from(pngBase64(16, 16), 'base64');
    const notIhdr = Buffer.from(real);
    notIhdr.write('IDAT', 12, 'latin1');
    const gif = Buffer.concat([Buffer.from('GIF89a'), real.subarray(6)]);
    const padded = Buffer.concat([real, Buffer.alloc(MAX_ICON_BYTES)]);
    for (const bytes of [notIhdr, gif, padded, real.subarray(0, 20)]) {
      assert.equal(isAppIcon({ mime: 'image/png', data: bytes.toString('base64') }), false);
    }
  });

  it('accepts PNGs up to 256 x 256, the agent’s 128 px icons among them', () => {
    for (const side of [1, 16, 128, 256]) {
      assert.equal(isIconSizedPng(pngBase64(side, side)), true);
      assert.equal(isMethodResult('apps.icons', { icons: { a: png(side, side), b: null } }), true);
    }
  });
});

describe('N1: the crash canary', () => {
  const memory = new Map<string, string>();
  const markStore = {
    getItem: async (key: string) => memory.get(key) ?? null,
    setItem: async (key: string, value: string) => void memory.set(key, value),
    removeItem: async (key: string) => void memory.delete(key),
  };
  const SETTLE = 20;
  /** A new launch: the in-memory state starts over, the saved mark stays. */
  const launch = () => {
    useIconCanary.setState({ checked: false, hidden: [], armed: [] }, true);
    return new IconCanary(markStore, SETTLE, 5000);
  };
  beforeEach(() => memory.clear());

  it('saves a mark naming the computer before its first icon may draw, and clears it once the icons drew', async () => {
    const canary = launch();
    assert.deepEqual(await canary.check(), []);
    const icon = {};
    canary.begin('ada-mac', icon);
    await waitFor('the mark', () => useIconCanary.getState().armed.includes('ada-mac'));
    assert.equal(memory.get(ICON_CANARY_KEY), '["ada-mac"]');
    canary.finish(icon);
    await waitFor('the mark to clear', () => useIconCanary.getState().armed.length === 0);
    assert.equal(memory.has(ICON_CANARY_KEY), false);
    // Drawn once in this launch: it draws again without a new mark.
    assert.equal(canary.hasDrawn(icon), true);
  });

  it('a launch that finds the mark still set hides that computer’s icons until they are cleared', async () => {
    const first = launch();
    await first.check();
    first.begin('ada-mac', {});
    await waitFor('the mark', () => memory.has(ICON_CANARY_KEY));
    // AuthDeck closes here, while the icon is drawing.

    const second = launch();
    assert.deepEqual(await second.check(), ['ada-mac']);
    assert.deepEqual(useIconCanary.getState().hidden, ['ada-mac']);
    // Another computer's icons still draw, and their mark keeps the hidden one.
    const other = {};
    second.begin('build-box', other);
    await waitFor('the mark', () => useIconCanary.getState().armed.includes('build-box'));
    second.finish(other);
    await waitFor('the settle', () => useIconCanary.getState().armed.length === 0);
    assert.equal(memory.get(ICON_CANARY_KEY), '["ada-mac"]');

    const third = launch();
    assert.deepEqual(await third.check(), ['ada-mac'], 'still hidden on the next launch');
    await third.clear('ada-mac');
    assert.deepEqual(useIconCanary.getState().hidden, []);
    assert.equal(memory.has(ICON_CANARY_KEY), false);
  });

  it('an icon that leaves the screen before it draws still lets the mark clear', async () => {
    const canary = launch();
    await canary.check();
    const icon = {};
    canary.begin('ada-mac', icon);
    await waitFor('the mark', () => memory.has(ICON_CANARY_KEY));
    canary.abandon(icon);
    await waitFor('the mark to clear', () => !memory.has(ICON_CANARY_KEY));
    assert.equal(canary.hasDrawn(icon), false);
  });

  it('"Clear this computer’s icons" clears the cached icons and the mark', async () => {
    await storage.setItem('authdeck-icons-v1:clear-mac', JSON.stringify({ 'com.good': png(16, 16) }));
    await storage.setItem(ICON_CANARY_KEY, '["clear-mac"]');
    useIconCanary.setState({ checked: true, hidden: ['clear-mac'], armed: [] }, true);
    const key = newLinkKey();
    useStore.setState({
      computers: [{ agentId: 'clear-mac', name: 'Mac', platform: 'macos', hosts: [], port: 9, linkKey: toBase64Url(key.public), pairedAt: 1 }],
      activeId: 'clear-mac',
      decks: {},
    });
    const manager = new ConnectionManager(async () => [], async () => null);
    stop = manager.init();
    await waitFor('the cached icons', () => 'com.good' in useLive.getState().icons);
    await manager.clearIcons('clear-mac');
    assert.equal(await storage.getItem('authdeck-icons-v1:clear-mac'), null);
    assert.equal(await storage.getItem(ICON_CANARY_KEY), null);
    assert.deepEqual(useLive.getState().icons, {});
    assert.deepEqual(useIconCanary.getState().hidden, []);
  });
});

describe('N2: limits on what a computer sends', () => {
  const hostileId = 'x'.repeat(120 * 1024);
  const hostileList = { apps: [{ id: hostileId, name: 'Visual Studio Code', hasIcon: false }] };

  it('the store-bloat PoC: the 120 KB app id is refused, and the starter deck never copies it', () => {
    assert.equal(isMethodResult('apps.list', hostileList), false);
    const deck = starterDeck('macos', hostileList.apps);
    assert.equal(JSON.stringify(deck).includes(hostileId), false);
  });

  it('a saved deck that already holds an over-long id keeps its other keys and drops those, staying under budget', () => {
    const bloated = starterDeck('macos', [{ id: 'mac:/Applications/Visual Studio Code.app', name: 'Visual Studio Code', hasIcon: true }]);
    const swap = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value).split('mac:/Applications/Visual Studio Code.app').join(hostileId));
    const saved = swap(bloated) as Deck;
    assert.ok(utf8Length(JSON.stringify(saved)) > 2 * 1024 * 1024, 'the PoC state is over 2 MB');
    const checked = checkedDecks({ evil: saved });
    const size = utf8Length(JSON.stringify(checked));
    assert.ok(size < MAX_SAVED_STATE_BYTES / 10, `checked deck is ${size} bytes`);
    assert.equal(checked.evil!.pages.length, 4);
    assert.ok(checked.evil!.pages[1]!.slots.some((slot) => slot?.label === 'Pull'), 'keys without app ids stay');
    assert.equal(checked.evil!.pages[0]!.focusApp, null);
  });

  it('counts are capped: apps, folder entries, and icons per reply', () => {
    const apps = (n: number) => ({ apps: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: 'A', hasIcon: false })) });
    assert.equal(isMethodResult('apps.list', apps(LIMITS.apps)), true);
    assert.equal(isMethodResult('apps.list', apps(LIMITS.apps + 1)), false);
    const fs = (n: number) => ({
      path: '/h',
      parent: '/',
      home: '/h',
      sep: '/',
      roots: [],
      entries: Array.from({ length: n }, () => ({ name: 'a', path: '/h/a', kind: 'file' })),
    });
    assert.equal(isMethodResult('fs.list', fs(LIMITS.fsEntries)), true);
    assert.equal(isMethodResult('fs.list', fs(LIMITS.fsEntries + 1)), false);
    const icons = (n: number) => ({ icons: Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, null])) });
    assert.equal(isMethodResult('apps.icons', icons(LIMITS.iconsPerReply)), true);
    assert.equal(isMethodResult('apps.icons', icons(LIMITS.iconsPerReply + 1)), false);
  });

  it('error text is bounded', () => {
    assert.equal(isProtocolError({ code: 'failed', message: 'x'.repeat(LIMITS.errorText) }), true);
    assert.equal(isProtocolError({ code: 'failed', message: 'x'.repeat(LIMITS.errorText + 1) }), false);
    assert.equal(isProtocolError({ code: 'failed', message: 'x', hint: 'x'.repeat(LIMITS.errorText + 1) }), false);
    assert.equal(isProtocolError({ code: 'x'.repeat(LIMITS.errorCode + 1), message: 'x' }), false);
  });

  it('each computer’s saved icons stay within MAX_ICON_CACHE_CHARS, in deck order', () => {
    const big = { mime: 'image/png' as const, data: 'A'.repeat(300_000) };
    const icons = { a: big, b: big, c: big, d: big, e: null };
    const kept = withinIconBudget(['a', 'b', 'c', 'd', 'e'], icons);
    assert.deepEqual(Object.keys(kept), ['a', 'b', 'c']);
    assert.ok(JSON.stringify(kept).length <= MAX_ICON_CACHE_CHARS);
    assert.deepEqual(Object.keys(withinIconBudget(['__proto__'], JSON.parse(`{"__proto__": ${JSON.stringify(big)}}`))), ['__proto__']);
  });

  it('an icon cache saved past the budget is dropped on load, not drawn', async () => {
    await storage.setItem('authdeck-icons-v1:fat-mac', JSON.stringify({ 'com.good': png(16, 16), pad: 'x'.repeat(MAX_ICON_CACHE_CHARS) }));
    const key = newLinkKey();
    useStore.setState({
      computers: [{ agentId: 'fat-mac', name: 'Mac', platform: 'macos', hosts: [], port: 9, linkKey: toBase64Url(key.public), pairedAt: 1 }],
      activeId: 'fat-mac',
      decks: {},
    });
    stop = new ConnectionManager(async () => [], async () => null).init();
    await untilRemoved('authdeck-icons-v1:fat-mac');
    assert.deepEqual(useLive.getState().icons, {});
  });
});

describe('N2: the saved state', () => {
  it('a write past MAX_SAVED_STATE_BYTES is skipped and reported once; the last good save stays', async () => {
    const problems: string[] = [];
    const saved = savedStateStorage<{ blob: string }>((problem) => problems.push(problem));
    await saved.setItem('budget-test', { state: { blob: 'small' }, version: 1 });
    await saved.setItem('budget-test', { state: { blob: 'x'.repeat(MAX_SAVED_STATE_BYTES) }, version: 1 });
    await saved.setItem('budget-test', { state: { blob: 'é'.repeat(MAX_SAVED_STATE_BYTES / 2) }, version: 1 });
    assert.deepEqual(problems, ['too-large']);
    assert.equal(await storage.getItem('budget-test'), JSON.stringify({ state: { blob: 'small' }, version: 1 }));
  });

  it('counts UTF-8 bytes, as the platform stores them', () => {
    assert.equal(utf8Length('abc'), 3);
    assert.equal(utf8Length('é'), 2);
    assert.equal(utf8Length('’'), 3);
    assert.equal(utf8Length('😀'), 4);
  });

  it('a read that fails ("Row too big") ends on the recovery screen, never the splash, and writes nothing', async () => {
    const before = JSON.stringify({ state: { deviceId: 'd-kept', computers: [], decks: {} }, version: 3 });
    await storage.setItem(SAVED_STATE_KEY, before);
    const restore = failReads(SAVED_STATE_KEY, new Error("Couldn't read row 0, col 0 from CursorWindow: Row too big to fit into CursorWindow"));
    try {
      await retryLoad();
      assert.deepEqual(useSavedStateLoad.getState(), { status: 'failed', tooLarge: true });
      assert.equal(launchScreen(true, useSavedStateLoad.getState()), 'recovery');
      // Anything set while the recovery screen shows must not replace what could not be read.
      useStore.getState().setSettings({ haptics: false });
      await new Promise((done) => setTimeout(done, 10));
    } finally {
      restore();
    }
    assert.equal(await storage.getItem(SAVED_STATE_KEY), before, 'the saved value is untouched');
  });

  it('saved state that is not JSON also reaches the recovery screen', async () => {
    await storage.setItem(SAVED_STATE_KEY, '{"state": {"computers": [');
    await retryLoad();
    assert.deepEqual(useSavedStateLoad.getState(), { status: 'failed', tooLarge: false });
    assert.equal(launchScreen(true, useSavedStateLoad.getState()), 'recovery');
  });

  it('"Reset decks and computers" deletes only the main key and opens the app', async () => {
    await storage.setItem(SAVED_STATE_KEY, 'not json');
    await storage.setItem('authdeck-vault-test', 'vault stays');
    await retryLoad();
    assert.equal(useSavedStateLoad.getState().status, 'failed');
    await resetSavedDecksAndComputers();
    assert.deepEqual(useSavedStateLoad.getState(), { status: 'loaded' });
    assert.equal(launchScreen(true, useSavedStateLoad.getState()), 'app');
    assert.equal(await storage.getItem('authdeck-vault-test'), 'vault stays');
    assert.notEqual(await storage.getItem(SAVED_STATE_KEY), 'not json');
    // Writing works again once the person chose to reset.
    useStore.getState().setSettings({ keySounds: false });
    await new Promise((done) => setTimeout(done, 10));
    assert.match((await storage.getItem(SAVED_STATE_KEY)) ?? '', /"keySounds":false/);
  });

  it('the splash shows only while fonts or the saved state are still loading', () => {
    assert.equal(launchScreen(false, { status: 'loaded' }), 'splash');
    assert.equal(launchScreen(true, { status: 'loading' }), 'splash');
    assert.equal(launchScreen(true, { status: 'loaded' }), 'app');
  });
});

describe('N5: names that start alike, and punctuation', () => {
  const K = toBase64Url(newLinkKey().public);
  const real: Computer = { agentId: 'ada-mac', name: 'Ada’s MacBook Pro, studio desk by the window', platform: 'macos', hosts: ['192.168.1.5'], port: 47474, linkKey: K, pairedAt: 1 };
  const tv: Computer = { agentId: 'tv', name: 'Meeting room TV', platform: 'linux', hosts: ['192.168.1.66'], port: 47474, linkKey: K, pairedAt: 2 };

  it('a rename on connect that starts like another saved computer’s name is not kept (the PoC)', () => {
    const renamed = 'Ada’s MacBook Pro, studio desk by the window (old drive, spare)';
    assert.deepEqual(acceptedIdentity(tv, { name: renamed, platform: 'macos' }, [real, tv]), { name: 'Meeting room TV', platform: 'linux' });
    // Either way round: a shorter name that the saved one starts with.
    assert.deepEqual(acceptedIdentity(tv, { name: 'Ada’s MacBook', platform: 'macos' }, [real, tv]).name, 'Meeting room TV');
    assert.deepEqual(acceptedIdentity(tv, { name: 'Living room TV', platform: 'linux' }, [real, tv]).name, 'Living room TV');
  });

  it('pairing a new computer whose name starts like a saved one asks first', () => {
    const decision = decidePairing(
      { route: 'qr', startedFrom: 'qr', named: 'Ada’s MacBook Pro (spare)', expectedAgentId: null, agentId: 'new', agentName: 'Ada’s MacBook Pro (spare)', linkKey: K },
      [{ ...real, name: 'Ada’s MacBook Pro' }],
    );
    assert.equal(decision.kind, 'ask');
  });

  it('punctuation does not count: "Adas" and "Ada’s" read alike', () => {
    assert.equal(isSameComputerName('Adas MacBook', 'Ada’s MacBook'), true);
    assert.equal(isSameComputerName('Adas MacBook', "Ada's MacBook"), true);
    assert.equal(isSameComputerName('Ada-s Mac.Book!', 'Adas MacBook'), true);
    assert.equal(nameSkeleton('Ada’s «Mac»'), nameSkeleton('Adas Mac'));
    assert.equal(isSameComputerName('Book', 'Boot'), false);
  });

  it('an empty skeleton is no prefix of every name', () => {
    assert.equal(couldPassFor('!!!', 'Meeting room TV'), false);
    assert.equal(couldPassFor('Meeting room', 'Meeting room TV'), true);
  });
});

describe('N6: cancelling a PIN pairing stops the address sweep', () => {
  it('no address is tried once the person has left', async () => {
    let answered = 0;
    server = await listen('127.0.0.1', 0, () => answered++);
    const cancelled = new AbortController();
    cancelled.abort();
    const device = newLinkKey();
    await assert.rejects(
      pairWithPin(['127.0.0.1'], server.port, '000000', device, { deviceId: 'd', deviceName: 'Phone' }, cancelled.signal),
      PairingCancelled,
    );
    assert.equal(server.connections(), 0);
    assert.equal(answered, 0);
  });

  it('a cancel mid-sweep stops before the next address', async () => {
    const sweep = new AbortController();
    server = await listen('127.0.0.1', 0, (peer) => {
      sweep.abort(); // The person backs out while the first address answers.
      peer.send(JSON.stringify({ ok: false, error: { code: 'failed', message: 'Not here.' } }));
    });
    await assert.rejects(
      pairWithPin(['127.0.0.1', '127.0.0.1', '127.0.0.1'], server.port, '000000', newLinkKey(), { deviceId: 'd', deviceName: 'Phone' }, sweep.signal),
      PairingCancelled,
    );
    assert.equal(server.connections(), 1);
  });

  it('the pairing flow aborts its sweep when the person picks another computer or goes back', async () => {
    const signals: AbortSignal[] = [];
    const target: PairTarget = { name: 'Mac', platform: 'macos', hosts: ['192.168.1.5'], port: 47474, agentId: 'mac', startedFrom: 'network' };
    const flow = new PairFlowController(target, {
      onPaired: () => undefined,
      pairByPin: (_target, _pin, signal) => {
        signals.push(signal!);
        return new Promise<PairResult>(() => undefined);
      },
    });
    for (const digit of '123456') flow.typeDigit(digit);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.aborted, false);
    flow.choose(null);
    assert.equal(signals[0]!.aborted, true);
    flow.choose(target);
    for (const digit of '123456') flow.typeDigit(digit);
    flow.leave();
    assert.equal(signals[1]!.aborted, true);
  });
});

describe('key words', () => {
  it('always two lines of three, every word kept', () => {
    const words = keyWordsOf(toBase64Url(newLinkKey().public));
    const lines = keyWordLines(words);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => line.split(' · ').length), [3, 3]);
    assert.equal(lines.join(' · '), words);
  });
});
