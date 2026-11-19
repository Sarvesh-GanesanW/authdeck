/**
 * A removal this phone signed offline of the device that then removed it first: the phone keeps
 * it, offers it for upload once it pairs again, and says so on the removed screen.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { remakeRejected } from '../src/auth/engine/remake';
import { heldRemoval, heldRemovalSentence, removedSentence } from '../src/auth/engine/removed';
import { buildSnapshot } from '../src/auth/engine/snapshot';
import { heldRemovalUploads, mergeLogs, pendingUploads } from '../src/auth/engine/sync';
import { buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, newAccountId } from '../src/vault/build';
import { entryHash, serializeEntry } from '../src/vault/entry';
import { openVault } from '../src/vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase } from '../src/vault/recovery';
import { replayVault } from '../src/vault/replay';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers';

const random = seededRandom('held-removal-tests');

/**
 * The owner's phone (the founder) and a thief's device. Offline, the phone adds an account and
 * removes the thief; the thief, not having seen that, removes the phone through the computer.
 */
function heldCounterRemoval() {
  const vault = new MemoryVault(device(random), random);
  const owner = vault.founder;
  const thief = device(random);
  const recovery = buildRecoverySetFromPhrase(vault.state(), owner, { phrase: generateRecoveryPhrase(random), currentKey: vault.key, random, time: vault.now() });
  vault.write(recovery.entry);
  const key = recovery.newKey;
  vault.write(buildDeviceAdd(vault.state(), owner, { device: thief, role: 'admin', name: 'Thief', currentKey: key, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), thief, vault.now()));
  const shared = vault.state();
  const sharedLogs = vault.copy();

  // The thief's removal reaches the folder.
  vault.write(buildDeviceRemove(shared, thief, { device: owner.deviceId, currentKey: key, random, time: vault.now() }).entry);
  const folder = vault.copy();

  // The phone's offline lines, signed on the vault as it saw it, never sent.
  const put = buildAccountPut(shared, owner, { account: newAccountId(random), record: totpRecord(), currentKey: key, random, time: vault.now() });
  const afterPut = replayVault(vault.vaultId, { ...sharedLogs, [owner.deviceId]: [...sharedLogs[owner.deviceId]!, serializeEntry(put)] });
  const removal = buildDeviceRemove(afterPut, owner, { device: thief.deviceId, currentKey: key, random, time: vault.now() }).entry;
  const local = { ...folder, [owner.deviceId]: [...folder[owner.deviceId]!, serializeEntry(put), serializeEntry(removal)] };
  return { vault, owner, thief, folder, local, put, removal, folderSeq: folder[owner.deviceId]!.length - 1 };
}

const names = (owner: string) => (id: string) => (id === owner ? 'Phone' : 'Thief');

