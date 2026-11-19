import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AgentError } from '../src/errors';
import { JoinRelay, MAX_JOIN_NAME_LENGTH, MAX_PENDING_JOINS, requireCleanJoinName } from '../src/joinRelay';
import { cleanJoinName } from '../src/vault/approval';
import type { EventName, Events, VaultEntry } from '../src/protocol';
import { VAULT_APPEND_RATE, VAULT_JOIN_REQUEST_RATE, VAULT_READ_RATE } from '../src/server';
import { buildAccountPut, createVault, newAccountId } from '../src/vault/build';
import { entryHash, serializeEntry, signEntry, type SignedEntry } from '../src/vault/entry';
import { replayVault } from '../src/vault/replay';
import { MAX_APPEND_BYTES, MAX_ENTRY_BYTES, MAX_LOG_FILES, MAX_READ_BYTES, MAX_READ_LINES, MAX_VAULT_ENTRIES, VaultStore } from '../src/vaultStore';
import { signBeacon } from '../src/vault/beacon';
import { startTestServer, type TestServer } from './helpers/server';
import { device, seededRandom, totpRecord } from './helpers/vault';

const random = seededRandom('vault-limits-tests');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-limits-'));
}

const isBadRequest = (pattern: RegExp) => (err: AgentError) => err.code === 'bad_request' && pattern.test(err.message);

function founded(store: VaultStore) {
  const founder = device(random);
  const created = createVault({ founder, kind: 'personal', name: 'Home', deviceName: 'Phone', random, time: 1_000 });
  store.append(created.vaultId, [created.entry], false);
  const stateNow = () => {
    const read = store.read(created.vaultId, undefined);
    return replayVault(created.vaultId, Object.fromEntries(Object.entries(read.logs).map(([id, log]) => [id, log.lines])));
  };
  const put = (time: number): SignedEntry =>
    buildAccountPut(stateNow(), founder, { account: newAccountId(random), record: totpRecord(), currentKey: created.key, random, time });
  return { founder, created, put };
}

/** Every string that must never be taken as a path segment. */
const HOSTILE_IDS = [
  '..',
  '.',
  '../../etc/passwd',
  '/etc/passwd',
  'C:\\Windows',
  'aaaaaaaaaa/aaaaaaaaaaa',
  'aaaaaaaaaa\\aaaaaaaaaaa',
  '..aaaaaaaaaaaaaaaaaaaa',
  'aaaaaaaaaaaaaaaaaaaaaa\n',
  'aaaaaaaaaaaaaaaaaaaa\u0000a',
  'ａａａａａａａａａａａａａａａａａａａａａａ', // fullwidth letters
  'aaaaaaaaaaaaaaaaaaaa\u2215a', // division slash
  'aaaaaaaaaaaaaaaaaaaa%2f',
  '',
  'aaaaaaaaaaaaaaaaaaaaaaa',
];

