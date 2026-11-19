import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentError, badRequest } from './errors';
import type { VaultEntry, VaultForkProof, VaultHead, VaultLocation, VaultReadResult, VaultSealProof, VaultSummary } from './protocol';
import { beaconShapeProblem, beaconSignedByMember, MAX_BEACON_BYTES, parseBeacon, type Beacon } from './vault/beacon';
import { entryHash, isEntryRef, isId, MAX_IDENTITIES, type SignedEntry } from './vault/entry';
import { AppendRefused, joinLogLines, planAppend, splitLogText } from './vault/logs';
import { canonicalLine, findFounder, forkProofProblem, VerifyCache, type ForkProof, type VaultLogs } from './vault/chain';
import { fromBase64Url } from './vault/bytes';
import { deviceIdFor } from './vault/crypto';
import { identityEd, replayVault, type Member, type ReplayOptions, type VaultState } from './vault/replay';
import { RETIRE_WINDOW_MS, RETIRED_KEEP_MS, retireProblem, retireShapeProblem, type VaultRetire } from './vault/retire';
import { judgeSealProof, sealProofShapeProblem, type SealProof } from './vault/sealProof';
import { DEFAULT_QUOTA_LIMITS, MAX_VAULT_BYTES, MAX_VAULT_ENTRIES, quotaProblem, RESERVE_PER_IDENTITY, UNCAPPED_BOUND, VAULT_RESERVE } from './vaultQuota';
import { vaultFeatures } from './vault/features';

export { MAX_VAULT_BYTES, MAX_VAULT_ENTRIES } from './vaultQuota';

const LOG_DIR = 'log';
const LOG_SUFFIX = '.jsonl';
const HEADS_DIR = 'heads';
const BEACON_SUFFIX = '.json';
const FORKS_DIR = 'forks';
const FORK_SUFFIX = '.json';
/** `seals/<authorId>.json`: the proof of that author's earliest proven bad seal (vault/sealProof.ts). */
const SEALS_DIR = 'seals';
const SEAL_SUFFIX = '.json';
/** One proof is about 260 bytes; anything far larger is not one. */
const MAX_SEAL_PROOF_BYTES = 4 * 1024;
/** Two entries of at most MAX_ENTRY_BYTES each, and a little more. */
const MAX_FORK_BYTES = 2 * 128 * 1024 + 1024;
const VAULT_FILE = 'vault.json';
/**
 * Retired solo vaults (vault.retire): `<personal root>/.retired/<vaultId>/`, the vault folder as
 * it was plus `retired.json`. Not an id, so nothing that lists vault folders takes it for one.
 */
const RETIRED_DIR = '.retired';
const RETIRED_FILE = 'retired.json';
const MAX_RETIRED_FILE_BYTES = 4 * 1024;
/** As pairing.ts keeps a device name. */
const MAX_RETIRED_BY_LENGTH = 80;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_APPEND_ENTRIES = 1000;
/** A `device.remove` seals a key to every device; at MAX_LOG_FILES devices that stays well under this. */
export const MAX_ENTRY_BYTES = 128 * 1024;
export const MAX_APPEND_BYTES = 512 * 1024;
/** Device logs per vault, the recovery identities' included. */
export const MAX_LOG_FILES = MAX_IDENTITIES;
/**
 * What one read of a log folder holds, junk included. Every verified line an identity may have
 * fits in one file (MAX_VAULT_BYTES, the size a vault could reach before quotas); every verified
 * line of the vault, reserves included (vaultQuota.ts), fits in one folder.
 */
const MAX_LOG_FILE_BYTES = MAX_VAULT_BYTES + UNCAPPED_BOUND.bytes;
const MAX_LOG_FILE_LINES = MAX_VAULT_ENTRIES + RESERVE_PER_IDENTITY.lines;
// Uncapped lines (removals and restores, bounded by identities) count toward neither cap.
const MAX_FOLDER_BYTES = MAX_VAULT_BYTES + VAULT_RESERVE.bytes + UNCAPPED_BOUND.bytes;
const MAX_FOLDER_LINES = MAX_VAULT_ENTRIES + VAULT_RESERVE.lines + UNCAPPED_BOUND.lines;
/** Warnings remembered so a junk file is reported once, not on every read; forgotten past this. */
const MAX_REMEMBERED_WARNINGS = 1000;
/** Per `vault.read` call; a device asks again from `from + lines.length` for the rest. */
export const MAX_READ_LINES = 1000;
export const MAX_READ_BYTES = 512 * 1024;
/** Not following links when a file is opened, where the platform has the flag. */
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export interface VaultRoots {
  /** ~/.authdeck/vault */
  personal: string;
  /** The team folder the user chose, if any. Read on every call so a change applies at once. */
  team: () => string | null;
}

interface VaultFolder {
  vaultId: string;
  dir: string;
  location: VaultLocation;
  /** Set for a retired vault's folder (under `.retired`): its retired.json, or null when that file is unreadable. */
  retired?: RetiredMarker | null;
}

/** `retired.json` in a retired vault's folder. */
interface RetiredMarker {
  v: 1;
  vaultId: string;
  at: number;
  keptUntil: number;
  newVaultId: string;
  byDevice: string | null;
}

/** The personal vault root under the agent's home folder. */
export function personalVaultRoot(home: string): string {
  return path.join(home, 'vault');
}

/**
 * Makes a folder the vault writes into, refusing a link or file in its place before anything
 * is created in it or its mode changed: chmod and writes would otherwise follow a planted link.
 */
function ensureDir(dir: string): void {
  if (!isPlainDir(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    if (!isPlainDir(dir)) throw new AgentError('failed', 'A vault folder could not be made on this computer.');
  }
  if (process.platform !== 'win32') fs.chmodSync(dir, DIR_MODE);
}

/** Writes beside the target and renames, so a reader or sync tool never sees half a file. */
function writeAtomically(file: string, content: string): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, content, { mode: FILE_MODE });
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

