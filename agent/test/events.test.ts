import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { describeActivity, shortcutLabel } from '../src/activity';
import { summarizeAction } from '../src/actions/summary';
import type { ActionRunner } from '../src/actions/runner';
import { AppCatalog } from '../src/apps/catalog';
import { AgentError } from '../src/errors';
import type { AgentEvent } from '../src/events';
import type { FocusTracker } from '../src/focus';
import type { IconService } from '../src/icons/service';
import { PROTOCOL_VERSION, type RunParams } from '../src/protocol';
import { AgentServer } from '../src/server';

/** What the device sees when the agent drops its socket without a close handshake. */
const CLOSE_CUT_OFF = 1006;
import { VaultStore } from '../src/vaultStore';
import { macSafari } from './helpers/context';
import { newDeviceKey, pairByQr, type SessionOptions } from './helpers/link';
import { agentLinkKey, testConfig, testPairing } from './helpers/server';

const runner = {
  async run(params: RunParams) {
    const action = params.action;
    if (action.type === 'command') return { durationMs: 5, exitCode: 2, output: '' };
    if (action.type === 'hotkey') throw new AgentError('permission', 'macOS blocked AuthDeck.', 'Turn on Accessibility.', 'accessibility');
    return { durationMs: 5 };
  },
} as unknown as ActionRunner;

const focus = {
  clientConnected() {},
  clientDisconnected() {},
  current: async () => ({ supported: false, appId: null, name: '' }),
} as unknown as FocusTracker;