describe('vault paths', () => {
  it('refuses every value that is not exactly an id as a vault id', () => {
    const root = tempDir();
    const store = new VaultStore({ personal: path.join(root, 'vault'), team: () => null });
    const { created } = founded(store);
    for (const id of HOSTILE_IDS) {
      assert.throws(() => store.read(id, undefined), isBadRequest(/not a vault id/), JSON.stringify(id));
      assert.throws(() => store.append(id, [created.entry], false), isBadRequest(/not a vault id/), JSON.stringify(id));
    }
    for (const id of [42, null, ['..'], { toString: () => '..' }]) assert.throws(() => store.read(id, undefined), isBadRequest(/not a vault id/));
    assert.deepEqual(fs.readdirSync(root), ['vault'], 'nothing was written beside the vault root');
  });

  it('refuses since keys that are not device ids', () => {
    const store = new VaultStore({ personal: tempDir(), team: () => null });
    const { created } = founded(store);
    for (const id of HOSTILE_IDS) assert.throws(() => store.read(created.vaultId, { [id]: 0 }), isBadRequest(/line numbers/), JSON.stringify(id));
  });

  it('refuses entries whose author is not a device id, so no log file is named by them', () => {
    const personal = tempDir();
    const store = new VaultStore({ personal, team: () => null });
    const { created, put } = founded(store);
    const entry = put(2_000);
    for (const author of HOSTILE_IDS) {
      assert.throws(() => store.append(created.vaultId, [{ ...entry, author }], false), isBadRequest(/author id is malformed/), JSON.stringify(author));
    }
    assert.deepEqual(fs.readdirSync(path.join(personal, created.vaultId, 'log')), [`${created.entry.author}.jsonl`]);
  });

  it('refuses a vault folder that is a link, and leaves its target alone', { skip: process.platform === 'win32' }, () => {
    const personal = tempDir();
    const outside = tempDir();
    fs.chmodSync(outside, 0o755);
    const store = new VaultStore({ personal, team: () => null });
    const created = createVault({ founder: device(random), kind: 'personal', name: 'Home', deviceName: 'Phone', random, time: 1_000 });
    fs.symlinkSync(outside, path.join(personal, created.vaultId));
    assert.throws(() => store.append(created.vaultId, [created.entry], false), (err: AgentError) => err.code === 'failed' && /is a link or a file/.test(err.message));
    assert.throws(() => store.read(created.vaultId, undefined), /is a link or a file/);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o755);
    assert.deepEqual(store.list(), [], 'a linked folder is not listed');
  });

  it('refuses a log folder that is a link, and skips log files that are links', { skip: process.platform === 'win32' }, () => {
    const personal = tempDir();
    const store = new VaultStore({ personal, team: () => null });
    const { created } = founded(store);
    const logDir = path.join(personal, created.vaultId, 'log');
    const outsideFile = path.join(tempDir(), 'secret.txt');
    fs.writeFileSync(outsideFile, 'not a log\n');
    fs.symlinkSync(outsideFile, path.join(logDir, `${newAccountId(random)}.jsonl`));
    assert.deepEqual(Object.keys(store.read(created.vaultId, undefined).lengths), [created.entry.author]);

    const other = founded(new VaultStore({ personal, team: () => null }));
    const otherLog = path.join(personal, other.created.vaultId, 'log');
    fs.rmSync(otherLog, { recursive: true });
    fs.symlinkSync(tempDir(), otherLog);
    assert.throws(() => store.read(other.created.vaultId, undefined), /is a link or a file/);
  });

  it('lists only folders named by a vault id in the team folder', () => {
    const team = tempDir();
    for (const name of ['..x', 'not-an-id', 'Dropbox conflict copy']) fs.mkdirSync(path.join(team, name));
    const store = new VaultStore({ personal: tempDir(), team: () => team });
    assert.deepEqual(store.list(), []);
  });
});

