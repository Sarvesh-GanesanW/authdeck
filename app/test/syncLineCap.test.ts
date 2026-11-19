// Round 6, R6-F: a hostile computer can't make this device keep padded or oversized lines. A read
// caps each line at the largest entry a vault can hold, and a sync only ever adopts lines in
// canonical form.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APPEND_LIMITS, MAX_LINE_BYTES, mergeLogs, OVERSIZED_LINE, readWholeFolder, type ReadPage } from '../src/auth/engine/sync';
import { buildAccountPut, newAccountId } from '../src/vault/build';
import { rotationEntryMaxBytes } from '../src/vault/bodies';
import { MAX_RAW_LINE_BYTES } from '../src/vault/chain';
import { MAX_IDENTITIES } from '../src/vault/entry';
import { replayVault } from '../src/vault/replay';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers';

const random = seededRandom('sync-line-cap');
const A = 'A'.repeat(22);

/** One page holding every line, the way the computer answers a small folder. */
const onePage =
  (lines: unknown[]): ReadPage =>
  async () => ({ logs: { [A]: { from: 0, lines: lines as string[] } }, lengths: { [A]: lines.length }, location: 'personal' });

describe('the per-line cap on a read', () => {
  it('is the widest rotation a vault can hold, and under what the computer takes in one entry', () => {
    for (const kind of ['device.remove', 'recovery.set', 'key.rotate'] as const) assert.ok(rotationEntryMaxBytes(kind, MAX_IDENTITIES) <= MAX_LINE_BYTES);
    assert.ok(MAX_LINE_BYTES <= APPEND_LIMITS.entryBytes);
  });

  it('keeps a line at the core\'s raw cap and drops a longer one, keeping its place so later lines stay in step', async () => {
    // One raw cap everywhere (review 8): the core's, which the agent and every replay use.
    const atCap = 'x'.repeat(MAX_RAW_LINE_BYTES);
    const read = await readWholeFolder(onePage(['a', atCap, 'y'.repeat(MAX_RAW_LINE_BYTES + 1), 'b']));
    assert.deepEqual(read.logs[A], ['a', atCap, OVERSIZED_LINE, 'b']);
  });

  it('drops a line that is not text', async () => {
    const read = await readWholeFolder(onePage(['a', { pad: 'x' }, 7]));
    assert.deepEqual(read.logs[A], ['a', OVERSIZED_LINE, OVERSIZED_LINE]);
  });

  it('never lets a dropped line count: the chain stops at it', () => {
    const founder = device(random);
    const vault = new MemoryVault(founder, random);
    vault.write(buildAccountPut(vault.state(), founder, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
    const logs = vault.copy();
    logs[founder.deviceId]![1] = OVERSIZED_LINE;
    assert.equal(replayVault(vault.vaultId, logs).chains[founder.deviceId]!.length, 1);
  });
});

describe('adopting the folder\'s lines', () => {
  it('never takes a padded copy of a line: it keeps its own text and adopts what follows in canonical form', () => {
    const founder = device(random);
    const vault = new MemoryVault(founder, random);
    for (let i = 0; i < 3; i++) vault.write(buildAccountPut(vault.state(), founder, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
    const local = vault.copy();
    local[founder.deviceId] = local[founder.deviceId]!.slice(0, 2);
    const folder = vault.copy();
    folder[founder.deviceId] = folder[founder.deviceId]!.map((line, i) => (i === 1 ? line.replace('{', `{${' '.repeat(100_000)}`) : line));
    const merged = mergeLogs(local, replayVault(vault.vaultId, local), folder, replayVault(vault.vaultId, folder));
    // Lines are normalised on read (S7r-1): the padding never reaches this device's copy, the lines after it do.
    assert.deepEqual(merged.logs[founder.deviceId], vault.copy()[founder.deviceId]);
    assert.ok(merged.logs[founder.deviceId]!.every((line) => !line.includes('  ')));
  });
});
