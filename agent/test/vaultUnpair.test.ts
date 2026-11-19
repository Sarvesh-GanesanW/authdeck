/**
 * Removing a device from a vault through this agent also unpairs the phone or tablet that is that
 * device: a stolen phone that is still paired could otherwise keep pressing keys on the computer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, createVault, newAccountId, type CreatedVault } from '../src/vault/build';
import { replayVault, type VaultState } from '../src/vault/replay';
import { VaultAuthors } from '../src/vaultAuthors';
import { VaultStore } from '../src/vaultStore';
import { startTestServer, type TestServer } from './helpers/server';
import { device, seededRandom, totpRecord } from './helpers/vault';

const random = seededRandom('vault-unpair-tests');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-unpair-'));
}

/** A vault with two admin devices, `phone` (the founder) and `tablet`, on a test server. */
async function twoDeviceVault(options: { tabletJoinsThroughAgent: boolean }) {
  const home = tempDir();
  const store = new VaultStore({ personal: path.join(home, 'vault'), team: () => null });
  const authors = VaultAuthors.load(home, () => {});
  const server = await startTestServer({ vaults: store, vaultAuthors: authors });
  const phoneKeys = device(random);
  const tabletKeys = device(random);
  const created: CreatedVault = createVault({ founder: phoneKeys, kind: 'personal', name: 'Home', deviceName: 'Phone', random, time: 1_000 });
  const stateNow = (): VaultState => {
    const read = store.read(created.vaultId, undefined);
    return replayVault(created.vaultId, Object.fromEntries(Object.entries(read.logs).map(([id, log]) => [id, log.lines])));
  };
  const phone = await server.connect('phone');
  const tablet = await server.connect('tablet');
  const append = async (link: typeof phone, entries: unknown[]) => {
    const reply = await link.request('vault.append', { vaultId: created.vaultId, entries });
    assert.equal(reply.ok, true, reply.error?.message ?? 'refused');
    return reply.result;
  };
  await append(phone, [created.entry]);
  await append(phone, [buildDeviceAdd(stateNow(), phoneKeys, { device: tabletKeys, role: 'admin', name: 'Tablet', currentKey: created.key, random, time: 2_000 })]);
  const hello = buildDeviceHello(stateNow(), tabletKeys, 3_000);
  // Without the agent: as if the tablet's lines came through another computer and a sync tool.
  if (options.tabletJoinsThroughAgent) await append(tablet, [hello]);
  else store.append(created.vaultId, [hello], false);
  return { home, store, server, created, stateNow, phone, tablet, phoneKeys, tabletKeys, append };
}

const paired = (server: TestServer) => server.config().devices.map((d) => d.deviceId).sort();

