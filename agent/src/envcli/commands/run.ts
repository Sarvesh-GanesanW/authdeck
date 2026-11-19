/** `authdeck env run -- <command>`: the set's values in one process's environment, nowhere else. */
import { runChild } from '../child';
import type { EnvCliDeps } from '../context';
import { askForValues, allowedWords, checkedSetHere, newerCopyWords } from '../release';
import { commandLine } from '../words';

export async function envRun(deps: EnvCliDeps, options: { set: string | null; allow: string[]; command: string[]; invocation: string; hasTerminal: boolean }): Promise<number> {
  // stdout is the child's; everything this command says goes to stderr.
  const say = deps.stderr;
  const here = await checkedSetHere(deps, options.set, 'run');
  const released = await askForValues(deps, { kind: 'run', set: options.set, command: options.command, target: null, invocation: options.invocation, stream: say }, here);
  const shown = commandLine(options.command);
  const after = released.result.via === 'grant' ? ` Running ${shown}.` : '\n  No file written.';
  say.write(`✔ ${allowedWords(released.setName, released.result)}${after}\n`);
  const newer = newerCopyWords(deps, released);
  if (newer) say.write(`${newer}\n`);
  return runChild({
    command: options.command,
    cwd: deps.cwd,
    env: deps.env,
    values: released.values,
    allowed: options.allow,
    loadsCode: deps.core.loadsCode,
    hasTerminal: options.hasTerminal,
    stderr: say,
  });
}
