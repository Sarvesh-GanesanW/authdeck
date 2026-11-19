import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VaultEntry } from '../src/protocol';
import { buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, buildKeyRotate, newAccountId } from '../src/vault/build';
import { planAppend } from '../src/vault/logs';
import { openVault } from '../src/vault/open';
import { remakeRejected } from '../src/auth/engine/remake';
import { replayVault } from '../src/vault/replay';
import {
  APPEND_LIMITS,
  appendBatches,
  headsAfterUpload,
  mergeLogs,
  ownHeadAfterUpload,
  ownHeadBeforeUpload,
  ownSentLength,
  pendingUploads,
  provenForks,
  readWholeFolder,
  withOwnHead,
  type ReadPage,
} from '../src/auth/engine/sync';
import { entryHash, serializeEntry, type SignedEntry } from '../src/vault/entry';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers';

const random = seededRandom('sync-tests');

/** Pages the way agent/src/vaultStore.ts does: devices sorted, a line budget, always one line. */
function pager(logs: Record<string, string[]>, maxLines: number): { readPage: ReadPage; calls: () => number } {
  let calls = 0;
  const readPage: ReadPage = async (since) => {
    calls++;
    let budget = maxLines;
    const page: Record<string, { from: number; lines: string[] }> = {};
    for (const deviceId of Object.keys(logs).sort()) {
      const lines = logs[deviceId]!;
      const from = Math.min(since[deviceId] ?? 0, lines.length);
      const taken = lines.slice(from, from + budget);
      budget -= taken.length;
      page[deviceId] = { from, lines: taken };
    }
    return { logs: page, lengths: Object.fromEntries(Object.entries(logs).map(([id, l]) => [id, l.length])), location: 'personal' };
  };
  return { readPage, calls: () => calls };
}

function vaultWithTwoDevices() {
  const founder = device(random);
  const vault = new MemoryVault(founder, random);
  const second = device(random);
  vault.write(buildDeviceAdd(vault.state(), founder, { device: second, role: 'admin', name: 'Tablet', currentKey: vault.key, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), second, vault.now()));
  return { founder, second, vault };
}

