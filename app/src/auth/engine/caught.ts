/**
 * Account changes caught in a symmetric conflict: two devices removed each other at once, so both
 * are out, and the account changes one of them made before it saw the other's removal are
 * rejected (`HistoryItem.caught`). They stay in the folder. This lists the ones this device can
 * show and says what re-applying each would write. Nothing here writes or applies anything: the
 * person picks which to re-apply, and the engine writes those as new changes. Pure.
 */
import type { CaughtChangeView } from '../contract';
import { parseBody } from '../../vault/bodies';
import { entryHash, type SignedEntry } from '../../vault/entry';
import type { Box } from '../../vault/crypto';
import type { AccountRecord, OpenAccount } from '../../vault/open';
import type { HistoryItem, VaultState } from '../../vault/replay';
import { bylines, openRecord, recoveryIds } from './history';
import type { LocalLogs } from './sync';

/** What re-applying a caught change writes. */
export type CaughtAction = { kind: 'account.put'; account: string; record: AccountRecord } | { kind: 'account.delete'; account: string };

export interface CaughtChange {
  view: CaughtChangeView;
  /** Null when the change can't be read, so it can only be dismissed. */
  action: CaughtAction | null;
}

export interface CaughtInput {
  state: VaultState;
  logs: LocalLogs;
  /** Epoch keys this device holds (OpenVault.keys). */
  keys: Record<number, Uint8Array>;
  deviceNames: Record<string, string | null>;
  /** The vault's accounts as this device has them open now. */
  accounts: Record<string, OpenAccount>;
  /** Entry hashes already re-applied or dismissed on this device. */
  handled: ReadonlySet<string>;
}

/** The signed line behind a history item, only if it is the one the replay saw. */
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

function describeAccount(record: { issuer: string; label: string }): string {
  const issuer = record.issuer.trim();
  const label = record.label.trim();
  if (issuer && label) return `${issuer} (${label})`;
  return issuer || label || 'an account';
}

function currentAccount(accounts: Record<string, OpenAccount>, id: string): OpenAccount | null {
  return Object.hasOwn(accounts, id) ? accounts[id]! : null;
}

function caughtAction(input: CaughtInput, entry: SignedEntry): { text: string; action: CaughtAction | null } {
  if (entry.kind === 'account.delete') {
    const parsed = parseBody(entry as SignedEntry & { kind: 'account.delete' });
    if (!parsed.ok) return { text: 'Delete an account', action: null };
    const current = currentAccount(input.accounts, parsed.body.account);
    const name = current ? describeAccount(current.record) : 'an account that is no longer in the vault';
    return { text: `Delete ${name}`, action: { kind: 'account.delete', account: parsed.body.account } };
  }
  const parsed = parseBody(entry as SignedEntry & { kind: 'account.put' });
  if (!parsed.ok) return { text: 'Change an account (unreadable)', action: null };
  const { account, box } = parsed.body;
  const record = openRecord(input.state, input.keys, { account, box, author: entry.author });
  if (!record) return { text: 'Change an account (this device has no key to read it)', action: null };
  const verb = currentAccount(input.accounts, account) ? 'Change' : 'Add';
  return { text: `${verb} ${describeAccount(record)}`, action: { kind: 'account.put', account, record } };
}

/**
 * How a caught change is labelled. Every one was made by a device the conflict had already cut off,
 * and a thief can write them under the name of the person's own phone, so the label says so.
 */
export function madeAfterRemoval(by: string): string {
  return `made after ${by} was removed`;
}

/**
 * Solo vaults: what devices a restore took out did to accounts, offered back once per account.
 * The replay marks their deletes and their last account lines by seq (`restoreReview`, never by
 * their clock). For each account whose latest changes are an unbroken run by one removed device,
 * starting at a marked change to the account as it existed, "Bring back" writes the account as it
 * was before that run: an edit followed by a delete comes back as it was before the edit too. Newest first by
 * seq. Adds aren't offered (nothing to bring back).
 */
