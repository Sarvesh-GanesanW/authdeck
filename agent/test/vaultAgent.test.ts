import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ActionRunner } from '../src/actions/runner';
import { AppCatalog } from '../src/apps/catalog';
import { parseArgs, UsageError } from '../src/args';
import { authdeckHome } from '../src/config';
import { AgentError } from '../src/errors';
import type { AgentEvent } from '../src/events';
import { DryRunExecutor, PlanExecutor } from '../src/executor';
import type { FocusTracker } from '../src/focus';
import type { IconService } from '../src/icons/service';
import { JoinRelay, MAX_PENDING_JOINS_PER_DEVICE } from '../src/joinRelay';
import { PROTOCOL_VERSION, VAULT_JOIN_TTL_MS, type EventName, type Events, type RunParams } from '../src/protocol';
import { AgentServer } from '../src/server';
import { buildAccountDelete, buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, createVault, newAccountId } from '../src/vault/build';
import { entryHash, serializeEntry, type SignedEntry } from '../src/vault/entry';
import { personalVaultRoot, VaultStore } from '../src/vaultStore';
import { VaultWatcher } from '../src/vaultWatcher';
import { replayVault } from '../src/vault/replay';
import { device, seededRandom, totpRecord } from './helpers/vault';
import { newDeviceKey, pairByQr, type LinkedDevice } from './helpers/link';
import { agentLinkKey, testConfig, testPairing } from './helpers/server';

const random = seededRandom('vault-agent-tests');
const CODE = '492039';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-vault-'));
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

/** A founded vault plus helpers to make the founder's next entries from what the store holds. */
function foundedVault(store: VaultStore, kind: 'personal' | 'team' = 'personal') {
  const founder = device(random);
  const created = createVault({ founder, kind, name: 'Home', deviceName: 'Phone', random, time: 1_000 });
  store.append(created.vaultId, [created.entry], false);
  const stateNow = () => {
    const read = store.read(created.vaultId, undefined);
    return replayVault(created.vaultId, Object.fromEntries(Object.entries(read.logs).map(([id, log]) => [id, log.lines])));
  };
  const put = (time: number): SignedEntry =>
    buildAccountPut(stateNow(), founder, { account: newAccountId(random), record: totpRecord(), currentKey: created.key, random, time });
  return { founder, created, stateNow, put };
}