describe('agent events', () => {
  const linkKey = agentLinkKey();
  const store = testPairing(testConfig('MacBook Pro'));
  let events: AgentEvent[];
  let server: AgentServer;
  let port: number;

  const waitForEvent = async (type: AgentEvent['type']): Promise<AgentEvent> => {
    for (let tries = 0; tries < 100; tries++) {
      const found = events.find((e) => e.type === type);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No ${type} event; got ${events.map((e) => e.type).join(', ')}`);
  };

  const pairDevice = async (deviceId: string, deviceName: string, options?: SessionOptions) => {
    return pairByQr(port, linkKey.public, store.config().pairSecret, newDeviceKey(), { deviceId, deviceName, form: 'tablet' }, options);
  };

  before(async () => {
    const catalog = new AppCatalog(async () => [macSafari]);
    await catalog.rescan();
    server = new AgentServer({
      agentInfo: { agentId: 'agent', name: 'MacBook Pro', platform: 'macos', version: '0.0.0', protocol: PROTOCOL_VERSION },
      port: 0,
      home: '/Users/ada',
      platform: 'macos',
      pairing: store.pairing,
      linkKey,
      catalog,
      icons: {} as IconService,
      runner,
      focus,
      vaults: new VaultStore({ personal: fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-events-')), team: () => null }),
      log: () => {},
      emit: (event) => events.push(event),
    });
    port = await server.listen();
  });

  after(() => server.close());

  it('reports a pairing, the connection once the device sends its first frame, and the disconnect', async () => {
    events = [];
    const device = await pairDevice('pad', 'Xiaomi Pad 7', { signIn: false });
    assert.deepEqual(events, [{ type: 'device.paired', deviceId: 'pad', deviceName: 'Xiaomi Pad 7' }]);
    assert.equal(server.connectedDeviceIds().size, 0, 'a handshake alone is not a sign-in');
    await device.request('ping', {});
    assert.deepEqual(events[1], { type: 'device.connected', deviceId: 'pad', deviceName: 'Xiaomi Pad 7' });
    assert.deepEqual([...server.connectedDeviceIds()], ['pad']);
    assert.equal(store.config().devices.find((d) => d.deviceId === 'pad')?.form, 'tablet');
    device.close();
    assert.deepEqual(await waitForEvent('device.disconnected'), { type: 'device.disconnected', deviceId: 'pad' });
    assert.equal(server.connectedDeviceIds().size, 0);
  });

  it('reports each action with what it was and how it ended', async () => {
    const device = await pairDevice('pad', 'Xiaomi Pad 7');
    events = [];
    await device.request('run', { action: { type: 'command', command: 'npm test', mode: 'background' }, label: 'Tests' });
    await device.request('run', { action: { type: 'hotkey', modifiers: ['mod', 'alt'], key: 's', focusAppId: macSafari.entry.id } });
    const [started, finished, keyStarted, keyFinished] = events;
    assert.deepEqual({ ...started, at: 0 }, { type: 'action.started', actionId: 1, deviceName: 'Xiaomi Pad 7', at: 0, title: 'Tests', detail: 'npm test' });
    assert.deepEqual({ ...finished, durationMs: 0 }, { type: 'action.finished', actionId: 1, ok: true, durationMs: 0, exitCode: 2 });
    assert.deepEqual(keyStarted?.type === 'action.started' && [keyStarted.title, keyStarted.detail], ['Shortcut', '⌥⌘S in Safari']);
    assert.deepEqual(keyFinished?.type === 'action.finished' && !keyFinished.ok && keyFinished.failure, {
      code: 'permission',
      message: 'macOS blocked AuthDeck.',
      hint: 'Turn on Accessibility.',
      permission: 'accessibility',
    });
    device.close();
    await device.closed;
  });

  it('disconnecting a device cuts off only its own sockets, at once', async () => {
    const pad = await pairDevice('pad', 'Xiaomi Pad 7');
    const phone = await pairDevice('phone', 'Pixel 8');
    events = [];
    server.disconnectDevice('pad');
    assert.equal(await pad.closed, CLOSE_CUT_OFF);
    await waitForEvent('device.disconnected');
    assert.deepEqual([...server.connectedDeviceIds()], ['phone']);
    phone.close();
    await phone.closed;
  });
});

describe('activity summaries', () => {
  const names = (id: string) => (id === macSafari.entry.id ? 'Safari' : undefined);

  it('writes shortcuts the way each platform does', () => {
    assert.equal(shortcutLabel(['mod', 'shift'], 'p', 'macos'), '⇧⌘P');
    assert.equal(shortcutLabel(['ctrl', 'alt'], 'enter', 'macos'), '⌃⌥↩');
    assert.equal(shortcutLabel(['mod', 'shift'], 'p', 'windows'), 'Ctrl+Shift+P');
    assert.equal(shortcutLabel(['meta'], 'pageup', 'linux'), 'Super+Page Up');
  });

  it('shows a secret as hidden, without even its length', () => {
    const summary = describeActivity({ type: 'text', text: '492039', pressEnter: true, secret: true }, 'macos', names);
    assert.deepEqual(summary, { title: 'Typed a code', detail: 'Hidden, then Enter' });
    assert.equal(summarizeAction({ type: 'text', text: '492039', secret: true }), 'type a secret');
  });

  it('never shows what was typed', () => {
    const summary = describeActivity({ type: 'text', text: 'hunter2', pressEnter: true }, 'macos', names);
    assert.deepEqual(summary, { title: 'Type text', detail: '7 characters, then Enter' });
  });

  it('names apps from the catalog and lists macro steps', () => {
    assert.deepEqual(describeActivity({ type: 'launch', appId: macSafari.entry.id, appName: 'Old name' }, 'macos', names), { title: 'Open app', detail: 'Safari' });
    const macro = { type: 'macro', steps: [{ action: { type: 'url', url: 'http://localhost:3000' }, delayMs: 0 }, { action: { type: 'command', command: 'make', mode: 'terminal' }, delayMs: 0 }] };
    assert.deepEqual(describeActivity(macro, 'macos', names), { title: 'Macro', detail: '2 steps: Open link, Command in terminal' });
  });

  it('describes an invalid action without throwing', () => {
    assert.equal(describeActivity({ type: 'teleport' }, 'linux', names).title, 'Unreadable action');
  });
});
