/**
 * The app-side findings of link review 5b: M1 (a computer's name and version are capped before
 * they are cleaned), L1 (a forgotten computer's icon cache goes, and a launch sweeps orphans), L2
 * (an icon that begins while the canary mark is being cleared waits for the mark), L3 (icons
 * answered for a computer the app switched away from are dropped) and L4 (icons in memory stay
 * within a budget, least recently used dropped first).
 */
import './native';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ConnectionManager } from '../src/net/connection';
import { iconCacheKey, orphanedIconCacheKeys, sweepOrphanedIconCaches } from '../src/net/iconCacheStorage';
import { IconMemory } from '../src/net/iconMemory';
import { LIMITS, isAgentInfo, isHelloResponse } from '../src/net/messages';
import { MAX_COMPUTER_NAME_CHARS, cleanName } from '../src/net/trust';
import { type AgentInfo, type AppIcon, PROTOCOL_VERSION } from '../src/protocol';
import { ICON_CANARY_KEY, IconCanary, useIconCanary } from '../src/state/iconCanary';
import { useLive } from '../src/state/live';
import type { Computer } from '../src/state/model';
import { useStore } from '../src/state/store';
import { waitFor } from './linkServers';

interface AsyncStorageStub {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
  getAllKeys: () => Promise<readonly string[]>;
  multiRemove: (keys: readonly string[]) => Promise<void>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = require('@react-native-async-storage/async-storage') as AsyncStorageStub;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const agent = (fields: Partial<AgentInfo> = {}): AgentInfo => ({
  agentId: 'ada-mac',
  name: 'Ada’s Mac',
  platform: 'macos',
  version: '0.2.0',
  protocol: PROTOCOL_VERSION,
  ...fields,
});

/** A computer paired before link keys: the connection manager never dials it, so tests drive it. */
const unlinked = (agentId: string): Computer => ({ agentId, name: agentId, platform: 'macos', hosts: [], port: 9, pairedAt: 1 });

describe('M1: the name and version a computer gives are capped before cleaning', () => {
  it('names up to LIMITS.agentName pass; longer ones are refused, in the handshake and in /hello', () => {
    assert.equal(isAgentInfo(agent({ name: 'x'.repeat(LIMITS.agentName) })), true);
    assert.equal(isAgentInfo(agent({ name: 'x'.repeat(LIMITS.agentName + 1) })), false);
    const hello = { ...agent(), app: 'authdeck-agent', port: 7000, fingerprint: 'A'.repeat(22) };
    assert.equal(isHelloResponse(hello), true);
    assert.equal(isHelloResponse({ ...hello, name: 'x'.repeat(LIMITS.agentName + 1) }), false);
  });

  it('the poc-huge-agent-name handshake (a 15 MB name) is refused', () => {
    assert.equal(isAgentInfo(agent({ name: 'a'.repeat(15_000_000) })), false);
    assert.equal(isAgentInfo(agent({ name: '\u{1F600}'.repeat(7_500_000) })), false);
  });

  it('versions are short and look like versions', () => {
    for (const version of ['0.2.0', '1.0.0-beta.1+build.7', '9'.repeat(LIMITS.agentVersion)]) assert.equal(isAgentInfo(agent({ version })), true, version);
    for (const version of ['', '9'.repeat(LIMITS.agentVersion + 1), '1.0 ', '1.0\n', 'v1/2', '‮1.0']) {
      assert.equal(isAgentInfo(agent({ version })), false, JSON.stringify(version));
    }
  });

  it('/hello fingerprints are a link fingerprint or absent', () => {
    const hello = { ...agent(), app: 'authdeck-agent', port: 7000 };
    assert.equal(isHelloResponse(hello), true);
    assert.equal(isHelloResponse({ ...hello, fingerprint: 'A'.repeat(22) }), true);
    assert.equal(isHelloResponse({ ...hello, fingerprint: 'A'.repeat(23) }), false);
    assert.equal(isHelloResponse({ ...hello, fingerprint: 'x'.repeat(1_000_000) }), false);
  });

  it('cleanName reads a bounded start of a huge name, quickly', () => {
    const started = performance.now();
    assert.equal(cleanName('a'.repeat(15_000_000)), 'a'.repeat(MAX_COMPUTER_NAME_CHARS));
    assert.equal(cleanName('\u{1F600}'.repeat(7_500_000)), '\u{1F600}'.repeat(MAX_COMPUTER_NAME_CHARS));
    assert.ok(performance.now() - started < 500, `took ${performance.now() - started} ms`);
  });

  it('cleanName keeps names that fit, and never cuts a character in half', () => {
    assert.equal(cleanName('  Ada’s​  Mac\t'), 'Ada’s Mac');
    // Invisible padding past the bound is dropped with the rest; what is kept is whole characters.
    const padded = cleanName('​'.repeat(255) + '\u{1F600}' + 'Mac');
    assert.equal(padded, '');
    const pairAtEdge = cleanName(' '.repeat(255) + '\u{1F600}');
    assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])/.test(pairAtEdge), false);
  });
});

