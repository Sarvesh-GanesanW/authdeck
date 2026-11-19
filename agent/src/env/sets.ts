/**
 * Checking set files the way this computer remembers them (a rollback is refused), and describing
 * the ones it knows for devices (env.sets.list).
 */
import { envFileHash, parseEnvFile, verifyEnvFile, type EnvVerifiedSet } from '../envcore';
import type { EnvFileProblem } from '../envcore/types';
import type { EnvSetSummary } from '../protocol';
import { ENV_REQUESTS_FOLDER } from '../envcore/types';
import { readEnvJoinRequest } from '../envcore';
import { commitOfLine, filesNewestFirst, headCommit, isUncommitted } from './git';
import type { KnownSetFile, ProjectRegistry } from './registry';
import { readRequestFiles, readSetFile, setFileLocation, WorkTreeError, type RequestFile, type SetFileLocation } from './workTree';

export type SetCheck = { ok: true; set: EnvVerifiedSet } | { ok: false; problem: EnvFileProblem; setId: string | null };

/**
 * Checks a set file's text against what this computer accepted for its set. Pure of side
 * effects: call ProjectRegistry.accept once the file is really taken. With `location`, the name in
 * the file must match its file name.
 */
export function verifySetText(registry: ProjectRegistry, text: string, location?: SetFileLocation): SetCheck {
  const parsed = parseEnvFile(text);
  if (!parsed.ok) return { ok: false, problem: parsed.problem, setId: null };
  const { header } = parsed.parsed.file;
  if (location && header.name !== location.setName) {
    return { ok: false, problem: { kind: 'unreadable', line: parsed.parsed.headerLine, detail: `the set is named ${header.name}, not ${location.setName}` }, setId: header.set };
  }
  const verified = verifyEnvFile(text, registry.trust(header.set));
  return verified.ok ? verified : { ok: false, problem: verified.problem, setId: header.set };
}

/** Checks and, when it passes, remembers the file as the newest this computer accepted. */
export function acceptSetText(registry: ProjectRegistry, text: string, location?: SetFileLocation): SetCheck {
  const checked = verifySetText(registry, text, location);
  if (checked.ok) registry.accept(checked.set);
  return checked;
}

/** The 1-based line a problem is about: its own line, or the header's for member-list problems. */
function problemLine(problem: EnvFileProblem, text: string): number | null {
  if ('line' in problem) return problem.line;
  if (problem.kind === 'header-unsigned' || problem.kind === 'header-chain' || problem.kind === 'older-header') {
    const index = text.split('\n').findIndex((line) => line.startsWith('@set '));
    return index >= 0 ? index + 1 : null;
  }
  return null;
}

/** The commit that brought the problem's line in, when git knows it. */
export async function problemCommit(location: SetFileLocation, problem: EnvFileProblem, text: string): Promise<string | null> {
  const line = problemLine(problem, text);
  return line === null ? null : commitOfLine(location.repoRoot, location.relPath, line);
}

/** How many lines git blame sees in the text. */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** The set a request file names, read leniently: devices check request files themselves. */
export function requestFileSet(file: RequestFile): string | null {
  try {
    const value = JSON.parse(file.text) as { set?: unknown };
    return typeof value?.set === 'string' ? value.set : null;
  } catch {
    return null;
  }
}

/**
 * Join request files in the tree that check out for one of `setIds`, newest first. Junk files (a
 * repo writer can add any number) are skipped without taking a place, so they can't hide a real one.
 */
export async function joinRequestFiles(repoRoot: string, setIds: ReadonlySet<string>): Promise<RequestFile[]> {
  if (setIds.size === 0) return [];
  const order = await filesNewestFirst(repoRoot, ENV_REQUESTS_FOLDER);
  const valid = (file: RequestFile) => {
    const setId = requestFileSet(file);
    return setId !== null && setIds.has(setId) && readEnvJoinRequest(file.text, { set: setId, path: file.relPath }).ok;
  };
  try {
    return readRequestFiles(repoRoot, valid, order);
  } catch (err) {
    if (err instanceof WorkTreeError) return [];
    throw err;
  }
}

/** One known set file as env.sets.list shows it; null when the file is no longer there. */
export async function summarize(registry: ProjectRegistry, known: KnownSetFile): Promise<EnvSetSummary | null> {
  const location = setFileLocation(known.repoRoot, known.path);
  if (!location) return null;
  let text: string | null;
  try {
    text = readSetFile(location);
  } catch {
    // A link or a folder where the file was: not a set file any more.
    return null;
  }
  if (text === null) return null;
  const checked = acceptSetText(registry, text, location);
  const setId = checked.ok ? checked.set.file.header.set : known.setId;
  const [requests, head, uncommitted, commit] = await Promise.all([
    joinRequestFiles(location.repoRoot, new Set([setId])),
    headCommit(location.repoRoot),
    isUncommitted(location.repoRoot, location.relPath),
    checked.ok ? Promise.resolve(null) : problemCommit(location, checked.problem, text),
  ]);
  return {
    setId,
    name: checked.ok ? checked.set.file.header.name : known.name,
    path: location.path,
    repoRoot: location.repoRoot,
    remote: known.remote,
    fileHash: envFileHash(text),
    rev: checked.ok ? checked.set.file.header.rev : 0,
    epoch: checked.ok ? checked.set.file.header.epoch : 0,
    variables: checked.ok ? checked.set.live.length : 0,
    members: checked.ok ? checked.set.file.header.members.length : 0,
    joinRequests: requests.length,
    headCommit: head,
    uncommitted,
    problem: checked.ok ? null : { problem: checked.problem, commit },
    lastReleaseAt: known.lastReleaseAt,
  };
}
