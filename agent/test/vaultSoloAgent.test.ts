/**
 * The agent in 0.3.0 (MULTI_DEVICE_VAULTS off): solo vaults only, in its own folder. It refuses
 * to create or append to any other vault, reads no team folder, and refuses the device-only kinds
 * of a solo vault.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAccountPut, buildKeyRotate, createVault, newAccountId } from '../src/vault/build';
import { MULTI_DEVICE_VAULTS, vaultFeatures } from '../src/vault/features';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase } from '../src/vault/recovery';
import { replayVault } from '../src/vault/replay';
import { retireShapeProblem } from '../src/vault/retire';
import { RETIRED_KEEP_MS, RETIRE_WINDOW_MS, signRetire } from '../src/vault/retire';
import { serializeEntry } from '../src/vault/entry';
import { VaultStore } from '../src/vaultStore';
import { device, seededRandom, soloRestoreLines, totpRecord } from './helpers/vault';

const random = seededRandom('solo-agent');
let home: string;
let store: VaultStore;

beforeEach(() => {
  vaultFeatures.multiDevice = MULTI_DEVICE_VAULTS;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-solo-'));
  fs.mkdirSync(path.join(home, 'team'));
  store = new VaultStore({ personal: path.join(home, 'vault'), team: () => path.join(home, 'team') });
});

afterEach(() => {
  vaultFeatures.multiDevice = true;
  fs.rmSync(home, { recursive: true, force: true });
});

function founded(kind: 'solo' | 'personal' | 'team') {
  const phone = device(random);
  const created = createVault({ founder: phone, kind, name: 'Home', deviceName: 'Phone', random, time: 1_000_000 });
  const state = replayVault(created.vaultId, { [phone.deviceId]: [serializeEntry(created.entry)] });
  const phrase = generateRecoveryPhrase(random);
  const set = buildRecoverySetFromPhrase(state, phone, { phrase, currentKey: created.key, random, time: 1_001_000 });
  return { phone, created, set, phrase };
}

test('0.3.0 ships with multi-device vaults off', () => {
  assert.equal(MULTI_DEVICE_VAULTS, false);
});

test('the agent creates a solo vault in its own folder and reads no team folder', () => {
  const { created, set } = founded('solo');
  store.append(created.vaultId, [created.entry, set.entry], false);
  assert.ok(fs.existsSync(path.join(home, 'vault', created.vaultId)));
  assert.deepEqual(store.watchRoots().map((r) => r.location), ['personal']);
  const [summary] = store.list();
  assert.equal(summary!.kind, 'solo');
});

for (const kind of ['personal', 'team'] as const) {
  test(`the agent refuses to create a ${kind} vault`, () => {
    const { created } = founded(kind);
    assert.throws(() => store.append(created.vaultId, [created.entry], false), /made by a newer or test build of AuthDeck\. Multi-device vaults arrive in 0\.4\./);
  });
}

test('the agent refuses to append to a multi-device vault already in its folder', () => {
  const { created, set } = founded('personal');
  vaultFeatures.multiDevice = true;
  store.append(created.vaultId, [created.entry], false);
  vaultFeatures.multiDevice = false;
  assert.throws(() => store.append(created.vaultId, [set.entry], false), /made by a newer or test build of AuthDeck\. Multi-device vaults arrive in 0\.4\./);
});

test('the agent refuses a key change a device signs in a solo vault', () => {
  const { phone, created, set } = founded('solo');
  store.append(created.vaultId, [created.entry, set.entry], false);
  const logs = { [phone.deviceId]: [serializeEntry(created.entry), serializeEntry(set.entry)] };
  const rotate = buildKeyRotate(replayVault(created.vaultId, logs), phone, { currentKey: set.newKey, random, time: 1_002_000 });
  assert.throws(() => store.append(created.vaultId, [rotate.entry], false), /only the recovery phrase/);
});

// vault.retire: a phone that made a new vault without the old phrase sets the old one aside.

const AGENT_ID = 'agent-1';
const NEW_VAULT = 'NNNNNNNNNNNNNNNNNNNNNN';
const T0 = 1_800_000_000_000;

/** A store on a clock the test moves, with a saved solo vault (phrase set) in it. */
function retireSetup(kind: 'solo' | 'personal' | 'team' = 'solo') {
  const clock = { now: T0 };
  const timed = new VaultStore({ personal: path.join(home, 'vault'), team: () => path.join(home, 'team') }, () => {}, () => clock.now);
  const vault = founded(kind);
  if (kind !== 'solo') vaultFeatures.multiDevice = true;
  timed.append(vault.created.vaultId, [vault.created.entry, vault.set.entry], false);
  const vaultId = vault.created.vaultId;
  const request = (overrides: { vault?: string; agentId?: string; time?: number } = {}, signer: Parameters<typeof signRetire>[1] = vault.phone) =>
    signRetire({ vault: overrides.vault ?? vaultId, newVault: NEW_VAULT, agentId: overrides.agentId ?? AGENT_ID, time: overrides.time ?? clock.now }, signer);
  const logsNow = () => Object.fromEntries(Object.entries(timed.read(vaultId, undefined).logs).map(([id, log]) => [id, log.lines]));
  const stateNow = () => replayVault(vaultId, logsNow());
  const restoreLines = (newPhone: ReturnType<typeof device>, time: number) => soloRestoreLines(vaultId, logsNow(), vault.phrase, newPhone, random, time);
  const live = path.join(home, kind === 'team' ? 'team' : 'vault', vaultId);
  const retired = path.join(home, 'vault', '.retired', vaultId);
  return { ...vault, clock, store: timed, vaultId, request, stateNow, restoreLines, live, retired };
}

