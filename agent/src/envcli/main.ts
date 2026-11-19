/** The `authdeck` binary: `authdeck env …` against the AuthDeck Agent running on this computer. */
import os from 'node:os';
import readline from 'node:readline/promises';

import { authdeckHome } from '../config';
import { envSocketPath } from '../envSocketContract';
import { runEnvCli } from './cli';
import { envCore } from './core';

async function confirm(question: string, fallback: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return fallback;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(question)).trim().toLowerCase();
    return answer === '' ? fallback : answer === 'y' || answer === 'yes';
  } finally {
    prompt.close();
  }
}

/**
 * The command's exit code once it has finished. Node exits by itself when the command is done;
 * AuthDeck Agent's CLI mode (desktop/src/main/cliMode.ts) waits for this, then quits the app.
 */
export const finished: Promise<number> = runEnvCli(
  {
    core: envCore,
    cwd: process.cwd(),
    env: process.env,
    socketPath: envSocketPath(authdeckHome(), process.platform, os.userInfo().username),
    stdout: process.stdout,
    stderr: process.stderr,
    confirm,
    now: Date.now,
  },
  { argv: process.argv.slice(2), hasTerminal: process.stdin.isTTY === true },
).then((code) => {
  process.exitCode = code;
  return code;
});
