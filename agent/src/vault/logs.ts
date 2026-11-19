import { findFounder, type ForkProof, type VaultLogs, type VerifyCache } from './chain';
import { entryHash, entryShapeProblem, serializeEntry, type EntryRef, type SignedEntry } from './entry';
import { replayVault, type VaultState } from './replay';
import type { SealProof } from './sealProof';
import { outOfVault } from './beacon';
import { fromBase64Url } from './bytes';
import { deviceIdFor } from './crypto';

/** Splits a `.jsonl` file into its entry lines. A missing final newline is fine. */
export function splitLogText(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

export function joinLogLines(lines: readonly string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export interface AppendPlan {
  /** The logs with the entries in place. */
  logs: VaultLogs;
  state: VaultState;
  /** Devices whose files must be rewritten with `logs[deviceId]`. */
  changed: string[];
  /** Hashes of added entries the rules reject that are kept to hold their author's seq (mayHoldPlace). */
  placeholders: string[];
  /** The folder's state before the append (quota passes judge lines against it). */
  before: VaultState;
}

export interface AppendOptions {
  /**
   * Writing back lines the folder lost. Each log written must come with `proof`: the head
   * (seq, hash) the device remembers the folder having, which the lines must lead up to.
   */
  repair?: boolean;
  proof?: Record<string, EntryRef>;
  cache?: VerifyCache;
  /** The folder's fork proofs, which the replay applies. */
  forks?: readonly ForkProof[];
  /** The folder's bad-seal proofs, which the replay applies. */
  sealProofs?: readonly SealProof[];
}

export class AppendRefused extends Error {}

/** A repair refills a gap up to a head the device remembers; it never writes past it. */
function checkRepairProof(entries: readonly SignedEntry[], verifiedLength: Record<string, number>, proof: Record<string, EntryRef> | undefined): void {
  const lastByAuthor = new Map<string, SignedEntry>();
  for (const entry of entries) lastByAuthor.set(entry.author, entry);
  for (const [author, last] of lastByAuthor) {
    const head = proof?.[author];
    if (!head) throw new AppendRefused('A repair must say which entry this device remembers for each log it writes back. Update AuthDeck and retry.');
    if (head.seq < (verifiedLength[author] ?? 0)) throw new AppendRefused('The folder already has every entry this device remembers for that log, so there is nothing to repair.');
    if (last.seq > head.seq) throw new AppendRefused('A repair can only write back entries up to the one this device remembers. Send newer entries as a normal change.');
    if (last.seq === head.seq && entryHash(last) !== head.hash) throw new AppendRefused('The entries written back do not lead to the entry this device remembers.');
  }
}

/**
 * Checks entries against the folder's logs with the same rules every device applies. Each
 * entry must be the next one in its author's verified chain; it may replace lines that fail the
 * chain checks (a tampered or truncated tail), never verified ones. Every entry must then apply:
 * one that waits on an entry the folder doesn't have is refused, with or without `repair`. One
 * the rules reject is refused too, unless its author is still in the vault: then it is kept as a
 * placeholder for its seq (mayHoldPlace), provided nothing that applied before stops applying.
 */
export function planAppend(vaultId: string, logs: VaultLogs, batch: readonly unknown[], options: AppendOptions = {}): AppendPlan {
  let entries = batch;
  if (entries.length === 0) throw new AppendRefused('There are no entries to add.');
  // Cheap checks first, so malformed input never pays for a replay.
  const batchSeq = new Map<string, number>();
  for (const [index, value] of entries.entries()) {
    const problem = entryShapeProblem(value);
    if (problem) throw new AppendRefused(`Entry ${index + 1} is malformed: ${problem}.`);
    const { vault, author, seq } = value as SignedEntry;
    if (vault !== vaultId) throw new AppendRefused(`Entry ${index + 1} belongs to another vault.`);
    const expected = batchSeq.get(author);
    if (expected !== undefined && seq !== expected) throw new AppendRefused(`Entry ${index + 1} has seq ${seq}, but the next entry of its device is ${expected}. Read the vault again and retry.`);
    if (expected === undefined && seq > (logs[author]?.length ?? 0)) throw new AppendRefused(`Entry ${index + 1} has seq ${seq}, but the next entry of its device is ${logs[author]?.length ?? 0} or earlier. Read the vault again and retry.`);
    batchSeq.set(author, seq + 1);
  }
  const replayOptions = { cache: options.cache, forks: options.forks, sealProofs: options.sealProofs };
  const before = replayVault(vaultId, logs, replayOptions);
  // Verified lines the folder holds re-encoded are written back in canonical form with any append.
  const canonical: Record<string, string[]> = {};
  for (const [deviceId, bySeq] of Object.entries(before.reencoded ?? {})) {
    const lines = [...logs[deviceId]!];
    for (const [seq, text] of Object.entries(bySeq)) lines[Number(seq)] = text;
    canonical[deviceId] = lines;
  }
  const folderLogs: VaultLogs = { ...logs, ...canonical };
  // An exact retry of lines already stored changes nothing (the device didn't hear back): those
  // lines are dropped, and a batch of nothing else is taken as it is. Compared canonically, on
  // the verified chain: the entry hash is of its canonical form, and a stored line that isn't
  // canonical is a bad line, never part of the chain.
  const stored = (value: unknown) => {
    const entry = value as SignedEntry;
    return Object.hasOwn(before.chains, entry.author) && before.chains[entry.author]![entry.seq] === entryHash(entry);
  };
  if (entries.every(stored)) return { logs: Object.fromEntries(Object.entries(folderLogs).map(([id, lines]) => [id, [...lines]])), state: before, changed: Object.keys(canonical), placeholders: [], before };
  const firstNew = new Map<string, number>();
  for (const value of entries) {
    const { author, seq } = value as SignedEntry;
    if (!stored(value) && !firstNew.has(author)) firstNew.set(author, seq);
    if (stored(value) && firstNew.has(author)) throw new AppendRefused('A batch can repeat stored entries of a device only before its new ones.');
  }
  entries = entries.filter((value) => !stored(value));
  // A repair is judged on what it makes apply (below): a founding line or a restore written back over junk.
  if (!options.repair) checkSolo(before, entries as SignedEntry[]);
  const pinned = options.repair ? pinnedRuns(before, entries as SignedEntry[]) : new Map<string, number>();
  const next: Record<string, string[]> = {};
  for (const [deviceId, lines] of Object.entries(folderLogs)) next[deviceId] = [...lines];
  const nextSeq: Record<string, number> = {};
  const verifiedLength: Record<string, number> = {};
  const added: string[] = [];

  for (const [index, value] of entries.entries()) {
    const problem = entryShapeProblem(value);
    if (problem) throw new AppendRefused(`Entry ${index + 1} is malformed: ${problem}.`);
    const entry = value as SignedEntry;
    if (entry.vault !== vaultId) throw new AppendRefused(`Entry ${index + 1} belongs to another vault.`);
    const pinStart = pinned.get(entry.author);
    // A pinned run may replace the other version the folder holds from its first seq on.
    const verified = pinStart ?? (before.chains[entry.author] ?? []).length;
    verifiedLength[entry.author] = verified;
    const authorKnown =
      before.chains[entry.author] !== undefined ||
      nextSeq[entry.author] !== undefined ||
      (options.repair === true && (Object.hasOwn(before.members, entry.author) || before.recovery?.deviceId === entry.author || foundingLine(vaultId, entry)));
    if (!authorKnown && (logs[entry.author]?.length ?? 0) > 0) {
      throw new AppendRefused(`Entry ${index + 1} is by a device whose log this computer can't check yet. Sync the vault folder and retry.`);
    }
    const expected = nextSeq[entry.author] ?? verified;
    if (entry.seq !== expected) {
      throw new AppendRefused(
        entry.seq < verified
          ? `Entry ${index + 1} would replace entry ${entry.seq} of its device, which is already verified in the folder.`
          : `Entry ${index + 1} has seq ${entry.seq}, but the next entry of its device is ${expected}. Read the vault again and retry.`,
      );
    }
    // Lines past the verified chain failed the checks (tampered or half-synced); the new entry
    // replaces them. A pinned run keeps what follows it: lines that don't chain on it count for nothing.
    const log = next[entry.author] ?? [];
    next[entry.author] = pinStart !== undefined ? [...log.slice(0, entry.seq), serializeEntry(entry), ...log.slice(entry.seq + 1)] : [...log.slice(0, entry.seq), serializeEntry(entry)];
    nextSeq[entry.author] = entry.seq + 1;
    added.push(entryHash(entry));
  }
  if (options.repair) checkRepairProof(entries as SignedEntry[], verifiedLength, options.proof);
  for (const id of Object.keys(canonical)) nextSeq[id] ??= next[id]!.length;

  const state = replayVault(vaultId, next, replayOptions);
  if (options.repair) checkSolo(before, (entries as SignedEntry[]).filter((e) => state.history.find((h) => h.hash === entryHash(e))?.status !== 'applied'));
  const pinnedAdded = new Set((entries as SignedEntry[]).filter((e) => pinned.has(e.author)).map(entryHash));
  const riders = checkAdmission(before, state, (entries as SignedEntry[]).filter((e) => !pinnedAdded.has(entryHash(e))), logs);
  const status = new Map(state.history.map((h) => [h.hash, h]));
  const placeholders: string[] = [];
  for (const [index, hash] of added.entries()) {
    const item = status.get(hash);
    if (!item) {
      const chainProblem = state.rejected.find((r) => !r.hash && nextSeq[r.deviceId] !== undefined);
      throw new AppendRefused(`Entry ${index + 1} failed the chain checks${chainProblem ? `: ${chainProblem.reason}` : ''}.`);
    }
    if (item.status === 'waiting') throw new AppendRefused(`Entry ${index + 1} (${item.kind}) follows entries this computer doesn't have yet. Sync the vault folder and retry.`);
    if (pinnedAdded.has(hash) && item.status !== 'applied') throw new AppendRefused(`Entry ${index + 1} (${item.kind}) was refused: ${item.reason ?? 'it does not apply'}.`);
    if (item.status === 'rejected') {
      // A change caught in a symmetric conflict is kept, to be offered back for review.
      if (!item.caught && !riders.has(hash) && (!mayHoldPlace(state, item.author) || bringsInLog(entries[index] as SignedEntry, logs))) throw new AppendRefused(`Entry ${index + 1} (${item.kind}) was refused: ${item.reason}.`);
      placeholders.push(hash);
    }
  }
  // A rejected line can't change another entry's outcome: nothing names it in `seen`, and the
  // rules count only applied changes. A batch of nothing but placeholders must show that.
  if (placeholders.length > 0 && placeholders.length === added.length) checkNothingFlips(before, state);
  return { logs: next, state, changed: Object.keys(nextSeq), placeholders, before };
}

/**
 * Rule (pinning): an identity that is out (removed, cut off or forked) gets back only lines that
 * standing identities' applied lines pin: the line another identity's applied line names in
 * `seen` (state.pins), and through `prev` every line below it. A repair may write such a run back
 * over junk or over another version the folder holds, and nothing past it. Returns, per out author
 * in the batch, the seq its run starts at. Throws for any other line of an out author in a repair.
 */
function pinnedRuns(before: VaultState, entries: readonly SignedEntry[]): Map<string, number> {
  const runs = new Map<string, number>();
  const byAuthor = new Map<string, SignedEntry[]>();
  for (const entry of entries) if (isOut(before, entry.author)) byAuthor.set(entry.author, [...(byAuthor.get(entry.author) ?? []), entry]);
  for (const [author, run] of byAuthor) {
    const pin = before.pins && Object.hasOwn(before.pins, author) ? before.pins[author]! : undefined;
    const last = run[run.length - 1]!;
    if (!pin || last.seq !== pin.seq || entryHash(last) !== pin.hash) continue;
    const first = run[0]!;
    const below = first.seq === 0 ? null : (before.chains[author]?.[first.seq - 1] ?? undefined);
    if (below === undefined || first.prev !== below) continue;
    if (!run.every((entry, i) => i === 0 || (entry.seq === run[i - 1]!.seq + 1 && entry.prev === entryHash(run[i - 1]!)))) continue;
    runs.set(author, first.seq);
  }
  return runs;
}

/** A vault.create that founds this vault (its key and salt give the vault id). */
function foundingLine(vaultId: string, entry: SignedEntry): boolean {
  return entry.kind === 'vault.create' && entry.seq === 0 && findFounder(vaultId, { [entry.author]: [serializeEntry(entry)] }) !== null;
}

const SOLO_ONLY_RECOVERY = new Set(['device.add', 'device.remove', 'key.rotate', 'recovery.set']);

/**
 * A solo vault (0.3.0): a device writes only its hello and its own lines. Adding a device (a
 * restore), changing the key and setting a new phrase are the recovery identity's, and nobody
 * removes a device except by a restore. The founder sets the first phrase as its second entry.
 * The replay rejects the same lines; this refuses them outright, so none is kept as a placeholder.
 */
function checkSolo(before: VaultState, entries: readonly SignedEntry[]): void {
  const create = entries.find((e) => e.kind === 'vault.create');
  const kind = before.created ? before.kind : create?.body.kind;
  if (kind !== 'solo') {
    // Multi-device vaults (0.4): the recovery identity only restores; its key changes are solo-only.
    const recovery = before.recovery?.deviceId;
    const index = entries.findIndex((e) => e.author === recovery && (e.kind === 'key.rotate' || e.kind === 'recovery.set'));
    if (index >= 0) throw new AppendRefused(`Entry ${index + 1} (${entries[index]!.kind}) was refused: only a solo vault takes key changes signed with the recovery phrase.`);
    return;
  }
  const founder = before.created ? before.founder : create?.author;
  for (const [index, entry] of entries.entries()) {
    if (!SOLO_ONLY_RECOVERY.has(entry.kind)) continue;
    if (entry.kind === 'device.remove') throw new AppendRefused(`Entry ${index + 1} was refused: in a solo vault a device is removed only by restoring the vault with the recovery phrase.`);
    if (before.recovery !== null && entry.author === before.recovery.deviceId) {
      // A restore comes with the recovery identity's key change right after it, in the same batch.
      if (entry.kind === 'device.add' && !entries.some((e) => e.author === entry.author && e.seq === entry.seq + 1 && e.kind === 'key.rotate')) {
        throw new AppendRefused(`Entry ${index + 1} (device.add) was refused: a restore must come with its key change, so only the new device and the phrase hold the key.`);
      }
      continue;
    }
    if (entry.kind === 'recovery.set' && before.recovery === null && entry.author === founder && entry.seq === 1) continue;
    throw new AppendRefused(`Entry ${index + 1} (${entry.kind}) was refused: in a solo vault only the recovery phrase adds a device, changes the key or sets a new phrase.`);
  }
}

/**
 * Admission (docs/authenticator.md, "What the computer takes"; invariant 9): the computer takes
 * no line from an identity that is removed, cut off or forked in the folder as it is now, before
 * the append. One exception, so whoever reaches the computer first can't win a true-symmetric
 * conflict: a removed device's removal made in true symmetry with its own removal (of its
 * remover, or of the device that approved its remover unseen), and the lines of any kind it
 * chains on in the same batch, kept as placeholders (account lines caught for review, the rest
 * void). Any of those lines that would apply, or bring in a log, refuses the whole batch. Both
 * sides then end up out (rule 2).
 */
/** Returns the lines taken as placeholders ahead of a counter-removal. */
function checkAdmission(before: VaultState, after: VaultState, entries: readonly SignedEntry[], logs: VaultLogs): Set<string> {
  const riders = new Set<string>();
  const counters = new Set(after.counterRemovals);
  const status = new Map(after.history.map((h) => [h.hash, h.status]));
  const lastAllowed = new Map<string, number>();
  for (const entry of entries) {
    if (isOut(before, entry.author) && counters.has(entryHash(entry))) lastAllowed.set(entry.author, Math.max(lastAllowed.get(entry.author) ?? -1, entry.seq));
  }
  for (const [index, entry] of entries.entries()) {
    if (!isOut(before, entry.author)) continue;
    // Only the counter-removal itself, and account lines it chains on (kept as caught placeholders).
    const riding = entry.seq < (lastAllowed.get(entry.author) ?? -1);
    if (counters.has(entryHash(entry))) continue;
    // A line the counter-removal chains on, of any kind (a removal included), is taken only as
    // a placeholder: it must end rejected or caught and change nothing. So an honest
    // counter-removal is never blocked by its own author's earlier unsent lines.
    if (riding && status.get(entryHash(entry)) !== 'applied' && !bringsInLog(entry, logs)) {
      riders.add(entryHash(entry));
      continue;
    }
    if (riding) throw new AppendRefused(`Entry ${index + 1} (${entry.kind}) is by a device that was removed from this vault; only its removal of the device that removed it is taken, and the lines before it only if they change nothing.`);
    const forkSeq = Object.hasOwn(before.forked, entry.author) ? before.forked[entry.author] : undefined;
    if (forkSeq !== undefined) {
      throw new AppendRefused(`Entry ${index + 1} was refused: its author signed two different entries at seq ${forkSeq}, so this computer takes no more changes from it.`);
    }
    throw new AppendRefused(`Entry ${index + 1} is by a device that was removed from this vault (or cut off), so this computer takes no more changes from it.`);
  }
  return riders;
}

function isOut(state: VaultState, id: string): boolean {
  return outOfVault(state, id) || Object.hasOwn(state.forked, id);
}

/**
 * A line the rules reject is still kept when its author is in the vault: it holds the author's
 * seq, so a device whose earlier send went unacknowledged re-sends the same bytes instead of
 * signing a second entry at that seq. A rejected line changes nothing in the replay. A removed
 * or cut-off author's lines are refused as before, so they can't fill the folder.
 */
function mayHoldPlace(state: VaultState, author: string): boolean {
  if (state.cutoffs[author] !== undefined) return false;
  const member = state.members[author];
  return (member !== undefined && !member.removed) || state.recovery?.deviceId === author;
}

/**
 * A rejected device.add or recovery.set naming an identity whose log is already in the folder
 * would make the replay read that log: refused, so a placeholder never brings anything in.
 */
function bringsInLog(entry: SignedEntry, logs: VaultLogs): boolean {
  if (entry.kind !== 'device.add' && entry.kind !== 'recovery.set') return false;
  const named = entry.kind === 'device.add' ? entry.body.device : null;
  if (typeof named === 'string') return (logs[named]?.length ?? 0) > 0;
  try {
    return (logs[deviceIdFor(fromBase64Url(String(entry.body.ed)))]?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** A placeholder must not change what applied: every entry applied before still is. */
function checkNothingFlips(before: VaultState, after: VaultState): void {
  const applied = new Set(after.history.filter((h) => h.status === 'applied').map((h) => h.hash));
  const flipped = before.history.find((h) => h.status === 'applied' && !applied.has(h.hash));
  if (flipped) throw new AppendRefused(`These entries would undo an applied ${flipped.kind}, so they are refused. Read the vault again and retry.`);
}
