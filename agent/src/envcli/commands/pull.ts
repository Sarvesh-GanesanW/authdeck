/** `authdeck env pull`: the set's values written to a .env readable only by its owner. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { EnvPlainValue } from '../../envcore/types';
import { resolveFromCwd, type EnvCliDeps } from '../context';
import { writtenWords } from '../codeLoading';
import { formatDotenv, unportableDotenvValue } from '../dotenv';
import { EnvCliFailure, usage } from '../failure';
import { isGitIgnored } from '../git';
import { askForValues, allowedWords, checkedSetHere, newerCopyWords } from '../release';

const OWNER_ONLY = 0o600;

export async function envPull(deps: EnvCliDeps, options: { file: string; force: boolean; set: string | null; invocation: string }): Promise<number> {
  const say = deps.stdout;
  const here = await checkedSetHere(deps, options.set, 'pull');
  const target = resolveFromCwd(deps, options.file);
  await checkInsideRepo(target, here.project.repoRoot, options.file);
  if (!options.force && (await exists(target))) throw new EnvCliFailure({ code: 'target-exists', path: options.file });
  const gitignored = await isGitIgnored(here.project.repoRoot, target);
  if (!gitignored) deps.stderr.write(`! ${options.file} is not in .gitignore here. A commit could publish the values.\n`);
  const released = await askForValues(deps, { kind: 'pull', set: options.set, command: null, target: { path: target, gitignored }, invocation: options.invocation, stream: say }, here);
  const { written, skipped } = splitWritable(released.values);
  // Again: the folder could have become a link while the phone was asked.
  await checkInsideRepo(target, here.project.repoRoot, options.file);
  await writeOwnerOnly(target, formatDotenv(written, [`Written by authdeck env pull from ${released.setName}. Secret: don't commit or share this file.`]));
  const allowed = released.result.via === 'once' ? 'Allowed once.' : allowedWords(released.setName, released.result);
  say.write(`✔ ${allowed} Wrote ${options.file} (${countWords(written)}${skippedSummary(skipped)}, mode 0600).\n`);
  for (const { name, reason } of skipped) deps.stderr.write(`Skipped ${name}: its value can't be written to a .env safely (${reason}). Use authdeck env run to pass it.\n`);
  for (const { name } of written.filter((value) => deps.core.loadsCode(value.name))) deps.stderr.write(`${writtenWords(options.file, name)}\n`);
  const newer = newerCopyWords(deps, released);
  if (newer) say.write(`${newer}\n`);
  return 0;
}

interface SkippedValue {
  name: string;
  reason: string;
}

/** Values every .env reader takes the same way are written; the rest are left to `env run`. */
function splitWritable(values: EnvPlainValue[]): { written: EnvPlainValue[]; skipped: SkippedValue[] } {
  const written: EnvPlainValue[] = [];
  const skipped: SkippedValue[] = [];
  for (const value of values) {
    const reason = unportableDotenvValue(value.value);
    if (reason === null) written.push(value);
    else skipped.push({ name: value.name, reason });
  }
  return { written, skipped };
}

function skippedSummary(skipped: SkippedValue[]): string {
  return skipped.length === 0 ? '' : `, skipped ${skipped.map(({ name }) => name).join(', ')}`;
}

/**
 * The target's folder, links resolved, must be inside the repo: a folder that is a link elsewhere
 * would put the values where the repo's .gitignore and its owner's checks don't reach.
 */
async function checkInsideRepo(target: string, repoRoot: string, shown: string): Promise<void> {
  const [folder, root] = await Promise.all([realFolder(path.dirname(target), shown), fs.realpath(repoRoot)]);
  const relative = path.relative(root, folder);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw usage(`${shown} is outside this repo (its folder is ${folder}). Pull writes only inside the repo.`);
}

async function realFolder(folder: string, shown: string): Promise<string> {
  try {
    return await fs.realpath(folder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw usage(`The folder for ${shown} doesn't exist. Create it, or name another file.`);
    throw err;
  }
}

function countWords(values: EnvPlainValue[]): string {
  return values.length === 1 ? '1 variable' : `${values.length} variables`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Writes beside the target with mode 0600 from the start, then renames over it, so the values
 * are never readable by others, not even for a moment, and a reader never sees half a file.
 */
async function writeOwnerOnly(target: string, text: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, text, { mode: OWNER_ONLY, flag: 'wx' });
    await fs.chmod(temporary, OWNER_ONLY);
    await fs.rename(temporary, target);
  } catch (err) {
    await fs.rm(temporary, { force: true });
    throw err;
  }
}