describe('L1: icon caches of forgotten computers', () => {
  beforeEach(() => {
    useLive.setState({ icons: {} });
  });

  it('Forget deletes the computer’s icon cache (poc-icon-cache-orphans: nothing left behind)', async () => {
    useStore.setState({ computers: [unlinked('hostile-0'), unlinked('kept')], activeId: 'kept', decks: {} });
    await storage.setItem(iconCacheKey('hostile-0'), '{"a":null}');
    await storage.setItem(iconCacheKey('kept'), '{"b":null}');
    const manager = new ConnectionManager(async () => [], async () => null);
    const stop = manager.init();
    try {
      await manager.forgetComputer('hostile-0');
      assert.deepEqual(
        useStore.getState().computers.map((c) => c.agentId),
        ['kept'],
      );
      assert.equal(await storage.getItem(iconCacheKey('hostile-0')), null);
      assert.equal(await storage.getItem(iconCacheKey('kept')), '{"b":null}');
    } finally {
      stop();
    }
  });

  it('Forget on the active computer also clears its canary mark and moves on', async () => {
    useStore.setState({ computers: [unlinked('crashy'), unlinked('other')], activeId: 'crashy', decks: {} });
    useIconCanary.setState({ checked: true, hidden: ['crashy'], armed: [] }, true);
    await storage.setItem(iconCacheKey('crashy'), '{}');
    const manager = new ConnectionManager(async () => [], async () => null);
    const stop = manager.init();
    try {
      await manager.forgetComputer('crashy');
      assert.equal(useStore.getState().activeId, 'other');
      assert.equal(await storage.getItem(iconCacheKey('crashy')), null);
      assert.deepEqual(useIconCanary.getState().hidden, []);
    } finally {
      stop();
    }
  });

  it('orphans are icon caches of computers not saved, and every DevDeck 0.1.0 one; nothing else', () => {
    const keys = [
      'authdeck-icons-v1:kept',
      'authdeck-icons-v1:gone',
      'devdeck-icons-v1:kept',
      'devdeck-icons-v1:old',
      'authdeck-v1',
      'authdeck-icon-canary-v1',
      'authdeck-vault-logs:abc',
      'devdeck-v1',
      'authdeck-icons-v2:gone',
    ];
    assert.deepEqual(orphanedIconCacheKeys(keys, new Set(['kept'])), ['authdeck-icons-v1:gone', 'devdeck-icons-v1:kept', 'devdeck-icons-v1:old']);
  });

  it('the launch sweep removes orphans from storage and leaves the vault’s and other keys alone', async () => {
    const others = { 'authdeck-vault-test:x': 'vault', 'authdeck-v1': 'state', [ICON_CANARY_KEY]: '[]' };
    for (const [key, value] of Object.entries(others)) await storage.setItem(key, value);
    for (let n = 0; n < 6; n++) await storage.setItem(iconCacheKey(`hostile-${n}`), 'x'.repeat(1000));
    await storage.setItem('devdeck-icons-v1:legacy', '{}');
    await storage.setItem(iconCacheKey('saved'), '{}');
    const removed = await sweepOrphanedIconCaches(() => new Set(['saved']), storage);
    // Earlier tests in this file leave caches of their own computers in the shared stub too.
    for (let n = 0; n < 6; n++) assert.ok(removed.includes(iconCacheKey(`hostile-${n}`)));
    assert.ok(removed.includes('devdeck-icons-v1:legacy'));
    const left = await storage.getAllKeys();
    assert.equal(left.some((key) => key.startsWith('devdeck-icons-v1:') || /hostile/.test(key)), false);
    assert.equal(await storage.getItem(iconCacheKey('saved')), '{}');
    for (const [key, value] of Object.entries(others)) assert.equal(await storage.getItem(key), value);
  });
});