describe('vault limits', () => {
  it('refuses one entry larger than the entry limit', () => {
    const store = new VaultStore({ personal: tempDir(), team: () => null });
    const { created, put } = founded(store);
    const entry = put(2_000);
    const big = { ...entry, body: { ...entry.body, pad: 'x'.repeat(MAX_ENTRY_BYTES) } };
    assert.throws(() => store.append(created.vaultId, [big], false), isBadRequest(/Entry 1 is larger than 128 KB/));
  });

  it('refuses a batch larger than the batch limit, or with too many entries', () => {
    const store = new VaultStore({ personal: tempDir(), team: () => null });
    const { created, put } = founded(store);
    const entry = put(2_000);
    const padded = { ...entry, body: { ...entry.body, pad: 'x'.repeat(MAX_ENTRY_BYTES - 2_000) } };
    const count = Math.ceil(MAX_APPEND_BYTES / MAX_ENTRY_BYTES) + 1;
    assert.throws(() => store.append(created.vaultId, Array(count).fill(padded), false), isBadRequest(/add up to more than 512 KB/));
    assert.throws(() => store.append(created.vaultId, Array(1001).fill(entry), false), isBadRequest(/at most 1000 entries/));
    store.append(created.vaultId, [entry], false);
  });

  it('reads only the vault\'s own logs when junk logs crowd the folder past what a vault may hold', () => {
    const personal = tempDir();
    const store = new VaultStore({ personal, team: () => null });
    const created = createVault({ founder: device(random), kind: 'personal', name: 'Home', deviceName: 'Phone', random, time: 1_000 });
    const logDir = path.join(personal, created.vaultId, 'log');
    fs.mkdirSync(logDir, { recursive: true });
    for (let i = 0; i < MAX_LOG_FILES; i++) fs.writeFileSync(path.join(logDir, `${newAccountId(random)}.jsonl`), '');
    store.append(created.vaultId, [created.entry], false);
    assert.deepEqual(store.read(created.vaultId, undefined).lengths, { [created.entry.author]: 1 });
  });

  it('serves a long vault in pages a device follows with since', () => {
    const personal = tempDir();
    const store = new VaultStore({ personal, team: () => null });
    const { created, founder } = founded(store);
    const other = newAccountId(random);
    const logDir = path.join(personal, created.vaultId, 'log');
    const total = MAX_READ_LINES + 500;
    fs.writeFileSync(path.join(logDir, `${other}.jsonl`), Array.from({ length: total }, (_, i) => `{"line":${i}}`).join('\n'));

    const since: Record<string, number> = {};
    const collected: Record<string, string[]> = {};
    let calls = 0;
    for (;;) {
      const page = store.read(created.vaultId, since);
      calls++;
      const served = Object.values(page.logs).reduce((sum, log) => sum + log.lines.length, 0);
      assert.ok(served <= MAX_READ_LINES);
      for (const [id, log] of Object.entries(page.logs)) {
        assert.equal(log.from, since[id] ?? 0);
        (collected[id] ??= []).push(...log.lines);
        since[id] = log.from + log.lines.length;
      }
      if (Object.entries(page.lengths).every(([id, length]) => since[id] === length)) break;
      assert.ok(calls < 10, 'pages always move forward');
    }
    assert.equal(calls, 2);
    assert.equal(collected[other]!.length, total);
    assert.equal(collected[other]![total - 1], `{"line":${total - 1}}`);
    assert.equal(collected[founder.deviceId]!.length, 1);
  });

  it('caps a page by bytes too, but always serves at least one line', () => {
    const personal = tempDir();
    const store = new VaultStore({ personal, team: () => null });
    const { created } = founded(store);
    const logDir = path.join(personal, created.vaultId, 'log');
    const wide = newAccountId(random);
    const line = `"${'x'.repeat(4096)}"`;
    fs.writeFileSync(path.join(logDir, `${wide}.jsonl`), Array(200).fill(line).join('\n'));
    const page = store.read(created.vaultId, { [created.entry.author]: 1 });
    const bytes = Object.values(page.logs).flatMap((log) => log.lines).reduce((sum, l) => sum + Buffer.byteLength(l), 0);
    assert.ok(bytes <= MAX_READ_BYTES);
    assert.ok(page.logs[wide]!.lines.length < 200);

    // A line larger than any entry is junk: it is dropped, never served.
    const huge = newAccountId(random);
    fs.writeFileSync(path.join(logDir, `${huge}.jsonl`), `"${'y'.repeat(MAX_READ_BYTES + 10)}"\n`);
    const first = store.read(created.vaultId, { [created.entry.author]: 1, [wide]: 200 });
    assert.equal(first.logs[huge]!.lines.length, 0);
  });
});

describe('repair appends', () => {
  function tamperable() {
    const personal = tempDir();
    const store = new VaultStore({ personal, team: () => null });
    const vault = founded(store);
    const file = path.join(personal, vault.created.vaultId, 'log', `${vault.founder.deviceId}.jsonl`);
    return { store, file, ...vault };
  }

  it('fills in a line missing from a rolled-back log', () => {
    const { store, file, created, put } = tamperable();
    const second = put(2_000);
    store.append(created.vaultId, [second], false);
    const third = put(3_000);
    store.append(created.vaultId, [third], false);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    fs.writeFileSync(file, `${lines.slice(0, 2).join('\n')}\n`);
    store.append(created.vaultId, [third], true, { [third.author]: { seq: third.seq, hash: entryHash(third) } });
    assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n'), lines);
  });

  it('replaces only lines that fail the checks, never a verified one', () => {
    const { store, file, created, put } = tamperable();
    const second = put(2_000);
    store.append(created.vaultId, [second], false);
    const verified = fs.readFileSync(file, 'utf8');
    const proof = { [second.author]: { seq: second.seq, hash: entryHash(second) } };
    // Exact copies of verified lines are retries and change nothing.
    for (const same of [created.entry, second]) {
      store.append(created.vaultId, [same as unknown as VaultEntry], true, proof);
      assert.equal(fs.readFileSync(file, 'utf8'), verified);
    }
    assert.throws(() => store.append(created.vaultId, [{ ...second, seq: 1, time: 9 }], true, proof), isBadRequest(/already verified|chain checks/));
    assert.equal(fs.readFileSync(file, 'utf8'), verified);
    fs.writeFileSync(file, verified.replace('"time":2000', '"time":2001'));
    assert.throws(() => store.append(created.vaultId, [second], true), isBadRequest(/needs "proof"/));
    store.append(created.vaultId, [second], true, proof);
    assert.equal(fs.readFileSync(file, 'utf8'), verified);
  });
});