function addAccount(vault: MemoryVault, author = vault.founder) {
  return vault.write(buildAccountPut(vault.state(), author, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
}

describe('readWholeFolder', () => {
  const [A, B, C] = ['A', 'B', 'C'].map((c) => c.repeat(22));

  it('reads every line across pages that stop part-way through a file', async () => {
    const logs = { [A]: ['1', '2', '3', '4', '5'], [B]: ['x', 'y', 'z'], [C]: [] };
    const { readPage, calls } = pager(logs, 2);
    const read = await readWholeFolder(readPage);
    assert.deepEqual(read.logs, logs);
    assert.equal(calls(), 4);
  });

  it('reads a folder that fits one page in one call', async () => {
    const { readPage, calls } = pager({ [A]: ['1'] }, 1000);
    assert.deepEqual((await readWholeFolder(readPage)).logs, { [A]: ['1'] });
    assert.equal(calls(), 1);
  });

  it('fails when the computer stops sending lines it says exist', async () => {
    const stuck: ReadPage = async () => ({ logs: { [A]: { from: 0, lines: [] } }, lengths: { [A]: 3 }, location: 'personal' });
    await assert.rejects(readWholeFolder(stuck), /stopped sending/);
  });

  it('fails when a file changes between pages', async () => {
    let call = 0;
    const shifting: ReadPage = async () => (call++ === 0 ? { logs: { [A]: { from: 0, lines: ['1'] } }, lengths: { [A]: 2 }, location: 'personal' } : { logs: { [A]: { from: 0, lines: ['1', '2'] } }, lengths: { [A]: 2 }, location: 'personal' });
    await assert.rejects(readWholeFolder(shifting), /changed while/);
  });

  it('skips a log named "__proto__" (or any non-id) instead of letting it key an object', async () => {
    const hostile: ReadPage = async () => JSON.parse(`{"logs": {"__proto__": {"from": 0, "lines": ["x"]}, "${A}": {"from": 0, "lines": ["1"]}}, "lengths": {"__proto__": 9, "${A}": 1}, "location": "personal"}`);
    const read = await readWholeFolder(hostile);
    assert.deepEqual(Object.keys(read.logs), [A]);
    assert.equal(Object.getPrototypeOf(read.logs), Object.prototype);
  });
});

describe('appendBatches', () => {
  const entry = (size: number) => ({ v: 2, vault: 'v', author: 'a', seq: 0, prev: null, seen: {}, time: 0, kind: 'account.put', body: { pad: 'x'.repeat(size) }, sig: 's' }) as VaultEntry;

  it('keeps every batch under the entry count and byte limits, in order', () => {
    const entries = Array.from({ length: 2500 }, (_, i) => ({ ...entry(10), seq: i }));
    const batches = appendBatches(entries);
    assert.deepEqual(batches.map((b) => b.length), [1000, 1000, 500]);
    assert.deepEqual(batches.flat().map((e) => e.seq), entries.map((e) => e.seq));
    const big = Array.from({ length: 10 }, () => entry(100 * 1024));
    for (const batch of appendBatches(big)) assert.ok(JSON.stringify(batch).length <= APPEND_LIMITS.bytes);
  });

  it('refuses an entry the computer could never take', () => {
    assert.throws(() => appendBatches([entry(APPEND_LIMITS.entryBytes)]), /too large/);
  });
});

describe('mergeLogs and the outbox', () => {
  it('takes newer lines from the folder and keeps lines the folder lacks', () => {
    const { vault, second } = vaultWithTwoDevices();
    const local = vault.copy();
    addAccount(vault, second); // arrives from the folder
    const folder = vault.copy();
    const mine = { ...local };
    const localVault = Object.assign(Object.create(Object.getPrototypeOf(vault)), vault, { logs: mine });
    addAccount(localVault); // made offline on the founder
    const merged = mergeLogs(mine, replayVault(vault.vaultId, mine), folder, replayVault(vault.vaultId, folder));
    assert.equal(merged.logs[second.deviceId]!.length, folder[second.deviceId]!.length);
    assert.equal(merged.logs[vault.founder.deviceId]!.length, mine[vault.founder.deviceId]!.length);
    assert.deepEqual(merged.diverged, []);
  });

  it('sends only this device\'s new lines as a plain append', () => {
    const { vault } = vaultWithTwoDevices();
    const folder = vault.copy();
    const remembered = replayVault(vault.vaultId, folder).heads;
    addAccount(vault);
    const uploads = pendingUploads(vault.logs, vault.state(), replayVault(vault.vaultId, folder), vault.founder.deviceId, remembered);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]!.repair, false);
    assert.equal(uploads[0]!.entries.length, 1);
    assert.equal(uploads[0]!.entries[0]!.author, vault.founder.deviceId);
  });

  it('repairs lines the folder lost up to the remembered heads, founder first, with the heads as proof', () => {
    const { vault, second } = vaultWithTwoDevices();
    const remembered = vault.state().heads;
    const uploads = pendingUploads(vault.logs, vault.state(), replayVault(vault.vaultId, {}), second.deviceId, remembered);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]!.repair, true);
    assert.equal(uploads[0]!.entries[0]!.kind, 'vault.create');
    assert.equal(uploads[0]!.entries.length, 3);
    assert.deepEqual(uploads[0]!.proof, Object.fromEntries(Object.entries(remembered).map(([id, h]) => [id, { seq: h.seq, hash: h.hash }])));
  });

  it('never writes back another device\'s lines the folder was not seen to hold', () => {
    const { vault, second } = vaultWithTwoDevices();
    const uploads = pendingUploads(vault.logs, vault.state(), replayVault(vault.vaultId, {}), second.deviceId, {});
    assert.deepEqual(uploads.map((u) => [u.repair, u.entries.map((e) => e.author)]), [[false, [second.deviceId]]]);
  });

  it('repairs first, then appends this device\'s new lines', () => {
    const { vault } = vaultWithTwoDevices();
    const remembered = vault.state().heads;
    addAccount(vault);
    const uploads = pendingUploads(vault.logs, vault.state(), replayVault(vault.vaultId, {}), vault.founder.deviceId, remembered);
    assert.deepEqual(uploads.map((u) => [u.repair, u.entries.length]), [[true, 3], [false, 1]]);
  });

  it('has nothing to send when the folder matches', () => {
    const { vault } = vaultWithTwoDevices();
    assert.deepEqual(pendingUploads(vault.logs, vault.state(), vault.state(), vault.founder.deviceId, vault.state().heads), []);
  });

  it('remembers the sent heads only after an upload', () => {
    const { vault } = vaultWithTwoDevices();
    const before = replayVault(vault.vaultId, vault.copy()).heads;
    addAccount(vault);
    const state = vault.state();
    assert.deepEqual(pendingUploads(vault.logs, state, replayVault(vault.vaultId, vault.copy()), vault.founder.deviceId, before), []);
    const sent = { entries: [JSON.parse(vault.logs[vault.founder.deviceId]!.at(-1)!) as VaultEntry], repair: false };
    const heads = headsAfterUpload(before, state, sent);
    assert.equal(heads[vault.founder.deviceId]!.seq, state.heads[vault.founder.deviceId]!.seq);
  });

  it('repairs this device\'s own lines up to the stored own head when the folder lost them (N7)', () => {
    const { vault } = vaultWithTwoDevices();
    const own = vault.founder.deviceId;
    const put = addAccount(vault);
    const folder = { ...vault.copy(), [own]: vault.logs[own]!.slice(0, put.seq) };
    // The remembered heads lag (say, the read after the upload never happened); the own head doesn't.
    const remembered = replayVault(vault.vaultId, folder).heads;
    const ownHead = { seq: put.seq, hash: entryHash(put) };
    const uploads = pendingUploads(vault.logs, vault.state(), replayVault(vault.vaultId, folder), own, withOwnHead(remembered, own, ownHead));
    assert.deepEqual(uploads.map((u) => [u.repair, u.entries.length, u.proof?.[own]?.seq]), [[true, 1, put.seq]]);
  });

  it('raises the stored own head only with this device\'s own sent lines', () => {
    const { vault, second } = vaultWithTwoDevices();
    const own = vault.founder.deviceId;
    const put = addAccount(vault);
    const state = vault.state();
    assert.equal(ownHeadAfterUpload(null, state, own, { entries: [JSON.parse(vault.logs[second.deviceId]![0]!) as VaultEntry], repair: false }), null);
    assert.deepEqual(ownHeadAfterUpload(null, state, own, { entries: [put as VaultEntry], repair: false }), { seq: put.seq, hash: entryHash(put) });
  });

  it('never writes back the log of a device proven to have signed two histories', () => {
    const { vault, second } = vaultWithTwoDevices();
    const first = addAccount(vault, second);
    const other = buildAccountPut(replayVault(vault.vaultId, { ...vault.copy(), [second.deviceId]: vault.logs[second.deviceId]!.slice(0, -1) }), second, {
      account: newAccountId(random),
      record: totpRecord(),
      currentKey: vault.key,
      random,
      time: vault.now(),
    });
    const proof = { deviceId: second.deviceId, seq: first.seq, lines: [serializeEntry(first), serializeEntry(other)] as [string, string] };
    const local = replayVault(vault.vaultId, vault.logs, { forks: [proof] });
    const uploads = pendingUploads(vault.logs, local, replayVault(vault.vaultId, {}), vault.founder.deviceId, vault.state().heads);
    assert.ok(uploads.every((u) => u.entries.every((e) => e.author !== second.deviceId)));
    assert.deepEqual(provenForks(local, [proof, { deviceId: second.deviceId, seq: 0, lines: ['x', 'y'] }, null, 'junk']), [proof]);
  });
});

