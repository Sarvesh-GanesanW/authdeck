/**
 * What the agent asks git about a working tree: its top folder, the commits that touched a set
 * file, which commit last changed each line, and whether the file differs from HEAD.
 *
 * The repo is untrusted input. Git runs without a shell, with its arguments after `--` where they
 * name paths, with features that could run the repo's own programs turned off (fsmonitor, external
 * diff, textconv), and with caps on time and output. Commit hashes it is given are checked first.
 *
 * A set file's history (fileHistory) is what a phone builds its floor from, so it is served whole or
 * not at all: a failed or capped git run, a shallow clone, an object a partial clone left out, or a
 * page cursor no longer in the list throws HistoryUnreadable. It never looks complete when it isn't.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import type { EnvCommit } from '../protocol';

const GIT_TIMEOUT_MS = 10_000;
/** History, file contents and blame of one set file stay well under this. */
const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SHORT_HASH_CHARS = 7;
export const COMMIT_HASH_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const UNCOMMITTED_HASH = /^0+$/;

/** Turn off what would run a program named by the repo's config while reading. */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'log.showSignature=false'];

export interface GitRun {
  code: number;
  stdout: Buffer;
}

/** Git's environment: the agent's, without anything that points git at another repo or asks for input. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
    // History is read as the commits say: no replace refs, no grafts, and no fetching what a
    // partial clone left out (a missing object is an error, not a trip to the network).
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: os.devNull,
    GIT_NO_LAZY_FETCH: '1',
  };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES']) delete env[name];
  return env;
}

export class GitUnavailable extends Error {
  constructor(detail: string) {
    super(`Could not run git (${detail}). Install git, or put it on the PATH.`);
    this.name = 'GitUnavailable';
  }
}

/** Runs git in `cwd`. Resolves with its exit code; rejects only when git can't be started. */
export function runGit(cwd: string, args: readonly string[], input?: string): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      { cwd, encoding: 'buffer', env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT_BYTES, windowsHide: true, shell: false },
      (err, stdout) => {
        if (!err) return resolve({ code: 0, stdout });
        const code = (err as { code?: unknown }).code;
        if (typeof code === 'number') return resolve({ code, stdout });
        // Killed for time or size, or not started at all.
        if ((err as { killed?: boolean }).killed || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: -1, stdout: Buffer.alloc(0) });
        reject(new GitUnavailable(String(code ?? err.message)));
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

/** The working tree's top folder as git sees it from `folder`, or null outside a repo. */
export async function gitTopLevel(folder: string): Promise<string | null> {
  const run = await runGit(folder, ['rev-parse', '--show-toplevel']);
  if (run.code !== 0) return null;
  const top = run.stdout.toString('utf8').trim();
  return top === '' ? null : path.resolve(top);
}

/** HEAD's short hash, or null in a repo with no commits. */
export async function headCommit(repoRoot: string): Promise<string | null> {
  const run = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const hash = run.stdout.toString('utf8').trim();
  return run.code === 0 && COMMIT_HASH_PATTERN.test(hash) ? hash.slice(0, SHORT_HASH_CHARS) : null;
}

/** True when the file differs from HEAD, or isn't committed at all. */
export async function isUncommitted(repoRoot: string, relPath: string): Promise<boolean> {
  const run = await runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', relPath]);
  return run.code !== 0 || run.stdout.length > 0;
}

/**
 * For each line of the file in the working tree, the short hash of the commit that last changed
 * it; null for lines not committed yet, and all null when git can't say (an untracked file).
 */
export async function blameLines(repoRoot: string, relPath: string, lineCount: number): Promise<(string | null)[]> {
  const commits: (string | null)[] = new Array(lineCount).fill(null);
  const run = await runGit(repoRoot, ['blame', '--porcelain', '--no-textconv', '--', relPath]);
  if (run.code !== 0) return commits;
  // Each group of lines starts "<hash> <original line> <final line> [<lines in group>]".
  for (const line of run.stdout.toString('utf8').split('\n')) {
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) \d+ (\d+)/.exec(line);
    if (!match) continue;
    const index = Number(match[2]) - 1;
    if (index < 0 || index >= lineCount) continue;
    commits[index] = UNCOMMITTED_HASH.test(match[1]!) ? null : match[1]!.slice(0, SHORT_HASH_CHARS);
  }
  return commits;
}

/** The short hash of the commit that last changed one line (1-based), or null. */
export async function commitOfLine(repoRoot: string, relPath: string, line: number): Promise<string | null> {
  const run = await runGit(repoRoot, ['blame', '--porcelain', '--no-textconv', '-L', `${line},${line}`, '--', relPath]);
  if (run.code !== 0) return null;
  const hash = run.stdout.toString('utf8').split(' ', 1)[0] ?? '';
  return COMMIT_HASH_PATTERN.test(hash) && !UNCOMMITTED_HASH.test(hash) ? hash.slice(0, SHORT_HASH_CHARS) : null;
}

