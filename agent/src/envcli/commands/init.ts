/**
 * `authdeck env init`: makes a set for this repo (create) or, when the repo already has it, asks
 * to join (join). Either way it sets up the merge rule for this clone.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import type { EnvCreateParams, EnvJoinParams, EnvProject } from '../../envSocketContract';
import { ENV_FILE_EXTENSION, ENV_FOLDER, ENV_SET_NAME_PATTERN, type EnvPlainValue } from '../../envcore/types';
import { readCheckedSetFile, resolveFromCwd, waitForAgent, type EnvCliDeps } from '../context';
import { EnvCliFailure, usage } from '../failure';
import { findRepo, listSetNames, setFilePath, setUpMergeDriver } from '../git';
import { readEnvInput } from '../input';
import { WAITING } from '../waiting';
import { printable, remoteWithoutCredentials, repoSlug, shownPath } from '../words';

interface InitOptions {
  from: string | null;
  set: string | null;
  invocation: string;
}

type Repo = Awaited<ReturnType<typeof findRepo>>;

export async function envInit(deps: EnvCliDeps, options: InitOptions): Promise<number> {
  const repo = await findRepo(deps.cwd);
  const existing = await listSetNames(repo.repoRoot);
  const setName = options.set ?? defaultSetName(repo, existing);
  const project: EnvProject = { repoRoot: repo.repoRoot, remote: repo.remote, path: setFilePath(repo.repoRoot, setName) };
  if (!existing.includes(setName)) return createSet(deps, repo, project, setName, options);
  if (options.from !== null) throw usage(`${setName} already lives here. To add the values in ${options.from}, run authdeck env push ${options.from}.`);
  return joinSet(deps, project, setName, options.invocation);
}

/** The set already here, when there is one; otherwise a name from the repo's. */
function defaultSetName(repo: Repo, existing: string[]): string {
  if (existing.length === 1) return existing[0]!;
  if (existing.length > 1) throw new EnvCliFailure({ code: 'several-sets', folder: repo.repoRoot, sets: existing });
  const repoName = (repo.remote ? repoSlug(repo.remote)?.split('/')[1] : null) ?? path.basename(repo.repoRoot);
  const name = setNameFrom(repoName);
  if (!name) throw usage(`Name the set with --set, for example --set app: "${repoName}" can't be made into a set name.`);
  return name;
}

/** "Acme API" → "acme-api"; null when nothing usable is left. */
export function setNameFrom(text: string): string | null {
  const name = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return ENV_SET_NAME_PATTERN.test(name) ? name : null;
}

async function createSet(deps: EnvCliDeps, repo: Repo, project: EnvProject, setName: string, options: InitOptions): Promise<number> {
  const say = deps.stdout;
  const values: EnvPlainValue[] = options.from === null ? [] : await readEnvInput(deps, options.from);
  const slug = repo.remote ? repoSlug(repo.remote) : null;
  const projectName = slug ?? path.basename(repo.repoRoot);
  say.write(`Project  ${projectName}${repo.remote ? ` (${remoteWithoutCredentials(repo.remote)})` : ''}\n`);
  say.write(`Set      ${setName} → ${ENV_FOLDER}/${setName}${ENV_FILE_EXTENSION}\n`);
  say.write(options.from === null ? 'Import   nothing; the set starts empty\n' : `Import   ${values.length} names from ${options.from}\n`);
  const params: EnvCreateParams = { project, setName, source: options.from, values, invocation: options.invocation };
  const result = await waitForAgent(deps, 'create', params, { wording: WAITING.create, stream: say });
  const by = printable(result.by);
  const recovery = result.recovery ? ' and your recovery phrase' : '';
  say.write(`✔ ${by} created ${setName}: owner ${by}, ${result.variables} variables,\n  encrypted for 1 device${recovery}.\n`);
  const addedRule = await setUpMergeDriver(repo.repoRoot);
  const shownSet = shownPath(repo.repoRoot, project.path);
  say.write(addedRule ? `Wrote ${shownSet} and a merge rule in .gitattributes.\n` : `Wrote ${shownSet}. .gitattributes already has the merge rule.\n`);
  if (options.from !== null) await offerToDelete(deps, options.from);
  say.write(`Next: git add ${ENV_FOLDER}${addedRule ? ' .gitattributes' : ''}\n      git commit -m "Add ${setName} env set"\n`);
  return 0;
}

/** The imported file still holds every value in plain text; deleting it is the person's call. */
async function offerToDelete(deps: EnvCliDeps, file: string): Promise<void> {
  const remove = await deps.confirm(`${file} still holds the plain values. Delete it? [y/N] `, false);
  if (!remove) return;
  await fs.rm(resolveFromCwd(deps, file));
  deps.stdout.write(`Deleted ${file}.\n`);
}

async function joinSet(deps: EnvCliDeps, project: EnvProject, setName: string, invocation: string): Promise<number> {
  const say = deps.stdout;
  const checked = await readCheckedSetFile(deps, { ...project, setName }, 'join-keys');
  const listed = await waitForAgent(deps, 'ls', { repoRoot: project.repoRoot, remote: project.remote, files: [{ path: project.path, file: checked.text }] }, { wording: WAITING.release, stream: deps.stderr });
  const role = listed.sets.find((row) => row.path === project.path)?.yourRole ?? null;
  if (role !== null) {
    await setUpMergeDriver(project.repoRoot);
    say.write(`✔ You're already in ${setName} (${role}). The merge rule is set up for this clone.\n`);
    return 0;
  }
  const owner = printable(checked.summary.ownerLabel);
  say.write(`${setName} already lives here (owner: ${owner}).\n`);
  if (!(await deps.confirm('Ask to join it from your phone? [Y/n] ', true))) {
    say.write('Nothing was asked.\n');
    return 0;
  }
  const params: EnvJoinParams = { project, file: checked.text, invocation };
  const result = await waitForAgent(deps, 'join', params, { wording: WAITING.join, stream: say });
  await setUpMergeDriver(project.repoRoot);
  const words = deps.core.joinKeyWords(result.request);
  const person = owner.split(' · ')[0] ?? owner;
  say.write(`✔ Wrote ${printable(result.requestPath)}\n`);
  say.write(`Your key words:  ${words.join(' ')}\n`);
  say.write(`Commit and push it, or open a pull request. Then read the six\nwords to ${person}; they approve on their phone.\n`);
  return 0;
}
