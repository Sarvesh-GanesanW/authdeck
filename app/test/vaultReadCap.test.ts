// A4: every folder-derived read is held to the agent's folder cap plus its reserve.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FOLDER_TOO_LARGE, MAX_LINE_BYTES, MAX_READ_BYTES, readWholeFolder } from '../src/auth/engine/sync';

const DEVICE = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('folder read cap', () => {
  it('ends a read whose pages add up past the cap, before keeping more', async () => {
    const line = 'x'.repeat(MAX_LINE_BYTES);
    const total = Math.ceil(MAX_READ_BYTES / MAX_LINE_BYTES) + 50;
    let served = 0;
    let pages = 0;
    await assert.rejects(
      readWholeFolder(async (since) => {
        pages++;
        const from = since[DEVICE] ?? 0;
        const lines = Array.from({ length: Math.min(100, total - from) }, () => line);
        served += lines.length;
        return { lengths: { [DEVICE]: total }, logs: { [DEVICE]: { from, lines } }, location: 'personal' } as never;
      }),
      new RegExp(FOLDER_TOO_LARGE.slice(0, 30)),
    );
    assert.ok(served * MAX_LINE_BYTES <= MAX_READ_BYTES + 100 * MAX_LINE_BYTES, 'stopped on the page that crossed the cap');
    assert.ok(pages < total / 100 + 1);
  });

  it('takes a read just under the cap', async () => {
    const line = 'y'.repeat(1000);
    const result = await readWholeFolder(async () => ({ lengths: { [DEVICE]: 3 }, logs: { [DEVICE]: { from: 0, lines: [line, line, line] } }, location: 'personal' }) as never);
    assert.equal(result.logs[DEVICE]!.length, 3);
  });
});
