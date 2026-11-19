/**
 * Env sets on the computer: what the `authdeck` command (agent/src/envcli, slice C) and the agent
 * (agent/src/env, slice B) say to each other over the local socket, the errors and exit codes the
 * command ends with, and what the agent tells the desktop app it runs inside (slice F).
 *
 * Socket
 * - A Unix socket at envSocketPath() (mode 0600, in the 0700 AuthDeck folder), or a named pipe
 *   on Windows. Only the person's own processes reach it; anything running as them could anyway.
 * - One request per connection. The command writes one EnvSocketRequest line; the agent answers
 *   with any number of progress lines, then one reply line, and closes. Lines are UTF-8 JSON
 *   ending in "\n", each at most ENV_SOCKET_MAX_LINE_BYTES.
 * - The command closing the connection (Ctrl-C) cancels its request: the agent closes it on every
 *   device (env.request.closed, reason 'cancelled').
 * - Every request names the set file the command read and checked, which is how the agent learns
 *   working trees (env.sets.list).
 */
import path from 'node:path';

import type { ActivitySummary } from './events';
import type { EnvFileProblem, EnvJoinRequestFile, EnvPlainValue, EnvRole, EnvSealedValues } from './envcore/types';
import { ENV_LIMITS, envFileProblemWords } from './envcore/types';
import type { EnvGrant, EnvGrantEndReason, EnvRequestKind } from './protocol';

/** Raised on any change to the messages below; the agent refuses other versions (`agent-version`). */
export const ENV_SOCKET_VERSION = 1;
export const ENV_SOCKET_MAX_LINE_BYTES = 2 * 1024 * 1024;
/** The command's name, which AuthDeck Agent offers to put on the PATH. */
export const ENV_CLI_NAME = 'authdeck';

/**
 * Where the agent listens. `home` is the AuthDeck folder (config.ts authdeckHome); on Windows the
 * pipe is per user, since pipes have no folder to keep them private.
 */
export function envSocketPath(home: string, platform: NodeJS.Platform, userName: string): string {
  if (platform === 'win32') return `\\\\.\\pipe\\authdeck-agent-${userName}`;
  return path.join(home, 'agent.sock');
}

/** The working tree a request is about. */
export interface EnvProject {
  repoRoot: string;
  /** The origin remote as git prints it; the agent removes credentials before showing it. Null without one. */
  remote: string | null;
  /** Absolute path of the set file. */
  path: string;
}

/** `authdeck env run` and `authdeck env pull`. */
export interface EnvReleaseParams {
  kind: 'run' | 'pull';
  project: EnvProject;
  /** The set file exactly as the command read and checked it. */
  file: string;
  /** run: the child's argv. Null for pull. */
  command: string[] | null;
  cwd: string;
  /** "Terminal · zsh", from TERM_PROGRAM and SHELL; null when unknown. */
  startedIn: string | null;
  /** pull: where .env goes, and whether git ignores it. Null for run. */
  target: { path: string; gitignored: boolean } | null;
  /** Sealing public key of the one-time key pair the command made for this run (vault/crypto keys). */
  oneTimeKey: string;
  /** The command as typed. */
  invocation: string;
}

export interface EnvReleaseResult {
  /** Sealed to `oneTimeKey`, whichever way they were allowed. */
  values: EnvSealedValues;
  /** The device that allowed it (now, or when the grant opened). */
  by: string;
  /** once: Allow once; grant: inside an open grant, no device asked; new-grant: Allow for 15 minutes, just now. */
  via: 'once' | 'grant' | 'new-grant';
  grantEndsAt: number | null;
  /** The copy the values came from. A hash other than the file's means a device had a newer copy: say so. */
  source: { rev: number; fileHash: string };
  /**
   * The link request id the values are sealed under (`openEnvSealedValues(…, { set, request })`).
   * The agent picks it, never the command, so a local process can't steer one release into another.
   */
  requestId: string;
}

/** `authdeck env push <file> [--prune]`. Always asks: a push is a signed change. */
export interface EnvPushParams {
  project: EnvProject;
  file: string;
  /** The file read, as typed: ".env.local". */
  source: string;
  values: EnvPlainValue[];
  prune: boolean;
  invocation: string;
}

/** The agent wrote the signed file. Names by what happened to them, for the diff the command prints. */
export interface EnvPushResult {
  by: string;
  fileHash: string;
  added: string[];
  changed: string[];
  removed: string[];
}

