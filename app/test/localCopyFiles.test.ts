/**
 * The vault's local copy lives in files, not AsyncStorage (Android refuses a value over ~2 MB and
 * caps the store at 6 MB): a vault at its quotas saves and loads, a damaged file costs only what it
 * held, and a crash at any write leaves the old copy or the new one.
 */
import './native';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadForks, loadHandledCaught, loadLogs, loadSealProofs, saveForks, saveHandledCaught, saveLogs, saveSealProofs } from '../src/auth/engine/localCopy';
import { ADMIN_QUOTA, MEMBER_QUOTA, RESERVE_PER_IDENTITY } from '../src/vault/quota';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { faults, root } = require('expo-file-system') as {
  faults: { tearNext(match: RegExp | string, keep: number): void; failNext(match: RegExp | string): void; pending: unknown[] };
  root: string;
};

let next = 0;
/** A fresh 22-character id per test, so tests don't share a folder. */
function freshId(): string {
  next++;
  return `T${String(next).padStart(21, '0')}`;
}
const folderOf = (vaultId: string) => path.join(root, 'document', 'authdeck-vault-v1', vaultId);
const filesIn = (vaultId: string) => fs.readdirSync(folderOf(vaultId)).sort();
const logFile = (vaultId: string, id: string) => filesIn(vaultId).find((name) => name.startsWith(`${id}.`) && name.endsWith('.jsonl'))!;

/** n distinct lines of about `size` characters, shaped like entries (they start with "{"). */
function lines(tag: string, n: number, size: number): string[] {
  const pad = 'x'.repeat(Math.max(0, size - 40));
  return Array.from({ length: n }, (_, i) => `{"tag":"${tag}","n":${i},"pad":"${pad}"}`);
}

const A = 'A'.repeat(22);
const B = 'B'.repeat(22);
const C = 'C'.repeat(22);

describe('the local copy in files', () => {
  it('saves and loads a vault with identities at their quotas, past what AsyncStorage could hold', async () => {
    const vaultId = freshId();
    const admin = Math.floor(ADMIN_QUOTA.bytes / ADMIN_QUOTA.lines);
    const member = Math.floor(MEMBER_QUOTA.bytes / MEMBER_QUOTA.lines);
    const logs = {
      [A]: lines('admin', ADMIN_QUOTA.lines, admin - 2),
      [B]: lines('member', MEMBER_QUOTA.lines, member - 2),
      // An identity's reserved lines on top: rotations sealed to many devices, few but large.
      [C]: lines('reserve', 256, Math.floor(RESERVE_PER_IDENTITY.bytes / 256) - 2),
    };
    const total = Object.values(logs).reduce((sum, l) => sum + l.reduce((s, line) => s + line.length + 1, 0), 0);
    assert.ok(total > 20 * 1024 * 1024, `the fixture holds ${total} bytes`);
    await saveLogs(vaultId, logs);
    assert.deepEqual(await loadLogs(vaultId), logs);
  });

  it('appends a log that only grew, and writes a fresh file for one that changed otherwise', async () => {
    const vaultId = freshId();
    const first = { [A]: lines('a', 3, 50), [B]: lines('b', 2, 50) };
    await saveLogs(vaultId, first);
    await loadLogs(vaultId);
    const aFile = logFile(vaultId, A);
    const grown = { [A]: [...first[A]!, ...lines('a2', 2, 50)], [B]: lines('b-other', 2, 50) };
    await saveLogs(vaultId, grown);
    assert.equal(logFile(vaultId, A), aFile, 'the grown log was appended to its file');
    assert.notEqual(logFile(vaultId, B), undefined);
    assert.deepEqual(await loadLogs(vaultId), grown);
    // Old files go once no committed manifest names them.
    await saveLogs(vaultId, grown);
    assert.equal(filesIn(vaultId).filter((name) => name.startsWith(`${B}.`)).length, 1);
  });

  it('keeps lines that would break a row: newlines and a leading quote', async () => {
    const vaultId = freshId();
    const odd = { [A]: ['{"a":1}', 'two\nlines', '"quoted"', 'cr\r'] };
    await saveLogs(vaultId, odd);
    assert.deepEqual(await loadLogs(vaultId), odd);
  });

  it('keeps fork proofs and handled caught changes in files too', async () => {
    const vaultId = freshId();
    const fork = { deviceId: A, seq: 3, lines: ['x', 'y'] as [string, string] };
    const hash = 'h'.repeat(43);
    await saveForks(vaultId, [fork]);
    await saveHandledCaught(vaultId, new Set([hash, 'not a hash']));
    await saveLogs(vaultId, { [A]: ['l'] });
    assert.deepEqual(await loadForks(vaultId), [fork]);
    assert.deepEqual([...(await loadHandledCaught(vaultId))], [hash]);
    assert.deepEqual(await loadLogs(vaultId), { [A]: ['l'] });
  });
});

describe('bad-seal proofs on the device', () => {
  it('keeps proofs shaped like one, drops the rest, and reads a damaged file as none', async () => {
    const vaultId = freshId();
    const good = { entry: 'e'.repeat(43), to: A, proof: 'p'.repeat(128) };
    await saveSealProofs(vaultId, [good, { entry: 'x', to: A, proof: 'p'.repeat(128) } as never, { ...good, extra: 1 } as never]);
    assert.deepEqual(await loadSealProofs(vaultId), [good]);
    for (const name of filesIn(vaultId)) if (name.startsWith('seals.')) fs.writeFileSync(path.join(folderOf(vaultId), name), '[');
    assert.deepEqual(await loadSealProofs(vaultId), []);
  });
});

