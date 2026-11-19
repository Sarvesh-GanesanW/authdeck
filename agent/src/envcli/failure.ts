import os from 'node:os';

import { ENV_EXIT, ENV_EXIT_FOR, envCommandErrorWords, type EnvCommandError, type EnvExitCode } from '../envSocketContract';

/** A command ending the way the contract words it. */
export class EnvCliFailure extends Error {
  constructor(readonly error: EnvCommandError) {
    super(envCommandErrorWords(error).message);
  }

  get exitCode(): EnvExitCode {
    return ENV_EXIT_FOR[this.error.code];
  }
}

/** Ctrl-C (or another stop signal) while waiting: the request was cancelled by closing the socket. */
export class EnvCliCancelled extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super('Cancelled.');
  }

  get exitCode(): number {
    return signal128(this.signal);
  }
}

/** The shell's exit code for a process stopped by `signal`: 128 + its number (Ctrl-C: 130). */
export function signal128(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return ENV_EXIT.interrupted;
  return 128 + (os.constants.signals[signal] ?? 0);
}

export function usage(detail: string): EnvCliFailure {
  return new EnvCliFailure({ code: 'usage', detail });
}

/** "✗ message" and the hint indented under it. */
export function failureText(error: EnvCommandError): string {
  const words = envCommandErrorWords(error);
  return words.hint ? `✗ ${words.message}\n  ${words.hint}` : `✗ ${words.message}`;
}
