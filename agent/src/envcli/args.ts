/** `authdeck env …` arguments, and the help text bad usage points to. */
import { ENV_NAME_PATTERN, ENV_SET_NAME_PATTERN } from '../envcore/types';
import { usage } from './failure';

export const DEFAULT_ENV_FILE = '.env';

export type EnvCliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  /** from: a .env to import; set: the set to make or join (default: the one here, or the repo's name). */
  | { kind: 'init'; from: string | null; set: string | null }
  | { kind: 'ls' }
  | { kind: 'push'; file: string; prune: boolean; set: string | null }
  | { kind: 'pull'; file: string; force: boolean; set: string | null }
  /** allow: names that change how programs start, injected anyway for this run. */
  | { kind: 'run'; set: string | null; allow: string[]; command: string[] }
  /** Git's merge driver: %O %A %B. The result goes into `ours`. */
  | { kind: 'merge'; base: string; ours: string; theirs: string };

export const ENV_HELP = `authdeck env: your project's .env, encrypted in its git repo. Your phone approves each use.

Usage
  authdeck env init [--from <file>] [--set <name>]
      Make a set for this repo (importing <file>), or ask to join the one here.
      Also adds the merge rule to .gitattributes and this clone's git config.
  authdeck env ls
      The sets in this repo, your role, and whether one is allowed on this computer.
  authdeck env push [<file>] [--prune] [--set <name>]
      Send <file> (default .env) to a member's phone to sign as the set's new values.
      --prune also removes names that aren't in <file>.
  authdeck env pull [<file>] [--force] [--set <name>]
      Write the set to <file> (default .env), readable only by you.
      --force replaces a file that is already there.
  authdeck env run [--set <name>] [--allow <NAME>]... -- <command> [<arg>...]
      Run <command> with the set in its environment. No file is written.
      Variables that change how programs start (NODE_OPTIONS, LD_PRELOAD, DYLD_*,
      BASH_ENV, PATH and the like) are skipped, since any member can set them;
      --allow NAME uses one for this run. pull writes them, with a warning.
  authdeck env --help | --version

  --set <name>  Which set, when the repo has more than one.

Exit codes
  0 done (run: the command's own code)   64 bad usage or several sets
  65 set file or values refused          66 no set, no file, or not a git repo
  69 AuthDeck Agent not running          70 something else failed
  73 pull: the file is already there     75 no member device answered
  77 denied on the phone                 130 stopped with Ctrl-C

Git runs "authdeck env merge %O %A %B" itself to merge set files; init sets that up.`;

interface Flags {
  values: Record<string, string>;
  /** Flags given any number of times, in order. */
  lists: Record<string, string[]>;
  switches: Set<string>;
  positional: string[];
}

interface FlagSpec {
  /** Flags that take a value: "--set". */
  values?: string[];
  /** Flags that take a value and may repeat: "--allow". */
  lists?: string[];
  switches?: string[];
  maxPositional: number;
}

const HELP_FLAGS = new Set(['--help', '-h']);
const VERSION_FLAGS = new Set(['--version', '-v']);

