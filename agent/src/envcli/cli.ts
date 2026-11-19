/** `authdeck env …`: parses the arguments, runs one command, and turns how it ended into an exit code. */
import packageJson from '../../package.json';
import { ENV_CLI_NAME, ENV_EXIT } from '../envSocketContract';
import { parseEnvArgs, ENV_HELP, type EnvCliCommand } from './args';
import { envInit } from './commands/init';
import { envLs } from './commands/ls';
import { envMerge } from './commands/merge';
import { envPull } from './commands/pull';
import { envPush } from './commands/push';
import { envRun } from './commands/run';
import type { EnvCliDeps } from './context';
import { EnvCliCancelled, EnvCliFailure, failureText } from './failure';
import { commandLine } from './words';

export interface EnvCliRun {
  argv: readonly string[];
  /** True when stdin is a terminal: Ctrl-C then reaches a child without being passed on. */
  hasTerminal: boolean;
}

/** Runs one command and returns its exit code. Never throws. */
export async function runEnvCli(deps: EnvCliDeps, run: EnvCliRun): Promise<number> {
  let command: EnvCliCommand;
  try {
    command = parseEnvArgs(run.argv);
  } catch (err) {
    // Bad arguments: the error, then the whole help.
    const code = reportFailure(deps, err);
    deps.stderr.write(`\n${ENV_HELP}\n`);
    return code;
  }
  try {
    return await runCommand(deps, command, run);
  } catch (err) {
    return reportFailure(deps, err);
  }
}

function runCommand(deps: EnvCliDeps, command: EnvCliCommand, run: EnvCliRun): Promise<number> | number {
  const invocation = `${ENV_CLI_NAME} ${commandLine(run.argv)}`;
  switch (command.kind) {
    case 'help':
      deps.stdout.write(`${ENV_HELP}\n`);
      return ENV_EXIT.ok;
    case 'version':
      deps.stdout.write(`${packageJson.version}\n`);
      return ENV_EXIT.ok;
    case 'init':
      return envInit(deps, { from: command.from, set: command.set, invocation });
    case 'ls':
      return envLs(deps);
    case 'push':
      return envPush(deps, { file: command.file, prune: command.prune, set: command.set, invocation });
    case 'pull':
      return envPull(deps, { file: command.file, force: command.force, set: command.set, invocation });
    case 'run':
      return envRun(deps, { set: command.set, allow: command.allow, command: command.command, invocation, hasTerminal: run.hasTerminal });
    case 'merge':
      return envMerge(deps, command);
  }
}

function reportFailure(deps: EnvCliDeps, err: unknown): number {
  if (err instanceof EnvCliCancelled) {
    deps.stderr.write('\n✗ Cancelled. Nothing was released or changed.\n');
    return err.exitCode;
  }
  if (err instanceof EnvCliFailure) {
    deps.stderr.write(`${failureText(err.error)}\n`);
    return err.exitCode;
  }
  const detail = err instanceof Error ? err.message : String(err);
  deps.stderr.write(`${failureText({ code: 'failed', detail })}\n`);
  return ENV_EXIT.internal;
}
