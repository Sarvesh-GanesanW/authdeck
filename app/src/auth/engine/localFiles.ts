/**
 * The part of the local copy that grows with the vault (each identity's log, fork proofs and the
 * caught changes this device handled), kept in files in the app's private document directory.
 * AsyncStorage can't hold it: Android refuses a value over about 2 MB ("Row too big") and caps the
 * whole store at 6 MB, while one identity's log may reach its quota.
 *
 * Layout, one folder per vault:
 *   <id>.<gen>.jsonl   an identity's log, one line per row, only ever appended to
 *   forks.<gen>.json   fork proofs        caught.<gen>.json   handled caught changes
 *   seals.<gen>.json   bad-seal proofs
 *   manifest-a.json / manifest-b.json   which files hold the copy, and how many rows of each
 *
 * A save writes new data to files nothing points at yet (appending past the committed rows, or a
 * fresh name), then commits by writing the manifest to the slot the current one isn't in. The
 * manifest carries its own checksum, so a write torn by a crash is just ignored, and a load takes
 * the newest whole manifest: the old copy or the new one, never neither. (Renaming a temp file
 * over the old one isn't atomic here: expo-file-system deletes the destination first, on both
 * platforms.) Rows past a manifest's count, or a file it doesn't name, are leftovers from a save
 * that never committed.
 *
 * Nothing here is secret: every log line is signed and its contents encrypted. A damaged file
 * costs only what it held, which the next sync reads again from the computer.
 *
 * Nothing is flushed to disk before the manifest commits: expo-file-system (58) offers no fsync on
 * either platform (File.write closes its stream without syncing, and FileHandle has no sync). A
 * power loss can therefore drop a committed save, including a line this device signed and
 * counted in its own head (secure storage). The folder usually still has it; when it doesn't,
 * lostOwnLine.ts decides, and the device joins again with new keys rather than sign that seq twice.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { toBase64Url, utf8Encode } from '../../vault/bytes';
import { sha256Bytes } from '../../vault/crypto';
import { isId, isPlainObject } from '../../vault/entry';

export type LogFiles = Record<string, string[]>;

const ROOT = 'authdeck-vault-v1';
const SLOTS = ['manifest-a.json', 'manifest-b.json'] as const;
const MANIFEST_VERSION = 1;

interface LogRecord {
  file: string;
  rows: number;
}

interface Manifest {
  gen: number;
  logs: Map<string, LogRecord>;
  forks: string | null;
  caught: string | null;
  seals: string | null;
}

/** What this process knows a log file holds: exactly `rows` whole rows, these lines. */
interface KnownLog extends LogRecord {
  lines: readonly string[];
}

interface Committed {
  manifest: Manifest;
  slot: number;
  /** Logs whose file is known to end exactly at its committed rows, so appending is safe. */
  known: Map<string, KnownLog>;
}

const committedByVault = new Map<string, Committed>();
const queues = new Map<string, Promise<unknown>>();

/** Saves and loads of one vault run one at a time, in the order asked. */
function serialized<T>(vaultId: string, work: () => Promise<T>): Promise<T> {
  const before = queues.get(vaultId) ?? Promise.resolve();
  const run = before.then(work, work);
  queues.set(
    vaultId,
    run.catch(() => undefined),
  );
  return run;
}

function folder(vaultId: string): Directory {
  if (!isId(vaultId)) throw new Error('A vault id is malformed, so AuthDeck will not use it to find stored vault data.');
  return new Directory(Paths.document, ROOT, vaultId);
}

function ensureFolder(dir: Directory): void {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
}

// --- Rows -----------------------------------------------------------------------------------

/** A log line as one row: as it is unless it could be misread (a newline, or a leading quote). */
function toRow(line: string): string {
  return line.includes('\n') || line.includes('\r') || line.startsWith('"') ? JSON.stringify(line) : line;
}