describe('vault calls over the wire', () => {
  let t: TestServer;
  const personal = tempDir();
  const store = new VaultStore({ personal, team: () => null });

  before(async () => {
    t = await startTestServer({ vaults: store });
  });
  after(() => t.server.close());

  it('logs a repair with the device and line count, never the lines', async () => {
    const phone = await t.connect('phone');
    const { created, put, founder } = founded(store);
    const entry = put(2_000);
    t.logLines.length = 0;
    const proof = { [entry.author]: { seq: entry.seq, hash: entryHash(entry) } };
    const reply = await phone.request('vault.append', { vaultId: created.vaultId, entries: [entry] as unknown as VaultEntry[], repair: true, proof });
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    assert.equal(t.logLines.length, 1);
    assert.match(t.logLines[0]!, /phone repaired a vault log: wrote back 1 line$/);
    for (const secretish of [entry.sig, founder.deviceId, created.vaultId, JSON.stringify(entry.body)]) assert.equal(t.logLines[0]!.includes(secretish), false);
    await phone.request('vault.append', { vaultId: created.vaultId, entries: [put(3_000)] as unknown as VaultEntry[] });
    assert.equal(t.logLines.length, 1, 'a plain append is not logged');
    phone.close();
  });

  it('limits vault.append per paired device, across its connections', async () => {
    const phone = await t.connect('burst-phone');
    const laptop = await t.connect('burst-laptop');
    for (let i = 0; i < VAULT_APPEND_RATE.burst; i++) {
      const reply = await phone.request('vault.append', { vaultId: '..', entries: [] });
      assert.match(reply.error!.message, /not a vault id/);
    }
    const limited = await phone.request('vault.append', { vaultId: '..', entries: [] });
    assert.equal(limited.error?.code, 'rate_limited');
    assert.match(limited.error!.message, /too fast/);
    const phoneAgain = await t.connect('burst-phone');
    assert.equal((await phoneAgain.request('vault.append', { vaultId: '..', entries: [] })).error?.code, 'rate_limited', 'a new connection of the same device shares its allowance');
    phoneAgain.close();
    assert.match((await laptop.request('vault.append', { vaultId: '..', entries: [] })).error!.message, /not a vault id/, 'another device has its own allowance');
    t.advance(VAULT_APPEND_RATE.refillMs);
    assert.match((await phone.request('vault.append', { vaultId: '..', entries: [] })).error!.message, /not a vault id/);
    assert.match((await phone.request('vault.append', { vaultId: '..', entries: [] })).error!.message, /too fast/);
    phone.close();
    laptop.close();
  });

  it('limits vault reads per paired device (each one reads or replays the folder)', async () => {
    const reader = await t.connect('burst-reader');
    for (let i = 0; i < VAULT_READ_RATE.burst; i++) await reader.request('vault.read', { vaultId: '..' });
    for (const method of ['vault.read', 'vault.list', 'vault.beacons.read', 'vault.forks.read'] as const) {
      const limited = await reader.request(method, { vaultId: '..' } as never);
      assert.equal(limited.error?.code, 'rate_limited', method);
    }
    t.advance(VAULT_READ_RATE.refillMs);
    assert.match((await reader.request('vault.read', { vaultId: '..' })).error!.message, /not a vault id/);
    reader.close();
  });

  it('limits vault.join.request per paired device, even when each request is cancelled', async () => {
    const fresh = await t.connect('fresh');
    const trusted = await t.connect('trusted');
    const request = { ed: 'ed', x: 'x', name: 'Fresh', commit: 'c' };
    for (let i = 0; i < VAULT_JOIN_REQUEST_RATE.burst; i++) {
      const asked = await fresh.request('vault.join.request', { request });
      assert.equal(asked.ok, true, JSON.stringify(asked.error));
      await fresh.request('vault.join.cancel', { requestId: asked.result.requestId });
    }
    const limited = await fresh.request('vault.join.request', { request });
    assert.equal(limited.error?.code, 'rate_limited');
    assert.match(limited.error!.message, /too many join requests/);
    t.advance(VAULT_JOIN_REQUEST_RATE.refillMs);
    assert.equal((await fresh.request('vault.join.request', { request })).ok, true);
    fresh.close();
    trusted.close();
  });

  it('refuses a device name with control characters instead of changing it, since the code covers it', async () => {
    const fresh = await t.connect('fresh-2');
    const trusted = await t.connect('trusted-2');
    const refused = await fresh.request('vault.join.request', { request: { ed: 'ed', x: 'x', name: 'Ann\u001b[31m\u202E\'s\r\nPhone', commit: 'c' } });
    assert.equal(refused.error?.code, 'bad_request');
    assert.match(refused.error!.message, /control characters/);
    const name = cleanJoinName('Ann\u001b[31m\u202E\'s\r\nPhone');
    assert.equal((await fresh.request('vault.join.request', { request: { ed: 'ed', x: 'x', name, commit: 'c' } })).ok, true);
    assert.equal((await trusted.event('vault.join.requested')).data.request.name, "Ann[31m's Phone");
    fresh.close();
    trusted.close();
  });
});

