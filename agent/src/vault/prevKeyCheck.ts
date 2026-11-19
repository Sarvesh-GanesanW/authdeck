/**
 * Checks each key change's `prevKey` on a device that holds both keys it links. Replay never opens
 * a `prevKey` (it holds no keys), so a key change can carry one that doesn't open to the key before
 * it; devices that join later then can't read older accounts. Pure.
 */
import { bytesEqual } from './bytes';
import type { VaultLogs } from './chain';
import { decryptBox } from './crypto';
import { boxContexts } from './open';
import type { VaultState } from './replay';

/** A key change whose `prevKey` does not open to the previous epoch's key, and who wrote it. */
export interface PrevKeyProblem {
  /** The epoch the key change started. */
  epoch: number;
  author: string;
  /** Hash of the key change's entry. */
  hash: string;
}

const ROTATION_KINDS: ReadonlySet<string> = new Set(['device.remove', 'recovery.set', 'key.rotate']);

function opensToPrevious(state: VaultState, keys: Readonly<Record<number, Uint8Array>>, epoch: number): boolean {
  const box = state.prevKeys[epoch]!;
  try {
    return bytesEqual(decryptBox(keys[epoch]!, box, boxContexts.prevKey(state.vaultId, epoch)), keys[epoch - 1]!);
  } catch {
    return false;
  }
}

/** The body of a verified line, or null when it can't be read (replay already judged the line). */
function bodyOf(logs: VaultLogs, author: string, seq: number): Record<string, unknown> | null {
  const line = Object.hasOwn(logs, author) ? logs[author]![seq] : undefined;
  if (line === undefined) return null;
  try {
    const entry = JSON.parse(line) as { body?: Record<string, unknown> };
    return entry.body ?? null;
  } catch {
    return null;
  }
}

/**
 * The applied key changes that started `epoch` with the vault's own key check and prevKey: the
 * one on the key chain (a line copying its whole body would match too, and is named as well).
 */
function writersOf(state: VaultState, logs: VaultLogs, epoch: number): { author: string; hash: string }[] {
  const box = state.prevKeys[epoch]!;
  return state.history
    .filter((item) => item.status === 'applied' && ROTATION_KINDS.has(item.kind))
    .filter((item) => {
      const body = bodyOf(logs, item.author, item.seq);
      const prevKey = body?.prevKey as { c?: unknown } | undefined;
      return body?.epoch === epoch && body.keyCheck === state.keyChecks[epoch] && prevKey?.c === box.c;
    })
    .map((item) => ({ author: item.author, hash: item.hash }));
}

/**
 * Key changes whose `prevKey` doesn't open to the previous epoch's key, among the epochs where
 * this device holds both keys (`keys`, OpenVault.keys: each one already checked against its
 * epoch's key check). Each comes with the device that wrote it.
 */
export function prevKeyProblems(state: VaultState, keys: Readonly<Record<number, Uint8Array>>, logs: VaultLogs): PrevKeyProblem[] {
  const problems: PrevKeyProblem[] = [];
  for (let epoch = 1; epoch <= state.epoch; epoch++) {
    if (!keys[epoch] || !keys[epoch - 1] || !state.prevKeys[epoch]) continue;
    if (opensToPrevious(state, keys, epoch)) continue;
    for (const writer of writersOf(state, logs, epoch)) problems.push({ epoch, ...writer });
  }
  return problems;
}
