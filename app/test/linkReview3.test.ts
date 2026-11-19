/**
 * The app-side proofs of concept from link review 3, run as regression tests against real agents
 * on loopback: N4 (a malformed result), N2 (a computer saved before link keys), N3 (invisible and
 * look-alike names) and N5 (a paired computer renaming itself to another's name).
 */
import { Platform } from './native';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ConnectionManager } from '../src/net/connection';
import { parsePairLink } from '../src/net/discovery';
import { linkStanding } from '../src/screens/pair/pairing';
import { PairFlowController } from '../src/screens/pair/pairFlow';
import { useLive } from '../src/state/live';
import type { Computer, DeckKey, Page } from '../src/state/model';
import { useStore } from '../src/state/store';
import { toBase64Url } from '../src/vault/bytes';
import { type TestServer, agentInfo, agentServer, newLinkKey, waitFor } from './linkServers';

const SAVED_NAME = 'Ada’s MacBook';
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAA';
const pairUrl = (name: string, port: number, key: Uint8Array) =>
  `authdeck://pair?v=2&n=${encodeURIComponent(name)}&p=${port}&h=127.0.0.1&k=${toBase64Url(key)}&s=${SECRET}`;

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

/** Confirms a link and waits for the flow to settle. */
async function pairByLink(url: string) {
  const paired: string[] = [];
  const flow = new PairFlowController(null, { onPaired: (name) => paired.push(name) });
  flow.offerLink(parsePairLink(url)!);
  flow.confirmLink();
  await waitFor('the pairing to settle', () => flow.getState().paired || !!flow.getState().problem || !!flow.getState().keyChange);
  return { flow, paired };
}

describe('N4: a paired computer sending malformed results', () => {
  it('run {note:{x:1}} and apps.list {apps:{}} fail their requests; no object reaches the toast or the app list', async () => {
    const key = newLinkKey();
    server = await agentServer('127.0.0.1', 0, {
      key,
      info: agentInfo('paired-mac', 'Mac'),
      answer: (id) => JSON.stringify({ id, ok: true, result: { apps: {}, durationMs: 1, note: { x: 1 } } }),
    });
    useStore.setState({
      computers: [{ agentId: 'paired-mac', name: 'Mac', platform: 'macos', hosts: ['127.0.0.1'], port: server.port, linkKey: toBase64Url(key.public), pairedAt: 1 }],
      activeId: 'paired-mac',
    });
    useLive.setState({ toast: null, apps: null, appsError: null });
    const manager = new ConnectionManager(async () => [], async () => null);
    stop = manager.init();
    await waitFor('online', () => useLive.getState().status === 'online');
    await waitFor('the app list', () => useLive.getState().apps !== null || !!useLive.getState().appsError);
    assert.equal(useLive.getState().apps, null);
    assert.equal(useLive.getState().appsError, 'The computer sent something AuthDeck does not understand.');

    const key1 = { id: 'k1', label: 'Build', icon: { kind: 'glyph', glyph: 'x' }, action: { type: 'launch', appId: 'x', appName: 'X' } } as unknown as DeckKey;
    await manager.runKey(key1, { id: 'p', name: 'p', slots: [] } as unknown as Page);
    const toast = useLive.getState().toast!;
    assert.equal(toast.tone, 'fail');
    assert.equal(typeof toast.title, 'string');
    assert.ok(toast.detail === undefined || typeof toast.detail === 'string');
    assert.equal(useLive.getState().status, 'online');
  });
});

describe('N2: a computer saved before link keys', () => {
  it('a link with an unrelated name answered with its id is refused: no key, name or activation changes', async () => {
    const legacy = { agentId: 'ada-mac', name: SAVED_NAME, platform: 'macos', hosts: ['192.168.1.5'], port: 47474, pairedAt: 1 } as Computer;
    useStore.setState({ computers: [legacy], decks: { 'ada-mac': { pages: [] } as never }, activeId: 'other' });
    const evilKey = newLinkKey();
    server = await agentServer('127.0.0.1', 0, { key: evilKey, info: agentInfo('ada-mac', SAVED_NAME) });
    const { flow, paired } = await pairByLink(pairUrl('Meeting room TV', server.port, evilKey.public));
    assert.equal(flow.getState().problem?.title, "This isn't Meeting room TV.");
    assert.equal(flow.getState().keyChange, null);
    assert.deepEqual(useStore.getState().computers, [legacy]);
    assert.equal(useStore.getState().activeId, 'other');
    assert.deepEqual(paired, []);
  });

  it('a link using its own name asks to compare key words instead of saving', async () => {
    const legacy = { agentId: 'ada-mac', name: SAVED_NAME, platform: 'macos', hosts: ['192.168.1.5'], port: 47474, pairedAt: 1 } as Computer;
    useStore.setState({ computers: [legacy], activeId: 'other' });
    const evilKey = newLinkKey();
    server = await agentServer('127.0.0.1', 0, { key: evilKey, info: agentInfo('ada-mac', SAVED_NAME) });
    const { flow } = await pairByLink(pairUrl(SAVED_NAME, server.port, evilKey.public));
    assert.equal(flow.getState().keyChange?.conflict, 'legacy');
    assert.deepEqual(useStore.getState().computers, [legacy]);
  });
});