/** `authdeck env init` where the repo has no such set: a device makes it. The agent writes the file. */
export interface EnvCreateParams {
  /** `path` is where the new file goes: .authdeck/<setName>.env. */
  project: EnvProject;
  setName: string;
  /** ".env" when importing one; null for an empty set. */
  source: string | null;
  values: EnvPlainValue[];
  invocation: string;
}

export interface EnvCreateResult {
  setId: string;
  by: string;
  fileHash: string;
  variables: number;
  /** The owner has a recovery phrase, so the set is also sealed to it. */
  recovery: boolean;
}

/**
 * `authdeck env init` where the repo has the set and none of the person's devices is in it: a
 * device makes keys and signs a request. The agent writes it to .authdeck/requests/.
 */
export interface EnvJoinParams {
  project: EnvProject;
  file: string;
  invocation: string;
}

export interface EnvJoinResult {
  by: string;
  /** Relative to the repo root. */
  requestPath: string;
  /** The command shows its six key words (envcore) for the person to read to the owner. */
  request: EnvJoinRequestFile;
}

/** `authdeck env ls`: the sets in this repo, as the command found them. */
export interface EnvListParams {
  repoRoot: string;
  remote: string | null;
  files: { path: string; file: string }[];
}

export interface EnvListRow {
  name: string;
  setId: string | null;
  path: string;
  variables: number;
  members: number;
  /** The role of the person's own devices (those watching), or null when none is a member. */
  yourRole: EnvRole | null;
  /** "allowed until 11:58"; null: asks each time. */
  grantEndsAt: number | null;
  problem: EnvFileProblem | null;
}

export interface EnvListResult {
  sets: EnvListRow[];
  /** Join request files waiting in this repo. */
  joinRequests: { setName: string; label: string }[];
}

export interface EnvSocketMethods {
  release: { params: EnvReleaseParams; result: EnvReleaseResult };
  push: { params: EnvPushParams; result: EnvPushResult };
  create: { params: EnvCreateParams; result: EnvCreateResult };
  join: { params: EnvJoinParams; result: EnvJoinResult };
  ls: { params: EnvListParams; result: EnvListResult };
}

export type EnvSocketMethod = keyof EnvSocketMethods;

/** The command's one line. */
export interface EnvSocketRequest<M extends EnvSocketMethod = EnvSocketMethod> {
  v: typeof ENV_SOCKET_VERSION;
  id: string;
  method: M;
  params: EnvSocketMethods[M]['params'];
}

/**
 * While a request waits on devices. Sent again whenever the list changes (a member device
 * connects). `devices` empty: none is connected yet; the agent keeps waiting until expiresAt.
 */
export interface EnvSocketProgress {
  stage: 'asking';
  devices: string[];
  expiresAt: number;
}

/** The agent's lines: progress, then one reply. */
export type EnvSocketMessage<M extends EnvSocketMethod = EnvSocketMethod> =
  | { id: string; progress: EnvSocketProgress }
  | { id: string; ok: true; result: EnvSocketMethods[M]['result'] }
  | { id: string; ok: false; error: EnvCommandError };

// ---------------------------------------------------------------------------
// How a command ends
// ---------------------------------------------------------------------------

/** Exit codes, from BSD sysexits where one fits. `run` otherwise exits with its child's code. */
export const ENV_EXIT = {
  ok: 0,
  /** Bad arguments, or several sets here and no --set. */
  usage: 64,
  /** The set file failed its checks, or the values given break the rules. */
  fileRefused: 65,
  /** No set here, no file to read, or not a git repository. */
  noInput: 66,
  /** AuthDeck Agent isn't running, or doesn't speak this socket version. */
  unavailable: 69,
  internal: 70,
  /** No member device answered in time, the file changed while one was answering, or too many requests just now. */
  noAnswer: 75,
  denied: 77,
  /** pull: the target file exists and --force wasn't given. */
  cantCreate: 73,
  /** Stopped with Ctrl-C. */
  interrupted: 130,
} as const;

export type EnvExitCode = (typeof ENV_EXIT)[keyof typeof ENV_EXIT];

/**
 * Every way a command fails. The agent sends the ones it finds; the command makes the rest
 * (agent-unavailable, usage, no-repo, no-input, bad-name, bad-dotenv, target-exists, too-large). Names of devices are their
 * pairing names; `set` is the set's name.
 */
