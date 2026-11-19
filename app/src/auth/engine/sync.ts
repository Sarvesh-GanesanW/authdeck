/**
 * Keeping this device's copy of the vault and the computer's folder in step. Pure: the engine
 * reads the folder, calls these, and sends what they say to send.
 *
 * The device keeps every verified line of every log. A read of the folder can only add lines:
 * when the folder has a longer verified chain for a device, its extra lines are taken; when it
 * has a shorter or different one, the local copy wins. Whatever the local copy has that the folder
 * lacks is the outbox: changes made offline, or history the folder lost.
 *
 * The remembered heads for the rollback check only ever come from the folder (a read, or an
 * upload it accepted), so lines this device has not sent yet never look like a rollback.
 */
import type { VaultEntry, VaultHead, VaultReadResult } from '../../protocol';
import { fromBase64Url, utf8Encode } from '../../vault/bytes';
import { canonicalLine, forkProofProblem, rawLineTooLong, type ForkProof, type VaultLogs, type VerifyCache } from '../../vault/chain';
import { rotationEntryMaxBytes } from '../../vault/bodies';
import { entryHash, isId, isPlainObject, MAX_IDENTITIES, type SignedEntry } from '../../vault/entry';
import { MAX_VAULT_BYTES, MAX_VAULT_ENTRIES, UNCAPPED_BOUND, VAULT_RESERVE } from '../../vault/quota';
import { repairLines, type RememberedHeads } from '../../vault/rollback';
import { identityEds, type VaultState } from '../../vault/replay';

export type LocalLogs = Record<string, string[]>;

/** The computer's limits on one vault.append call (agent/src/vaultStore.ts). */
export const APPEND_LIMITS = { entries: 1000, bytes: 512 * 1024, entryBytes: 128 * 1024 };

/** One page of a read: `since[deviceId]` is the first line wanted from each file. */
export type ReadPage = (since: Record<string, number>) => Promise<Pick<VaultReadResult, 'logs' | 'lengths' | 'location'>>;

/**
 * The most lines a read takes: every line a vault can hold (its ordinary cap, its reserve, and
 * the lines no cap refuses; vault/quota.ts). A folder claiming more is refused before it is read,
 * so a hostile computer can't make this device read and check more than a full vault.
 */
const MAX_READ_LINES = MAX_VAULT_ENTRIES + VAULT_RESERVE.lines + UNCAPPED_BOUND.lines;
/**
 * The most text one folder read keeps: the agent's folder cap plus its reserve. A computer that
 * sends more ends the read with an error; the app never holds more than this of the folder.
 */
export const MAX_READ_BYTES = MAX_VAULT_BYTES + VAULT_RESERVE.bytes;
export const FOLDER_TOO_LARGE = 'The vault folder is too large to read. Check it for files that should not be there.';

/**
 * The longest line a vault can hold: a rotation (removal, recovery change or key change) sealed to
 * every identity a vault can have, with a full `seen`. Every other kind is smaller: its body is
 * at most a 6 KB account record or a name, against 256 sealed keys. A line is valid only in
 * canonical form (vault/chain.ts), which is printable ASCII, so its length in characters is its
 * length in bytes.
 */
export const MAX_LINE_BYTES = Math.max(
  rotationEntryMaxBytes('device.remove', MAX_IDENTITIES),
  rotationEntryMaxBytes('recovery.set', MAX_IDENTITIES),
  rotationEntryMaxBytes('key.rotate', MAX_IDENTITIES),
);

/**
 * Stands in for a line longer than any entry (or not text at all): not JSON, so the chain check
 * stops at it like at any bad line, and nothing after it in that file counts. Keeping its place
 * keeps the paging in step without holding the computer's bytes.
 */
export const OVERSIZED_LINE = 'oversized line, not kept';

/** One raw cap everywhere: the core's (vault/chain.ts). A line it would parse is kept and normalised. */
function cappedLine(line: unknown): string {
  return typeof line === 'string' && !rawLineTooLong(line) ? line : OVERSIZED_LINE;
}

/**
 * Reads every line of every log. The computer answers in pages (at most 1000 lines and 512 KB,
 * devices in sorted order), so this asks again from where each file left off until every file
 * has reached the length the computer reports. A line longer than any entry is never kept
 * (OVERSIZED_LINE), so a hostile computer can't make this device hold padded lines.
 */