/** The short hash of the commit that added a file, or null when it isn't committed. */
export async function commitThatAdded(repoRoot: string, relPath: string): Promise<string | null> {
  const run = await runGit(repoRoot, ['log', '--no-textconv', '--diff-filter=A', '-1', '--format=%H', '--', relPath]);
  const hash = run.stdout.toString('utf8').trim();
  return run.code === 0 && COMMIT_HASH_PATTERN.test(hash) ? hash.slice(0, SHORT_HASH_CHARS) : null;
}

/** Commits looked at to order join request files; older requests than these sort after them, by name. */
const REQUEST_ORDER_COMMITS = 512;

/**
 * Request file names in `folder` (relative to the repo root), newest first by the commit that
 * added them. Files git doesn't know (not committed yet) aren't listed; callers put them first.
 */
export async function filesNewestFirst(repoRoot: string, folder: string): Promise<string[]> {
  const run = await runGit(repoRoot, ['log', '--no-textconv', '--diff-filter=A', `--max-count=${REQUEST_ORDER_COMMITS}`, '--format=', '--name-only', '-z', '--', folder]);
  if (run.code !== 0) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of run.stdout.toString('utf8').split('\0')) {
    const name = entry.trim().split('/').pop() ?? '';
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Author names and subjects are display-only, and capped: they come from whoever made the commit. */
export const DISPLAY_TEXT_CHARS = 200;
export function displayText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, DISPLAY_TEXT_CHARS);
}

/** Commits that touched one set file that one history read looks at; a longer history is refused, not cut. */
export const MAX_HISTORY_COMMITS = 50_000;
/** What one commit's author and subject can add to a page, at most (UTF-8, both capped). */
const METADATA_BYTES = 2 * DISPLAY_TEXT_CHARS * 4;

/** One page of the file's history, newest first, as env.history.read answers it. */
export interface HistoryPageLimits {
  commits: number;
  bytes: number;
  /** Larger versions of the file are served as null: too big to send, not unknown. */
  fileBytes: number;
}

/** The history can't be served whole; the message is a sentence the phone shows. */
export class HistoryUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryUnreadable';
  }
}

const COULD_NOT_READ = "Git couldn't read this repo's history of the set file, so it can't be checked.";
const MISSING_OBJECTS = "This repo is missing part of the set file's history (a partial clone), so it can't be checked. Run git fetch --refetch, then try again.";

/** Runs git and returns its output, or throws: no failed, killed or timed-out run is ever read as an answer. */
async function mustRun(repoRoot: string, args: readonly string[], input?: string): Promise<Buffer> {
  const run = await runGit(repoRoot, args, input);
  if (run.code !== 0) throw new HistoryUnreadable(COULD_NOT_READ);
  return run.stdout;
}

/**
 * The distinct versions of `relPath` reachable from HEAD, newest first, one page at a time. Every
 * commit that touched the file is considered (--full-history: git's default simplification would
 * skip a side of a merge, such as the commit that deleted a variable), and each version, by its
 * blob (or "deleted"), is served once, at the newest commit that has it. A page starts after
 * `before` in that same list and stops at `limits.commits` or its byte budget; `more: false` means
 * every distinct version has been served.
 */