describe('a damaged local copy costs only what it held', () => {
  it('a log file cut short gives the whole rows before the cut; the next save writes it whole again', async () => {
    const vaultId = freshId();
    const logs = { [A]: lines('a', 5, 60), [B]: lines('b', 2, 60) };
    await saveLogs(vaultId, logs);
    const file = path.join(folderOf(vaultId), logFile(vaultId, A));
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.slice(0, text.indexOf('\n', text.indexOf('\n', text.indexOf('\n') + 1) + 1) + 10));
    const loaded = await loadLogs(vaultId);
    assert.deepEqual(loaded[A], logs[A]!.slice(0, 3));
    assert.deepEqual(loaded[B], logs[B]);
    // A sync brings the rest back; the save must not append after the torn row.
    await saveLogs(vaultId, logs);
    assert.deepEqual(await loadLogs(vaultId), logs);
  });

  it('garbage in a log file, or a missing one, loses only that log', async () => {
    const vaultId = freshId();
    const logs = { [A]: lines('a', 3, 60), [B]: lines('b', 2, 60) };
    await saveLogs(vaultId, logs);
    fs.writeFileSync(path.join(folderOf(vaultId), logFile(vaultId, A)), '"\u0000not json\n');
    fs.rmSync(path.join(folderOf(vaultId), logFile(vaultId, B)));
    assert.deepEqual(await loadLogs(vaultId), {});
    await saveLogs(vaultId, logs);
    assert.deepEqual(await loadLogs(vaultId), logs);
  });

  it('a damaged manifest falls back to the other one; both damaged is an empty copy that saves again', async () => {
    const vaultId = freshId();
    const old = { [A]: lines('a', 2, 60) };
    const fresh = { [A]: lines('a', 4, 60) };
    await saveLogs(vaultId, old);
    await saveLogs(vaultId, fresh);
    const dir = folderOf(vaultId);
    // The newest manifest is in slot b (second commit).
    fs.writeFileSync(path.join(dir, 'manifest-b.json'), fs.readFileSync(path.join(dir, 'manifest-b.json'), 'utf8').replace('"gen":2', '"gen":9'));
    assert.deepEqual(await loadLogs(vaultId), old, 'a manifest whose checksum fails is ignored');
    fs.writeFileSync(path.join(dir, 'manifest-a.json'), 'garbage');
    assert.deepEqual(await loadLogs(vaultId), {});
    await saveLogs(vaultId, fresh);
    assert.deepEqual(await loadLogs(vaultId), fresh);
  });

  it('damaged fork proofs or handled caught changes read as none', async () => {
    const vaultId = freshId();
    await saveForks(vaultId, [{ deviceId: A, seq: 1, lines: ['x', 'y'] }]);
    await saveHandledCaught(vaultId, new Set(['h'.repeat(43)]));
    for (const name of filesIn(vaultId)) if (/^(forks|caught)\./.test(name)) fs.writeFileSync(path.join(folderOf(vaultId), name), '{');
    await loadLogs(vaultId);
    assert.deepEqual(await loadForks(vaultId), []);
    assert.deepEqual([...(await loadHandledCaught(vaultId))], []);
  });
});

describe('a crash at any write leaves the old copy or the new one', () => {
  const old = { [A]: lines('a', 3, 60), [B]: lines('b', 1, 60) };
  const grown = { [A]: [...old[A]!, ...lines('a-more', 2, 60)], [B]: lines('b-new', 2, 60) };

  async function crashDuring(arm: () => void): Promise<Record<string, string[]>> {
    const vaultId = freshId();
    await saveLogs(vaultId, old);
    await loadLogs(vaultId);
    arm();
    await assert.rejects(saveLogs(vaultId, grown), /Simulated crash/);
    assert.equal(faults.pending.length, 0, 'the fault fired');
    const after = await loadLogs(vaultId);
    // Whatever was left, the next save completes and the copy is whole.
    await saveLogs(vaultId, grown);
    assert.deepEqual(await loadLogs(vaultId), grown);
    return after;
  }

  it('torn while appending to a log: the old copy', async () => {
    assert.deepEqual(await crashDuring(() => faults.tearNext(new RegExp(`^${A}\\.`), 30)), old);
  });

  it('failed while writing a fresh log file: the old copy', async () => {
    assert.deepEqual(await crashDuring(() => faults.failNext(new RegExp(`^${B}\\.`))), old);
  });

  it('torn while writing the manifest (the commit): the old copy', async () => {
    assert.deepEqual(await crashDuring(() => faults.tearNext(/^manifest-/, 25)), old);
  });

  it('failed before the manifest write: the old copy', async () => {
    assert.deepEqual(await crashDuring(() => faults.failNext(/^manifest-/)), old);
  });

  it('a crash after the commit: the new copy', async () => {
    const vaultId = freshId();
    await saveLogs(vaultId, old);
    await saveLogs(vaultId, grown);
    // A leftover from a save that never committed is ignored, then cleaned up.
    fs.writeFileSync(path.join(folderOf(vaultId), `${C}.99.jsonl`), 'stray\n');
    assert.deepEqual(await loadLogs(vaultId), grown);
    await saveLogs(vaultId, grown);
    assert.equal(filesIn(vaultId).includes(`${C}.99.jsonl`), false);
  });
});