export async function readWholeFolder(readPage: ReadPage): Promise<{ logs: LocalLogs; location: VaultReadResult['location'] }> {
  const logs: Record<string, string[]> = {};
  const since: Record<string, number> = {};
  let bytes = 0;
  // Every page adds a line or the read stops, so the line cap bounds the pages too.
  for (;;) {
    const result = await readPage(since);
    const claimed = Object.entries(result.lengths).reduce((sum, [deviceId, length]) => sum + (isId(deviceId) ? length : 0), 0);
    if (claimed > MAX_READ_LINES) throw new Error(FOLDER_TOO_LARGE);
    let progressed = false;
    for (const [deviceId, part] of Object.entries(result.logs)) {
      // A key that isn't a device id (say "__proto__") is not a log: skip it before it keys anything.
      if (!isId(deviceId)) continue;
      const have = logs[deviceId] ?? [];
      if (part.from !== have.length) throw new Error('The vault folder changed while it was being read. AuthDeck will read it again.');
      if (part.lines.length > 0) progressed = true;
      // Stored in canonical form: a re-encoded copy of a signed line reads, counts and is kept as its entry.
      const lines = part.lines.map((line) => canonicalLine(cappedLine(line)));
      bytes += lines.reduce((sum, line) => sum + line.length, 0);
      if (bytes > MAX_READ_BYTES) throw new Error(FOLDER_TOO_LARGE);
      logs[deviceId] = [...have, ...lines];
      since[deviceId] = logs[deviceId].length;
    }
    const complete = Object.entries(result.lengths).every(([deviceId, length]) => !isId(deviceId) || (logs[deviceId]?.length ?? 0) >= length);
    if (complete) return { logs, location: result.location };
    if (!progressed) throw new Error('The computer stopped sending the vault part-way. AuthDeck will read it again.');
    if (Object.values(logs).reduce((sum, lines) => sum + lines.length, 0) > MAX_READ_LINES) throw new Error(FOLDER_TOO_LARGE);
  }
}

function entryBytes(entry: VaultEntry): number {
  return utf8Encode(JSON.stringify(entry)).length;
}

/**
 * Splits entries into appends the computer accepts, in order. Throws for an entry larger than
 * the computer takes: it can never be sent, so the person has to hear about it.
 */