describe('a send whose answer was lost (N7)', () => {
  it('counts the lines as sent before they go, re-sends the same bytes, and makes a rejected one again after it', () => {
    const { vault, second } = vaultWithTwoDevices();
    const own = second.deviceId;
    // A third device joins; the founder's copy stops there.
    const third = device(random);
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: third, role: 'admin', name: 'Old', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), third, vault.now()));
    const founderView = vault.state();
    // The third device makes a fresh key, which the tablet sees.
    const rotation = buildKeyRotate(founderView, third, { currentKey: vault.key, random, time: vault.now() });
    vault.write(rotation.entry);
    const shared = vault.copy();
    const sharedState = replayVault(vault.vaultId, shared);
    // The tablet signs a put under that key; it is stored locally and counted as sent before the upload.
    const put = buildAccountPut(sharedState, second, { account: newAccountId(random), record: totpRecord({ issuer: 'Kept' }), currentKey: rotation.newKey, random, time: vault.now() });
    const local = { ...shared, [own]: [...shared[own]!, serializeEntry(put)] };
    const upload = { entries: [put as VaultEntry], repair: false };
    const ownHead = ownHeadBeforeUpload(null, own, upload);
    assert.deepEqual(ownHead, { seq: put.seq, hash: entryHash(put) });
    // The answer is lost and, meanwhile, the founder (not having seen the fresh key) removes the
    // third device, so that key never becomes the vault's.
    const removal = buildDeviceRemove(founderView, vault.founder, { device: third.deviceId, currentKey: vault.key, random, time: vault.now() });
    const folderLogs = planAppend(vault.vaultId, shared, [removal.entry]).logs;
    const remote = replayVault(vault.vaultId, folderLogs);
    // Next sync: the line counts as sent, so remake keeps it and makes the change again after it.
    const merged = mergeLogs(local, replayVault(vault.vaultId, local), folderLogs, remote);
    const mergedState = replayVault(vault.vaultId, merged.logs);
    assert.match(mergedState.history.find((h) => h.hash === entryHash(put))!.status, /rejected/);
    const remade = remakeRejected({ logs: merged.logs, state: mergedState, sentLength: ownSentLength(remote, own, ownHead), device: second, keys: openVault(mergedState, second).keys, random, time: vault.now(), replay: {} });
    assert.ok(remade);
    assert.equal(remade.logs[own]![put.seq], serializeEntry(put), 'the sent seq is never signed again');
    assert.equal(remade.logs[own]!.length, put.seq + 2);
    // The outbox sends the identical line first (the computer keeps it as a placeholder), then the remake.
    const uploads = pendingUploads(remade.logs, remade.state, remote, own, withOwnHead(remote.heads, own, ownHead));
    const sentLines = uploads.flatMap((u) => u.entries.map((e) => serializeEntry(e as SignedEntry)));
    assert.equal(sentLines[0], serializeEntry(put));
    let folderNow = folderLogs;
    for (const u of uploads) folderNow = planAppend(vault.vaultId, folderNow, u.entries, u.repair ? { repair: true, proof: u.proof } : {}).logs;
    const final = replayVault(vault.vaultId, folderNow);
    assert.equal(final.chains[own]![put.seq], entryHash(put));
    const open = openVault(final, second);
    assert.equal(Object.values(open.accounts).some((a) => a.record.issuer === 'Kept'), true);
  });

  it('a computer that never stored the line takes the same bytes later', () => {
    const { vault, second } = vaultWithTwoDevices();
    const own = second.deviceId;
    const put = buildAccountPut(vault.state(), second, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    const folder = vault.copy();
    vault.write(put);
    const ownHead = ownHeadBeforeUpload(null, own, { entries: [put as VaultEntry], repair: false });
    const remote = replayVault(vault.vaultId, folder);
    assert.equal(ownSentLength(remote, own, ownHead), put.seq + 1);
    const uploads = pendingUploads(vault.logs, vault.state(), remote, own, withOwnHead(remote.heads, own, ownHead));
    assert.deepEqual(uploads.map((u) => [u.repair, u.entries.length]), [[true, 1]]);
    const after = planAppend(vault.vaultId, folder, uploads[0]!.entries, { repair: true, proof: uploads[0]!.proof });
    assert.equal(after.state.chains[own]![put.seq], entryHash(put));
  });
});