export async function fileHistory(repoRoot: string, relPath: string, before: string | null, limits: HistoryPageLimits): Promise<{ commits: EnvCommit[]; more: boolean }> {
  if ((await mustRun(repoRoot, ['rev-parse', '--is-shallow-repository'])).toString('utf8').trim() === 'true') {
    throw new HistoryUnreadable("This repo is a shallow clone, so its history can't be checked. Run git fetch --unshallow, then try again.");
  }
  // No commit yet: nothing is in history, and that is the whole of it.
  if ((await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) {
    if (before !== null) throw historyChanged();
    return { commits: [], more: false };
  }
  const logged = await commitsTouching(repoRoot, relPath);
  const versions = await versionsAt(repoRoot, relPath, logged);
  const distinct = distinctVersions(logged, versions);
  const from = before === null ? 0 : distinct.findIndex(({ commit }) => commit === before) + 1;
  if (before !== null && from === 0) throw historyChanged();
  const page = choosePage(distinct.slice(from), limits);
  const [metadata, files] = await Promise.all([
    commitMetadata(repoRoot, page.map(({ commit }) => commit)),
    blobTexts(repoRoot, page.map(({ version }) => (servable(version, limits) ? version.key : null))),
  ]);
  const commits = page.map(({ commit, time }, index): EnvCommit => ({ commit, time, ...metadata.get(commit)!, file: files[index] ?? null }));
  return { commits, more: from + page.length < distinct.length };
}

function historyChanged(): HistoryUnreadable {
  return new HistoryUnreadable('The history changed while it was being read. Read it again from the start.');
}

interface LoggedCommit {
  commit: string;
  time: number;
  /** The commit's root tree. */
  tree: string;
}

/** Every commit reachable from HEAD that touched the file, newest first: hashes and times only, so commit messages can't fill the output. */
async function commitsTouching(repoRoot: string, relPath: string): Promise<LoggedCommit[]> {
  const out = await mustRun(repoRoot, ['log', '--full-history', '--no-textconv', '--no-color', '-z', `--max-count=${MAX_HISTORY_COMMITS + 1}`, '--format=%H%x00%ct%x00%T', 'HEAD', '--', relPath]);
  const fields = out.toString('utf8').split('\0');
  const logged: LoggedCommit[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const commit = fields[i]!.replace(/^\n/, '');
    const seconds = Number(fields[i + 1]);
    const tree = fields[i + 2]!;
    if (!COMMIT_HASH_PATTERN.test(commit) || !COMMIT_HASH_PATTERN.test(tree) || !Number.isSafeInteger(seconds)) throw new HistoryUnreadable(COULD_NOT_READ);
    logged.push({ commit, time: seconds * 1000, tree });
  }
  if (logged.length > MAX_HISTORY_COMMITS) throw new HistoryUnreadable(`More than ${MAX_HISTORY_COMMITS} commits touched this set file, so its history can't be checked.`);
  return logged;
}

/** The file at a commit: its blob id and size, or "deleted" (no file at that path). */
interface FileVersion {
  key: string;
  size: number | null;
}

const DELETED: FileVersion = { key: 'deleted', size: null };

function servable(version: FileVersion, limits: HistoryPageLimits): boolean {
  return version.size !== null && version.size <= limits.fileBytes;
}

/** Each version once, at its newest commit. */
function distinctVersions(logged: LoggedCommit[], versions: FileVersion[]): (LoggedCommit & { version: FileVersion })[] {
  const seen = new Set<string>();
  return logged.flatMap((entry, index) => {
    const version = versions[index]!;
    if (seen.has(version.key)) return [];
    seen.add(version.key);
    return [{ ...entry, version }];
  });
}

/** As many versions as fit the page's commit count and byte budget, from the sizes alone; always at least one. */
function choosePage<T extends { version: FileVersion }>(rest: T[], limits: HistoryPageLimits): T[] {
  const page: T[] = [];
  let bytes = 0;
  for (const entry of rest) {
    if (page.length >= limits.commits) break;
    const cost = (servable(entry.version, limits) ? entry.version.size! : 0) + METADATA_BYTES;
    if (page.length > 0 && bytes + cost > limits.bytes) break;
    bytes += cost;
    page.push(entry);
  }
  return page;
}

/**
 * The file's blob at each commit. Where git can't name a blob, the commit's trees decide: no file
 * at that path is "deleted"; a file the trees list but this clone doesn't have (a partial clone) is
 * an error, never "deleted".
 */
async function versionsAt(repoRoot: string, relPath: string, logged: LoggedCommit[]): Promise<FileVersion[]> {
  if (logged.length === 0) return [];
  const gitPath = relPath.split(path.sep).join('/');
  const out = await mustRun(repoRoot, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], `${logged.map(({ commit }) => `${commit}:${gitPath}`).join('\n')}\n`);
  const answers = out.toString('utf8').split('\n');
  const versions = logged.map((_, index): FileVersion | null => {
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) blob (\d+)$/.exec(answers[index] ?? '');
    return match ? { key: match[1]!, size: Number(match[2]) } : null;
  });
  const unresolved = logged.filter((_, index) => versions[index] === null);
  const fileIn = await filesInTrees(repoRoot, [...new Set(unresolved.map(({ tree }) => tree))], gitPath.split('/'));
  return versions.map((version, index) => {
    if (version) return version;
    if (fileIn.has(logged[index]!.tree)) throw new HistoryUnreadable(MISSING_OBJECTS);
    return DELETED;
  });
}

/** Tree entry modes of a file git stores as a blob (a regular file, an executable, a symlink). */
const FILE_MODES = new Set(['100644', '100755', '120000']);
const FOLDER_MODE = '40000';
/** Objects per `git cat-file --batch`, so many large trees don't run into the output cap. */
const TREES_PER_READ = 256;

