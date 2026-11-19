/**
 * Set files and join request files in a working tree. The tree is untrusted: a `.authdeck` folder,
 * set file or request file that is a link is refused (a link could point a write at any file of
 * the person's), reads are capped, and every write goes to a new file renamed into place.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ENV_FILE_EXTENSION, ENV_FOLDER, ENV_LIMITS, ENV_REQUESTS_FOLDER, ENV_SET_NAME_PATTERN } from '../envcore/types';
import { isId } from '../vault/entry';

/** A join request file is a few hundred bytes; anything far larger isn't one. */
export const MAX_REQUEST_FILE_BYTES = 16 * 1024;
/** Valid request files read per set; more are left for the next read. */
export const MAX_REQUEST_FILES = 64;
/** Request files looked at, valid or not, and their bytes: the most one read spends on a flood. */
export const MAX_REQUEST_SCAN = 1024;
export const MAX_REQUEST_SCAN_BYTES = 2 * 1024 * 1024;
const REQUEST_FILE_PATTERN = /^[A-Za-z0-9_-]{22}\.json$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Where one set file sits. */
export interface SetFileLocation {
  repoRoot: string;
  /** Absolute: <repoRoot>/.authdeck/<setName>.env. */
  path: string;
  /** Relative to the repo root, with "/": ".authdeck/acme-api.env". */
  relPath: string;
  setName: string;
}

export class WorkTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkTreeError';
  }
}

/** Checks that `filePath` is `<repoRoot>/.authdeck/<set name>.env`, both absolute. Null when it isn't. */
export function setFileLocation(repoRoot: string, filePath: string): SetFileLocation | null {
  if (!path.isAbsolute(repoRoot) || !path.isAbsolute(filePath)) return null;
  const root = path.resolve(repoRoot);
  const file = path.resolve(filePath);
  // Only plain paths: no "..", "." or doubled separators that could name another place.
  if (root !== repoRoot || file !== filePath) return null;
  if (path.dirname(file) !== path.join(root, ENV_FOLDER)) return null;
  const base = path.basename(file);
  if (!base.endsWith(ENV_FILE_EXTENSION)) return null;
  const setName = base.slice(0, -ENV_FILE_EXTENSION.length);
  if (!ENV_SET_NAME_PATTERN.test(setName)) return null;
  return { repoRoot: root, path: file, relPath: `${ENV_FOLDER}/${base}`, setName };
}

/** Throws when `folder` exists and is not a real folder (a link, or a file). False when missing. */
function realFolder(folder: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(folder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!stat.isDirectory()) throw new WorkTreeError(`${folder} is a link or a file, not a folder, so AuthDeck won't use it.`);
  return true;
}

/** Reads a regular file of at most `maxBytes` (one more is read, so a caller can tell it's too large). Null when missing. */
function readCapped(file: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new WorkTreeError(`${file} is a link, so AuthDeck won't read it.`);
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new WorkTreeError(`${file} isn't a regular file.`);
    // lstat as well where O_NOFOLLOW doesn't exist (Windows).
    if (NO_FOLLOW === 0 && fs.lstatSync(file).isSymbolicLink()) throw new WorkTreeError(`${file} is a link, so AuthDeck won't read it.`);
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes + 1));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** The set file's text, or null when it isn't there. Larger than the cap: the first cap+1 bytes (parsing refuses it). */
export function readSetFile(location: SetFileLocation): string | null {
  if (!realFolder(path.dirname(location.path))) return null;
  return readCapped(location.path, ENV_LIMITS.fileBytes)?.toString('utf8') ?? null;
}