function requireVaultId(value: unknown): string {
  if (!isId(value)) throw badRequest('"vaultId" is not a vault id.');
  return value;
}

/**
 * True when `dir` is a real folder, false when it is missing. A link or a file in its place is
 * refused: the folder may come from a sync tool, and a planted link must not redirect writes
 * (or the 0700 chmod) somewhere else on the computer.
 */
function isPlainDir(dir: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (stat.isDirectory()) return true;
  // The path stays out of the message: it would tell the device about this computer's folders.
  throw new AgentError('failed', 'A vault folder on this computer is a link or a file, not a folder, so AuthDeck won\'t use it.', 'Replace it with the real vault folder. `authdeck-agent team-folder` shows where team vaults are kept.');
}

/** True when `dir` is a real folder; false when it is missing, a link or a file (never thrown). */
function isRealDir(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** A retired.json read back, or null when it is missing, unreadable or not one for `vaultId`. */
function readRetiredMarker(dir: string, vaultId: string): RetiredMarker | null {
  let raw: unknown;
  try {
    const text = readPlainFile(path.join(dir, RETIRED_FILE), MAX_RETIRED_FILE_BYTES, () => new AgentError('failed', 'too large'));
    if (text === null) return null;
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const byDevice = m.byDevice === null || (typeof m.byDevice === 'string' && m.byDevice.length <= MAX_RETIRED_BY_LENGTH) ? m.byDevice : undefined;
  if (m.v !== 1 || m.vaultId !== vaultId || !isTime(m.at) || !isTime(m.keptUntil) || !isId(m.newVaultId) || byDevice === undefined) return null;
  return { v: 1, vaultId, at: m.at, keptUntil: m.keptUntil, newVaultId: m.newVaultId, byDevice };
}

/**
 * Reads a plain file without following a link in its place, checking its size on the open file
 * itself (no gap between the check and the read). Null when it is missing, a link or not a file.
 */
function readPlainFile(file: string, maxBytes: number, tooLarge: () => AgentError): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'EMLINK') return null;
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) throw tooLarge();
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function entryBytes(entry: unknown): number {
  return Buffer.byteLength(JSON.stringify(entry) ?? '', 'utf8');
}

/** Refuses an append batch that is too large before any of it is parsed or checked. */
function checkAppendSize(entries: readonly unknown[]): void {
  if (entries.length > MAX_APPEND_ENTRIES) throw badRequest(`Send at most ${MAX_APPEND_ENTRIES} entries at a time.`);
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    const size = entryBytes(entry);
    if (size > MAX_ENTRY_BYTES) throw badRequest(`Entry ${index + 1} is larger than ${MAX_ENTRY_BYTES / 1024} KB, the most one entry may be.`);
    total += size;
  }
  if (total > MAX_APPEND_BYTES) throw badRequest(`These entries add up to more than ${MAX_APPEND_BYTES / 1024} KB. Send them in smaller batches.`);
}

/** A log file's lines, or why the file was skipped. `cut` says why its tail was dropped, if it was. */
type LogRead = { lines: string[]; cut: string | null } | { skipped: string };

/**
 * Reads at most MAX_LOG_FILE_BYTES of a plain log file (never through a link) and keeps its
 * lines up to the first one no entry could be. Lines after such a line can't verify: each
 * entry chains on the one before it, so dropping them loses nothing honest.
 */
function readLogFile(file: string, maxBytes = MAX_LOG_FILE_BYTES): LogRead {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (err) {
    return { skipped: `it could not be opened (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { skipped: 'it is not a plain file' };
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    let filled = 0;
    while (filled < buffer.length) {
      const read = fs.readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    const tooLarge = stat.size > maxBytes;
    // Cut at a newline, so a multi-byte character is never split.
    const kept = tooLarge ? buffer.subarray(0, buffer.lastIndexOf(0x0a, filled - 1) + 1) : buffer.subarray(0, filled);
    const lines = splitLogText(kept.toString('utf8'));
    const oversized = lines.findIndex((line) => Buffer.byteLength(line, 'utf8') > MAX_ENTRY_BYTES);
    if (oversized >= 0) return { lines: lines.slice(0, oversized), cut: `line ${oversized + 1} is larger than an entry may be` };
    if (lines.length > MAX_LOG_FILE_LINES) return { lines: lines.slice(0, MAX_LOG_FILE_LINES), cut: `it has more than ${MAX_LOG_FILE_LINES} lines` };
    return { lines, cut: tooLarge ? `it is larger than ${maxBytes / (1024 * 1024)} MB` : null };
  } catch (err) {
    return { skipped: `it could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  } finally {
    fs.closeSync(fd);
  }
}

function logBytes(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0);
}

/** The identity a verified device.add or recovery.set names, so its log can be read next. */
function identityNamedBy(line: string): string | null {
  try {
    const entry = JSON.parse(line) as SignedEntry;
    if (entry.kind === 'device.add') return isId(entry.body.device) ? entry.body.device : null;
    if (entry.kind === 'recovery.set') return deviceIdFor(fromBase64Url(String(entry.body.ed)));
  } catch {
    // A verified line always parses; anything else names nobody.
  }
  return null;
}

function requireProof(value: unknown): Record<string, VaultHead> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('A repair needs "proof": the head this device remembers for each log it writes back.');
  const proof: Record<string, VaultHead> = {};
  for (const [deviceId, head] of Object.entries(value)) {
    if (!isId(deviceId) || !isEntryRef(head)) throw badRequest('"proof" must map device ids to { seq, hash }.');
    proof[deviceId] = head;
  }
  return proof;
}