export type EnvCommandError =
  | { code: 'denied'; kind: EnvRequestKind; set: string; by: string; command: string | null; target: string | null }
  /** `devices`: member devices paired with this computer, by name, to tell the person which to open. */
  | { code: 'no-answer'; set: string; devices: string[]; waitedSec: number }
  | { code: 'file-refused'; kind: EnvRequestKind | 'ls'; set: string; file: string; problem: EnvFileProblem; commit: string | null }
  | { code: 'changed-meanwhile'; file: string; by: string }
  | { code: 'no-set'; folder: string }
  | { code: 'several-sets'; folder: string; sets: string[] }
  | { code: 'unknown-set'; set: string; sets: string[] }
  | { code: 'no-repo'; folder: string }
  | { code: 'no-input'; path: string }
  | { code: 'bad-name'; path: string; line: number; name: string }
  /** A .env line the command can't read: an unclosed quote, or text after a closing quote. Never echoes the line. */
  | { code: 'bad-dotenv'; path: string; line: number; reason: 'unclosed-quote' | 'after-quote' }
  /** pull: the target exists; --force replaces it. */
  | { code: 'target-exists'; path: string }
  | { code: 'too-large'; path: string; limit: 'names' | 'value' | 'values'; name: string | null }
  | { code: 'agent-unavailable' }
  /** Too many requests from this computer in a short time; try again after `retryAfterSec`. */
  | { code: 'rate-limited'; retryAfterSec: number }
  | { code: 'agent-version'; agentVersion: string; socketVersion: number }
  | { code: 'usage'; detail: string }
  | { code: 'failed'; detail: string };

export type EnvCommandErrorCode = EnvCommandError['code'];

export const ENV_EXIT_FOR: Record<EnvCommandErrorCode, EnvExitCode> = {
  denied: ENV_EXIT.denied,
  'no-answer': ENV_EXIT.noAnswer,
  'file-refused': ENV_EXIT.fileRefused,
  'changed-meanwhile': ENV_EXIT.noAnswer,
  'no-set': ENV_EXIT.noInput,
  'several-sets': ENV_EXIT.usage,
  'unknown-set': ENV_EXIT.usage,
  'no-repo': ENV_EXIT.noInput,
  'no-input': ENV_EXIT.noInput,
  'bad-name': ENV_EXIT.fileRefused,
  'bad-dotenv': ENV_EXIT.fileRefused,
  'target-exists': ENV_EXIT.cantCreate,
  'too-large': ENV_EXIT.fileRefused,
  'agent-unavailable': ENV_EXIT.unavailable,
  'rate-limited': ENV_EXIT.noAnswer,
  'agent-version': ENV_EXIT.unavailable,
  usage: ENV_EXIT.usage,
  failed: ENV_EXIT.internal,
};

/** What did not happen, in the words the denial ends with. */
function notDone(kind: EnvRequestKind | 'ls', command: string | null, target: string | null): string {
  switch (kind) {
    case 'run':
      return `${command ?? 'The command'} did not start.`;
    case 'pull':
      return `${target ?? '.env'} was not written.`;
    case 'push':
      return 'Nothing was changed.';
    case 'create':
      return 'No set was made.';
    case 'join-keys':
      return 'No join request was made.';
    case 'ls':
      return '';
  }
}