describe('N3: invisible and look-alike characters in a borrowed name', () => {
  for (const [label, fake] of [
    ['zero-width space', 'Ada’s​ MacBook'],
    ['word joiner', 'Ada’s MacBook⁠'],
    ['soft hyphen', 'Ada’s Mac­Book'],
    ['Cyrillic а', 'Adа’s MacBook'],
  ] as const) {
    it(`${label}: the sheet warns, the pairing asks, and the active computer stays`, async () => {
      const real: Computer = { agentId: 'real', name: SAVED_NAME, platform: 'macos', hosts: ['192.168.1.5'], port: 47474, linkKey: toBase64Url(newLinkKey().public), pairedAt: 1 };
      useStore.setState({ computers: [real], activeId: 'real' });
      const evilKey = newLinkKey();
      server = await agentServer('127.0.0.1', 0, { key: evilKey, info: agentInfo(`evil-${label.replace(/[^A-Za-z]/g, '')}`, fake) });
      const url = pairUrl(fake, server.port, evilKey.public);
      assert.deepEqual(linkStanding(parsePairLink(url)!, [real]), { kind: 'new', lookAlike: real });
      const { flow } = await pairByLink(url);
      assert.equal(flow.getState().keyChange?.conflict, 'name');
      assert.equal(useStore.getState().activeId, 'real');
      assert.deepEqual(useStore.getState().computers, [real]);
    });
  }
});

describe('N5: a paired computer renaming itself on connect', () => {
  it('to another saved computer’s name: the saved name and platform stay', async () => {
    const bobKey = newLinkKey();
    server = await agentServer('127.0.0.1', 0, { key: bobKey, info: { ...agentInfo('bob-pc', 'Adа’s​ MacBook'), platform: 'macos' } });
    useStore.setState({
      computers: [
        { agentId: 'ada-mac', name: SAVED_NAME, platform: 'macos', hosts: ['192.168.1.5'], port: 47474, linkKey: toBase64Url(newLinkKey().public), pairedAt: 1 },
        { agentId: 'bob-pc', name: 'Bob’s PC', platform: 'windows', hosts: ['127.0.0.1'], port: server.port, linkKey: toBase64Url(bobKey.public), pairedAt: 2 },
      ],
      activeId: 'bob-pc',
    });
    stop = new ConnectionManager(async () => [], async () => null).init();
    await waitFor('online', () => useLive.getState().status === 'online');
    const bob = useStore.getState().computers.find((c) => c.agentId === 'bob-pc')!;
    assert.equal(bob.name, 'Bob’s PC');
    assert.equal(bob.platform, 'windows');
    assert.equal(useLive.getState().agent?.name, 'Bob’s PC');
  });

  it('to a new name of its own: taken, without invisible characters', async () => {
    const bobKey = newLinkKey();
    server = await agentServer('127.0.0.1', 0, { key: bobKey, info: agentInfo('bob-pc', 'Bob’s​ Linux box⁠') });
    useStore.setState({
      computers: [{ agentId: 'bob-pc', name: 'Bob’s PC', platform: 'windows', hosts: ['127.0.0.1'], port: server.port, linkKey: toBase64Url(bobKey.public), pairedAt: 2 }],
      activeId: 'bob-pc',
    });
    stop = new ConnectionManager(async () => [], async () => null).init();
    await waitFor('online', () => useLive.getState().status === 'online');
    assert.equal(useStore.getState().computers[0]!.name, 'Bob’s Linux box');
    assert.equal(useStore.getState().computers[0]!.platform, 'macos');
  });
});
