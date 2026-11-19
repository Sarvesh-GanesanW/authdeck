import { AgentError } from '../errors';
import { isSpawnNotFound, runProcess } from '../proc';
import { missingTool } from '../tools';
import type { ShellInvocation } from './context';

export const DEFAULT_COMMAND_TIMEOUT_SEC = 120;
export const OUTPUT_TAIL_CHARS = 8000;

export interface BackgroundOutcome {
  exitCode: number;
  output: string;
}

/** Runs a shell command hidden, waits for it, and returns exit code plus the tail of its output. */
export async function runBackgroundCommand(shell: ShellInvocation, cwd: string, timeoutSec: number): Promise<BackgroundOutcome> {
  let outcome;
  try {
    outcome = await runProcess(shell.cmd, shell.args, {
      cwd,
      timeoutMs: timeoutSec * 1000,
      tailChars: OUTPUT_TAIL_CHARS,
      verbatimArgs: shell.verbatimArgs,
    });
  } catch (err) {
    if (isSpawnNotFound(err)) throw missingTool(shell.cmd, 'run commands');
    throw err;
  }
  if (outcome.timedOut) {
    const partial = outcome.combined.trim();
    throw new AgentError(
      'timeout',
      `The command was stopped after ${timeoutSec} seconds.`,
      partial ? `Output so far:\n${partial.slice(-2000)}` : 'Give it a longer timeout, or run it in a terminal window instead.',
    );
  }
  return { exitCode: outcome.exitCode ?? -1, output: outcome.combined };
}
