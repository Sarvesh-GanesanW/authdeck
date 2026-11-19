/** `authdeck env push [<file>] [--prune]`: new values, encrypted and signed on a member's phone. */
import type { EnvPushParams, EnvPushResult } from '../../envSocketContract';
import { readCheckedSetFile, waitForAgent, type EnvCliDeps } from '../context';
import { chooseSet, findRepo } from '../git';
import { readEnvInput } from '../input';
import { WAITING } from '../waiting';
import { printable } from '../words';

/** Names shown in the suggested commit message before "and N more". */
const COMMIT_MESSAGE_NAMES = 3;

export async function envPush(deps: EnvCliDeps, options: { file: string; prune: boolean; set: string | null; invocation: string }): Promise<number> {
  const say = deps.stdout;
  const repo = await findRepo(deps.cwd);
  const project = await chooseSet(repo, options.set);
  const checked = await readCheckedSetFile(deps, project, 'push');
  const values = await readEnvInput(deps, options.file);
  const params: EnvPushParams = {
    project: { repoRoot: project.repoRoot, remote: project.remote, path: project.path },
    file: checked.text,
    source: options.file,
    values,
    prune: options.prune,
    invocation: options.invocation,
  };
  const result = await waitForAgent(deps, 'push', params, { wording: WAITING.push, stream: say });
  const changes = result.added.length + result.changed.length + result.removed.length;
  if (changes === 0) {
    say.write(`✔ Nothing to change: ${options.file} matches ${project.setName}.\n`);
    return 0;
  }
  say.write(`✔ Signed by ${printable(result.by)}. Wrote ${checked.shown}.\n`);
  say.write(diffLines(project.setName, result));
  say.write(`Next: git commit -am ${JSON.stringify(commitMessage(project.setName, result))} && git push\n`);
  return 0;
}

/**
 * acme-api: + FEATURE_FLAGS_URL      added
 *           ~ STRIPE_WEBHOOK_SECRET  changed
 *           − LEGACY_API_KEY         removed
 */
export function diffLines(setName: string, result: Pick<EnvPushResult, 'added' | 'changed' | 'removed'>): string {
  const rows = [
    ...result.added.map((name) => ({ mark: '+', name, what: 'added' })),
    ...result.changed.map((name) => ({ mark: '~', name, what: 'changed' })),
    ...result.removed.map((name) => ({ mark: '−', name, what: 'removed' })),
  ].map((row) => ({ ...row, name: printable(row.name) }));
  const width = Math.max(...rows.map((row) => row.name.length));
  const lead = `${setName}: `;
  return rows.map((row, i) => `${i === 0 ? lead : ' '.repeat(lead.length)}${row.mark} ${row.name.padEnd(width)}  ${row.what}\n`).join('');
}

/** "acme-api: add FEATURE_FLAGS_URL, change STRIPE_WEBHOOK_SECRET, remove LEGACY_API_KEY". */
export function commitMessage(setName: string, result: Pick<EnvPushResult, 'added' | 'changed' | 'removed'>): string {
  const parts = [
    ...result.added.map((name) => `add ${name}`),
    ...result.changed.map((name) => `change ${name}`),
    ...result.removed.map((name) => `remove ${name}`),
  ].map(printable);
  const shown = parts.slice(0, COMMIT_MESSAGE_NAMES).join(', ');
  const more = parts.length - COMMIT_MESSAGE_NAMES;
  return `${setName}: ${shown}${more > 0 ? ` and ${more} more` : ''}`;
}
