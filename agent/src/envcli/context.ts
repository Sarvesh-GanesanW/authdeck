/** What every env command runs with, and the two steps most of them share. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { EnvRequestKind } from '../protocol';
import type { EnvSocketMethod, EnvSocketMethods } from '../envSocketContract';
import { ENV_LIMITS } from '../envcore/types';
import type { EnvCliCore, EnvSetFileSummary } from './core';
import { EnvCliFailure } from './failure';
import { commitOfLine } from './git';
import { askAgent } from './socket';
import { WaitingLine, type WaitingStream, type WaitingWording } from './waiting';
import { shownPath } from './words';

export interface EnvCliOutput extends WaitingStream {
  write(text: string): unknown;
}

export interface EnvCliDeps {
  core: EnvCliCore;
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  stdout: EnvCliOutput;
  stderr: EnvCliOutput;
  /** A yes/no question; returns `fallback` when nobody can answer (no terminal). */
  confirm(question: string, fallback: boolean): Promise<boolean>;
  now(): number;
}

/** Signals that, while a request waits, cancel it (by closing the socket) and end the command. */
const CANCEL_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export interface WaitOptions {
  wording: WaitingWording;
  /** Where the waiting line goes: stderr for run, whose stdout belongs to the child. */
  stream: EnvCliOutput;
  /** Runs once, before the first waiting line: only when a device is actually asked. */
  beforeAsking?: () => void;
}

/** Sends one request and waits for its reply, showing who is being asked. Ctrl-C cancels it. */
export async function waitForAgent<M extends EnvSocketMethod>(
  deps: EnvCliDeps,
  method: M,
  params: EnvSocketMethods[M]['params'],
  options: WaitOptions,
): Promise<EnvSocketMethods[M]['result']> {
  const cancel = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => cancel.abort(signal);
  for (const signal of CANCEL_SIGNALS) process.on(signal, onSignal);
  const line = new WaitingLine(options.stream, options.wording, deps.now(), deps.now);
  let asked = false;
  try {
    return await askAgent(method, params, {
      socketPath: deps.socketPath,
      requestId: randomUUID(),
      signal: cancel.signal,
      onProgress: (progress) => {
        if (!asked) options.beforeAsking?.();
        asked = true;
        line.update(progress);
      },
    });
  } finally {
    line.stop();
    for (const signal of CANCEL_SIGNALS) process.off(signal, onSignal);
  }
}

export interface CheckedSetFile {
  /** The file exactly as read. */
  text: string;
  summary: EnvSetFileSummary;
  /** As the person knows it: ".authdeck/acme-api.env". */
  shown: string;
}

/** Reads a set file and checks it with the core; a refused file ends the command (exit 65). */
export async function readCheckedSetFile(
  deps: EnvCliDeps,
  project: { repoRoot: string; path: string; setName: string },
  kind: EnvRequestKind | 'ls',
): Promise<CheckedSetFile> {
  const shown = shownPath(project.repoRoot, project.path);
  const refuse = async (problem: Extract<EnvCliFailure['error'], { code: 'file-refused' }>['problem']) => {
    const commit = 'line' in problem ? await commitOfLine(project.repoRoot, shown, problem.line) : null;
    return new EnvCliFailure({ code: 'file-refused', kind, set: project.setName, file: shown, problem, commit });
  };
  const stat = await fs.stat(project.path);
  if (stat.size > ENV_LIMITS.fileBytes) throw await refuse({ kind: 'too-large', limit: 'file' });
  const text = await fs.readFile(project.path, 'utf8');
  const check = deps.core.checkSetFile(text);
  if (!check.ok) throw await refuse(check.problem);
  return { text, summary: check.summary, shown };
}

/** A file named on the command line, from the folder the command runs in. */
export function resolveFromCwd(deps: EnvCliDeps, file: string): string {
  return path.resolve(deps.cwd, file);
}
