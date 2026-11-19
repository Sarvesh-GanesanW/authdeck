/**
 * Starts the command with the set's values in its environment only, passes stdio and signals
 * through, and ends with its exit code (128 + n when a signal stopped it, as shells report).
 */
import { spawn } from 'node:child_process';

import type { EnvPlainValue } from '../envcore/types';
import { holdBackCodeLoading, skippedWords, type LoadsCode } from './codeLoading';
import { envCore } from './core';
import { signal128 } from './failure';

/** Exit code a shell gives for a command it can't find. */
export const COMMAND_NOT_FOUND_EXIT = 127;
/** …and for one it found but can't run. */
export const COMMAND_NOT_RUNNABLE_EXIT = 126;

/** Signals passed on to the child. */
const FORWARDED: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGUSR2'];
/**
 * Signals a terminal sends to its whole foreground process group, child included. They are
 * passed on only when there is no terminal (someone signalled this process by its pid), so a
 * Ctrl-C at the keyboard reaches the child once, not twice.
 */
const FROM_TERMINAL: NodeJS.Signals[] = ['SIGINT', 'SIGQUIT'];

export interface ChildOptions {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  values: EnvPlainValue[];
  /** Names that change how programs start which the person allowed for this run (--allow). */
  allowed?: readonly string[];
  /** Which names change how programs start; the core's list unless a test gives another. */
  loadsCode?: LoadsCode;
  /** True when stdin is a terminal, so terminal signals reach the child without us. */
  hasTerminal: boolean;
  /** Where skipped names and "command not found" are said. */
  stderr: { write(text: string): unknown };
}

export function runChild(options: ChildOptions): Promise<number> {
  const [file, ...args] = options.command as [string, ...string[]];
  const { kept, skipped } = holdBackCodeLoading(options.values, options.loadsCode ?? envCore.loadsCode, new Set(options.allowed ?? []));
  for (const name of skipped) options.stderr.write(`${skippedWords(name)}\n`);
  const env = { ...options.env };
  for (const { name, value } of kept) env[name] = value;
  return new Promise((resolve) => {
    // Windows needs a shell to find npm.cmd and friends; the argv is the person's own command.
    const child = spawn(file, args, { cwd: options.cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
    const relay = (signal: NodeJS.Signals) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const handled = [...FORWARDED, ...FROM_TERMINAL];
    const onSignal = (signal: NodeJS.Signals) => {
      if (FROM_TERMINAL.includes(signal) && options.hasTerminal) return;
      relay(signal);
    };
    for (const signal of handled) process.on(signal, onSignal);
    const done = (code: number) => {
      for (const signal of handled) process.off(signal, onSignal);
      resolve(code);
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      const notFound = err.code === 'ENOENT';
      options.stderr.write(`✗ ${notFound ? `${file}: command not found.` : `Could not start ${file} (${err.code ?? err.message}).`}\n`);
      done(notFound ? COMMAND_NOT_FOUND_EXIT : COMMAND_NOT_RUNNABLE_EXIT);
    });
    child.on('exit', (code, signal) => done(signal ? signal128(signal) : (code ?? 0)));
  });
}
