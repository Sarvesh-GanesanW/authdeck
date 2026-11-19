/**
 * AuthDeck Agent's CLI mode: `AuthDeck Agent --authdeck-cli -- <args>`, what the authdeck
 * launchers run (cliPath.ts). It runs the command bundled in the app's resources and nothing else:
 * no path or script comes from the arguments, so the app can't be used to run other code under its
 * name and with the permissions the person gave it. No window, no tray, no agent server, and no
 * single-instance lock, so it works beside the running agent.
 */
import { app } from 'electron';
import path from 'node:path';
import { CLI_SCRIPT } from './cliPath';

/** What the bundled command's module gives: its exit code once done (agent/src/envcli/main.ts). */
interface BundledCli {
  finished: Promise<number>;
}

/** Runs the bundled command with `args`, then quits with its exit code once its output is written. */
export async function runCliMode(args: string[]): Promise<void> {
  // A command line tool: no dock icon, and no GPU process for a program that draws nothing.
  app.dock?.hide();
  app.disableHardwareAcceleration();
  const script = path.join(process.resourcesPath, 'cli', CLI_SCRIPT);
  // The command reads its arguments the way Node passes them: after the runtime and the script.
  process.argv = [process.execPath, script, ...args];
  let code: number;
  try {
    code = await (require(script) as BundledCli).finished;
  } catch (err) {
    process.stderr.write(`✗ AuthDeck Agent couldn't run its authdeck command: ${(err as Error).message}\n  Reinstall AuthDeck Agent.\n`);
    code = 1;
  }
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  app.exit(code);
}

/** Resolves once everything written to `stream` so far has gone out: app.exit doesn't wait for pipes. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write('', () => resolve()));
}