test('vault.retire signed by the active device sets the vault aside for 30 days, listed as retired and still readable', () => {
  const v = retireSetup();
  const lengths = v.store.read(v.vaultId, undefined).lengths;
  assert.deepEqual(v.store.retire(v.vaultId, v.request(), AGENT_ID, 'Phone'), { keptUntil: T0 + RETIRED_KEEP_MS, retiredNow: true });
  assert.equal(fs.existsSync(v.live), false);
  assert.ok(fs.existsSync(path.join(v.retired, 'log')));
  const marker = JSON.parse(fs.readFileSync(path.join(v.retired, 'retired.json'), 'utf8'));
  assert.deepEqual(marker, { v: 1, vaultId: v.vaultId, at: T0, keptUntil: T0 + RETIRED_KEEP_MS, newVaultId: NEW_VAULT, byDevice: 'Phone' });
  const [summary, ...others] = v.store.list();
  assert.deepEqual(others, []);
  assert.equal(summary!.vaultId, v.vaultId);
  assert.equal(summary!.location, 'personal');
  assert.deepEqual(summary!.retired, { at: T0, keptUntil: T0 + RETIRED_KEEP_MS, newVaultId: NEW_VAULT, byDevice: 'Phone' });
  // A restore with the old phrase still finds and reads it.
  assert.deepEqual(v.store.read(v.vaultId, undefined).lengths, lengths);
  assert.deepEqual(v.store.readBeacons(v.vaultId), { beacons: {} });
  assert.deepEqual(v.store.readForks(v.vaultId), { forks: [], sealProofs: [] });
  // The vault watcher's roots are unchanged, and `.retired` is no vault.
  assert.deepEqual(v.store.watchRoots().map((r) => r.root), [path.join(home, 'vault')]);
  // A second retire (a retry after a lost answer) changes nothing and answers the same time.
  v.clock.now += 60_000;
  assert.deepEqual(v.store.retire(v.vaultId, v.request(), AGENT_ID, 'Phone'), { keptUntil: T0 + RETIRED_KEEP_MS, retiredNow: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(v.retired, 'retired.json'), 'utf8')).at, T0);
});

for (const kind of ['personal', 'team'] as const) {
  test(`vault.retire refuses a ${kind} vault and leaves its folder`, () => {
    const v = retireSetup(kind);
    assert.throws(() => v.store.retire(v.vaultId, v.request(), AGENT_ID, 'Phone'), /Only a vault kept on one device/);
    vaultFeatures.multiDevice = false;
    if (kind === 'personal') assert.throws(() => v.store.retire(v.vaultId, v.request(), AGENT_ID, 'Phone'), /Only a vault kept on one device/);
    assert.ok(fs.existsSync(path.join(v.live, 'log')));
    assert.equal(fs.existsSync(path.join(home, 'vault', '.retired')), false);
  });
}

