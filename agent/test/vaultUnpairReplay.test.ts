/**
 * Who sent a vault identity's lines is learnt only from lines that changed the folder, and only
 * for one device's own new lines: sending another device's stored lines again can't move that
 * device's unpairing onto the sender, nor let a removed device dodge its own.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { buildDeviceAdd, buildDeviceHello, buildDeviceRemove, createVault } from '../src/vault/build';
import { replayVault } from '../src/vault/replay';
import { VaultAuthors } from '../src/vaultAuthors';
import { VaultStore } from '../src/vaultStore';
import { startTestServer, type TestServer } from './helpers/server';
import { device, seededRandom } from './helpers/vault';

const random = seededRandom('vault-unpair-replay-tests');
const paired = (server: TestServer) => server.config().devices.map((d) => d.deviceId).sort();

describe('the record of who sent which identity ignores lines sent again', () => {
  let running: TestServer | null = null;
  afterEach(async () => {
    await running?.server.close();
    running = null;
  });

  it('a device that sends another device\'s stored lines again is not taken for it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-unpair-replay-'));
    const store = new VaultStore({ personal: path.join(home, 'vault'), team: () => null });
    const authors = VaultAuthors.load(home, () => {});
    const server = await startTestServer({ vaults: store, vaultAuthors: authors });
    running = server;
    const [phoneKeys, tabletKeys] = [device(random), device(random)];
    const created = createVault({ founder: phoneKeys, kind: 'personal', name: 'Home', deviceName: 'Phone', random, time: 1_000 });
    const stateNow = () => {
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
    await append(tablet, [hello]);
    // The phone sends the tablet's stored line again: the folder doesn't change.
    await append(phone, [hello]);
    assert.equal(authors.linkDeviceOf(created.vaultId, tabletKeys.deviceId), 'tablet');
    assert.equal(authors.linkDeviceOf(created.vaultId, phoneKeys.deviceId), 'phone');
    const removal = buildDeviceRemove(stateNow(), phoneKeys, { device: tabletKeys.deviceId, currentKey: created.key, random, time: 4_000 });
    const result = await append(phone, [removal.entry]);
    assert.deepEqual(result.removals, [{ device: tabletKeys.deviceId, unpairedFrom: 'Mac' }]);
    await tablet.closed;
    assert.deepEqual(paired(server), ['phone']);
    phone.close();
  });
});