describe('L2: an icon that begins while the mark is being cleared', () => {
  it('poc-canary-settle-race: the icon may not draw until the mark names its computer again', async () => {
    const disk = new Map<string, string>();
    const slow = {
      getItem: async (key: string) => (await sleep(40), disk.get(key) ?? null),
      setItem: async (key: string, value: string) => {
        await sleep(40);
        disk.set(key, value);
      },
      removeItem: async (key: string) => {
        await sleep(40);
        disk.delete(key);
      },
    };
    useIconCanary.setState({ checked: false, hidden: [], armed: [] }, true);
    const canary = new IconCanary(slow, 100, 10_000);
    const A = 'hostile-mac';
    const mayDraw = (icon: object) => {
      const s = useIconCanary.getState();
      return s.checked && !s.hidden.includes(A) && (canary.hasDrawn(icon) || s.armed.includes(A));
    };
    await canary.check();
    const benign = {};
    const bomb = {};
    canary.begin(A, benign);
    await waitFor('the first mark', () => mayDraw(benign));
    canary.finish(benign);
    await sleep(105); // the settle write is now removing the mark
    canary.begin(A, bomb);
    assert.equal(mayDraw(bomb), false, 'not on the arming the removal is undoing');
    // Native decoding starts when the Image mounts and is not stopped by unmounting it, so once
    // the icon may draw, the mark must stay on disk from then on.
    let mounted = false;
    let msWithoutMark = 0;
    for (let t = 0; t < 200; t++) {
      mounted ||= mayDraw(bomb);
      if (mounted && !disk.has(ICON_CANARY_KEY)) msWithoutMark++;
      await sleep(1);
    }
    assert.equal(msWithoutMark, 0);
    assert.equal(mayDraw(bomb), true, 'it draws once the mark is saved again');
    assert.deepEqual(JSON.parse(disk.get(ICON_CANARY_KEY)!), [A]);
  });
});

/** Stands in for an open session whose apps.icons answers the test releases. */
class HeldSession {
  readonly isOpen = true;
  readonly asked: string[][] = [];
  private readonly waiting: { ids: string[]; answer: (result: { icons: Record<string, AppIcon | null> }) => void }[] = [];

  request(method: string, params: { ids: string[] }): Promise<{ icons: Record<string, AppIcon | null> }> {
    assert.equal(method, 'apps.icons');
    this.asked.push(params.ids);
    return new Promise((answer) => this.waiting.push({ ids: params.ids, answer }));
  }

  /** Answers the oldest request with `icon` for each id it asked. */
  answerNext(icon: (id: string) => AppIcon | null): void {
    const next = this.waiting.shift()!;
    next.answer({ icons: Object.fromEntries(next.ids.map((id) => [id, icon(id)])) });
  }

  close(): void {}
}

const iconOf = (chars: number): AppIcon => ({ mime: 'image/png', data: 'A'.repeat(chars) });

/** A manager on `active`, with a session the test answers by hand. */
function managerWithSession(computers: Computer[], active: string): { manager: ConnectionManager; session: HeldSession; stop: () => void } {
  useStore.setState({ computers, activeId: active, decks: {} });
  const manager = new ConnectionManager(async () => [], async () => null);
  const stop = manager.init();
  const session = new HeldSession();
  Reflect.set(manager, 'session', session);
  return { manager, session, stop };
}