test('vault.retire judges the kind by the logs, not by the vault.json hint', () => {
  const v = retireSetup('personal');
  vaultFeatures.multiDevice = false;
  fs.writeFileSync(path.join(v.live, 'vault.json'), `${JSON.stringify({ v: 1, vaultId: v.vaultId, kind: 'solo' })}\n`);
  assert.throws(() => v.store.retire(v.vaultId, v.request(), AGENT_ID, 'Phone'), /Only a vault kept on one device/);
  assert.ok(fs.existsSync(path.join(v.live, 'log')));
});

test('vault.retire refuses a request signed by a device not in the vault (another paired phone)', () => {
  const v = retireSetup();
  assert.throws(() => v.store.retire(v.vaultId, v.request({}, device(random)), AGENT_ID, 'Other phone'), /not signed by the device in this vault/);
  // Nor may another device sign in the vault device's name.
  const forged = { ...v.request(), sig: signRetire({ vault: v.vaultId, newVault: NEW_VAULT, agentId: AGENT_ID, time: T0 }, { ...device(random), deviceId: v.phone.deviceId }).sig };
  assert.throws(() => v.store.retire(v.vaultId, forged, AGENT_ID, 'Other phone'), /signature is not the vault device's/);
  assert.ok(fs.existsSync(path.join(v.live, 'log')));
});

test('vault.retire refuses a request signed by a device a restore took out', () => {
  const v = retireSetup();
  const fresh = device(random);
  assert.equal(v.store.append(v.vaultId, v.restoreLines(fresh, 1_002_000), false).restored, true);
  assert.throws(() => v.store.retire(v.vaultId, v.request(), AGENT_ID, 'Phone'), /not signed by the device in this vault/);
  // The restored device may.
  assert.equal(v.store.retire(v.vaultId, v.request({}, fresh), AGENT_ID, 'New phone').retiredNow, true);
});

test('vault.retire refuses a request for another computer, or too far from this clock', () => {
  const v = retireSetup();
  assert.throws(() => v.store.retire(v.vaultId, v.request({ agentId: 'agent-2' }), AGENT_ID, 'Phone'), /for another computer/);
  assert.throws(() => v.store.retire(v.vaultId, v.request({ time: T0 - RETIRE_WINDOW_MS - 1 }), AGENT_ID, 'Phone'), /too far from this computer's clock/);
  assert.throws(() => v.store.retire(v.vaultId, v.request({ time: T0 + RETIRE_WINDOW_MS + 1 }), AGENT_ID, 'Phone'), /too far from this computer's clock/);
  assert.ok(fs.existsSync(path.join(v.live, 'log')));
});

test('vault.retire refuses a request taken before, sent again', () => {
  const v = retireSetup();
  const request = v.request();
  assert.equal(v.store.retire(v.vaultId, request, AGENT_ID, 'Phone').retiredNow, true);
  // The folder back in place (as a sync tool might bring it): the same signed request is still refused.
  fs.renameSync(v.retired, v.live);
  fs.rmSync(path.join(v.live, 'retired.json'));
  assert.throws(() => v.store.retire(v.vaultId, request, AGENT_ID, 'Phone'), /already taken/);
  assert.ok(fs.existsSync(path.join(v.live, 'log')));
  // A new request from the vault's device is taken.
  v.clock.now += 1;
  assert.equal(v.store.retire(v.vaultId, v.request(), AGENT_ID, 'Phone').retiredNow, true);
});

test('vault.retire refuses a request for another vault than the one named, and malformed input', () => {
  const v = retireSetup();
  const other = retireSetup();
  assert.throws(() => v.store.retire(v.vaultId, other.request(), AGENT_ID, 'Phone'), /for another vault/);
  assert.throws(() => v.store.retire(v.vaultId, { ...v.request(), extra: 1 }, AGENT_ID, 'Phone'), /malformed/);
  assert.throws(() => v.store.retire(v.vaultId, null, AGENT_ID, 'Phone'), /malformed/);
  // I9-1: a version nested 100k levels deep is refused as malformed, never turned into text.
  let deep: unknown = 1;
  for (let i = 0; i < 100_000; i++) deep = [deep];
  assert.throws(() => v.store.retire(v.vaultId, { ...v.request(), v: deep }, AGENT_ID, 'Phone'), /malformed: its version is not a number/);
  assert.equal(retireShapeProblem({ ...v.request(), v: deep }), 'its version is not a number');
  for (const bad of ['../vault', '.retired', '__proto__', '', 7, null]) assert.throws(() => v.store.retire(bad, v.request(), AGENT_ID, 'Phone'), /not a vault id/);
  assert.throws(() => v.store.retire('abcdefghijklmnopqrstuv', v.request({ vault: 'abcdefghijklmnopqrstuv' }), AGENT_ID, 'Phone'), /no vault with that id/);
  assert.ok(fs.existsSync(path.join(v.live, 'log')));
});

test('vault.retire refuses a folder holding no vault', () => {
  const v = retireSetup();
  const id = 'abcdefghijklmnopqrstuv';
  fs.mkdirSync(path.join(home, 'vault', id, 'log'), { recursive: true });
  assert.throws(() => v.store.retire(id, v.request({ vault: id }), AGENT_ID, 'Phone'), /Only a vault kept on one device/);
  assert.ok(fs.existsSync(path.join(home, 'vault', id)));
});

test('a retired vault takes appends, and a restore with its phrase makes it live again', () => {
  const v = retireSetup();
  v.store.retire(v.vaultId, v.request(), AGENT_ID, 'Phone');
  // An account change from the vault's own device is written into the retired folder; it stays retired.
  const put = buildAccountPut(v.stateNow(), v.phone, { account: newAccountId(random), record: totpRecord(), currentKey: v.set.newKey, random, time: 1_002_000 });
  assert.equal(v.store.append(v.vaultId, [put], false).restored, false);
  assert.ok(fs.existsSync(path.join(v.retired, 'retired.json')));
  const restore = v.restoreLines(device(random), 1_003_000);
  const result = v.store.append(v.vaultId, restore, false);
  assert.equal(result.restored, true);
  assert.deepEqual(result.takenOut, [v.phone.deviceId]);
  assert.equal(fs.existsSync(v.retired), false);
  assert.ok(fs.existsSync(path.join(v.live, 'log')));
  assert.equal(fs.existsSync(path.join(v.live, 'retired.json')), false);
  const [summary] = v.store.list();
  assert.equal(summary!.retired, undefined);
  // Sending the restore again restores nothing.
  assert.equal(v.store.append(v.vaultId, restore, false).restored, false);
});

test('a retired vault is deleted 30 days after it was retired, not before', () => {
  const v = retireSetup();
  v.store.retire(v.vaultId, v.request(), AGENT_ID, 'Phone');
  v.clock.now = T0 + RETIRED_KEEP_MS - 1;
  assert.equal(v.store.list().length, 1);
  assert.equal(new VaultStore({ personal: path.join(home, 'vault'), team: () => null }, () => {}, () => v.clock.now).list().length, 1);
  assert.ok(fs.existsSync(v.retired));
  v.clock.now = T0 + RETIRED_KEEP_MS;
  // Constructing a store sweeps too.
  new VaultStore({ personal: path.join(home, 'vault'), team: () => null }, () => {}, () => v.clock.now);
  assert.equal(fs.existsSync(v.retired), false);
  assert.deepEqual(v.store.list(), []);
  assert.throws(() => v.store.read(v.vaultId, undefined), /no vault with that id/);
});

test('a retired folder whose record is unreadable is kept, found, but never listed or swept', () => {
  const v = retireSetup();
  v.store.retire(v.vaultId, v.request(), AGENT_ID, 'Phone');
  fs.writeFileSync(path.join(v.retired, 'retired.json'), '{not json');
  v.clock.now = T0 + 10 * RETIRED_KEEP_MS;
  assert.deepEqual(v.store.list(), []);
  assert.ok(fs.existsSync(v.retired));
  assert.ok(v.store.read(v.vaultId, undefined).lengths);
});

test('a link in place of the retired folder is not followed', { skip: process.platform === 'win32' }, () => {
  const v = retireSetup();
  v.store.retire(v.vaultId, v.request(), AGENT_ID, 'Phone');
  const elsewhere = path.join(home, 'elsewhere');
  fs.renameSync(path.join(home, 'vault', '.retired'), elsewhere);
  fs.symlinkSync(elsewhere, path.join(home, 'vault', '.retired'));
  assert.deepEqual(v.store.list(), []);
  assert.throws(() => v.store.read(v.vaultId, undefined), /no vault with that id/);
  v.clock.now = T0 + RETIRED_KEEP_MS;
  v.store.list();
  assert.ok(fs.existsSync(path.join(elsewhere, v.vaultId, 'log')));
});