export function parseEnvArgs(argv: readonly string[]): EnvCliCommand {
  const [group, command, ...rest] = argv;
  if (group === undefined) throw usage('Name a command: authdeck env init, ls, push, pull or run.');
  if (HELP_FLAGS.has(group)) return { kind: 'help' };
  if (VERSION_FLAGS.has(group)) return { kind: 'version' };
  if (group !== 'env') throw usage(`Unknown command "${group}". Commands start with authdeck env.`);
  if (command === undefined) throw usage('Name a command: authdeck env init, ls, push, pull or run.');
  if (HELP_FLAGS.has(command)) return { kind: 'help' };
  if (VERSION_FLAGS.has(command)) return { kind: 'version' };
  if (command !== 'run' && rest.some((arg) => HELP_FLAGS.has(arg))) return { kind: 'help' };
  switch (command) {
    case 'init': {
      const flags = parseFlags(command, rest, { values: ['--from', '--set'], maxPositional: 0 });
      return { kind: 'init', from: flags.values['--from'] ?? null, set: setName(flags) };
    }
    case 'ls':
      parseFlags(command, rest, { maxPositional: 0 });
      return { kind: 'ls' };
    case 'push': {
      const flags = parseFlags(command, rest, { values: ['--set', '--file'], switches: ['--prune'], maxPositional: 1 });
      return { kind: 'push', file: fileArgument(flags), prune: flags.switches.has('--prune'), set: setName(flags) };
    }
    case 'pull': {
      const flags = parseFlags(command, rest, { values: ['--set', '--file'], switches: ['--force'], maxPositional: 1 });
      return { kind: 'pull', file: fileArgument(flags), force: flags.switches.has('--force'), set: setName(flags) };
    }
    case 'run':
      return parseRun(rest);
    case 'merge': {
      if (rest.length !== 3) throw usage('Use: authdeck env merge <base> <ours> <theirs> (git runs it with %O %A %B).');
      const [base, ours, theirs] = rest as [string, string, string];
      return { kind: 'merge', base, ours, theirs };
    }
    default:
      throw usage(`Unknown command "authdeck env ${command}".`);
  }
}

/** run's own options come before the command; `--`, or the first word that isn't one, starts it. */
function parseRun(args: string[]): EnvCliCommand {
  const optionArgs: string[] = [];
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      index++;
      break;
    }
    if (!arg.startsWith('-')) break;
    if (HELP_FLAGS.has(arg)) return { kind: 'help' };
    optionArgs.push(arg);
    if (arg === '--set' || arg === '--allow') optionArgs.push(args[++index] ?? '');
  }
  const flags = parseFlags('run', optionArgs, { values: ['--set'], lists: ['--allow'], maxPositional: 0 });
  const command = args.slice(index);
  if (command.length === 0) throw usage('Name the command to run: authdeck env run -- npm run dev');
  return { kind: 'run', set: setName(flags), allow: allowedNames(flags), command };
}

function parseFlags(command: string, args: string[], spec: FlagSpec): Flags {
  const flags: Flags = { values: {}, lists: {}, switches: new Set(), positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [flag, inline] = splitInline(arg);
    if (spec.values?.includes(flag) || spec.lists?.includes(flag)) {
      const value = inline ?? args[++i];
      if (value === undefined || value === '') throw usage(`${flag} needs a value.`);
      if (spec.lists?.includes(flag)) (flags.lists[flag] ??= []).push(value);
      else flags.values[flag] = value;
    } else if (spec.switches?.includes(flag) && inline === undefined) {
      flags.switches.add(flag);
    } else if (arg.startsWith('-') && arg !== '-') {
      throw usage(`authdeck env ${command} has no option ${flag}.`);
    } else {
      flags.positional.push(arg);
    }
  }
  if (flags.positional.length > spec.maxPositional) throw usage(`Too many arguments for authdeck env ${command}: ${flags.positional.join(' ')}.`);
  return flags;
}

function splitInline(arg: string): [string, string | undefined] {
  const equals = arg.indexOf('=');
  if (!arg.startsWith('--') || equals < 0) return [arg, undefined];
  return [arg.slice(0, equals), arg.slice(equals + 1)];
}

function fileArgument(flags: Flags): string {
  const named = flags.values['--file'];
  const positional = flags.positional[0];
  if (named !== undefined && positional !== undefined) throw usage(`Name the file once: ${positional} or --file ${named}.`);
  return named ?? positional ?? DEFAULT_ENV_FILE;
}

function allowedNames(flags: Flags): string[] {
  const names = flags.lists['--allow'] ?? [];
  const bad = names.find((name) => !ENV_NAME_PATTERN.test(name));
  if (bad !== undefined) throw usage(`--allow takes a variable name, not "${bad}".`);
  return names;
}

function setName(flags: Flags): string | null {
  const name = flags.values['--set'];
  if (name === undefined) return null;
  if (!ENV_SET_NAME_PATTERN.test(name)) throw usage(`"${name}" can't be a set name: use lower-case letters, digits, ".", "_" and "-", starting with a letter or digit.`);
  return name;
}
