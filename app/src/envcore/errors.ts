import type { EnvFileProblem } from './types';

/**
 * Thrown when a set file, or a change to one, breaks a rule every reader checks. Callers word it
 * with envFileProblemWords; on the computer it ends the command with exit 65.
 */
export class EnvFileRefused extends Error {
  readonly problem: EnvFileProblem;

  constructor(problem: EnvFileProblem) {
    super(`The env set file was refused: ${problem.kind}.`);
    this.name = 'EnvFileRefused';
    this.problem = problem;
  }
}