export function appendBatches(entries: readonly VaultEntry[]): VaultEntry[][] {
  const batches: VaultEntry[][] = [];
  let batch: VaultEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = entryBytes(entry);
    if (size > APPEND_LIMITS.entryBytes)
      throw new Error('A vault change is too large for the computer to store. Remove a device or shorten names, then try again.');
    if (batch.length === APPEND_LIMITS.entries || bytes + size > APPEND_LIMITS.bytes) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export interface Merged {
  logs: LocalLogs;
  /** Devices whose verified chain in the folder differs from the local one at some seq. */
  diverged: string[];
}

/**
 * Adds the folder's newer verified lines to the local copy. Never drops a local verified line.
 * Only verified lines are taken, and a verified line is exactly its entry's canonical form
 * (vault/chain.ts), so the text taken is the text this device would have written: the folder
 * can't swap in a padded copy of a line with the same hash.
 */
export function mergeLogs(local: VaultLogs, localState: VaultState, remote: VaultLogs, remoteState: VaultState): Merged {
  const logs: LocalLogs = {};
  const diverged: string[] = [];
  const devices = new Set([...Object.keys(localState.chains), ...Object.keys(remoteState.chains)]);
  for (const deviceId of devices) {
    const mine = localState.chains[deviceId] ?? [];
    const theirs = remoteState.chains[deviceId] ?? [];
    const shared = commonPrefix(mine, theirs);
    // Only canonical text is kept: a padded copy of a line counts and is stored as its entry.
    // The lines both hold stay this copy's text, so a padded copy of a line is never adopted.
    if (shared === mine.length) logs[deviceId] = (remote[deviceId] ?? []).slice(0, theirs.length).map((line, seq) => (seq < mine.length ? local[deviceId]![seq]! : canonicalLine(line)));
    else {
      logs[deviceId] = (local[deviceId] ?? []).slice(0, mine.length);
      if (shared < theirs.length) diverged.push(deviceId);
    }
  }
  return { logs, diverged };
}

/** One vault.append: a plain append of new entries, or a repair with its proof. */
export interface Upload {
  entries: VaultEntry[];
  /** Write back lines the folder lost, each log up to the head in `proof`. */
  repair: boolean;
  /** For a repair: the head this device remembers the folder having, per log written back. */
  proof?: Record<string, VaultHead>;
}

/**
 * The outbox: local verified lines the folder lacks. Lines the folder had once (up to the head
 * this device remembers seeing there) go back as a repair, founder's log first, so a missing
 * folder is recreated by its vault.create. This device's lines past that are new and go as a
 * plain append after the repair. Another device's lines past the remembered head were never in
 * this device's sight of the folder, so nothing proves them: that device sends its own. Logs
 * of devices that signed two histories (`localState.forked`) are never written back.
 */
export function pendingUploads(local: VaultLogs, localState: VaultState, remoteState: VaultState, thisDevice: string, remembered: RememberedHeads): Upload[] {
  const repairs = repairLines(local, localState, remoteState);
  // A device proven to have signed two histories is cut off; writing its lines back helps nobody.
  const devices = Object.keys(repairs)
    .filter((deviceId) => localState.forked[deviceId] === undefined)
    .sort((a, b) => Number(b === localState.founder) - Number(a === localState.founder) || a.localeCompare(b));
  const repaired: VaultEntry[] = [];
  const proof: Record<string, VaultHead> = {};
  const fresh: VaultEntry[] = [];
  for (const deviceId of devices) {
    const { from, lines } = repairs[deviceId]!;
    const head = remembered[deviceId];
    lines.forEach((line, i) => {
      const seq = from + i;
      const entry = JSON.parse(line) as VaultEntry;
      if (head && seq <= head.seq && localState.chains[deviceId]?.[head.seq] === head.hash) {
        repaired.push(entry);
        proof[deviceId] = { seq: head.seq, hash: head.hash };
      } else if (deviceId === thisDevice) fresh.push(entry);
    });
  }
  const uploads: Upload[] = [];
  if (repaired.length > 0) uploads.push({ entries: repaired, repair: true, proof });
  if (fresh.length > 0) uploads.push({ entries: fresh, repair: false });
  return uploads;
}

/**
 * The outbox of a removed device that holds a counter-removal (removed.ts heldRemoval): only its
 * own lines up to `lastSeq`, which the computer takes from a removed author in true symmetry, and
 * nothing at all unless they reach `lastSeq`, since the computer refuses the rest on their own. A
 * line it would refuse even then (one still waiting, or rejected without being caught in the
 * conflict) stops the whole send. Account changes caught in the conflict go along: the computer
 * keeps them as placeholders and they hold their seqs.
 */
export function heldRemovalUploads(uploads: readonly Upload[], state: VaultState, thisDevice: string, lastSeq: number): Upload[] {
  const status = new Map(state.history.map((h) => [h.hash, h]));
  const refused = (entry: VaultEntry) => {
    const item = status.get(entryHash(entry as SignedEntry));
    return !item || item.status === 'waiting' || (item.status === 'rejected' && !item.caught);
  };
  const own = uploads
    .map((upload) => ({ ...upload, entries: upload.entries.filter((e) => e.author === thisDevice && e.seq <= lastSeq) }))
    .filter((upload) => upload.entries.length > 0)
    .map((upload) =>
      upload.repair ? { ...upload, proof: Object.fromEntries(Object.entries(upload.proof ?? {}).filter(([id]) => id === thisDevice)) } : upload,
    );
  const lines = own.flatMap((upload) => upload.entries);
  if (!lines.some((e) => e.seq === lastSeq) || lines.some(refused)) return [];
  return own;
}

/** After a successful upload, the folder holds the local heads of every device that was sent. */
export function headsAfterUpload(remembered: RememberedHeads, localState: VaultState, upload: Upload): RememberedHeads {
  const heads = { ...remembered };
  for (const author of new Set(upload.entries.map((e) => e.author))) {
    const sent = upload.entries.filter((e) => e.author === author).at(-1)!;
    const hash = localState.chains[author]?.[sent.seq];
    if (hash && (!heads[author] || sent.seq >= heads[author]!.seq)) heads[author] = { seq: sent.seq, hash };
  }
  return heads;
}

/** The highest of its own entries this device has sent (or was about to send), kept in secure storage. */
export type OwnHead = { seq: number; hash: string };

/**
 * How many of this device's own lines count as sent: what the folder shows, or more when this
 * device remembers the folder accepting more. A folder that under-reports can't make it sign a
 * second entry at a seq it already sent.
 */
export function ownSentLength(remoteState: VaultState, deviceId: string, ownHead: OwnHead | null): number {
  return Math.max(remoteState.chains[deviceId]?.length ?? 0, ownHead ? ownHead.seq + 1 : 0);
}

/** The remembered heads with this device's own head raised to the stored one, so lost own lines go back as a repair. */
export function withOwnHead(remembered: RememberedHeads, deviceId: string, ownHead: OwnHead | null): RememberedHeads {
  const known = remembered[deviceId];
  if (!ownHead || (known && known.seq >= ownHead.seq)) return remembered;
  return { ...remembered, [deviceId]: ownHead };
}

/** This device's own head once it is about to send `upload`: its last own line, which counts as sent from then on. */
export function ownHeadBeforeUpload(previous: OwnHead | null, deviceId: string, upload: Upload): OwnHead | null {
  const last = upload.entries.filter((e) => e.author === deviceId).at(-1);
  if (!last || (previous && previous.seq >= last.seq)) return previous;
  return { seq: last.seq, hash: entryHash(last as SignedEntry) };
}

/** This device's own head after an upload, when the upload carried its lines. */
export function ownHeadAfterUpload(previous: OwnHead | null, localState: VaultState, deviceId: string, upload: Upload): OwnHead | null {
  return (
    headsAfterUpload(previous ? { [deviceId]: previous } : {}, localState, { ...upload, entries: upload.entries.filter((e) => e.author === deviceId) })[
      deviceId
    ] ?? previous
  );
}

/**
 * The proofs that hold: both lines signed by a device (or recovery identity) of this vault at one
 * seq. Proofs come from the computer too, so anything else is dropped rather than kept or shown.
 */
/**
 * The proofs that hold, at most one per identity (the first that does). A proof about an id that
 * is neither a member nor an identity with lines in this vault (a replaced recovery identity) is
 * dropped before any check, so junk proofs cost nothing; the keys of replaced recovery identities
 * come from one discovery pass, with `cache`. At most two proofs are checked per identity.
 */
export function provenForks(state: VaultState, proofs: readonly unknown[], logs?: VaultLogs, cache?: VerifyCache): ForkProof[] {
  const kept = new Map<string, ForkProof>();
  const tries = new Map<string, number>();
  let others: Map<string, string> | null = null;
  for (const proof of proofs) {
    if (!isPlainObject(proof) || typeof proof.deviceId !== 'string' || !isId(proof.deviceId) || kept.has(proof.deviceId)) continue;
    const id = proof.deviceId;
    // Bounded work: at most two proofs checked per identity (the folder's and this device's own).
    if ((tries.get(id) ?? 0) >= 2) continue;
    tries.set(id, (tries.get(id) ?? 0) + 1);
    const member = Object.hasOwn(state.members, id) ? state.members[id] : undefined;
    if (!member && state.recovery?.deviceId !== id && !Object.hasOwn(state.chains, id)) continue;
    // A replaced recovery identity too (solo: a proof about it chooses which version counts).
    let ed = member?.ed ?? (state.recovery?.deviceId === id ? state.recovery.ed : null);
    if (!ed && logs) ed = (others ??= identityEds(state.vaultId, logs, cache)).get(id) ?? null;
    if (!ed) continue;
    if (forkProofProblem(state.vaultId, { deviceId: id, ed: fromBase64Url(ed), role: 'device' }, proof as unknown as ForkProof) === null) kept.set(id, proof as unknown as ForkProof);
  }
  return [...kept.values()];
}

/** True when the vault still counts this identity's lines: not removed, replaced or cut off. */
export function isActiveAuthor(state: VaultState, id: string): boolean {
  if (Object.hasOwn(state.cutoffs, id)) return false;
  return !Object.hasOwn(state.members, id) || state.members[id]!.removed !== true;
}

/**
 * A refused repair, cut down to the lines that matter: this device's own and those of active
 * authors. Null when nothing is left, so a refusal over a removed or cut-off identity's lines
 * (which the computer rightly won't write back) never holds up this device's upload or beacon.
 */
export function repairOfActiveAuthors(upload: Upload, state: VaultState, thisDevice: string): Upload | null {
  const counts = (id: string) => id === thisDevice || isActiveAuthor(state, id);
  const entries = upload.entries.filter((e) => counts(e.author));
  if (entries.length === 0) return null;
  const proof = Object.fromEntries(Object.entries(upload.proof ?? {}).filter(([id]) => counts(id)));
  return { entries, repair: true, proof };
}

/**
 * Lines this device signed with the recovery phrase: a restore (the recovery identity's device.add,
 * this device's hello and, in a solo vault, the recovery identity's key change), or a solo vault's
 * new phrase (the recovery identity's recovery.set). Kept before it is sent, so a retry or a
 * restart sends these same bytes. The recovery identity must never sign two entries at one seq:
 * the pair would prove it forked and void the phrase.
 */
export interface PendingRestore {
  recoveryId: string;
  deviceId: string;
  /** The first line's seq in the recovery identity's log. */
  seq: number;
  /** The lines, exactly as signed (one to three; see above). */
  lines: string[];
  /** The folder holds another entry at `seq`, so these lines are dead and a new restore signs past `seq`. */
  superseded: boolean;
}

/** What a restore does next: send the lines the folder lacks, nothing (it holds both), or stop (its seq went to another entry). */
export type RestoreStep = { kind: 'send'; entries: VaultEntry[] } | { kind: 'held' } | { kind: 'taken' };

export function restoreStep(folderState: VaultState, pending: PendingRestore): RestoreStep {
  const missing: VaultEntry[] = [];
  for (const line of pending.lines) {
    const entry = JSON.parse(line) as SignedEntry;
    const there = folderState.chains[entry.author]?.[entry.seq];
    if (there === undefined) missing.push(entry as unknown as VaultEntry);
    else if (there !== entryHash(entry)) return { kind: 'taken' };
  }
  return missing.length === 0 ? { kind: 'held' } : { kind: 'send', entries: missing };
}

/** The folder's logs with the restore's lines in place (those it already holds stay as they are). */
export function withRestoreLines(logs: LocalLogs, folderState: VaultState, pending: PendingRestore): LocalLogs {
  const placed: LocalLogs = { ...logs };
  for (const line of pending.lines) {
    const entry = JSON.parse(line) as SignedEntry;
    if (folderState.chains[entry.author]?.[entry.seq] === entryHash(entry)) continue;
    placed[entry.author] = [...(placed[entry.author] ?? []).slice(0, entry.seq), line];
  }
  return placed;
}

export const RESTORE_TAKEN =
  "Another device restored with this recovery phrase at the same moment, so the vault folder holds its change instead of this device's. AuthDeck did not sign again in its place. Try the restore again; if this keeps happening, someone else may have the phrase, so make a new one from a device in the vault.";
export const RECOVERY_NOT_KEPT =
  "The computer answered, but the vault folder still doesn't hold what this device signed with the recovery phrase. AuthDeck keeps it and sends the same lines again when the computer is reachable.";

/** This device's recovery lines lost their seq: the folder counts another version there (or the rules reject them). */
export class RecoveryLinesLost extends Error {}

export const RESTORE_FOLDER_BEHIND =
  "The vault folder on the computer is missing a restore this device already signed with the phrase. AuthDeck won't sign a second one in its place, since that would stop the phrase from working. Check that the vault folder has finished syncing to the computer, then try again.";

/** What sending a restore needs from the engine: the folder, signing, storage and the computer. */
export interface RestoreIo {
  readFolder(): Promise<{ logs: LocalLogs; state: VaultState }>;
  /** Signs a new device.add as the recovery identity and this device's hello, on top of `folder`. */
  sign(folder: { logs: LocalLogs; state: VaultState }): Promise<PendingRestore>;
  save(pending: PendingRestore): Promise<void>;
  append(entries: VaultEntry[]): Promise<void>;
  /** True for an answer worth another read and resend (the computer refused the append). */
  isRefused(err: unknown): boolean;
  /** An attempt of this device's the folder counts (applied, its device a live member), made current; else null. */
  earlier?(folder: { logs: LocalLogs; state: VaultState }): Promise<PendingRestore | null>;
}

export interface SentRestore {
  folder: { logs: LocalLogs; state: VaultState };
  pending: PendingRestore;
  /** The lines this call sent; empty when the folder already held them. */
  sent: VaultEntry[];
}

/** The pending lines the folder holds, every one applied; else why not (null when some are still missing). */
export function heldProblem(folderState: VaultState, pending: PendingRestore): string | null {
  for (const line of pending.lines) {
    const hash = entryHash(JSON.parse(line) as SignedEntry);
    const item = folderState.history.find((h) => h.hash === hash);
    if (item?.status !== 'applied') return item?.reason ?? 'the vault rules reject it';
  }
  return null;
}

/**
 * Sends lines signed with the recovery phrase (a restore, or a solo phrase change), signing only
 * when no live set is stored, and returns once a folder read shows every line applied: an "ok"
 * alone proves nothing (a computer can drop what it answered). A refusal, or a read that still
 * lacks them, sends the same stored bytes again, up to `attempts` sends; then RECOVERY_NOT_KEPT,
 * with the lines kept for the next try. When the folder counts another version at the seq
 * (RecoveryLinesLost): with `redo` (a restore, phrase at hand, solo vault) a new set is signed on
 * top of it at the next seq; without, the caller hears it. A later restore signs only past that seq.
 */
export async function sendRestore(io: RestoreIo, stored: PendingRestore | null, attempts: number, options: { redo?: boolean } = {}): Promise<SentRestore> {
  let pending = stored;
  const sent: VaultEntry[] = [];
  let sends = 0;
  for (let round = 0; round < 3 * attempts + 3; round++) {
    const folder = await io.readFolder();
    // The computer counts an earlier attempt of this device's: that one is adopted, nothing is signed or sent.
    const earlier = io.earlier ? await io.earlier(folder) : null;
    if (earlier) return { folder, pending: earlier, sent: [] };
    if (!pending || pending.superseded) {
      if (pending && (folder.state.chains[pending.recoveryId]?.length ?? 0) <= pending.seq) throw new Error(RESTORE_FOLDER_BEHIND);
      pending = await io.sign(folder);
      // Stored before it goes: if the answer is lost or the app stops, the next try sends these bytes.
      await io.save(pending);
    }
    const step = restoreStep(folder.state, pending);
    const problem = step.kind === 'held' ? heldProblem(folder.state, pending) : null;
    if (step.kind === 'held' && problem === null) return { folder, pending, sent };
    if (step.kind === 'taken' || problem !== null) {
      await io.save({ ...pending, superseded: true });
      if (options.redo && sends < attempts) {
        pending = { ...pending, superseded: true };
        continue;
      }
      throw new RecoveryLinesLost(step.kind === 'taken' ? RESTORE_TAKEN : `The vault doesn't take what this device signed with the recovery phrase: ${problem}.`);
    }
    if (step.kind !== 'send') continue;
    if (sends >= attempts) throw new Error(RECOVERY_NOT_KEPT);
    sends++;
    try {
      await io.append(step.entries);
      sent.push(...step.entries);
    } catch (err) {
      if (io.isRefused(err) && sends < attempts) continue;
      throw err;
    }
  }
  throw new Error(RECOVERY_NOT_KEPT);
}

/** What sending an upload needs from the engine. */
export interface UploadIo {
  send(upload: Upload): Promise<void>;
  isRefused(err: unknown): boolean;
}

export interface UploadOutcome {
  /** What the folder took, or null when nothing went. */
  sent: Upload | null;
  /** True when lines that count were refused, so the outbox is not complete. */
  blocked: boolean;
}

/**
 * Sends one upload. The computer refuses a repair that would bring back a change the rules
 * reject; that can't be forced, and the device's own copy stays complete. A refused repair is
 * tried again with only this device's and active authors' lines, so a removed or cut-off
 * identity's lines never hold up this device's beacon or its own changes.
 */
export async function sendUpload(upload: Upload, state: VaultState, thisDevice: string, io: UploadIo): Promise<UploadOutcome> {
  const refusedRepair = (err: unknown) => {
    if (!upload.repair || !io.isRefused(err)) throw err;
  };
  try {
    await io.send(upload);
    return { sent: upload, blocked: false };
  } catch (err) {
    refusedRepair(err);
  }
  const counted = repairOfActiveAuthors(upload, state, thisDevice);
  if (!counted) return { sent: null, blocked: false };
  if (counted.entries.length === upload.entries.length) return { sent: null, blocked: true };
  try {
    await io.send(counted);
    return { sent: counted, blocked: false };
  } catch (err) {
    refusedRepair(err);
    return { sent: null, blocked: true };
  }
}