function forkProofShape(value: unknown): ForkProof {
  const raw = value as Partial<VaultForkProof> | null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw badRequest('The fork proof must be an object.');
  if (Object.keys(raw).sort().join(',') !== 'deviceId,lines,seq') throw badRequest('The fork proof has missing or extra fields.');
  if (!isId(raw.deviceId) || !Number.isSafeInteger(raw.seq) || (raw.seq as number) < 0) throw badRequest('The fork proof names no valid device or seq.');
  const lines = raw.lines;
  if (!Array.isArray(lines) || lines.length !== 2 || !lines.every((l) => typeof l === 'string' && Buffer.byteLength(l, 'utf8') <= MAX_ENTRY_BYTES)) throw badRequest('The fork proof must hold two entry lines.');
  return { deviceId: raw.deviceId, seq: raw.seq as number, lines: [lines[0]!, lines[1]!] };
}

function sealProofShape(value: unknown): SealProof {
  const problem = sealProofShapeProblem(value);
  if (problem) throw badRequest(`The seal proof is malformed: ${problem}.`);
  const raw = value as VaultSealProof;
  return { entry: raw.entry, to: raw.to, proof: raw.proof };
}

/** Replay options carrying seal proofs; replay.ts reads them as `sealProofs`. */
type FolderReplayOptions = ReplayOptions & { forks: ForkProof[]; sealProofs: readonly SealProof[] };

/** Lines from each device's `since` point, at most MAX_READ_LINES and MAX_READ_BYTES in all (always at least one line, so a reader moves on). */
function pageLogs(logs: VaultLogs, since: Record<string, number>): VaultReadResult['logs'] {
  const page: VaultReadResult['logs'] = {};
  let lineBudget = MAX_READ_LINES;
  let byteBudget = MAX_READ_BYTES;
  for (const deviceId of Object.keys(logs).sort()) {
    const lines = logs[deviceId]!;
    const from = Math.min(since[deviceId] ?? 0, lines.length);
    const taken: string[] = [];
    for (const line of lines.slice(from)) {
      const size = Buffer.byteLength(line, 'utf8');
      const first = lineBudget === MAX_READ_LINES && byteBudget === MAX_READ_BYTES;
      if (lineBudget === 0 || (size > byteBudget && !first)) break;
      taken.push(line);
      lineBudget -= 1;
      byteBudget = Math.max(0, byteBudget - size);
    }
    page[deviceId] = { from, lines: taken };
  }
  return page;
}

/** Every identity a replay knows: its members (the founder among them) and its recovery identity. */
function knownIdentities(state: VaultState): string[] {
  const ids = new Set(Object.keys(state.members));
  if (state.founder) ids.add(state.founder);
  if (state.recovery) ids.add(state.recovery.deviceId);
  return [...ids].filter(isId);
}

/** Out of the vault by a removal (not by signing two histories). */
function wasRemoved(member: Member): boolean {
  return member.removed && member.removedBy.length > 0;
}

/**
 * Identities a change took out of the vault: members removed after it and not before, plus, when
 * such a removal was answered by one at the same time (a symmetric conflict, both devices out),
 * the removed devices that made it.
 */
export function identitiesTakenOut(before: VaultState, after: VaultState): string[] {
  const outBefore = (id: string) => Object.hasOwn(before.members, id) && before.members[id]!.removed;
  const takenOut = new Set<string>();
  for (const member of Object.values(after.members)) {
    if (!wasRemoved(member) || outBefore(member.deviceId)) continue;
    takenOut.add(member.deviceId);
    for (const remover of member.removedBy) {
      if (Object.hasOwn(after.members, remover) && after.members[remover]!.removed) takenOut.add(remover);
    }
  }
  return [...takenOut];
}

/**
 * True when `entries` hold a restore this append applied and the folder lacked: a device.add in a
 * solo vault, which only the recovery identity (no member) signs. Lines sent again restore nothing.
 */
function appliedNewRestore(entries: readonly VaultEntry[], before: VaultState, after: VaultState): boolean {
  if (after.kind !== 'solo') return false;
  return entries.some((entry) => {
    if (entry.kind !== 'device.add' || Object.hasOwn(after.members, entry.author)) return false;
    const hash = entryHash(entry as SignedEntry);
    if (Object.hasOwn(before.chains, entry.author) && before.chains[entry.author]![entry.seq] === hash) return false;
    return after.history.some((item) => item.hash === hash && item.status === 'applied');
  });
}

/** 0.3.0 keeps solo vaults only; no released build could make any other kind. */
const SOLO_ONLY = 'This vault was made by a newer or test build of AuthDeck. Multi-device vaults arrive in 0.4.';
const NOT_SOLO_RETIRE = 'Only a vault kept on one device (a solo vault) can be retired from a device.';

/**
 * Vault folders on this computer: `<root>/<vaultId>/vault.json` and `log/<deviceId>.jsonl`.
 * Appends are checked with the vault core's rules and written atomically, one vault at a time.
 */
export class VaultStore {
  /** Verified prefixes per vault folder, so an append re-checks signatures only on new lines. */
  private readonly caches = new Map<string, VerifyCache>();

  /** Warnings already logged, so a junk file in a watched folder is reported once. */
  private readonly warned = new Set<string>();

  /** Signatures of retire requests already taken, until they could no longer pass the time check anyway. */
  private readonly usedRetires = new Map<string, number>();

  /**
   * `log` takes warnings about junk in vault folders; it is never given log contents. `now` is the
   * clock retire requests and retired folders are judged by. Retired vaults past their time are
   * deleted now and on every list.
   */
  constructor(
    private readonly roots: VaultRoots,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    this.sweepRetired();
  }

  /** Folders to watch for changes from sync tools. */
  watchRoots(): { root: string; location: VaultLocation }[] {
    // 0.3.0 keeps solo vaults in the agent's own folder only; no team folder is read.
    const team = vaultFeatures.multiDevice ? this.roots.team() : null;
    return [{ root: this.roots.personal, location: 'personal' as const }, ...(team ? [{ root: team, location: 'team' as const }] : [])];
  }