function fromRow(row: string): string | null {
  if (!row.startsWith('"')) return row;
  try {
    const value: unknown = JSON.parse(row);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

const rowsText = (lines: readonly string[]) => lines.map((line) => `${toRow(line)}\n`).join('');

/**
 * The first `rows` rows of a log file. `exact` says the file holds those rows and nothing more,
 * so the next save may append to it; a short or unreadable file gives what it holds up to the
 * first bad row.
 */
async function readLog(file: File, rows: number): Promise<{ lines: string[]; exact: boolean }> {
  let text: string;
  try {
    if (!file.exists) return { lines: [], exact: false };
    text = await file.text();
  } catch {
    return { lines: [], exact: false };
  }
  const parts = text.split('\n');
  // A file ending in a newline splits to a trailing '' that is not a row.
  const whole = parts.length - 1;
  const lines: string[] = [];
  for (let i = 0; i < Math.min(rows, whole); i++) {
    const line = fromRow(parts[i]!);
    if (line === null || line === '') return { lines, exact: false };
    lines.push(line);
  }
  return { lines, exact: lines.length === rows && whole === rows && parts[whole] === '' };
}

// --- Manifest -------------------------------------------------------------------------------

function checksum(body: string): string {
  return toBase64Url(sha256Bytes(utf8Encode(body)));
}

function manifestText(manifest: Manifest): string {
  const logs: Record<string, [string, number]> = {};
  for (const [id, record] of [...manifest.logs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) logs[id] = [record.file, record.rows];
  const body = JSON.stringify({ v: MANIFEST_VERSION, gen: manifest.gen, logs, forks: manifest.forks, caught: manifest.caught, seals: manifest.seals });
  return `${body}\n${checksum(body)}\n`;
}

const isFileName = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const LOG_FILE = /^[A-Za-z0-9_-]{22}\.\d{1,15}\.jsonl$/;
const FORKS_FILE = /^forks\.\d{1,15}\.json$/;
const CAUGHT_FILE = /^caught\.\d{1,15}\.json$/;
const SEALS_FILE = /^seals\.\d{1,15}\.json$/;

/** A manifest from its text, or null when it is torn, damaged or not one. Ids key only a Map. */
function parseManifest(text: string): Manifest | null {
  const [body, check, rest] = text.split('\n');
  if (body === undefined || check === undefined || rest !== '' || checksum(body) !== check) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || value.v !== MANIFEST_VERSION || !Number.isSafeInteger(value.gen) || (value.gen as number) < 0) return null;
  if (!isPlainObject(value.logs)) return null;
  if (value.forks !== null && !isFileName(value.forks, FORKS_FILE)) return null;
  if (value.caught !== null && !isFileName(value.caught, CAUGHT_FILE)) return null;
  if (value.seals !== null && !isFileName(value.seals, SEALS_FILE)) return null;
  const logs = new Map<string, LogRecord>();
  for (const [id, record] of Object.entries(value.logs)) {
    if (!isId(id) || !Array.isArray(record) || record.length !== 2) return null;
    const [file, rows] = record as unknown[];
    if (!isFileName(file, LOG_FILE) || !file.startsWith(`${id}.`) || !Number.isSafeInteger(rows) || (rows as number) < 0) return null;
    logs.set(id, { file, rows: rows as number });
  }
  return { gen: value.gen as number, logs, forks: value.forks as string | null, caught: value.caught as string | null, seals: value.seals as string | null };
}

const EMPTY: Manifest = { gen: 0, logs: new Map(), forks: null, caught: null, seals: null };

function filesOf(manifest: Manifest | null): Set<string> {
  const files = new Set<string>();
  if (!manifest) return files;
  for (const record of manifest.logs.values()) files.add(record.file);
  if (manifest.forks) files.add(manifest.forks);
  if (manifest.caught) files.add(manifest.caught);
  if (manifest.seals) files.add(manifest.seals);
  return files;
}

/** The newest whole manifest of the two slots; the empty one when there is none. */
async function readCommitted(dir: Directory): Promise<Committed> {
  const found: (Manifest | null)[] = [];
  for (const name of SLOTS) {
    const file = new File(dir, name);
    try {
      found.push(file.exists ? parseManifest(await file.text()) : null);
    } catch {
      found.push(null);
    }
  }
  let slot = -1;
  found.forEach((manifest, i) => {
    if (manifest && (slot < 0 || manifest.gen > found[slot]!.gen)) slot = i;
  });
  // No whole manifest: nothing is committed, and the first commit goes to slot 0.
  if (slot < 0) return { manifest: EMPTY, slot: 1, known: new Map() };
  return { manifest: found[slot]!, slot, known: new Map() };
}

async function committedFor(vaultId: string, dir: Directory): Promise<Committed> {
  const cached = committedByVault.get(vaultId);
  if (cached) return cached;
  const committed = await readCommitted(dir);
  committedByVault.set(vaultId, committed);
  return committed;
}

/**
 * Commits a new manifest to the slot the current one isn't in, then removes files neither it nor
 * the one it replaces names (the replaced one stays whole, as the fallback if this write tore).
 */
async function commit(vaultId: string, dir: Directory, before: Committed, manifest: Manifest, known: Map<string, KnownLog>): Promise<void> {
  const slot = 1 - before.slot;
  await new File(dir, SLOTS[slot]).write(manifestText(manifest));
  const keep = new Set([...filesOf(manifest), ...filesOf(before.manifest), ...SLOTS]);
  committedByVault.set(vaultId, { manifest, slot, known });
  try {
    for (const entry of dir.list()) if (entry instanceof File && !keep.has(entry.name)) entry.delete();
  } catch {
    // Leftovers cost only space; the next commit tries again.
  }
}

/** Runs a change against the committed copy; any failure forgets what this process knew, so the next save reads the manifest again and appends to nothing. */
async function change(vaultId: string, work: (dir: Directory, committed: Committed) => Promise<void>): Promise<void> {
  const dir = folder(vaultId);
  await serialized(vaultId, async () => {
    try {
      ensureFolder(dir);
      await work(dir, await committedFor(vaultId, dir));
    } catch (err) {
      committedByVault.delete(vaultId);
      throw err;
    }
  });
}

// --- Logs -----------------------------------------------------------------------------------

function isPrefix(stored: readonly string[], lines: readonly string[]): boolean {
  if (stored.length > lines.length) return false;
  for (let i = 0; i < stored.length; i++) if (stored[i] !== lines[i]) return false;
  return true;
}

/** Every identity's log, read up to the rows the manifest commits. A damaged file gives what it holds before the damage. */
export function readLogFiles(vaultId: string): Promise<LogFiles> {
  const dir = folder(vaultId);
  return serialized(vaultId, async () => {
    const committed = await readCommitted(dir);
    const logs: LogFiles = {};
    const known = new Map<string, KnownLog>();
    for (const [id, record] of committed.manifest.logs) {
      const { lines, exact } = await readLog(new File(dir, record.file), record.rows);
      if (lines.length > 0) logs[id] = lines;
      if (exact) known.set(id, { ...record, lines });
    }
    committed.known = known;
    committedByVault.set(vaultId, committed);
    return logs;
  });
}

/**
 * Saves the logs. A log that only grew is appended to; one that changed otherwise is written to a
 * fresh file. Nothing counts until the manifest naming it is committed.
 */
export function writeLogFiles(vaultId: string, logs: LogFiles): Promise<void> {
  return change(vaultId, async (dir, before) => {
    const gen = before.manifest.gen + 1;
    const manifest: Manifest = { ...before.manifest, gen, logs: new Map() };
    const known = new Map<string, KnownLog>();
    for (const [id, lines] of Object.entries(logs)) {
      if (!isId(id) || lines.length === 0) continue;
      const prev = before.known.get(id);
      let record: LogRecord;
      if (prev && isPrefix(prev.lines, lines)) {
        if (lines.length > prev.rows) await new File(dir, prev.file).write(rowsText(lines.slice(prev.rows)), { append: true });
        record = { file: prev.file, rows: lines.length };
      } else {
        record = { file: `${id}.${gen}.jsonl`, rows: lines.length };
        await new File(dir, record.file).write(rowsText(lines));
      }
      manifest.logs.set(id, record);
      known.set(id, { ...record, lines: [...lines] });
    }
    await commit(vaultId, dir, before, manifest, known);
  });
}

// --- Small JSON files -------------------------------------------------------------------------

async function readJsonFile(vaultId: string, pick: (manifest: Manifest) => string | null): Promise<unknown> {
  const dir = folder(vaultId);
  return serialized(vaultId, async () => {
    const committed = await committedFor(vaultId, dir);
    const name = pick(committed.manifest);
    if (!name) return null;
    try {
      const file = new File(dir, name);
      return file.exists ? (JSON.parse(await file.text()) as unknown) : null;
    } catch {
      return null;
    }
  });
}

function writeJsonFile(vaultId: string, kind: 'forks' | 'caught' | 'seals', value: unknown): Promise<void> {
  return change(vaultId, async (dir, before) => {
    const gen = before.manifest.gen + 1;
    const name = `${kind}.${gen}.json`;
    await new File(dir, name).write(JSON.stringify(value));
    await commit(vaultId, dir, before, { ...before.manifest, gen, [kind]: name }, before.known);
  });
}

/** Fork proofs as stored, or null when there are none or the file is damaged. */
export const readForksFile = (vaultId: string) => readJsonFile(vaultId, (manifest) => manifest.forks);
export const writeForksFile = (vaultId: string, value: unknown) => writeJsonFile(vaultId, 'forks', value);
/** Handled caught changes as stored, or null when there are none or the file is damaged. */
export const readCaughtFile = (vaultId: string) => readJsonFile(vaultId, (manifest) => manifest.caught);
export const writeCaughtFile = (vaultId: string, value: unknown) => writeJsonFile(vaultId, 'caught', value);
/** Bad-seal proofs as stored, or null when there are none or the file is damaged. */
export const readSealsFile = (vaultId: string) => readJsonFile(vaultId, (manifest) => manifest.seals);
export const writeSealsFile = (vaultId: string, value: unknown) => writeJsonFile(vaultId, 'seals', value);

/** Removes the vault's files. */
export function forgetVaultFiles(vaultId: string): Promise<void> {
  const dir = folder(vaultId);
  return serialized(vaultId, async () => {
    committedByVault.delete(vaultId);
    if (dir.exists) dir.delete();
  });
}