function restoreReviewChanges(input: CaughtInput, byline: ReturnType<typeof bylines>): CaughtChange[] {
  const { state } = input;
  if (state.kind !== 'solo' || !state.history.some((h) => h.restoreReview)) return [];
  const removed = (id: string) => Object.hasOwn(state.members, id) && state.members[id]!.removed === true;
  // Each account's record after every applied change, in replay order, and its current run of removed-device changes.
  const records = new Map<string, AccountRecord | null>();
  const runs = new Map<string, { before: AccountRecord | null; last: HistoryItem; marked: boolean }>();
  for (const item of state.history) {
    if (item.status !== 'applied' || (item.kind !== 'account.put' && item.kind !== 'account.delete')) continue;
    const entry = entryOf(input.logs, item);
    if (!entry) continue;
    const body = entry.kind === 'account.delete' ? parseBody(entry as SignedEntry & { kind: 'account.delete' }) : parseBody(entry as SignedEntry & { kind: 'account.put' });
    if (!body.ok) continue;
    const account = body.body.account;
    const before = records.has(account) ? records.get(account)! : null;
    records.set(account, entry.kind === 'account.put' ? openRecord(state, input.keys, { account, box: (body.body as unknown as { box: Box }).box, author: entry.author }) : null);
    if (!removed(item.author)) {
      runs.delete(account);
      continue;
    }
    const run = runs.get(account);
    if (run && run.last.author === item.author) runs.set(account, { ...run, last: item, marked: run.marked || item.restoreReview === true });
    // A run starts at a marked change to an account that existed (the same phone may have added it honestly before).
    else if (before !== null && item.restoreReview === true) runs.set(account, { before, last: item, marked: true });
    else runs.delete(account);
  }
  const changes: { seq: number; change: CaughtChange }[] = [];
  for (const [account, run] of runs) {
    const { before, last } = run;
    if (!run.marked || !before || input.handled.has(last.hash)) continue;
    // Still as the run left it here: nothing on this device changed the account since.
    const now = currentAccount(input.accounts, account)?.record ?? null;
    const after = records.get(account) ?? null;
    if ((after === null) !== (now === null) || (after && now && !sameRecord(after, now)) || (after && sameRecord(before, after))) continue;
    const { by, byKeyWords } = byline(last.author);
    const renamed = after !== null && (after.issuer !== before.issuer || after.label !== before.label);
    const text = after === null ? `Bring back ${describeAccount(before)}` : renamed ? `Undo renaming ${describeAccount(before)} to ${describeAccount(after)}` : `Undo changes to ${describeAccount(before)}`;
    const view: CaughtChangeView = {
      id: last.hash,
      time: last.time,
      text,
      by,
      ...(byKeyWords ? { byKeyWords } : {}),
      madeAfter: `${after === null ? 'deleted' : 'changed'} on ${by} before the restore took it out`,
      canReapply: true,
      origin: 'restore',
    };
    changes.push({ seq: last.seq, change: { view, action: { kind: 'account.put', account, record: before } } });
  }
  return changes.sort((a, b) => b.seq - a.seq).map((c) => c.change);
}

function sameRecord(a: AccountRecord, b: AccountRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Caught changes not handled yet, newest first; in a solo vault, also what a restore's removed devices deleted or changed (restoreReviewChanges). */
export function listCaughtChanges(input: CaughtInput): CaughtChange[] {
  const byline = bylines(input.state, input.deviceNames, recoveryIds(input.state.history));
  const changes: CaughtChange[] = [];
  for (const item of input.state.history) {
    if (item.caught !== true || input.handled.has(item.hash)) continue;
    const entry = entryOf(input.logs, item);
    if (!entry || (entry.kind !== 'account.put' && entry.kind !== 'account.delete')) continue;
    const { text, action } = caughtAction(input, entry);
    const { by, byKeyWords } = byline(item.author);
    const view = {
      id: item.hash,
      time: item.time,
      text,
      by,
      ...(byKeyWords ? { byKeyWords } : {}),
      madeAfter: madeAfterRemoval(by),
      canReapply: action !== null,
    };
    changes.push({ view, action });
  }
  // Caught changes newest first by time; the restore's offers after them, newest first by seq (their clock is the thief's).
  return [...changes.sort((a, b) => b.view.time - a.view.time), ...restoreReviewChanges(input, byline)];
}

/**
 * The changes to write for the chosen caught changes, oldest first, as they stand against the
 * accounts now: an HOTP counter never goes back, and deleting an account that is already gone
 * writes nothing.
 */
export function reapplyActions(changes: readonly CaughtChange[], chosen: ReadonlySet<string>, accounts: Record<string, OpenAccount>): CaughtAction[] {
  const actions: CaughtAction[] = [];
  const counters = new Map<string, number>();
  const exists = new Map<string, boolean>(Object.keys(accounts).map((id) => [id, true]));
  for (const change of [...changes].sort((a, b) => a.view.time - b.view.time)) {
    const action = change.action;
    if (!action || !chosen.has(change.view.id)) continue;
    if (action.kind === 'account.delete') {
      if (!exists.get(action.account)) continue;
      exists.set(action.account, false);
      actions.push(action);
      continue;
    }
    const current = currentAccount(accounts, action.account)?.record ?? null;
    const floor = Math.max(counters.get(action.account) ?? 0, current?.type === 'hotp' ? current.counter : 0);
    const record = action.record.type === 'hotp' ? { ...action.record, counter: Math.max(action.record.counter, floor) } : action.record;
    if (record.type === 'hotp') counters.set(action.account, record.counter);
    exists.set(action.account, true);
    actions.push({ ...action, record });
  }
  return actions;
}
