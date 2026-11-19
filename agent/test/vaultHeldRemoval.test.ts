/**
 * A counter-removal held on a phone the vault removed: the owner's phone removed a thief's device
 * while offline, the thief removed the phone through this computer first (which unpaired it), and
 * the owner pairs the phone again to send the removal it signed. The agent admits it as a
 * true-symmetric counter-removal, so both are out, and the recovery phrase takes the vault back.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { buildDeviceAdd, buildDeviceHello, buildDeviceRemove, createVault } from '../src/vault/build';
import { entryHash } from '../src/vault/entry';
import { openVault } from '../src/vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, restoreWithPhrase } from '../src/vault/recovery';
import { replayVault, type VaultState } from '../src/vault/replay';
import { VaultAuthors } from '../src/vaultAuthors';
import { VaultStore } from '../src/vaultStore';
import { startTestServer, type TestServer } from './helpers/server';
import { device, seededRandom } from './helpers/vault';

const random = seededRandom('vault-held-removal-tests');

const paired = (server: TestServer) => server.config().devices.map((d) => d.deviceId).sort();

describe('a counter-removal held on a removed phone', () => {
  let running: TestServer | null = null;
  afterEach(async () => {
    await running?.server.close();
    running = null;
  });

  it('is admitted after the phone pairs again, takes both devices out, and the phrase restores the vault', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-held-removal-'));
    const store = new VaultStore({ personal: path.join(home, 'vault'), team: () => null });
    const server = await startTestServer({ vaults: store, vaultAuthors: VaultAuthors.load(home, () => {}) });
    running = server;
    const ownerKeys = device(random);
    const thiefKeys = device(random);
    const created = createVault({ founder: ownerKeys, kind: 'personal', name: 'Home', deviceName: 'Phone', random, time: 1_000 });
    const vaultId = created.vaultId;
    const stateNow = (): VaultState => {
      const read = store.read(vaultId, undefined);
      return replayVault(vaultId, Object.fromEntries(Object.entries(read.logs).map(([id, log]) => [id, log.lines])));
    };
    const appendVia = async (link: Awaited<ReturnType<TestServer['connect']>>, entries: unknown[]) => {
      const reply = await link.request('vault.append', { vaultId, entries });
      assert.equal(reply.ok, true, reply.error?.message ?? 'refused');
      return reply.result as { lengths: Record<string, number>; removals?: { device: string; unpairedFrom: string | null }[] };
    };

    const phone = await server.connect('phone');
    const thief = await server.connect('thief');
    await appendVia(phone, [created.entry]);
    const phrase = generateRecoveryPhrase(random);
    const recovery = buildRecoverySetFromPhrase(stateNow(), ownerKeys, { phrase, currentKey: created.key, random, time: 1_500 });
    await appendVia(phone, [recovery.entry]);
    await appendVia(phone, [buildDeviceAdd(stateNow(), ownerKeys, { device: thiefKeys, role: 'admin', name: 'Thief', currentKey: recovery.newKey, random, time: 2_000 })]);
    await appendVia(thief, [buildDeviceHello(stateNow(), thiefKeys, 3_000)]);

    // Offline, the owner's phone removes the thief: signed and kept on the phone, not sent.
    const shared = stateNow();
    const held = buildDeviceRemove(shared, ownerKeys, { device: thiefKeys.deviceId, currentKey: recovery.newKey, random, time: 4_000 });
    // The thief, not having seen it, removes the phone through this computer first.
    const first = await appendVia(thief, [buildDeviceRemove(shared, thiefKeys, { device: ownerKeys.deviceId, currentKey: recovery.newKey, random, time: 4_500 }).entry]);
    assert.deepEqual(first.removals, [{ device: ownerKeys.deviceId, unpairedFrom: 'Mac' }]);
    await phone.closed;
    assert.deepEqual(paired(server), ['thief']);
    assert.equal(stateNow().members[ownerKeys.deviceId]?.removed, true);
    assert.equal(stateNow().members[thiefKeys.deviceId]?.removed, false);

    // The owner pairs the phone again and sends the removal it held.
    const again = await server.connect('phone');
    const sent = await appendVia(again, [held.entry]);
    const after = stateNow();
    assert.ok(after.counterRemovals.includes(entryHash(held.entry)), 'admitted as a true-symmetric counter-removal');
    assert.equal(after.members[ownerKeys.deviceId]?.removed, true);
    assert.equal(after.members[thiefKeys.deviceId]?.removed, true);
    assert.ok(sent.removals?.some((r) => r.device === thiefKeys.deviceId && r.unpairedFrom === 'Mac'), 'the thief is unpaired from this computer');
    await thief.closed;
    assert.equal(paired(server).includes('thief'), false);

    // Everyone involved is out: a fresh phone restores with the phrase through this computer.
    const freshKeys = device(random);
    const restorer = await server.connect('fresh');
    const restore = restoreWithPhrase(after, { phrase, device: freshKeys, name: 'New phone', random, time: 5_000 });
    await appendVia(restorer, [restore.entry]);
    await appendVia(restorer, [buildDeviceHello(stateNow(), freshKeys, 5_500)]);
    const restored = stateNow();
    assert.equal(restored.members[freshKeys.deviceId]?.removed, false);
    assert.equal(openVault(restored, freshKeys).name, 'Home');
    restorer.close();
  });
});