describe('join relay limits', () => {
  function relay(connected: string[]) {
    let now = 0;
    const sent: { to: string; event: EventName; data: any }[] = [];
    const joins = new JoinRelay({
      now: () => now,
      sendTo: <E extends EventName>(to: string, event: E, data: Events[E]) => sent.push({ to, event, data }),
      connected: () => new Set(connected),
      deviceName: (id) => id,
    });
    return { joins, sent, advance: (ms: number) => (now += ms) };
  }
  const request = { ed: 'ed', x: 'x', name: 'Tablet', commit: 'c' };

  it('cleans and caps a plaintext name the same way on every device', () => {
    assert.equal(cleanJoinName('  Ada\'s\tiPad\u0000\u0007 '), "Ada's iPad");
    assert.equal(cleanJoinName('\u2066evil\u2069\u200Fname\u061C'), 'evilname');
    // 65 characters in 120 UTF-16 units: under the raw limit, over the shown one.
    const long = cleanJoinName(`${'a'.repeat(10)}${'😀'.repeat(MAX_JOIN_NAME_LENGTH - 9)}`);
    assert.equal(long, `${'a'.repeat(10)}${'😀'.repeat(MAX_JOIN_NAME_LENGTH - 10)}`, 'capped by characters, no surrogate pair split');
    assert.equal(cleanJoinName('\u0000\u001f\u202e'), '');
  });

  it('the relay passes clean names on and refuses others', () => {
    assert.equal(requireCleanJoinName("Ada's iPad"), "Ada's iPad");
    assert.throws(() => requireCleanJoinName('  Ada '), isBadRequest(/control characters or extra spaces/));
    assert.throws(() => requireCleanJoinName('x'.repeat(129)), isBadRequest(/device name is missing or too long/));
    assert.throws(() => requireCleanJoinName(42), isBadRequest(/device name/));
  });

  it('holds at most the global number of pending requests', () => {
    const devices = Array.from({ length: MAX_PENDING_JOINS }, (_, i) => `d${i}`);
    const { joins } = relay(['trusted', ...devices]);
    for (const id of devices.slice(0, MAX_PENDING_JOINS / 2)) {
      joins.request(id, { request });
      joins.request(id, { request });
    }
    assert.equal(joins.pendingCount(), MAX_PENDING_JOINS);
    assert.throws(() => joins.request(devices.at(-1)!, { request }), /Too many devices are asking/);
  });

  it('frees a device\'s slots once its requests expire', () => {
    const { joins, advance } = relay(['new', 'phone']);
    joins.request('new', { request });
    joins.request('new', { request });
    assert.throws(() => joins.request('new', { request }), /already has join requests waiting/);
    advance(5 * 60 * 1000);
    joins.request('new', { request });
    assert.equal(joins.pendingCount(), 1);
  });

  it('ends a request when the approver disconnects', () => {
    const { joins, sent } = relay(['new', 'phone', 'laptop']);
    const { requestId } = joins.request('new', { request });
    joins.challenge('phone', { requestId, challenge: { ed: 'a', x: 'x', vault: 'v', vaultName: 'Home', name: 'Phone', nonce: 'n' } });
    sent.length = 0;
    joins.deviceGone('phone');
    assert.deepEqual(sent, [{ to: 'new', event: 'vault.join.cancelled', data: { requestId, reason: 'disconnected' } }]);
    assert.equal(joins.pendingCount(), 0);
  });
});

