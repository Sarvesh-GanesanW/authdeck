/**
 * What the command asks git and the working tree: the repo, its sets, whether a path is
 * ignored, the merge rule, and which commit brought a line in. Git runs without a shell.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { EnvProject } from '../envSocketContract';
import {
  ENV_FILE_EXTENSION,
  ENV_FOLDER,
  ENV_GITATTRIBUTES_LINE,
  ENV_MERGE_DRIVER,
  ENV_MERGE_DRIVER_COMMAND,
  ENV_SET_NAME_PATTERN,
} from '../envcore/types';
import { EnvCliFailure } from './failure';

const MERGE_DRIVER_NAME = 'AuthDeck env set';
const SHORT_HASH_CHARS = 7;

interface GitOutcome {
  code: number;
  stdout: string;
}

function git(cwd: string, args: string[]): Promise<GitOutcome> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout });
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'number') return resolve({ code, stdout });
      reject(new EnvCliFailure({ code: 'failed', detail: `Could not run git (${String(code ?? err.message)}). Install git, or put it on the PATH.` }));
    });
  });
}

/** The repo around `cwd` and its origin remote. Fails with no-repo outside one. */
export async function findRepo(cwd: string): Promise<{ repoRoot: string; remote: string | null }> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new EnvCliFailure({ code: 'no-repo', folder: cwd });
  const remote = await git(cwd, ['remote', 'get-url', 'origin']);
  return { repoRoot: path.resolve(top.stdout.trim()), remote: remote.code === 0 ? remote.stdout.trim() || null : null };
}

export function setFilePath(repoRoot: string, setName: string): string {
  return path.join(repoRoot, ENV_FOLDER, `${setName}${ENV_FILE_EXTENSION}`);
}

/** Set names in `.authdeck/`, sorted. Files whose names can't be set names are not sets. */
export async function listSetNames(repoRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(repoRoot, ENV_FOLDER));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.endsWith(ENV_FILE_EXTENSION))
    .map((entry) => entry.slice(0, -ENV_FILE_EXTENSION.length))
    .filter((name) => ENV_SET_NAME_PATTERN.test(name))
    .sort();
}

/**
 * The set a command is about: the one named with --set, or the only one in the repo. Fails with
 * unknown-set, no-set or several-sets.
 */
export async function chooseSet(repo: { repoRoot: string; remote: string | null }, requested: string | null): Promise<EnvProject & { setName: string }> {
  const names = await listSetNames(repo.repoRoot);
  const setName = requested ?? onlySet(names, repo.repoRoot);
  if (!names.includes(setName)) throw new EnvCliFailure({ code: 'unknown-set', set: setName, sets: names });
  return { ...repo, path: setFilePath(repo.repoRoot, setName), setName };
}

function onlySet(names: string[], folder: string): string {
  if (names.length === 0) throw new EnvCliFailure({ code: 'no-set', folder });
  if (names.length > 1) throw new EnvCliFailure({ code: 'several-sets', folder, sets: names });
  return names[0]!;
}

/** True when git would leave `target` out of a commit. */
export async function isGitIgnored(repoRoot: string, target: string): Promise<boolean> {
  const outcome = await git(repoRoot, ['check-ignore', '--quiet', '--', target]);
  return outcome.code === 0;
}

/**
 * Adds the merge rule to .gitattributes (committed) when it's missing, and the merge driver to
 * this clone's git config (never committed, so every clone sets it). True when .gitattributes changed.
 */
export async function setUpMergeDriver(repoRoot: string): Promise<boolean> {
  await setGitConfig(repoRoot, `merge.${ENV_MERGE_DRIVER}.name`, MERGE_DRIVER_NAME);
  await setGitConfig(repoRoot, `merge.${ENV_MERGE_DRIVER}.driver`, ENV_MERGE_DRIVER_COMMAND);
  const attributesPath = path.join(repoRoot, '.gitattributes');
  const current = await readIfExists(attributesPath);
  if (current !== null && current.split(/\r?\n/).some((line) => line.trim() === ENV_GITATTRIBUTES_LINE)) return false;
  const separator = current === null || current === '' || current.endsWith('\n') ? '' : '\n';
  await fs.writeFile(attributesPath, `${current ?? ''}${separator}${ENV_GITATTRIBUTES_LINE}\n`);
  return true;
}

async function setGitConfig(repoRoot: string, key: string, value: string): Promise<void> {
  const outcome = await git(repoRoot, ['config', '--local', key, value]);
  if (outcome.code !== 0) throw new EnvCliFailure({ code: 'failed', detail: `git config ${key} failed with code ${outcome.code}.` });
}

/** The short hash of the commit that last changed `line` of `file`; null when not committed or unknown. */
export async function commitOfLine(repoRoot: string, file: string, line: number): Promise<string | null> {
  const outcome = await git(repoRoot, ['blame', '--porcelain', '-L', `${line},${line}`, '--', file]);
  if (outcome.code !== 0) return null;
  const hash = outcome.stdout.slice(0, outcome.stdout.indexOf(' '));
  if (!/^[0-9a-f]{40,64}$/.test(hash) || /^0+$/.test(hash)) return null;
  return hash.slice(0, SHORT_HASH_CHARS);
}

export async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