describe('L3: icons answered after a switch to another computer', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  it('a late reply from the computer switched away from is not drawn for the new one', async () => {
    const held = managerWithSession([unlinked('first'), unlinked('second')], 'first');
    stop = held.stop;
    const loading = held.manager.loadIcons(['com.shared']);
    useStore.getState().setActive('second');
    held.session.answerNext(() => iconOf(100));
    await loading;
    assert.equal(Object.prototype.hasOwnProperty.call(useLive.getState().icons, 'com.shared'), false);
  });

  it('later batches are not asked of the session after a switch', async () => {
    const held = managerWithSession([unlinked('first'), unlinked('second')], 'first');
    stop = held.stop;
    const ids = Array.from({ length: LIMITS.iconsPerReply + 5 }, (_, i) => `app${i}`);
    const loading = held.manager.loadIcons(ids);
    useStore.getState().setActive('second');
    held.session.answerNext(() => null);
    await loading;
    assert.equal(held.session.asked.length, 1);
  });

  it('the icon cache save of the computer switched away from never writes over another computer’s cache', async () => {
    await storage.setItem(iconCacheKey('second'), '{"kept":null}');
    const held = managerWithSession([unlinked('first'), unlinked('second')], 'first');
    stop = held.stop;
    const loading = held.manager.loadIcons(['com.first']);
    held.session.answerNext(() => iconOf(100));
    await loading;
    useStore.getState().setActive('second');
    await sleep(1700); // past the 1.5 s save delay
    assert.equal(await storage.getItem(iconCacheKey('second')), '{"kept":null}');
    assert.equal(await storage.getItem(iconCacheKey('first')), null);
  });
});

describe('L4: icons in memory stay within a budget', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  it('past the budget, the least recently used icons not on screen are dropped', () => {
    const memory = new IconMemory(1000);
    const icons: Record<string, AppIcon | null> = {};
    const add = (id: string) => {
      icons[id] = iconOf(300 - 'image/png'.length);
      for (const gone of memory.evictions(icons, [id])) delete icons[gone];
    };
    const releaseB = memory.hold('b');
    add('a');
    add('b');
    add('c');
    add('d'); // 1200 chars: 'a' is oldest
    assert.deepEqual(Object.keys(icons), ['b', 'c', 'd']);
    add('e'); // 'b' is older than 'c' but on screen, so 'c' goes
    assert.deepEqual(Object.keys(icons), ['b', 'd', 'e']);
    releaseB();
    add('f'); // released just now: 'd' is now the oldest
    assert.deepEqual(Object.keys(icons), ['b', 'e', 'f']);
  });

  it('icons on screen are kept even past the budget, so they never drop and reload in a loop', () => {
    const memory = new IconMemory(100);
    const releases = ['a', 'b'].map((id) => memory.hold(id));
    const icons = { a: iconOf(200), b: iconOf(200), none: null };
    assert.deepEqual(memory.evictions(icons, ['a', 'b', 'none']), []);
    releases.forEach((release) => release());
    assert.deepEqual(memory.evictions(icons, []), ['a', 'b']);
  });

  it('the live map is capped, and a dropped icon is asked for again once, however often it is drawn', async () => {
    const held = managerWithSession([unlinked('big')], 'big');
    stop = held.stop;
    const perIcon = 256 * 1024;
    const ids = Array.from({ length: LIMITS.iconsPerReply }, (_, i) => `app${i}`);
    const loading = held.manager.loadIcons(ids);
    held.session.answerNext(() => iconOf(perIcon));
    await loading;
    const live = useLive.getState().icons;
    const chars = Object.values(live).reduce((n, icon) => n + (icon?.data.length ?? 0), 0);
    assert.ok(chars <= 8_000_000, `${chars} chars in memory`);
    assert.equal(Object.prototype.hasOwnProperty.call(live, 'app0'), false, 'the oldest went first');
    assert.equal(Object.prototype.hasOwnProperty.call(live, `app${LIMITS.iconsPerReply - 1}`), true);

    // The picker scrolls back to app0: every tile render asks, one request goes out.
    const release = held.manager.holdIcon('app0');
    const asks = [held.manager.loadIcons(['app0']), held.manager.loadIcons(['app0']), held.manager.loadIcons(['app0'])];
    assert.equal(held.session.asked.length, 2);
    assert.deepEqual(held.session.asked[1], ['app0']);
    held.session.answerNext(() => iconOf(perIcon));
    await Promise.all(asks);
    assert.equal(Object.prototype.hasOwnProperty.call(useLive.getState().icons, 'app0'), true, 'held while shown');
    release();
  });
});