/** Writes `text` to `target` through a new file in the same folder; with `exclusive`, fails when `target` exists. */
function replaceFile(target: string, text: string, exclusive: boolean): void {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o644 });
  try {
    if (exclusive) fs.linkSync(temp, target);
    else {
      // A link at the target is replaced, never followed; a folder there makes rename fail.
      fs.renameSync(temp, target);
      return;
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function ensureFolder(folder: string): void {
  if (realFolder(folder)) return;
  fs.mkdirSync(folder, { recursive: true });
  realFolder(folder);
}

export class FileExists extends Error {
  constructor(file: string) {
    super(`${file} already exists.`);
    this.name = 'FileExists';
  }
}

/** Writes the set file; with `exclusive` (a new set), refuses to replace one that appeared meanwhile. */
export function writeSetFile(location: SetFileLocation, text: string, { exclusive = false } = {}): void {
  ensureFolder(path.dirname(location.path));
  try {
    replaceFile(location.path, text, exclusive);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new FileExists(location.relPath);
    throw err;
  }
}

/** A join request file as found in `.authdeck/requests/`. */
export interface RequestFile {
  /** Relative to the repo root: ".authdeck/requests/<member>.json". */
  relPath: string;
  text: string;
}

/**
 * The request files in the tree that `accept` takes, at most MAX_REQUEST_FILES, newest first:
 * `newestFirst` orders names (the caller asks git), names it doesn't list come first, then by
 * name. Files `accept` refuses (junk a repo writer added) don't count against the cap; reading
 * stops after MAX_REQUEST_SCAN files or MAX_REQUEST_SCAN_BYTES, so a flood can't stall the agent.
 * Links, odd names and oversized files are skipped.
 */
export function readRequestFiles(repoRoot: string, accept: (file: RequestFile) => boolean, newestFirst: readonly string[] = []): RequestFile[] {
  const folder = path.join(repoRoot, ENV_REQUESTS_FOLDER);
  if (!realFolder(path.join(repoRoot, ENV_FOLDER)) || !realFolder(folder)) return [];
  const rank = new Map(newestFirst.map((name, index) => [name, index]));
  const names = fs
    .readdirSync(folder)
    .filter((name) => REQUEST_FILE_PATTERN.test(name))
    .sort((a, b) => (rank.get(a) ?? -1) - (rank.get(b) ?? -1) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_REQUEST_SCAN);
  const files: RequestFile[] = [];
  let bytesRead = 0;
  for (const name of names) {
    if (files.length >= MAX_REQUEST_FILES || bytesRead >= MAX_REQUEST_SCAN_BYTES) break;
    let bytes: Buffer | null;
    try {
      bytes = readCapped(path.join(folder, name), MAX_REQUEST_FILE_BYTES);
    } catch (err) {
      if (err instanceof WorkTreeError) continue;
      throw err;
    }
    if (bytes === null) continue;
    bytesRead += bytes.length;
    if (bytes.length > MAX_REQUEST_FILE_BYTES) continue;
    const file = { relPath: `${ENV_REQUESTS_FOLDER}/${name}`, text: bytes.toString('utf8') };
    if (accept(file)) files.push(file);
  }
  return files;
}

/** Checks a request path a device named: exactly ".authdeck/requests/<member id>.json". */
export function isRequestPath(relPath: unknown): relPath is string {
  if (typeof relPath !== 'string' || !relPath.startsWith(`${ENV_REQUESTS_FOLDER}/`)) return false;
  const name = relPath.slice(ENV_REQUESTS_FOLDER.length + 1);
  return REQUEST_FILE_PATTERN.test(name) && isId(name.slice(0, -'.json'.length));
}

export function writeRequestFile(repoRoot: string, relPath: string, text: string): void {
  if (!isRequestPath(relPath)) throw new WorkTreeError(`${relPath} isn't a join request path.`);
  ensureFolder(path.join(repoRoot, ENV_FOLDER));
  ensureFolder(path.join(repoRoot, ENV_REQUESTS_FOLDER));
  replaceFile(path.join(repoRoot, ...relPath.split('/')), text, false);
}

/** Removes a request file; one already gone is fine. Only regular files are removed. */
export function removeRequestFile(repoRoot: string, relPath: string): void {
  if (!isRequestPath(relPath)) throw new WorkTreeError(`${relPath} isn't a join request path.`);
  if (!realFolder(path.join(repoRoot, ENV_FOLDER)) || !realFolder(path.join(repoRoot, ENV_REQUESTS_FOLDER))) return;
  const file = path.join(repoRoot, ...relPath.split('/'));
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new WorkTreeError(`${relPath} isn't a file.`);
  // Unlinking a link removes the link only.
  fs.unlinkSync(file);
}
