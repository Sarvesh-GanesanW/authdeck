/**
 * vault.retire through the server: a solo vault's active device sets the vault it replaced aside,
 * the computer's user is told (the desktop app's notification), and the method is rate-limited
 * like appends. A restore sent by the same paired phone never unpairs it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createVault } from '../src/vault/build';
import { serializeEntry } from '../src/vault/entry';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase } from '../src/vault/recovery';
import { replayVault } from '../src/vault/replay';
import { RETIRED_KEEP_MS, signRetire } from '../src/vault/retire';
import { VAULT_APPEND_RATE } from '../src/server';
import { VaultAuthors } from '../src/vaultAuthors';
import { VaultStore } from '../src/vaultStore';
import { startTestServer, type TestServer } from './helpers/server';
import { device, seededRandom, soloRestoreLines } from './helpers/vault';

const random = seededRandom('vault-retire-server-tests');
const NOW = 1_800_000_000_000;
const NEW_VAULT = 'NNNNNNNNNNNNNNNNNNNNNN';
const paired = (server: TestServer) => server.config().devices.map((d) => d.deviceId).sort();

/** A solo vault (phrase set) saved through the paired device 'phone' on a test server. */
async function soloOnServer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-retire-'));
  const store = new VaultStore({ personal: path.join(home, 'vault'), team: () => null }, () => {}, () => NOW);
  const retired: { deviceName: string | null; keptUntil: number }[] = [];
  const server = await startTestServer({ vaults: store, vaultAuthors: VaultAuthors.load(home, () => {}), onVaultRetired: (info) => retired.push(info) });
  const phoneKeys = device(random);
  const created = createVault({ founder: phoneKeys, kind: 'solo', name: 'Home', deviceName: 'Phone', random, time: 1_000 });
  const phrase = generateRecoveryPhrase(random);
  const set = buildRecoverySetFromPhrase(replayVault(created.vaultId, { [phoneKeys.deviceId]: [serializeEntry(created.entry)] }), phoneKeys, { phrase, currentKey: created.key, random, time: 2_000 });
  const phone = await server.connect('phone');
  const reply = await phone.request('vault.append', { vaultId: created.vaultId, entries: [created.entry, set.entry] });
  assert.equal(reply.ok, true, reply.error?.message ?? 'refused');
  const logsNow = () => Object.fromEntries(Object.entries(store.read(created.vaultId, undefined).logs).map(([id, log]) => [id, log.lines]));
  return { home, store, server, retired, phone, phoneKeys, vaultId: created.vaultId, phrase, logsNow };
}

describe('vault.retire through the server', () => {
  let running: TestServer | null = null;
  afterEach(async () => {
    await running?.server.close();
    running = null;
  });

  it('retires the vault, tells the user with the device name, and logs the device, never ids or paths', async () => {
    const v = await soloOnServer();
    running = v.server;
    const request = signRetire({ vault: v.vaultId, newVault: NEW_VAULT, agentId: 'agent', time: NOW }, v.phoneKeys);
    const reply = await v.phone.request('vault.retire', { vaultId: v.vaultId, request });
    assert.equal(reply.ok, true, reply.error?.message ?? 'refused');
    assert.deepEqual(reply.result, { keptUntil: NOW + RETIRED_KEEP_MS });
    assert.deepEqual(v.retired, [{ deviceName: 'phone', keptUntil: NOW + RETIRED_KEEP_MS }]);
    const logged = v.server.logLines.filter((line) => line.includes('replaced a vault'));
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /phone replaced a vault with a new one/);
    for (const secret of [v.vaultId, NEW_VAULT, v.home]) assert.equal(logged[0]!.includes(secret), false);
    // A retry changes nothing and tells nobody again.
    const again = await v.phone.request('vault.retire', { vaultId: v.vaultId, request });
    assert.deepEqual(again.result, { keptUntil: NOW + RETIRED_KEEP_MS });
    assert.equal(v.retired.length, 1);
    const listed = await v.phone.request('vault.list', {});
    assert.deepEqual(listed.result.vaults[0].retired, { at: NOW, keptUntil: NOW + RETIRED_KEEP_MS, newVaultId: NEW_VAULT, byDevice: 'phone' });
    v.phone.close();
  });

  it('refuses a request signed by another paired device, and tells nobody', async () => {
    const v = await soloOnServer();
    running = v.server;
    const other = await v.server.connect('tablet');
    const request = signRetire({ vault: v.vaultId, newVault: NEW_VAULT, agentId: 'agent', time: NOW }, device(random));
    const reply = await other.request('vault.retire', { vaultId: v.vaultId, request });
    assert.equal(reply.ok, false);
    assert.equal(reply.error?.code, 'bad_request');
    assert.deepEqual(v.retired, []);
    assert.equal(v.store.list()[0]!.retired, undefined);
    v.phone.close();
    other.close();
  });

  it('is rate-limited like appends', async () => {
    const v = await soloOnServer();
    running = v.server;
    // The append above took one token.
    for (let i = 1; i < VAULT_APPEND_RATE.burst; i++) {
      const reply = await v.phone.request('vault.retire', { vaultId: v.vaultId, request: {} });
      assert.equal(reply.error?.code, 'bad_request');
    }
    const limited = await v.phone.request('vault.retire', { vaultId: v.vaultId, request: {} });
    assert.equal(limited.error?.code, 'rate_limited');
    v.phone.close();
  });

  it('a restore sent by the same paired phone does not unpair it, though its old identity is out', async () => {
    const v = await soloOnServer();
    running = v.server;
    const lines = soloRestoreLines(v.vaultId, v.logsNow(), v.phrase, device(random), random, 3_000);
    const reply = await v.phone.request('vault.append', { vaultId: v.vaultId, entries: lines });
    assert.equal(reply.ok, true, reply.error?.message ?? 'refused');
    assert.deepEqual(reply.result.removals, [{ device: v.phoneKeys.deviceId, unpairedFrom: null }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(paired(v.server), ['phone']);
    assert.equal((await v.phone.request('vault.list', {})).ok, true);
    v.phone.close();
  });

  it('a restore sent by another paired device still unpairs the old phone', async () => {
    const v = await soloOnServer();
    running = v.server;
    const newPhone = await v.server.connect('new-phone');
    const lines = soloRestoreLines(v.vaultId, v.logsNow(), v.phrase, device(random), random, 3_000);
    const reply = await newPhone.request('vault.append', { vaultId: v.vaultId, entries: lines });
    assert.equal(reply.ok, true, reply.error?.message ?? 'refused');
    assert.deepEqual(reply.result.removals, [{ device: v.phoneKeys.deviceId, unpairedFrom: 'Mac' }]);
    await v.phone.closed;
    assert.deepEqual(paired(v.server), ['new-phone']);
    newPhone.close();
  });
});