  /** Live vaults, then retired ones (`retired` set) not already listed live. */
  list(): VaultSummary[] {
    this.sweepRetired();
    const vaults: VaultSummary[] = [];
    const summary = (folder: VaultFolder): VaultSummary => ({ vaultId: folder.vaultId, kind: this.kindHint(folder), location: folder.location, path: folder.dir, lengths: this.lengths(this.readLogs(folder)) });
    for (const { root, location } of this.watchRoots()) {
      for (const name of this.dirNames(root)) {
        if (isId(name)) vaults.push(summary({ vaultId: name, dir: path.join(root, name), location }));
      }
    }
    const live = new Set(vaults.map((v) => v.vaultId));
    for (const folder of this.retiredFolders()) {
      if (live.has(folder.vaultId) || !folder.retired) continue;
      const { at, keptUntil, newVaultId, byDevice } = folder.retired;
      vaults.push({ ...summary(folder), retired: { at, keptUntil, newVaultId, byDevice } });
    }
    return vaults;
  }

  read(vaultIdInput: unknown, sinceInput: unknown): VaultReadResult {
    const vaultId = requireVaultId(vaultIdInput);
    const since = this.since(sinceInput);
    const folder = this.find(vaultId);
    if (!folder) throw new AgentError('not_found', 'This computer has no vault with that id.', 'Check that the vault folder is synced to this computer.');
    const raw = this.readLogs(folder);
    // Served canonical (S7r-1): a padded line reaches devices as the entry it encodes, never as the computer's bytes.
    const logs: VaultLogs = Object.fromEntries(Object.entries(raw).map(([id, lines]) => [id, lines.map(canonicalLine)]));
    return { vaultId, location: folder.location, logs: pageLogs(logs, since), lengths: this.lengths(raw) };
  }

  /**
   * Checks and writes entries. Synchronous on purpose: two appends to one vault can't interleave.
   * `takenOut` lists the identities this append took out of the vault (see identitiesTakenOut).
   * `wrote` lists the devices of the vault whose logs this append changed: lines it only sent
   * again change nothing, and a recovery identity is not a device.
   */
  append(vaultIdInput: unknown, entriesInput: unknown, repair: boolean, proofInput?: unknown): { lengths: Record<string, number>; takenOut: string[]; wrote: string[]; restored: boolean } {
    const vaultId = requireVaultId(vaultIdInput);
    if (!Array.isArray(entriesInput) || entriesInput.length === 0) throw badRequest('"entries" must be a list of log entries.');
    checkAppendSize(entriesInput);
    const proof = repair ? requireProof(proofInput) : undefined;
    const entries = entriesInput as VaultEntry[];
    const folder = this.find(vaultId) ?? this.newFolder(vaultId, entries[0]);
    const logsBefore = this.readLogs(folder);
    let plan;
    try {
      plan = planAppend(vaultId, logsBefore, entries, { repair, proof, ...this.replayOptions(folder, logsBefore) });
    } catch (err) {
      if (err instanceof AppendRefused) throw new AgentError('bad_request', err.message);
      throw err;
    }
    if (!vaultFeatures.multiDevice && plan.state.created && plan.state.kind !== 'solo') throw new AgentError('bad_request', SOLO_ONLY);
    if (Object.keys(plan.state.chains).length > MAX_LOG_FILES) throw badRequest(`A vault can hold at most ${MAX_LOG_FILES} device logs.`);
    const quota = quotaProblem(plan.state, plan.logs, new Set(entries.map((entry) => entryHash(entry as SignedEntry))), DEFAULT_QUOTA_LIMITS, plan.before);
    if (quota) throw badRequest(quota);
    ensureDir(folder.dir);
    const logDir = path.join(folder.dir, LOG_DIR);
    ensureDir(logDir);
    if (!fs.existsSync(path.join(folder.dir, VAULT_FILE))) {
      writeAtomically(path.join(folder.dir, VAULT_FILE), `${JSON.stringify({ v: 1, vaultId, kind: plan.state.kind })}\n`);
    }
    for (const deviceId of plan.changed) writeAtomically(path.join(logDir, `${deviceId}${LOG_SUFFIX}`), joinLogLines(plan.logs[deviceId] ?? []));
    const wrote = plan.changed.filter((id) => Object.hasOwn(plan.state.members, id));
    const takenOut = this.takenOutBy(vaultId, logsBefore, plan.state, folder);
    const restored = appliedNewRestore(entries, plan.before, plan.state);
    // Its owner took a retired vault back with its phrase: it is live again (see retire).
    if (restored && folder.retired !== undefined) this.unretire(folder);
    return { lengths: this.lengths(plan.logs), takenOut, wrote, restored };
  }