describe('head beacons in the store', () => {
  it('keeps a member\'s signed beacon, refuses an older or foreign one, and serves them raw', () => {
    const personal = tempDir();
    const store = new VaultStore({ personal, team: () => null });
    const { founder, created } = founded(store);
    const state = () => replayVault(created.vaultId, Object.fromEntries(Object.entries(store.read(created.vaultId, undefined).logs).map(([id, log]) => [id, log.lines])));
    const beacon = signBeacon(state(), founder, 5_000);
    store.writeBeacon(created.vaultId, beacon);
    assert.equal(fs.readFileSync(path.join(personal, created.vaultId, 'heads', `${founder.deviceId}.json`), 'utf8'), `${JSON.stringify(beacon)}\n`);
    assert.deepEqual(Object.keys(store.readBeacons(created.vaultId).beacons), [founder.deviceId]);
    assert.throws(() => store.writeBeacon(created.vaultId, signBeacon(state(), founder, 4_000)), isBadRequest(/older/));
    assert.throws(() => store.writeBeacon(created.vaultId, signBeacon(state(), device(random), 6_000)), isBadRequest(/not signed by a device/));
    assert.throws(() => store.writeBeacon(created.vaultId, { ...beacon, epoch: 7 }), isBadRequest(/not signed by a device/));
  });
});

describe('join names', () => {
  it('drops lone surrogates, so two different names never give one code', () => {
    assert.equal(cleanJoinName('Pixel\uD800 8'), 'Pixel 8');
    assert.equal(cleanJoinName('Pixel\uDC00 8'), 'Pixel 8');
    assert.equal(cleanJoinName('Pixel \uD83D\uDE00'), 'Pixel \uD83D\uDE00');
  });
});

describe('N11: links planted in the vault folder', () => {
  it('a heads link is refused before its target is chmodded or written', { skip: process.platform === 'win32' }, () => {
    const personal = tempDir();
    const outside = tempDir();
    fs.chmodSync(outside, 0o755);
    const store = new VaultStore({ personal, team: () => null });
    const { founder, created } = founded(store);
    fs.symlinkSync(outside, path.join(personal, created.vaultId, 'heads'));
    const state = replayVault(created.vaultId, Object.fromEntries(Object.entries(store.read(created.vaultId, undefined).logs).map(([id, log]) => [id, log.lines])));
    assert.throws(() => store.writeBeacon(created.vaultId, signBeacon(state, founder, 5_000)), /link or a file/);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

describe('fork proofs in the store', () => {
  it('keeps a proof signed twice by one device and refuses anything else', () => {
    const personal = tempDir();
    const store = new VaultStore({ personal, team: () => null });
    const { founder, created, put } = founded(store);
    const first = put(2_000);
    store.append(created.vaultId, [first], false);
    const { sig: _sig, ...unsigned } = first;
    const twin = signEntry({ ...unsigned, time: first.time + 1 }, founder);
    const proof = { deviceId: founder.deviceId, seq: first.seq, lines: [serializeEntry(first), serializeEntry(twin)] as [string, string] };
    assert.throws(() => store.writeFork(created.vaultId, { ...proof, lines: [proof.lines[0], proof.lines[0]] }), isBadRequest(/same entry/));
    const stranger = device(random);
    assert.throws(() => store.writeFork(created.vaultId, { ...proof, lines: [proof.lines[0], serializeEntry(signEntry({ ...unsigned, time: 9 }, stranger))] }), isBadRequest(/not signed by that device/));
    assert.throws(() => store.writeFork(created.vaultId, { ...proof, extra: 1 }), isBadRequest(/missing or extra/));
    store.writeFork(created.vaultId, proof);
    assert.deepEqual(store.readForks(created.vaultId).forks, [proof]);
    // From then on the agent's own replay cuts the device off at that seq.
    assert.throws(() => store.append(created.vaultId, [put(3_000)], false), /signed two different entries/);
  });
});

describe('vault size caps', () => {
  it('counts no junk lines toward the entry cap: a folder full of them still reads and takes changes', () => {
    const personal = tempDir();
    const store = new VaultStore({ personal, team: () => null });
    const { created, put } = founded(store);
    fs.writeFileSync(path.join(personal, created.vaultId, 'log', `${'z'.repeat(22)}.jsonl`), 'x\n'.repeat(MAX_VAULT_ENTRIES));
    assert.equal(store.read(created.vaultId, undefined).lengths[created.entry.author], 1);
    store.append(created.vaultId, [put(2_000)], false);
  });
});
