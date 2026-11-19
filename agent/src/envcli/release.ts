/** What run and pull share: choosing and checking the set, asking for its values, opening them. */
import type { EnvReleaseParams, EnvReleaseResult } from '../envSocketContract';
import type { EnvTransferScope } from '../envcore';
import type { EnvPlainValue } from '../envcore/types';
import { toBase64Url } from '../vault/bytes';
import type { OneTimeKey } from './core';
import { EnvCliFailure } from './failure';
import { readCheckedSetFile, waitForAgent, type CheckedSetFile, type EnvCliDeps, type EnvCliOutput } from './context';
import { chooseSet, findRepo } from './git';
import { WAITING } from './waiting';
import { clockTime, printable, startedIn } from './words';

export interface ReleaseRequest {
  kind: 'run' | 'pull';
  set: string | null;
  command: string[] | null;
  target: EnvReleaseParams['target'];
  invocation: string;
  /** Where the command's own lines go. */
  stream: EnvCliOutput;
}

export interface Released {
  setName: string;
  checked: CheckedSetFile;
  result: EnvReleaseResult;
  values: EnvPlainValue[];
}

/** The set run and pull are about, checked, before anything is asked. */
export async function checkedSetHere(deps: EnvCliDeps, set: string | null, kind: 'run' | 'pull') {
  const repo = await findRepo(deps.cwd);
  const project = await chooseSet(repo, set);
  const checked = await readCheckedSetFile(deps, project, kind);
  return { project, checked };
}

export async function askForValues(deps: EnvCliDeps, request: ReleaseRequest, here: Awaited<ReturnType<typeof checkedSetHere>>): Promise<Released> {
  const { project, checked } = here;
  // The one-time key lives only in this process; Allow once seals the values to it.
  const oneTimeKey = deps.core.newOneTimeKey();
  const { summary } = checked;
  const params: EnvReleaseParams = {
    kind: request.kind,
    project: { repoRoot: project.repoRoot, remote: project.remote, path: project.path },
    file: checked.text,
    command: request.command,
    cwd: deps.cwd,
    startedIn: startedIn(deps.env),
    target: request.target,
    oneTimeKey: toBase64Url(oneTimeKey.xPublic),
    invocation: request.invocation,
  };
  const result = await waitForAgent(deps, 'release', params, {
    wording: WAITING.release,
    stream: request.stream,
    beforeAsking: () =>
      request.stream.write(`${project.setName}: ${summary.variables} variables, signatures check out (rev ${summary.rev}, epoch ${summary.epoch})\n`),
  });
  // The agent picks the request id the values are sealed under; the command only opens them.
  const values = openReleased(deps, result, { set: summary.setId, request: result.requestId }, oneTimeKey);
  return { setName: project.setName, checked, result, values };
}

function openReleased(deps: EnvCliDeps, result: EnvReleaseResult, scope: EnvTransferScope, key: OneTimeKey): EnvPlainValue[] {
  try {
    return deps.core.openValues(result.values, scope, key);
  } catch (err) {
    throw new EnvCliFailure({ code: 'failed', detail: `The values from ${printable(result.by)} don't open with this command's one-time key (${(err as Error).message}). Nothing was started or written.` });
  }
}

/** "Pixel 8 allowed acme-api for 15 minutes (until 11:58)." and the like. */
export function allowedWords(setName: string, result: EnvReleaseResult): string {
  const by = printable(result.by);
  const until = result.grantEndsAt === null ? null : clockTime(result.grantEndsAt);
  switch (result.via) {
    case 'once':
      return `${by} allowed ${setName} once.`;
    case 'new-grant':
      return `${by} allowed ${setName} for 15 minutes${until ? ` (until ${until})` : ''}.`;
    case 'grant':
      return `${setName} allowed${until ? ` until ${until}` : ''} by ${by}.`;
  }
}

/** Said when the values came from a device's newer copy than this folder's file. */
export function newerCopyWords(deps: EnvCliDeps, released: Released): string | null {
  if (released.result.source.fileHash === deps.core.fileHash(released.checked.text)) return null;
  return `  ${printable(released.result.by)} used its newer copy of ${released.setName} (rev ${released.result.source.rev}). Run git pull to bring this folder up to date.`;
}
