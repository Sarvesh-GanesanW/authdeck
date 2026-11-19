/**
 * Membership changes voided after the fact (`HistoryItem.voided`): a device made them after an
 * applied removal of it that it had not seen, so they don't count (rule 1), even when that
 * device was honest. The person is told what happened; nothing is redone, and no button redoes
 * it. Account changes take the caught-changes path instead. Pure.
 */
import type { VoidedChangeView } from '../contract';
import { parseBody } from '../../vault/bodies';
import { entryHash, type SignedEntry } from '../../vault/entry';
import type { VaultState } from '../../vault/replay';
import { bylines, recoveryIds } from './history';
import type { LocalLogs } from './sync';

export interface VoidedInput {
  state: VaultState;
  logs: LocalLogs;
  deviceNames: Record<string, string | null>;
  /** This device's id, or null before it joined. */
  me: string | null;
  /** Hashes already redone or dismissed on this device. */
  handled: ReadonlySet<string>;
}

function entryOf(logs: LocalLogs, item: { author: string; seq: number; hash: string }): SignedEntry | null {
  const line = Object.hasOwn(logs, item.author) ? logs[item.author]![item.seq] : undefined;
  if (line === undefined) return null;
  try {
    const entry = JSON.parse(line) as SignedEntry;
    return entryHash(entry) === item.hash ? entry : null;
  } catch {
    return null;
  }
}

function activeMember(state: VaultState, id: string | null): boolean {
  if (id === null || !Object.hasOwn(state.members, id)) return false;
  const member = state.members[id]!;
  return member.joined && !member.removed;
}

/**
 * Voided membership changes not handled yet, newest first. In the folder the honest case (a
 * device that hadn't seen its own removal) and an attack (a removed device writing stale
 * changes) look the same, so each is only told, in neutral words, with no button to redo it.
 */
export function listVoidedChanges(input: VoidedInput): VoidedChangeView[] {
  const { state } = input;
  const byline = bylines(state, input.deviceNames, recoveryIds(state.history));
  const name = (id: string) => byline(id).by;
  const out: VoidedChangeView[] = [];
  for (const item of state.history) {
    if (item.voided !== true || input.handled.has(item.hash)) continue;
    const entry = entryOf(input.logs, item);
    if (!entry) continue;
    const author = name(item.author);
    const base = { id: item.hash, time: item.time, by: author };
    if (entry.kind === 'device.remove') {
      const parsed = parseBody(entry as SignedEntry & { kind: 'device.remove' });
      if (!parsed.ok) continue;
      const target = name(parsed.body.device);
      const stillIn = activeMember(state, parsed.body.device) && parsed.body.device !== input.me;
      out.push({
        ...base,
        text: `${author}, which was removed, also tried to remove ${target}. Nothing changed.`,
        ...(stillIn ? { hint: `If you want ${target} removed, remove it from its page.` } : {}),
      });
    } else if (entry.kind === 'device.add') {
      const parsed = parseBody(entry as SignedEntry & { kind: 'device.add' });
      if (!parsed.ok) continue;
      const joiner = name(parsed.body.device);
      out.push({
        ...base,
        text: `${author}, which was removed, also tried to approve ${joiner}. ${joiner} didn't join.`,
        hint: `If ${joiner} should join, approve it from a device that is in the vault when it asks.`,
      });
    } else if (entry.kind === 'recovery.set') {
      out.push({
        ...base,
        text: `${author}, which was removed, also tried to set a new recovery phrase. The phrase didn't change.`,
        hint: 'If you want a new phrase, make one under Backup.',
      });
    } else if (entry.kind === 'key.rotate') {
      out.push({ ...base, text: `${author}, which was removed, also tried to change the vault key. Nothing changed.` });
    }
  }
  return out.sort((a, b) => b.time - a.time);
}