  /**
   * Retires a solo vault (vault.retire): a phone that made a new vault without the old phrase
   * sets the old one aside. The request must be signed by the vault's active device, judged by a
   * full replay of the folder, for this computer (`agentId`) and near this computer's clock
   * (vault/retire.ts); a signature already taken is refused, so a request can't be sent again.
   *
   * Nothing is deleted: the folder moves to `<personal root>/.retired/<vaultId>/` with a
   * retired.json, is listed with `retired`, can still be read and restored with its phrase (a
   * restore makes it live again, see append), and is deleted RETIRED_KEEP_MS later. Retiring a
   * vault already retired changes nothing and answers its `keptUntil` again, once the request
   * passes the same checks against the retired folder (a phone retrying after a lost answer).
   * `retiredNow` is false then. `byDevice` is the paired device's name, shown to the user.
   */
  retire(vaultIdInput: unknown, requestInput: unknown, agentId: string, byDevice: string | null): { keptUntil: number; retiredNow: boolean } {
    const vaultId = requireVaultId(vaultIdInput);
    const shape = retireShapeProblem(requestInput);
    if (shape) throw badRequest(`The retire request is malformed: ${shape}.`);
    const request = requestInput as VaultRetire;
    if (request.vault !== vaultId) throw badRequest('The retire request is for another vault.');
    const folder = this.requireFolder(vaultId);
    if (folder.location !== 'personal') throw new AgentError('bad_request', NOT_SOLO_RETIRE);
    const logs = this.readLogs(folder);
    const state = replayVault(vaultId, logs, this.replayOptions(folder, logs));
    if (!state.created || state.kind !== 'solo') throw new AgentError('bad_request', NOT_SOLO_RETIRE);
    const now = this.now();
    const problem = retireProblem(request, state, agentId, now);
    if (problem) throw badRequest(`This computer won't retire the vault: ${problem}.`);
    if (folder.retired !== undefined) {
      if (!folder.retired) throw new AgentError('failed', 'This vault was already retired on this computer, but its record could not be read.');
      return { keptUntil: folder.retired.keptUntil, retiredNow: false };
    }
    for (const [sig, until] of this.usedRetires) if (until < now) this.usedRetires.delete(sig);
    if (this.usedRetires.has(request.sig)) throw badRequest('This retire request was already taken. Make a new one.');
    const keptUntil = now + RETIRED_KEEP_MS;
    const marker: RetiredMarker = { v: 1, vaultId, at: now, keptUntil, newVaultId: request.newVault, byDevice: byDevice === null ? null : byDevice.slice(0, MAX_RETIRED_BY_LENGTH) };
    const retiredRoot = path.join(this.roots.personal, RETIRED_DIR);
    ensureDir(retiredRoot);
    const target = path.join(retiredRoot, vaultId);
    // An older retired copy of this id (one taken back, then retired again with the live folder
    // still behind it) is replaced: the live folder holds every line it did and more.
    if (isPlainDir(target)) fs.rmSync(target, { recursive: true, force: true });
    const markerFile = path.join(folder.dir, RETIRED_FILE);
    writeAtomically(markerFile, `${JSON.stringify(marker)}\n`);
    try {
      fs.renameSync(folder.dir, target);
    } catch (err) {
      fs.rmSync(markerFile, { force: true });
      throw err;
    }
    this.usedRetires.set(request.sig, Math.max(now, request.time) + RETIRE_WINDOW_MS);
    this.caches.delete(folder.dir);
    return { keptUntil, retiredNow: true };
  }

  /**
   * Moves a retired vault back to the personal root, when its owner restored it with its phrase.
   * Left where it is (still found, still retired) when a live folder of that id appeared meanwhile.
   */
  private unretire(folder: VaultFolder): void {
    const live = path.join(this.roots.personal, folder.vaultId);
    try {
      fs.lstatSync(live);
      return;
    } catch {
      // Nothing there: the folder goes back.
    }
    fs.renameSync(folder.dir, live);
    fs.rmSync(path.join(live, RETIRED_FILE), { force: true });
    this.caches.delete(folder.dir);
    this.log('A retired vault was restored with its recovery phrase, so it is no longer retired.');
  }

  /** Retired vault folders, each with its retired.json (null when unreadable). */
  private retiredFolders(): VaultFolder[] {
    const root = path.join(this.roots.personal, RETIRED_DIR);
    if (!isRealDir(root)) return [];
    return this.dirNames(root)
      .filter(isId)
      .map((vaultId) => {
        const dir = path.join(root, vaultId);
        return { vaultId, dir, location: 'personal' as const, retired: readRetiredMarker(dir, vaultId) };
      });
  }

  /**
   * Deletes retired vaults whose time is up. A folder whose retired.json can't be read is kept:
   * this agent can't tell when it was retired. Never thrown: a failure is logged and tried again.
   */
  private sweepRetired(): void {
    try {
      const now = this.now();
      for (const folder of this.retiredFolders()) {
        if (folder.retired && folder.retired.keptUntil <= now) {
          fs.rmSync(folder.dir, { recursive: true, force: true });
          this.caches.delete(folder.dir);
        }
      }
    } catch (err) {
      this.log(`Could not delete an old retired vault: ${(err as NodeJS.ErrnoException).code ?? 'error'}. Trying again later.`);
    }
  }

  /** Replays the folder as it was only when someone is out now, so most appends pay for no extra replay. */
  private takenOutBy(vaultId: string, logsBefore: VaultLogs, after: VaultState, folder: VaultFolder): string[] {
    if (!Object.values(after.members).some(wasRemoved)) return [];
    const before = replayVault(vaultId, logsBefore, this.replayOptions(folder, logsBefore));
    return identitiesTakenOut(before, after);
  }

  /**
   * The beacon file of every identity the vault knows, raw: devices check the signatures
   * themselves. Files are read by those identities' names, so other files in the folder, however
   * many, never hide one.
   */
  readBeacons(vaultIdInput: unknown): { beacons: Record<string, string> } {
    const vaultId = requireVaultId(vaultIdInput);
    const folder = this.requireFolder(vaultId);
    const headsDir = path.join(folder.dir, HEADS_DIR);
    if (!isPlainDir(headsDir)) return { beacons: {} };
    const logs = this.readLogs(folder);
    const state = replayVault(vaultId, logs, this.replayOptions(folder, logs));
    const beacons = new Map<string, string>();
    for (const id of knownIdentities(state)) {
      // An oversized beacon is skipped like a stray file: devices ignore anything they can't verify.
      const text = readPlainFile(path.join(headsDir, `${id}${BEACON_SUFFIX}`), MAX_BEACON_BYTES, () => new AgentError('failed', 'too large'));
      if (text !== null) beacons.set(id, text);
    }
    return { beacons: Object.fromEntries(beacons) };
  }