/** The one home for what the command prints when it fails: a sentence, then what to do. */
export function envCommandErrorWords(error: EnvCommandError): { message: string; hint?: string } {
  switch (error.code) {
    case 'denied':
      return { message: `${error.by} denied ${error.set}. ${notDone(error.kind, error.command, error.target)}` };
    case 'no-answer':
      return {
        message: `No member device answered in ${error.waitedSec} s.`,
        hint: `Open AuthDeck on ${error.devices.length > 0 ? listWords(error.devices) : "a member's phone or tablet"}, on the same network as this computer, and run this again.`,
      };
    case 'file-refused': {
      const words = envFileProblemWords(error.problem, { file: error.file, set: error.set, commit: error.commit ?? undefined, where: 'computer' });
      const released = error.kind === 'run' || error.kind === 'pull' ? ' Nothing was released.' : error.kind === 'ls' ? '' : ' Nothing was changed.';
      return { message: `${words.message}${released}`, hint: words.hint };
    }
    case 'changed-meanwhile':
      return { message: `${error.file} changed while ${error.by} was answering.`, hint: 'Run this again.' };
    case 'no-set':
      return { message: `There is no env set in ${error.folder}.`, hint: 'Run authdeck env init in the project folder to make one.' };
    case 'several-sets':
      return { message: `${error.folder} has ${error.sets.length} sets: ${error.sets.join(', ')}.`, hint: `Name one with --set, for example --set ${error.sets[0] ?? 'name'}.` };
    case 'unknown-set':
      return { message: `There is no set named ${error.set} here.`, hint: error.sets.length > 0 ? `Sets here: ${error.sets.join(', ')}.` : 'Run authdeck env init to make one.' };
    case 'no-repo':
      return { message: `${error.folder} isn't inside a git repository.`, hint: 'Env sets live in the project\'s repo: run this in your project folder, or run git init first.' };
    case 'no-input':
      return { message: `${error.path} doesn't exist.`, hint: 'Name the file to read, for example authdeck env push .env.local.' };
    case 'bad-name':
      return { message: `${error.path} line ${error.line}: ${error.name} can't be a variable name.`, hint: "Names take letters, digits and _, and don't start with a digit." };
    case 'bad-dotenv':
      return {
        message: `${error.path} line ${error.line}: ${error.reason === 'unclosed-quote' ? 'a quote is opened and never closed' : 'there is text after the closing quote'}.`,
        hint: 'Fix that line, then try again. Quoted values can span lines; anything after the closing quote must be a # comment.',
      };
    case 'target-exists':
      return { message: `${error.path} already exists.`, hint: 'Add --force to replace it, or name another file with --file.' };
    case 'too-large':
      return { message: tooLargeInput(error), hint: 'Move large files out of the set and keep a path to them instead.' };
    case 'rate-limited':
      return { message: 'Too many env requests from this computer just now.', hint: `Wait ${error.retryAfterSec} s, then try again.` };
    case 'agent-unavailable':
      return { message: "AuthDeck Agent isn't running on this computer.", hint: 'Open AuthDeck Agent, or run authdeck-agent, then try again.' };
    case 'agent-version':
      return {
        message: `This authdeck command doesn't match AuthDeck Agent ${error.agentVersion} on this computer (env socket ${error.socketVersion}, not ${ENV_SOCKET_VERSION}).`,
        hint: 'Update AuthDeck Agent; the authdeck command comes with it.',
      };
    case 'usage':
      return { message: error.detail, hint: 'Run authdeck env --help.' };
    case 'failed':
      return { message: error.detail, hint: 'Try again. If it keeps failing, restart AuthDeck Agent.' };
  }
}

function tooLargeInput(error: Extract<EnvCommandError, { code: 'too-large' }>): string {
  switch (error.limit) {
    case 'names':
      return `${error.path} has more than ${ENV_LIMITS.names} variables; a set holds at most ${ENV_LIMITS.names}.`;
    case 'value':
      return `${error.name ?? 'A value'} in ${error.path} is larger than ${ENV_LIMITS.valueBytes / 1024} KB.`;
    case 'values':
      return `The values in ${error.path} add up to more than ${ENV_LIMITS.valueTotalBytes / 1024} KB.`;
  }
}

/** "Pixel 8", "Pixel 8 or iPad mini", "Pixel 8, iPad mini or Pixel 9". */
function listWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// The agent and the desktop app it runs inside
// ---------------------------------------------------------------------------

/**
 * A row in the Agent window's Activity list. The agent writes the words: title "Ran with
 * acme-api", detail "npm test · 12 variables", outcome "Inside the 15-min grant". Never a value.
 */
export interface EnvActivityEntry extends ActivitySummary {
  id: number;
  at: number;
  kind: EnvRequestKind;
  setName: string;
  outcome: { text: string; tone: 'ok' | 'warn' | 'bad' };
}

/** Env events for the host UI, given to startAgent as AgentOptions.onEnvEvent (slice B adds the option). */
/**
 * To the host app. `ended` names the grant that just ended and why, so the window's row can say so;
 * the agent doesn't also send an env.activity entry for a grant's end.
 */
export type EnvAgentEvent =
  | { type: 'env.activity'; entry: EnvActivityEntry }
  | { type: 'env.grants.changed'; grants: EnvGrant[]; ended?: { grantId: string; setId: string; reason: EnvGrantEndReason } };

export type EnvAgentEventListener = (event: EnvAgentEvent) => void;

/** What the host UI can ask of the agent: RunningAgent.env (slice B adds it). */
export interface EnvAgentControl {
  grants(): EnvGrant[];
  /** End now in the Agent window. False when no such grant is open. */
  endGrant(grantId: string): boolean;
  /**
   * Ends every grant, telling each device why. The desktop app calls it on powerMonitor's
   * lock-screen ('computer-locked') and suspend ('computer-slept'); the agent itself uses it for
   * 'clock-jumped' and 'unpaired'.
   */
  endAllGrants(reason: EnvGrantEndReason): void;
}
