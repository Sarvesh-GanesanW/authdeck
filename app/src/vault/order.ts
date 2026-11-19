import type { VerifiedEntry } from './chain';

/** A verified entry placed in the order, with what it had seen. */
export interface Placed {
  item: VerifiedEntry;
  /**
   * The causal past: for each other identity, the highest seq of its entries this entry follows
   * (through `prev` and `seen`, transitively). Shared between entries that saw nothing new.
   */
  past: Readonly<Record<string, number>>;
  /** Set when the entry can't apply whatever the rules say: its time runs backwards. */
  problem?: string;
}

/** An entry whose `seen` names an entry of another device with a hash the folder doesn't have at that seq. */
export interface SeenConflict {
  /** The entry that names it. */
  author: string;
  seq: number;
  hash: string;
  /** What it names, and what the folder holds there. */
  names: { deviceId: string; seq: number; hash: string };
  folderHash: string;
}

export interface Waiting {
  item: VerifiedEntry;
  /** The entry it names that is not in the folder yet, when it names one itself (otherwise it follows a waiting entry). */
  waitsFor?: { deviceId: string; seq: number };
}

export interface CausalOrder {
  /** Entries in the one order every device computes. */
  ordered: Placed[];
  /** Entries that name, directly or through an earlier entry, something past the end of a log. */
  waiting: Waiting[];
  conflicts: SeenConflict[];
}

/** True when `placed` is the entry (author, seq) or follows it. */
export function follows(placed: Placed, author: string, seq: number): boolean {
  if (author === placed.item.entry.author) return seq <= placed.item.entry.seq;
  return (placed.past[author] ?? -1) >= seq;
}

function before(a: VerifiedEntry, b: VerifiedEntry): boolean {
  if (a.entry.time !== b.entry.time) return a.entry.time < b.entry.time;
  return a.hash < b.hash;
}

/** Min-heap on (time, hash). */
class EntryHeap {
  private readonly items: VerifiedEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: VerifiedEntry): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): VerifiedEntry {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && before(items[left]!, items[smallest]!)) smallest = left;
        if (right < items.length && before(items[right]!, items[smallest]!)) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

interface Links {
  /** Entries named in `seen` that are in the folder with the named hash. */
  seen: VerifiedEntry[];
  missing?: { deviceId: string; seq: number };
  conflicts: SeenConflict[];
}

/**
 * Resolves `seen`: an entry waits only for a seq past the end of a log (a sync tool hasn't brought
 * it yet). Naming a seq the folder has with another hash means the named device signed two
 * entries there (or the namer is wrong): the entry counts as having seen that device's history up
 * to the entry before, which both versions share, and the conflict is recorded. The naming entry
 * itself is never rejected for it, so a device can't undo what others built on its old entry by
 * re-signing it.
 */
function resolveSeen(item: VerifiedEntry, chains: Record<string, VerifiedEntry[]>, present: ReadonlyMap<string, number>): Links {
  const links: Links = { seen: [], conflicts: [] };
  for (const [deviceId, ref] of Object.entries(item.entry.seen)) {
    const chain = Object.hasOwn(chains, deviceId) ? chains[deviceId] : undefined;
    // A log the folder holds but no applied line brings in (its approval was on the other version
    // of a forked line): the namer saw a history the folder doesn't share. A conflict, not a wait.
    if (!chain && (present.get(deviceId) ?? 0) > 0) {
      links.conflicts.push({ author: item.entry.author, seq: item.entry.seq, hash: item.hash, names: { deviceId, seq: ref.seq, hash: ref.hash }, folderHash: '' });
      continue;
    }
    // A seq the folder's log holds but that failed the checks (a bad line, or one after it): the
    // namer saw a line the folder can't vouch for. Also a conflict, never a wait.
    if (chain && ref.seq >= chain.length && ref.seq < (present.get(deviceId) ?? 0)) {
      links.conflicts.push({ author: item.entry.author, seq: item.entry.seq, hash: item.hash, names: { deviceId, seq: ref.seq, hash: ref.hash }, folderHash: '' });
      if (chain.length > 0) links.seen.push(chain[chain.length - 1]!);
      continue;
    }
    if (!chain || ref.seq >= chain.length) {
      links.missing ??= { deviceId, seq: ref.seq };
      continue;
    }
    const target = chain[ref.seq]!;
    if (target.hash === ref.hash) {
      links.seen.push(target);
      continue;
    }
    links.conflicts.push({ author: item.entry.author, seq: item.entry.seq, hash: item.hash, names: { deviceId, seq: ref.seq, hash: ref.hash }, folderHash: target.hash });
    if (ref.seq > 0) links.seen.push(chain[ref.seq - 1]!);
  }
  return links;
}