  /**
   * Overwrites one device's beacon. The agent checks it is signed by a device of the vault and
   * is not older than the stored one, so an honest computer never serves a stale beacon.
   */
  writeBeacon(vaultIdInput: unknown, beaconInput: unknown): Record<string, never> {
    const vaultId = requireVaultId(vaultIdInput);
    const problem = beaconShapeProblem(beaconInput);
    if (problem) throw badRequest(`The head beacon is malformed: ${problem}.`);
    const beacon = beaconInput as Beacon;
    const text = `${JSON.stringify(beacon)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_BEACON_BYTES) throw badRequest('The head beacon is too large.');
    if (beacon.vault !== vaultId) throw badRequest('The head beacon belongs to another vault.');
    const folder = this.find(vaultId);
    if (!folder) throw new AgentError('not_found', 'This computer has no vault with that id.', 'Check that the vault folder is synced to this computer.');
    const logs = this.readLogs(folder);
    const state = replayVault(vaultId, logs, this.replayOptions(folder, logs));
    if (!beaconSignedByMember(beacon, state)) throw badRequest('The head beacon is not signed by a device of this vault.');
    const headsDir = path.join(folder.dir, HEADS_DIR);
    ensureDir(headsDir);
    const file = path.join(headsDir, `${beacon.device}${BEACON_SUFFIX}`);
    const stored = readPlainFile(file, MAX_BEACON_BYTES, () => new AgentError('failed', 'too large'));
    const previous = stored === null ? null : parseBeacon(stored);
    if (previous && previous.time > beacon.time) throw badRequest('This head beacon is older than the one stored for the device.');
    writeAtomically(file, text);
    return {};
  }

  /** The folder's fork proofs and seal proofs, raw; devices check them like the agent does. */
  readForks(vaultIdInput: unknown): { forks: VaultForkProof[]; sealProofs: VaultSealProof[] } {
    const folder = this.requireFolder(requireVaultId(vaultIdInput));
    const logs = this.readLogs(folder);
    return { forks: this.readForkProofs(folder, logs), sealProofs: this.readSealProofs(folder, logs) };
  }

  /**
   * Keeps proof that a device signed two histories (chain.ts ForkProof). Checked against that identity's
   * key, so nobody else can make one; the earliest proven seq per device is kept.
   */
  writeFork(vaultIdInput: unknown, proofInput: unknown): Record<string, never> {
    const vaultId = requireVaultId(vaultIdInput);
    const proof = forkProofShape(proofInput);
    const folder = this.requireFolder(vaultId);
    const logs = this.readLogs(folder);
    const options = this.replayOptions(folder, logs);
    const { forks } = options;
    const state = replayVault(vaultId, logs, options);
    const member = Object.hasOwn(state.members, proof.deviceId) ? state.members[proof.deviceId] : undefined;
    // Before any check: only a member or an identity with lines here (a replaced recovery identity).
    if (!member && state.recovery?.deviceId !== proof.deviceId && !Object.hasOwn(state.chains, proof.deviceId)) throw badRequest('The fork proof is about a device this vault doesn\'t know.');
    // A replaced recovery identity too: in a solo vault a proof about it chooses which of its versions counts.
    const ed = member?.ed ?? (state.recovery?.deviceId === proof.deviceId ? state.recovery.ed : identityEd(vaultId, logs, proof.deviceId, options.cache));
    if (!ed) throw badRequest('The fork proof is about a device this vault doesn\'t know.');
    const identity = { deviceId: proof.deviceId, ed: fromBase64Url(ed), role: 'device' as const };
    const problem = forkProofProblem(vaultId, identity, proof);
    if (problem) throw badRequest(`The fork proof is not valid: ${problem}.`);
    // A recovery identity's line a standing device already built on is settled here: this
    // computer holds it, so a second version signed later at or below it is refused (N1).
    if (!member && recoveryLineBuiltOn(state, logs, proof.deviceId, proof.seq)) {
      throw badRequest('A device in this vault already built on the recovery phrase\'s line at that place, so another version there is not taken.');
    }
    const stored = forks.find((f) => f.deviceId === proof.deviceId);
    // A stored proof that doesn't hold (junk the folder was given) never keeps a valid one out.
    if (stored && stored.seq <= proof.seq && forkProofProblem(vaultId, identity, stored) === null) return {};
    const forksDir = path.join(folder.dir, FORKS_DIR);
    ensureDir(forksDir);
    writeAtomically(path.join(forksDir, `${proof.deviceId}${FORK_SUFFIX}`), `${JSON.stringify(proof)}\n`);
    return {};
  }

  /**
   * Keeps proof that a seal in a key change or approval is bad (vault/sealProof.ts): checked
   * against the folder, so only the seal's recipient can make one and an honest author's good
   * seal never passes. The proof against each author's earliest such entry is kept, as
   * `seals/<authorId>.json`.
   */
  writeSealProof(vaultIdInput: unknown, proofInput: unknown): Record<string, never> {
    const vaultId = requireVaultId(vaultIdInput);
    const proof = sealProofShape(proofInput);
    const folder = this.requireFolder(vaultId);
    const logs = this.readLogs(folder);
    const state = replayVault(vaultId, logs, this.replayOptions(folder, logs));
    const judged = judgeSealProof(state, logs, proof);
    if (!judged.ok) throw badRequest(`The seal proof is not valid: ${judged.reason}.`);
    const seqOf = (hash: string) => state.history.find((h) => h.hash === hash && h.author === judged.author)?.seq;
    const earlier = this.readSealProofs(folder, logs).some((stored) => (seqOf(stored.entry) ?? Number.POSITIVE_INFINITY) <= judged.seq);
    if (earlier) return {};
    const sealsDir = path.join(folder.dir, SEALS_DIR);
    ensureDir(sealsDir);
    writeAtomically(path.join(sealsDir, `${judged.author}${SEAL_SUFFIX}`), `${JSON.stringify(proof)}\n`);
    return {};
  }

  /** What every replay of this folder applies: its fork proofs and seal proofs. */
  private replayOptions(folder: VaultFolder, logs: VaultLogs): FolderReplayOptions {
    return { cache: this.cacheFor(folder), forks: this.readForkProofs(folder, logs), sealProofs: this.readSealProofs(folder, logs) };
  }

  /**
   * The seal proofs against the identities whose logs are being replayed, read by their file
   * names (`seals/<authorId>.json`) like fork proofs, never by listing the folder. Only the shape
   * is checked here: every replay checks each proof against the entry it names.
   */
  private readSealProofs(folder: VaultFolder, logs: VaultLogs): SealProof[] {
    const sealsDir = path.join(folder.dir, SEALS_DIR);
    if (!isPlainDir(sealsDir)) return [];
    const proofs: SealProof[] = [];
    for (const id of Object.keys(logs)) {
      if (!isId(id)) continue;
      const text = readPlainFile(path.join(sealsDir, `${id}${SEAL_SUFFIX}`), MAX_SEAL_PROOF_BYTES, () => new AgentError('failed', 'too large'));
      if (text === null) continue;
      try {
        proofs.push(sealProofShape(JSON.parse(text)));
      } catch {
        // A file that isn't a proof proves nothing.
      }
    }
    return proofs;
  }

  /**
   * The fork proofs of the identities whose logs are being replayed, read by their file names
   * (`forks/<deviceId>.json`), so other files in the folder, however many, never hide one. A
   * replay knows only identities with a log, so a proof about anyone else would change nothing;
   * and the logs a read holds are capped, falling back to the vault's own devices' logs when
   * junk crowds the folder (readLogs).
   */
  private readForkProofs(folder: VaultFolder, logs: VaultLogs): ForkProof[] {
    const forksDir = path.join(folder.dir, FORKS_DIR);
    if (!isPlainDir(forksDir)) return [];
    const proofs: ForkProof[] = [];
    for (const id of Object.keys(logs)) {
      if (!isId(id)) continue;
      const text = readPlainFile(path.join(forksDir, `${id}${FORK_SUFFIX}`), MAX_FORK_BYTES, () => new AgentError('failed', 'too large'));
      if (text === null) continue;
      try {
        const proof = forkProofShape(JSON.parse(text));
        if (proof.deviceId === id) proofs.push(proof);
      } catch {
        // A file that isn't a proof proves nothing; replays check every proof's signatures anyway.
      }
    }
    return proofs;
  }

  private requireFolder(vaultId: string): VaultFolder {
    const folder = this.find(vaultId);
    if (!folder) throw new AgentError('not_found', 'This computer has no vault with that id.', 'Check that the vault folder is synced to this computer.');
    return folder;
  }

  private cacheFor(folder: VaultFolder): VerifyCache {
    let cache = this.caches.get(folder.dir);
    if (!cache) {
      cache = new VerifyCache();
      this.caches.set(folder.dir, cache);
    }
    return cache;
  }

  /** Where a new vault goes: a team vault in the team folder, a personal one under the agent's home. */
  private newFolder(vaultId: string, first: VaultEntry | undefined): VaultFolder {
    if (first?.kind !== 'vault.create') throw new AgentError('not_found', 'This computer has no vault with that id.', 'Check that the vault folder is synced to this computer.');
    if (!vaultFeatures.multiDevice && first.body.kind !== 'solo') throw new AgentError('bad_request', SOLO_ONLY);
    if (first.body.kind === 'team') {
      const team = this.roots.team();
      if (!team) throw new AgentError('failed', 'No team folder is set on this computer.', 'Choose a shared folder for team vaults in the AuthDeck agent first.');
      return { vaultId, dir: path.join(team, vaultId), location: 'team' };
    }
    return { vaultId, dir: path.join(this.roots.personal, vaultId), location: 'personal' };
  }

  /** A live vault's folder, else a retired one's (still read, written and restored). */
  private find(vaultId: string): VaultFolder | null {
    for (const { root, location } of this.watchRoots()) {
      const dir = path.join(root, vaultId);
      if (isPlainDir(dir)) return { vaultId, dir, location };
    }
    const retiredRoot = path.join(this.roots.personal, RETIRED_DIR);
    const dir = path.join(retiredRoot, vaultId);
    if (isRealDir(retiredRoot) && isRealDir(dir)) return { vaultId, dir, location: 'personal', retired: readRetiredMarker(dir, vaultId) };
    return null;
  }

  private dirNames(root: string): string[] {
    try {
      return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private kindHint(folder: VaultFolder): VaultSummary['kind'] {
    try {
      const hint = JSON.parse(fs.readFileSync(path.join(folder.dir, VAULT_FILE), 'utf8')) as { kind?: unknown };
      return hint.kind === 'personal' || hint.kind === 'team' || hint.kind === 'solo' ? hint.kind : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Every `<deviceId>.jsonl` in the log folder, up to what a folder read holds. Junk is skipped
   * with a warning, never thrown: other files (sync tools' conflict copies, temp files, links),
   * unreadable files, and lines no entry could be. When junk crowds the folder past what a read
   * holds, only the logs of identities the vault brings in are read (readKnownLogs).
   */
  private readLogs(folder: VaultFolder): VaultLogs {
    const logDir = path.join(folder.dir, LOG_DIR);
    if (!isPlainDir(logDir)) return {};
    const ids = this.logIds(folder, logDir);
    if (ids.length > MAX_LOG_FILES) return this.readKnownLogs(folder, logDir, ids, `it has ${ids.length} device logs`);
    const logs: Record<string, string[]> = {};
    let bytes = 0;
    let lines = 0;
    for (const id of ids) {
      const read = this.readLog(folder, logDir, id);
      if (!read) continue;
      logs[id] = read;
      bytes += logBytes(read);
      lines += read.length;
      if (bytes > MAX_FOLDER_BYTES || lines > MAX_FOLDER_LINES) return this.readKnownLogs(folder, logDir, ids, 'its logs are larger than a vault can be');
    }
    return logs;
  }

  /** The device ids of the folder's log files; anything else there is skipped with a warning. */
  private logIds(folder: VaultFolder, logDir: string): string[] {
    const ids: string[] = [];
    for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
      const id = entry.name.endsWith(LOG_SUFFIX) ? entry.name.slice(0, -LOG_SUFFIX.length) : null;
      if (entry.isFile() && id !== null && isId(id)) ids.push(id);
      // Dot files are this agent's own temp files mid-write. Stray names stay out of the log: a hostile one could forge lines.
      else if (!entry.name.startsWith('.')) this.warn(folder, `a file whose name is not a device log was skipped (${entry.isFile() ? 'not <device id>.jsonl' : 'not a plain file'})`);
    }
    return ids.sort();
  }

  /** One log's lines, or null when it is skipped. Junk is reported once through the logger. */
  private readLog(folder: VaultFolder, logDir: string, id: string): string[] | null {
    const read = readLogFile(path.join(logDir, `${id}${LOG_SUFFIX}`));
    if ('skipped' in read) {
      this.warn(folder, `the log ${id} was skipped: ${read.skipped}`);
      return null;
    }
    if (read.cut) this.warn(folder, `the end of the log ${id} was ignored: ${read.cut}`);
    return read.lines;
  }

  /**
   * Reads only the logs the vault itself brings in: the founder's, then each identity a
   * verified device.add or recovery.set names, as the replay discovers them. Lines past each
   * verified chain are dropped. Junk files, however many or large, are never read.
   */
  private readKnownLogs(folder: VaultFolder, logDir: string, ids: readonly string[], why: string): VaultLogs {
    this.warn(folder, `only the logs of the vault's own devices were read: ${why}`);
    const onDisk = new Set(ids);
    const logs: Record<string, string[]> = {};
    const founder = this.findFounderLog(folder, logDir, ids);
    if (!founder) return logs;
    logs[founder.id] = founder.lines;
    const cache = this.cacheFor(folder);
    for (let round = 0; round < MAX_IDENTITIES; round++) {
      const { chains } = replayVault(folder.vaultId, logs, { ...this.replayOptions(folder, logs), cache });
      const named = new Set<string>();
      for (const [id, hashes] of Object.entries(chains)) {
        logs[id] = logs[id]!.slice(0, hashes.length);
        for (const line of logs[id]!) {
          const next = identityNamedBy(line);
          if (next !== null && onDisk.has(next) && !Object.hasOwn(logs, next)) named.add(next);
        }
      }
      if (named.size === 0) break;
      for (const id of named) logs[id] = this.readLog(folder, logDir, id) ?? [];
    }
    return logs;
  }