describe('vault store', () => {
  it('keeps vaults under AUTHDECK_HOME/vault with owner-only folders and files', () => {
    const home = authdeckHome({ AUTHDECK_HOME: tempHome() });
    const store = new VaultStore({ personal: personalVaultRoot(home), team: () => null });
    const { created, put } = foundedVault(store);
    store.append(created.vaultId, [put(2_000)], false);
    const dir = path.join(home, 'vault', created.vaultId);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8')), { v: 1, vaultId: created.vaultId, kind: 'personal' });
    const logFile = path.join(dir, 'log', `${created.entry.author}.jsonl`);
    assert.equal(fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length, 2);
    if (process.platform !== 'win32') {
      assert.equal(mode(dir), 0o700);
      assert.equal(mode(path.join(dir, 'log')), 0o700);
      assert.equal(mode(logFile), 0o600);
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, 'log')), [`${created.entry.author}.jsonl`], 'no temp files left behind');
    assert.deepEqual(store.list(), [{ vaultId: created.vaultId, kind: 'personal', location: 'personal', path: dir, lengths: { [created.entry.author]: 2 } }]);
  });

  it('reads entries after a per-device point and reports full lengths', () => {
    const store = new VaultStore({ personal: tempHome(), team: () => null });
    const { created, put, founder } = foundedVault(store);
    store.append(created.vaultId, [put(2_000)], false);
    store.append(created.vaultId, [put(3_000)], false);
    const read = store.read(created.vaultId, { [founder.deviceId]: 2 });
    assert.equal(read.logs[founder.deviceId]?.from, 2);
    assert.equal(read.logs[founder.deviceId]?.lines.length, 1);
    assert.deepEqual(read.lengths, { [founder.deviceId]: 3 });
    assert.equal(store.read(created.vaultId, { [founder.deviceId]: 99 }).logs[founder.deviceId]?.lines.length, 0);
    assert.throws(() => store.read('../../etc', undefined), /not a vault id/);
    assert.throws(() => store.read(created.vaultId, { x: -1 }), /line numbers/);
  });

  it('refuses entries that fail the rules, with the reason', () => {
    const store = new VaultStore({ personal: tempHome(), team: () => null });
    assert.throws(() => foundedVault(store, 'team'), /No team folder/);
    const teamDir = tempHome();
    const teamStore = new VaultStore({ personal: tempHome(), team: () => teamDir });
    const team = foundedVault(teamStore, 'team');
    const member = device(random);
    teamStore.append(team.created.vaultId, [
      buildDeviceAdd(team.stateNow(), team.founder, { device: member, role: 'member', name: 'Ann', currentKey: team.created.key, random, time: 2_000 }),
    ], false);
    teamStore.append(team.created.vaultId, [buildDeviceHello(team.stateNow(), member, 3_000)], false);
    const sneaky = buildDeviceAdd(team.stateNow(), member, { device: device(random), role: 'admin', name: 'X', currentKey: team.created.key, random, time: 4_000 });
    // A member's line the rules reject is kept only to hold its seq; it adds nobody.
    teamStore.append(team.created.vaultId, [sneaky], false);
    const after = team.stateNow();
    assert.match(after.history.find((h) => h.hash === entryHash(sneaky))?.reason ?? '', /only an admin device can do this/);
    assert.equal(Object.keys(after.members).length, 2);
    // A removed device's lines are still refused outright, so it can't fill the folder.
    teamStore.append(team.created.vaultId, [buildDeviceRemove(after, team.founder, { device: member.deviceId, currentKey: team.created.key, random, time: 5_000 }).entry], false);
    const late = buildAccountDelete(team.stateNow(), member, { account: newAccountId(random), time: 6_000 });
    assert.throws(() => teamStore.append(team.created.vaultId, [late], false), (err: AgentError) => err.code === 'bad_request' && /removed/.test(err.message));
    assert.equal(teamStore.list()[0]?.location, 'team');
  });

  it('refuses a tampered entry, a skipped seq and a foreign vault id', () => {
    const store = new VaultStore({ personal: tempHome(), team: () => null });
    const { created, put } = foundedVault(store);
    const entry = put(2_000);
    assert.throws(() => store.append(created.vaultId, [{ ...entry, time: entry.time + 1 }], false), /failed the chain checks: the signature is not valid/);
    assert.throws(() => store.append(created.vaultId, [{ ...entry, seq: 5 }], false), /seq 5, but the next entry of its device is 1/);
    const other = createVault({ founder: device(random), kind: 'personal', name: 'Other', deviceName: 'X', random, time: 1 });
    assert.throws(() => store.append(created.vaultId, [other.entry], false), /another vault/);
    assert.throws(() => store.append(newAccountId(random), [entry], false), /no vault with that id/);
    store.append(created.vaultId, [entry], false);
  });

  it('replaces a tampered tail with the device\'s verified copy, but never a verified entry', () => {
    const personal = tempHome();
    const store = new VaultStore({ personal, team: () => null });
    const { created, put, founder } = foundedVault(store);
    const good = put(2_000);
    store.append(created.vaultId, [good], false);
    const file = path.join(personal, created.vaultId, 'log', `${founder.deviceId}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    fs.writeFileSync(file, `${lines[0]}\n${lines[1]!.replace('"time":2000', '"time":2001')}\n`);
    const proof = { [good.author]: { seq: good.seq, hash: entryHash(good) } };
    store.append(created.vaultId, [good], true, proof);
    assert.equal(fs.readFileSync(file, 'utf8'), `${lines[0]}\n${serializeEntry(good)}\n`);
    // Sending the same line again is an exact retry: it changes nothing.
    store.append(created.vaultId, [good], true, proof);
    assert.equal(fs.readFileSync(file, 'utf8'), `${lines[0]}\n${serializeEntry(good)}\n`);
    assert.throws(() => store.append(created.vaultId, [{ ...good, time: 2_002 }], true, proof), /already verified|chain checks|signature/);
  });
});

describe('vault watcher', () => {
  it('reports the vault a sync tool changed', async () => {
    const root = tempHome();
    const changed: string[] = [];
    const watcher = new VaultWatcher({ roots: () => [root], onChange: (id) => changed.push(id), log: () => {} });
    watcher.start();
    try {
      const vaultId = newAccountId(random);
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.mkdirSync(path.join(root, vaultId, 'log'), { recursive: true });
      fs.writeFileSync(path.join(root, vaultId, 'log', 'x.jsonl'), '{}\n');
      for (let tries = 0; tries < 60 && changed.length === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual([...new Set(changed)], [vaultId]);
    } finally {
      watcher.stop();
    }
  });
});

describe('join relay', () => {
  function relay(connected: string[]) {
    let now = 0;
    const sent: { to: string; event: EventName; data: unknown }[] = [];
    const joins = new JoinRelay({
      now: () => now,
      sendTo: <E extends EventName>(to: string, event: E, data: Events[E]) => sent.push({ to, event, data }),
      connected: () => new Set(connected),
      deviceName: (id) => `name of ${id}`,
    });
    return { joins, sent, advance: (ms: number) => (now += ms) };
  }
  const request = { ed: 'ed', x: 'x', name: 'Tablet', commit: 'commit' };

  it('carries request, challenge, reveal and finish between the two devices in order', () => {
    const { joins, sent } = relay(['new', 'phone', 'laptop']);
    const { requestId } = joins.request('new', { request });
    assert.deepEqual(sent.map((s) => [s.to, s.event]), [['phone', 'vault.join.requested'], ['laptop', 'vault.join.requested']]);
    assert.throws(() => joins.reveal('new', { requestId, reveal: { nonce: 'n' } }), /Wait for the other device/);
    joins.challenge('phone', { requestId, challenge: { ed: 'a', x: 'x', vault: 'v', vaultName: 'Home', name: 'Phone', nonce: 'na' } });
    assert.throws(() => joins.challenge('laptop', { requestId, challenge: { ed: 'b', x: 'x', vault: 'v', vaultName: 'Home', name: 'Laptop', nonce: 'nb' } }), /already answering/);
    assert.throws(() => joins.finish('phone', { requestId, approved: true }), /not revealed/);
    joins.reveal('new', { requestId, reveal: { nonce: 'nn' } });
    assert.throws(() => joins.finish('laptop', { requestId, approved: true }), /Only the approving device/);
    joins.finish('phone', { requestId, approved: true, vaultId: 'v' });
    assert.deepEqual(sent.slice(2).map((s) => [s.to, s.event]), [
      ['laptop', 'vault.join.cancelled'],
      ['new', 'vault.join.challenged'],
      ['phone', 'vault.join.revealed'],
      ['new', 'vault.join.finished'],
    ]);
    assert.equal(joins.pendingCount(), 0);
  });

  it('expires requests after five minutes and tells both sides', () => {
    const { joins, sent, advance } = relay(['new', 'phone']);
    const { requestId, expiresAt } = joins.request('new', { request });
    assert.equal(expiresAt, VAULT_JOIN_TTL_MS);
    joins.challenge('phone', { requestId, challenge: { ed: 'a', x: 'x', vault: 'v', vaultName: 'Home', name: 'Phone', nonce: 'na' } });
    advance(VAULT_JOIN_TTL_MS);
    joins.expire();
    assert.deepEqual(sent.filter((s) => s.event === 'vault.join.cancelled').map((s) => [s.to, (s.data as { reason: string }).reason]), [['new', 'expired'], ['phone', 'expired']]);
    assert.throws(() => joins.reveal('new', { requestId, reveal: { nonce: 'n' } }), /ended or expired/);
  });

  it('limits pending requests per device and needs another device connected', () => {
    const { joins } = relay(['new', 'phone']);
    for (let i = 0; i < MAX_PENDING_JOINS_PER_DEVICE; i++) joins.request('new', { request });
    assert.throws(() => joins.request('new', { request }), /already has join requests waiting/);
    assert.throws(() => relay(['new']).joins.request('new', { request }), /No other device is connected/);
    assert.throws(() => relay(['new', 'phone']).joins.request('new', { request: { ...request, commit: '' } }), /commitment is missing/);
  });

  it('ends a request when one side disconnects or cancels', () => {
    const { joins, sent } = relay(['new', 'phone']);
    const first = joins.request('new', { request });
    joins.deviceGone('new');
    assert.deepEqual(sent.at(-1), { to: 'phone', event: 'vault.join.cancelled', data: { requestId: first.requestId, reason: 'disconnected' } });
    const second = joins.request('new', { request });
    assert.throws(() => joins.cancel('stranger', { requestId: second.requestId }), /not part of that request/);
    joins.cancel('new', { requestId: second.requestId });
    assert.equal(joins.pendingCount(), 0);
  });
});

describe('secret typing', () => {
  it('a dry run never prints the secret', async () => {
    const lines: string[] = [];
    await new DryRunExecutor((line) => lines.push(line)).execute([{ kind: 'run', cmd: 'xdotool', args: ['type', '--', CODE], purpose: 'type', failure: 'xdotool' }], { secret: true });
    assert.equal(lines.join('\n').includes(CODE), false);
    assert.match(lines.join('\n'), /not shown/);
  });

  it('a failed secret step reports a generic error, never the tool\'s output', async () => {
    const executor = new PlanExecutor({ hostAppName: 'AuthDeck', winHelper: null });
    await assert.rejects(
      executor.execute([{ kind: 'run', cmd: process.execPath, args: ['-e', `console.error(${JSON.stringify(CODE)}); process.exit(3)`], purpose: 'type', failure: 'plain' }], { secret: true }),
      (err: AgentError) => err.message === 'Could not type the code.' && !JSON.stringify(err).includes(CODE),
    );
  });
});

describe('vault over the wire', () => {
  const linkKey = agentLinkKey();
  const pairing = testPairing(testConfig());
  let server: AgentServer;
  let port: number;
  const events: AgentEvent[] = [];
  const logLines: string[] = [];
  const store = new VaultStore({ personal: tempHome(), team: () => null });

  before(async () => {
    const catalog = new AppCatalog(async () => []);
    await catalog.rescan();
    server = new AgentServer({
      agentInfo: { agentId: 'agent', name: 'Mac', platform: 'macos', version: '0.0.0', protocol: PROTOCOL_VERSION },
      port: 0,
      home: '/Users/ada',
      platform: 'macos',
      pairing: pairing.pairing,
      linkKey,
      catalog,
      icons: {} as IconService,
      runner: { run: async (_params: RunParams) => ({ durationMs: 1 }) } as unknown as ActionRunner,
      focus: { clientConnected() {}, clientDisconnected() {}, current: async () => ({ supported: false, appId: null, name: '' }) } as unknown as FocusTracker,
      vaults: store,
      log: (line) => logLines.push(line),
      emit: (event) => events.push(event),
    });
    port = await server.listen();
  });

  after(() => server.close());

  function connect(deviceId: string): Promise<LinkedDevice> {
    return pairByQr(port, linkKey.public, pairing.config().pairSecret, newDeviceKey(), { deviceId, deviceName: deviceId });
  }

  it('lists, appends and reads a vault, and refuses a bad append with the reason', async () => {
    const phone = await connect('phone');
    const founder = device(random);
    const created = createVault({ founder, kind: 'personal', name: 'Home', deviceName: 'Phone', random, time: 1_000 });
    const appended = await phone.request('vault.append', { vaultId: created.vaultId, entries: [created.entry] });
    assert.deepEqual(appended.result, { lengths: { [founder.deviceId]: 1 } });
    const listed = await phone.request('vault.list', {});
    assert.deepEqual(listed.result.vaults.map((v: { vaultId: string }) => v.vaultId), [created.vaultId]);
    const read = await phone.request('vault.read', { vaultId: created.vaultId });
    assert.deepEqual(read.result.logs[founder.deviceId].lines, [serializeEntry(created.entry)]);
    const refused = await phone.request('vault.append', { vaultId: created.vaultId, entries: [{ ...created.entry, seq: 1 }] });
    assert.equal(refused.ok, false);
    assert.match(refused.error!.message, /malformed|chain checks|prev/);
    phone.close();
  });

  it('types a secret code with the device\'s label and keeps the digits out of logs and events', async () => {
    const phone = await connect('phone');
    logLines.length = 0;
    events.length = 0;
    const response = await phone.request('run', { action: { type: 'text', text: CODE, secret: true }, label: 'Typed a code for GitHub' });
    assert.equal(response.ok, true);
    const started = events.find((e) => e.type === 'action.started');
    assert.deepEqual(started && 'title' in started ? [started.title, started.detail] : null, ['Typed a code for GitHub', 'Hidden']);
    assert.equal(JSON.stringify(events).includes(CODE), false);
    assert.equal(logLines.join('\n').includes(CODE), false);
    phone.close();
  });

  it('relays a join between two connected devices', async () => {
    const tablet = await connect('tablet');
    const phone = await connect('phone');
    const asked = await tablet.request('vault.join.request', { request: { ed: 'ed', x: 'x', name: 'Tablet', commit: 'c' } });
    assert.equal(asked.ok, true);
    const requested = await phone.event('vault.join.requested');
    assert.equal(requested.data.fromDevice, 'tablet');
    await phone.request('vault.join.challenge', { requestId: asked.result.requestId, challenge: { ed: 'a', x: 'x', vault: 'v', vaultName: 'Home', name: 'Phone', nonce: 'na' } });
    assert.deepEqual((await tablet.event('vault.join.challenged')).data.challenge, { ed: 'a', x: 'x', vault: 'v', vaultName: 'Home', name: 'Phone', nonce: 'na' });
    tablet.close();
    assert.equal((await phone.event('vault.join.cancelled')).data.reason, 'disconnected');
    phone.close();
  });
});

describe('team folder setting', () => {
  it('parses show, set and clear', () => {
    assert.deepEqual(parseArgs(['team-folder']), { kind: 'team-folder' });
    assert.deepEqual(parseArgs(['team-folder', '~/Dropbox/AuthDeck']), { kind: 'team-folder', folder: '~/Dropbox/AuthDeck' });
    assert.deepEqual(parseArgs(['team-folder', '--clear']), { kind: 'team-folder', folder: null });
    assert.throws(() => parseArgs(['team-folder', 'a', 'b']), UsageError);
  });
});