describe('a counter-removal held on a removed phone', () => {
  it('is found as held: this phone is out, its removal of its remover is a true-symmetric counter-removal the folder lacks', () => {
    const { vault, owner, thief, local, removal, folderSeq } = heldCounterRemoval();
    const state = replayVault(vault.vaultId, local);
    assert.equal(state.members[owner.deviceId]?.removed, true);
    assert.ok(state.counterRemovals.includes(entryHash(removal)));
    assert.deepEqual(heldRemoval(state, owner.deviceId, folderSeq), { targets: [thief.deviceId], lastSeq: removal.seq });
  });

  it('survives learning of the removal: the merge keeps it and nothing remakes or drops it', () => {
    const { vault, owner, folder, local, removal } = heldCounterRemoval();
    const localState = replayVault(vault.vaultId, local);
    const folderState = replayVault(vault.vaultId, folder);
    const merged = mergeLogs(local, localState, folder, folderState);
    assert.equal(merged.logs[owner.deviceId]!.at(-1), serializeEntry(removal));
    const remade = remakeRejected({ logs: merged.logs, state: localState, sentLength: folder[owner.deviceId]!.length, device: owner, keys: {}, random, time: vault.now(), replay: {} });
    assert.equal(remade, null, 'a removed device remakes nothing, so its unsent lines stay as signed');
  });

  it('is offered for upload with the caught account change it chains on, and nothing else', () => {
    const { vault, owner, folder, local, put, removal, folderSeq } = heldCounterRemoval();
    const state = replayVault(vault.vaultId, local);
    const caught = state.history.find((h) => h.hash === entryHash(put));
    assert.equal(caught?.status, 'rejected');
    assert.equal(caught?.caught, true);
    const outbox = pendingUploads(local, state, replayVault(vault.vaultId, folder), owner.deviceId, {});
    const held = heldRemoval(state, owner.deviceId, folderSeq)!;
    const uploads = heldRemovalUploads(outbox, state, owner.deviceId, held.lastSeq);
    assert.deepEqual(
      uploads.map((u) => [u.repair, u.entries.map((e) => entryHash(e as never))]),
      [[false, [entryHash(put), entryHash(removal)]]],
    );
  });

  it('sends nothing when an own line before it would be refused on its own', () => {
    const { vault, owner, folder, local, put, folderSeq } = heldCounterRemoval();
    const state = replayVault(vault.vaultId, local);
    const notCaught = { ...state, history: state.history.map((h) => (h.hash === entryHash(put) ? { ...h, caught: undefined } : h)) };
    const outbox = pendingUploads(local, state, replayVault(vault.vaultId, folder), owner.deviceId, {});
    assert.deepEqual(heldRemovalUploads(outbox, notCaught, owner.deviceId, heldRemoval(state, owner.deviceId, folderSeq)!.lastSeq), []);
  });

  it('tells the person to pair again, and offers Re-pair through the snapshot', () => {
    const { vault, owner, local, folderSeq } = heldCounterRemoval();
    const state = replayVault(vault.vaultId, local);
    const held = heldRemoval(state, owner.deviceId, folderSeq)!;
    const text = heldRemovalSentence(held, names(owner.deviceId), 'Mac');
    assert.match(text, /^Thief removed this phone\. You removed Thief on this phone before that\. To send your removal, pair this phone with Mac again\. /);
    assert.match(heldRemovalSentence(held, () => null, null), /^Another device removed this phone\. .+ pair this phone with your computer again\./);

    const snapshot = buildSnapshot({
      loaded: true,
      prefs: { vaultId: vault.vaultId, deviceId: owner.deviceId, appLock: false, autoLockMs: 60_000, recoverySavedAt: null, location: null, folderPath: null },
      state,
      open: openVault(state, owner),
      thisDevice: owner.deviceId,
      folderRejections: [],
      readAt: 0,
      rollbackWarning: null,
      lockAt: null,
      computerName: 'Mac',
      computerOnline: false,
      heardAt: {},
      forked: new Set(),
      warnings: [],
      secretsPaused: false,
      removed: text,
      heldRemoval: true,
      logs: local,
      handledCaught: new Set(),
    });
    assert.equal(snapshot.heldRemoval, true);
    assert.equal(snapshot.removed, text);
    assert.equal(snapshot.secretsPaused, true);
  });

  it('once the folder holds it, both are out and the screen points to the recovery phrase', () => {
    const { vault, owner, thief, local, removal } = heldCounterRemoval();
    const state = replayVault(vault.vaultId, local);
    assert.equal(heldRemoval(state, owner.deviceId, removal.seq), null);
    assert.equal(state.members[thief.deviceId]?.removed, true);
    assert.match(removedSentence(state, owner.deviceId, names(owner.deviceId))!, /^Thief removed this device at the same time it was removed itself, so neither is in the vault now\. .*recovery phrase/);
  });

  it('is nothing to hold for a phone removed without having removed its remover', () => {
    const { vault, owner, folder } = heldCounterRemoval();
    const state = replayVault(vault.vaultId, folder);
    assert.equal(state.members[owner.deviceId]?.removed, true);
    assert.equal(heldRemoval(state, owner.deviceId, -1), null);
  });
});