  /** The founder's log: the one whose first line founds this vault. Only first lines are read until it is found. */
  private findFounderLog(folder: VaultFolder, logDir: string, ids: readonly string[]): { id: string; lines: string[] } | null {
    for (const id of ids) {
      const first = readLogFile(path.join(logDir, `${id}${LOG_SUFFIX}`), MAX_ENTRY_BYTES + 1);
      if ('skipped' in first || first.lines.length === 0 || !findFounder(folder.vaultId, { [id]: first.lines.slice(0, 1) })) continue;
      const lines = this.readLog(folder, logDir, id);
      return lines ? { id, lines } : null;
    }
    return null;
  }

  /** Logs a warning about a vault folder once, while it is remembered. */
  private warn(folder: VaultFolder, message: string): void {
    const key = `${folder.dir}\0${message}`;
    if (this.warned.has(key)) return;
    if (this.warned.size >= MAX_REMEMBERED_WARNINGS) this.warned.clear();
    this.warned.add(key);
    this.log(`Vault ${folder.vaultId}: ${message}.`);
  }

  private lengths(logs: VaultLogs): Record<string, number> {
    return Object.fromEntries(Object.entries(logs).map(([deviceId, lines]) => [deviceId, lines.length]));
  }

  private since(value: unknown): Record<string, number> {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('"since" must map device ids to line numbers.');
    const since: Record<string, number> = {};
    for (const [deviceId, line] of Object.entries(value)) {
      if (!isId(deviceId) || !Number.isSafeInteger(line) || (line as number) < 0) throw badRequest('"since" must map device ids to line numbers.');
      since[deviceId] = line as number;
    }
    return since;
  }
}