function causalPast(prev: Placed | undefined, seen: Placed[]): Readonly<Record<string, number>> {
  let past = prev?.past ?? {};
  let copied = false;
  for (const target of seen) {
    const { author, seq } = target.item.entry;
    if ((past[author] ?? -1) >= seq) continue;
    if (!copied) {
      past = { ...past };
      copied = true;
    }
    const merged = past as Record<string, number>;
    for (const [id, s] of Object.entries(target.past)) if ((merged[id] ?? -1) < s) merged[id] = s;
    merged[author] = seq;
  }
  return past;
}

/**
 * Rule 2: an entry comes after its own device's earlier entries and after every entry named in
 * its `seen`. Among entries with no order between them, the lower (time, hash) goes first. The
 * result depends only on the set of entries, never on the order files were read.
 */
export function orderEntries(chains: Record<string, VerifiedEntry[]>, present: ReadonlyMap<string, number> = new Map()): CausalOrder {
  const links = new Map<VerifiedEntry, Links>();
  const blockers = new Map<VerifiedEntry, number>();
  const dependents = new Map<VerifiedEntry, VerifiedEntry[]>();
  const conflicts: SeenConflict[] = [];
  for (const chain of Object.values(chains)) {
    for (const [index, item] of chain.entries()) {
      const resolved = resolveSeen(item, chains, present);
      links.set(item, resolved);
      conflicts.push(...resolved.conflicts);
      const deps = new Set<VerifiedEntry>(resolved.seen);
      if (index > 0) deps.add(chain[index - 1]!);
      blockers.set(item, deps.size);
      for (const dep of deps) {
        const list = dependents.get(dep);
        if (list) list.push(item);
        else dependents.set(dep, [item]);
      }
    }
  }

  const placed = new Map<VerifiedEntry, Placed>();
  const ready = new EntryHeap();
  for (const [item, count] of blockers) if (count === 0 && !links.get(item)!.missing) ready.push(item);
  const ordered: Placed[] = [];
  while (ready.size > 0) {
    const item = ready.pop();
    const link = links.get(item)!;
    const seen = link.seen.map((target) => placed.get(target)!);
    const prev = item.entry.seq > 0 ? placed.get(chains[item.entry.author]![item.entry.seq - 1]!) : undefined;
    const entry: Placed = { item, past: causalPast(prev, seen), ...placementProblem(item, seen) };
    placed.set(item, entry);
    ordered.push(entry);
    for (const next of dependents.get(item) ?? []) {
      const left = blockers.get(next)! - 1;
      blockers.set(next, left);
      if (left === 0 && !links.get(next)!.missing) ready.push(next);
    }
  }
  const waiting: Waiting[] = [...blockers.keys()]
    .filter((item) => !placed.has(item))
    .sort((a, b) => (before(a, b) ? -1 : 1))
    .map((item) => {
      const missing = links.get(item)!.missing;
      return missing ? { item, waitsFor: missing } : { item };
    });
  return { ordered, waiting, conflicts };
}

function placementProblem(item: VerifiedEntry, seen: Placed[]): { problem?: string } {
  if (seen.some((target) => target.item.entry.time > item.entry.time)) return { problem: 'its time is earlier than an entry it says it had seen' };
  return {};
}