/** Which of these root trees list a file at `parts`. Any tree on the way that can't be read is an error. */
async function filesInTrees(repoRoot: string, roots: string[], parts: string[]): Promise<Set<string>> {
  const withFile = new Set<string>();
  if (roots.length === 0) return withFile;
  const idBytes = (await mustRun(repoRoot, ['rev-parse', '--show-object-format'])).toString('utf8').trim() === 'sha256' ? 32 : 20;
  // Root trees still walking, by the tree reached so far.
  let walking = new Map(roots.map((root) => [root, root]));
  for (const [depth, part] of parts.entries()) {
    const trees = await readObjects(repoRoot, [...new Set(walking.values())], 'tree', TREES_PER_READ);
    const next = new Map<string, string>();
    for (const [root, tree] of walking) {
      const entry = treeEntry(trees.get(tree)!, part, idBytes);
      if (entry === null) continue;
      if (depth === parts.length - 1) {
        if (FILE_MODES.has(entry.mode)) withFile.add(root);
      } else if (entry.mode === FOLDER_MODE) {
        next.set(root, entry.id);
      }
    }
    walking = next;
  }
  return withFile;
}

/** The mode and object id of `name` in a raw tree ("<mode> <name>\0<id bytes>" entries), or null. */
function treeEntry(tree: Buffer, name: string, idBytes: number): { mode: string; id: string } | null {
  let at = 0;
  while (at < tree.length) {
    const nul = tree.indexOf(0, at);
    if (nul < 0 || nul + 1 + idBytes > tree.length) throw new HistoryUnreadable(COULD_NOT_READ);
    const header = tree.subarray(at, nul).toString('utf8');
    const space = header.indexOf(' ');
    if (header.slice(space + 1) === name) return { mode: header.slice(0, space), id: tree.subarray(nul + 1, nul + 1 + idBytes).toString('hex') };
    at = nul + 1 + idBytes;
  }
  return null;
}

/** Objects by name, of one type, `perRead` to a `git cat-file --batch`. Throws for any that is missing or of another type. */
async function readObjects(repoRoot: string, names: string[], type: 'tree' | 'blob', perRead = names.length): Promise<Map<string, Buffer>> {
  const objects = new Map<string, Buffer>();
  for (let start = 0; start < names.length; start += perRead) {
    const chunk = names.slice(start, start + perRead);
    const out = await mustRun(repoRoot, ['cat-file', '--batch=%(objecttype) %(objectsize)'], `${chunk.join('\n')}\n`);
    let at = 0;
    for (const name of chunk) {
      const end = out.indexOf(0x0a, at);
      if (end < 0) throw new HistoryUnreadable(COULD_NOT_READ);
      const match = /^(\w+) (\d+)$/.exec(out.subarray(at, end).toString('utf8'));
      if (!match || match[1] !== type) throw new HistoryUnreadable(MISSING_OBJECTS);
      const size = Number(match[2]);
      if (end + 1 + size > out.length) throw new HistoryUnreadable(COULD_NOT_READ);
      objects.set(name, out.subarray(end + 1, end + 1 + size));
      at = end + 1 + size + 1;
    }
  }
  return objects;
}

/** The text of each blob (null where none is wanted). Every requested blob must be read. */
async function blobTexts(repoRoot: string, blobs: (string | null)[]): Promise<(string | null)[]> {
  const contents = await readObjects(repoRoot, [...new Set(blobs.filter((blob): blob is string => blob !== null))], 'blob');
  return blobs.map((blob) => (blob === null ? null : contents.get(blob)!.toString('utf8')));
}

/** Author and subject of each page commit, capped by git itself, so a huge message never reaches the output. */
async function commitMetadata(repoRoot: string, commits: string[]): Promise<Map<string, { author: string; subject: string }>> {
  const metadata = new Map<string, { author: string; subject: string }>();
  if (commits.length === 0) return metadata;
  const cap = `%<(${DISPLAY_TEXT_CHARS},trunc)`;
  const out = await mustRun(repoRoot, ['log', '--no-walk=unsorted', '--no-color', '-z', `--format=%H%x00${cap}%an%x00${cap}%s`, ...commits, '--']);
  const fields = out.toString('utf8').split('\0');
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const commit = fields[i]!.replace(/^\n/, '');
    metadata.set(commit, { author: displayText(fields[i + 1]!.trimEnd()), subject: displayText(fields[i + 2]!.trimEnd()) });
  }
  if (commits.some((commit) => !metadata.has(commit))) throw new HistoryUnreadable(COULD_NOT_READ);
  return metadata;
}

/**
 * The origin remote for display, with any credentials and the scheme removed:
 * "git@github.com:acme/api.git" and "https://token@github.com/acme/api" both give "github.com/acme/api".
 */
export function displayRemote(remote: string | null): string | null {
  if (remote === null) return null;
  const trimmed = remote.trim();
  if (trimmed === '') return null;
  let shown: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      shown = `${url.host}${url.pathname}`;
    } catch {
      return null;
    }
  } else if (scp) {
    shown = `${scp[1]}/${scp[2]}`;
  } else {
    // A local path: no credentials in it, but nothing a device needs either.
    shown = trimmed;
  }
  return displayText(shown.replace(/\.git\/?$/, '').replace(/\/+$/, ''));
}