describe('removing a device from the vault unpairs it from this computer', () => {
  let running: TestServer | null = null;
  afterEach(async () => {
    await running?.server.close();
    running = null;
  });

  it('cuts the removed device off at once and removes its pairing', async () => {
    const vault = await twoDeviceVault({ tabletJoinsThroughAgent: true });
    running = vault.server;
    const removal = buildDeviceRemove(vault.stateNow(), vault.phoneKeys, { device: vault.tabletKeys.deviceId, currentKey: vault.created.key, random, time: 4_000 });
    const result = await vault.append(vault.phone, [removal.entry]);
    assert.deepEqual(result.removals, [{ device: vault.tabletKeys.deviceId, unpairedFrom: 'Mac' }]);
    await vault.tablet.closed;
    assert.deepEqual(paired(vault.server), ['phone']);
    const logged = vault.server.logLines.filter((line) => line.includes('removed from a vault'));
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /tablet was removed from a vault, so it is unpaired from this computer/);
    assert.equal(logged[0]!.includes(vault.tabletKeys.deviceId), false, 'the log names the device, not its vault identity');
    // The phone stays paired and keeps working.
    assert.equal((await vault.phone.request('vault.list', {})).ok, true);
    vault.phone.close();
  });

  it('a symmetric conflict unpairs every paired device involved, the sender after its answer', async () => {
    const vault = await twoDeviceVault({ tabletJoinsThroughAgent: true });
    running = vault.server;
    const shared = vault.stateNow();
    // The tablet's removal of the phone reaches the folder through another computer…
    vault.store.append(vault.created.vaultId, [buildDeviceRemove(shared, vault.tabletKeys, { device: vault.phoneKeys.deviceId, currentKey: vault.created.key, random, time: 4_000 }).entry], false);
    // …while the phone, not having seen it, removes the tablet through this one.
    const counter = buildDeviceRemove(shared, vault.phoneKeys, { device: vault.tabletKeys.deviceId, currentKey: vault.created.key, random, time: 4_500 });
    const result = await vault.append(vault.phone, [counter.entry]);
    const after = vault.stateNow();
    assert.equal(after.members[vault.phoneKeys.deviceId]?.removed, true);
    assert.equal(after.members[vault.tabletKeys.deviceId]?.removed, true);
    assert.deepEqual(
      [...result.removals].sort((a: { device: string }, b: { device: string }) => a.device.localeCompare(b.device)),
      [vault.phoneKeys.deviceId, vault.tabletKeys.deviceId].sort().map((id) => ({ device: id, unpairedFrom: 'Mac' })),
    );
    await Promise.all([vault.phone.closed, vault.tablet.closed]);
    assert.deepEqual(paired(vault.server), []);
  });

  it('says it does not know when the removed device never sent its lines through this computer', async () => {
    const vault = await twoDeviceVault({ tabletJoinsThroughAgent: false });
    running = vault.server;
    const removal = buildDeviceRemove(vault.stateNow(), vault.phoneKeys, { device: vault.tabletKeys.deviceId, currentKey: vault.created.key, random, time: 4_000 });
    const result = await vault.append(vault.phone, [removal.entry]);
    assert.deepEqual(result.removals, [{ device: vault.tabletKeys.deviceId, unpairedFrom: null }]);
    assert.deepEqual(paired(vault.server), ['phone', 'tablet']);
    assert.equal((await vault.tablet.request('vault.list', {})).ok, true, 'the tablet is still paired');
    vault.phone.close();
    vault.tablet.close();
  });

  it('answers an append that removes nobody exactly as before', async () => {
    const vault = await twoDeviceVault({ tabletJoinsThroughAgent: true });
    running = vault.server;
    const put = buildAccountPut(vault.stateNow(), vault.phoneKeys, { account: newAccountId(random), record: totpRecord(), currentKey: vault.created.key, random, time: 4_000 });
    const result = await vault.append(vault.phone, [put]);
    assert.deepEqual(Object.keys(result), ['lengths']);
    assert.deepEqual(paired(vault.server), ['phone', 'tablet']);
    vault.phone.close();
    vault.tablet.close();
  });
});

describe('the record of who sent which identity', () => {
  const id = (c: string) => c.repeat(22);

  it('is kept in the agent home, survives a restart, and ignores ids that are not ids', () => {
    const home = tempDir();
    const authors = VaultAuthors.load(home, () => {});
    authors.record(id('V'), [id('A'), '__proto__', '../x'], 'phone');
    authors.record('__proto__', [id('A')], 'phone');
    const reloaded = VaultAuthors.load(home, () => {});
    assert.equal(reloaded.linkDeviceOf(id('V'), id('A')), 'phone');
    assert.equal(reloaded.linkDeviceOf(id('V'), '__proto__'), undefined);
    assert.equal(reloaded.linkDeviceOf('__proto__', id('A')), undefined);
    assert.deepEqual(fs.readdirSync(home), ['vault-authors.json']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, 'vault-authors.json')).mode & 0o777, 0o600);
  });

  it('drops malformed stored entries, "__proto__" keys included, and reads a damaged file as empty', () => {
    const home = tempDir();
    const file = path.join(home, 'vault-authors.json');
    fs.writeFileSync(file, `{"v":1,"vaults":{"__proto__":{"${id('A')}":"evil"},"${id('V')}":{"__proto__":"x","constructor":"y","${id('A')}":"phone","${id('B')}":5,"${id('C')}":""}}}`);
    const authors = VaultAuthors.load(home, () => {});
    assert.equal(authors.linkDeviceOf(id('V'), id('A')), 'phone');
    assert.equal(authors.linkDeviceOf(id('V'), id('B')), undefined);
    assert.equal(authors.linkDeviceOf(id('V'), id('C')), undefined);
    assert.equal(authors.linkDeviceOf(id('V'), 'constructor'), undefined);
    assert.equal(authors.linkDeviceOf('__proto__', id('A')), undefined);
    assert.equal(({} as Record<string, unknown>)[id('A')], undefined, 'nothing reached Object.prototype');
    fs.writeFileSync(file, '{not json');
    const logged: string[] = [];
    assert.equal(VaultAuthors.load(home, (line) => logged.push(line)).linkDeviceOf(id('V'), id('A')), undefined);
    assert.equal(logged.length, 1);
  });
});