/**
 * True when a standing member's applied line builds on the recovery identity's folder line at
 * `seq` or a later one of the same `prev` chain: it names one in `seen`, or a hello names one as
 * its approval (writeFork, N1). The folder holds those lines; the replay can't tell which
 * version came first, but this computer can.
 */
function recoveryLineBuiltOn(state: VaultState, logs: VaultLogs, recoveryId: string, seq: number): boolean {
  const lines = logs[recoveryId] ?? [];
  const held = new Set<string>();
  let prev: string | null = null;
  for (let at = seq; at < lines.length; at++) {
    let entry: SignedEntry;
    try {
      entry = JSON.parse(lines[at]!) as SignedEntry;
    } catch {
      break;
    }
    if (entry.seq !== at || (at > seq && entry.prev !== prev)) break;
    prev = entryHash(entry);
    held.add(prev);
  }
  if (held.size === 0) return false;
  for (const item of state.history) {
    if (item.status !== 'applied' || item.author === recoveryId) continue;
    const author = Object.hasOwn(state.members, item.author) ? state.members[item.author]! : null;
    if (!author || author.removed === true) continue;
    let entry: SignedEntry;
    try {
      entry = JSON.parse(logs[item.author]?.[item.seq] ?? 'null') as SignedEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const ref = isPlainRecord(entry.seen) && Object.hasOwn(entry.seen, recoveryId) ? entry.seen[recoveryId] : undefined;
    if (ref && held.has(ref.hash)) return true;
    const approval = entry.kind === 'device.hello' && isPlainRecord(entry.body) ? entry.body.approval : undefined;
    if (typeof approval === 'string' && held.has(approval)) return true;
  }
  return false;
}

const isPlainRecord = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
