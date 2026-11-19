/**
 * Which arguments AuthDeck Agent starts with. It holds the person's Accessibility and Automation
 * grants, so no other program may start it with its own code: Chromium's launcher and debugging
 * switches (--gpu-launcher, --renderer-cmd-prefix, --remote-debugging-port, --js-flags…) would
 * run a command, or open the app to one, under AuthDeck Agent's name. So the app takes only the
 * arguments it uses itself and refuses to start with anything else. No Electron import here, so
 * the rules are tested as plain functions.
 */
// With its extension: the desktop tests load this file with Node's type stripping, which needs it.
import { CLI_ARGS_SEPARATOR, CLI_MODE_FLAG } from './cliPath.ts';

/** What the sign-in entries pass (startAtSignIn.ts): a Windows login item and a Linux autostart file. */
export const HIDDEN_FLAG = '--hidden';
/** What older macOS adds when it opens an app from the Finder: its process serial number. */
const MAC_PROCESS_SERIAL = /^-psn_\d+_\d+$/;
/**
 * Linux only: Ubuntu 24.04 and others block Chromium's sandbox for AppImages, which then start
 * only with --no-sandbox. Linux has no grants for another program to borrow, so it is allowed there.
 */
const LINUX_NO_SANDBOX = '--no-sandbox';
/** Longest argument echoed back in the refusal. */
const SHOWN_ARGUMENT_CHARS = 80;

/**
 * Chromium switches that run a program, load code or open the app to a debugger. Checked again in
 * Chromium's own reading of the command line, and removed from it, in case one gets past argv.
 */
export const CHROMIUM_LAUNCH_SWITCHES = [
  'gpu-launcher',
  'renderer-cmd-prefix',
  'utility-cmd-prefix',
  'ppapi-plugin-launcher',
  'browser-subprocess-path',
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'js-flags',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-brk-node',
  'no-sandbox',
  'disable-gpu-sandbox',
] as const;

export type LaunchMode =
  | { mode: 'app' }
  | { mode: 'cli'; args: string[] }
  | { mode: 'refused'; argument: string };

export interface LaunchContext {
  platform: NodeJS.Platform;
  /** `electron .` in development (process.defaultApp): argv[1] is the app's folder. */
  defaultApp: boolean;
}

/**
 * How to start, from the app's own argv (process.argv). CLI mode is exactly CLI_MODE_FLAG, then
 * `--`, then the command's arguments (Chromium reads no switches after `--`). The app itself takes
 * only HIDDEN_FLAG and, on macOS, a process serial number. Anything else is refused.
 */
export function launchMode(argv: readonly string[], context: LaunchContext): LaunchMode {
  if (argv[1] === CLI_MODE_FLAG && argv[2] === CLI_ARGS_SEPARATOR) return { mode: 'cli', args: argv.slice(3) };
  const appArguments = argv.slice(context.defaultApp ? 2 : 1);
  const unknown = appArguments.find((argument) => !isAppArgument(argument, context.platform));
  return unknown === undefined ? { mode: 'app' } : { mode: 'refused', argument: unknown };
}

function isAppArgument(argument: string, platform: NodeJS.Platform): boolean {
  return argument === HIDDEN_FLAG || (platform === 'darwin' && MAC_PROCESS_SERIAL.test(argument)) || (platform === 'linux' && argument === LINUX_NO_SANDBOX);
}

/** The Chromium switches refused on this platform: --no-sandbox is allowed on Linux (see LINUX_NO_SANDBOX). */
export function refusedSwitches(platform: NodeJS.Platform): readonly string[] {
  return platform === 'linux' ? CHROMIUM_LAUNCH_SWITCHES.filter((name) => `--${name}` !== LINUX_NO_SANDBOX) : CHROMIUM_LAUNCH_SWITCHES;
}

/** The refusal, on stderr: what was refused, never more than a line of it. */
export function refusedWords(argument: string): string {
  const shown = argument.length > SHOWN_ARGUMENT_CHARS ? `${argument.slice(0, SHOWN_ARGUMENT_CHARS)}…` : argument;
  return `AuthDeck Agent doesn't take the argument ${JSON.stringify(shown)}, so it didn't start. Open it from its app icon, or run the authdeck command.`;
}
