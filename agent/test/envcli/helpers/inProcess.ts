/** Runs the command in this process against a fake agent and the fake core, capturing its output. */
import { runEnvCli } from '../../../src/envcli/cli';
import type { EnvCliDeps } from '../../../src/envcli/context';
import { fakeCore } from './fakeCore';

export interface CliOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface InProcessOptions {
  cwd: string;
  socketPath: string;
  /** Answers to confirm() questions, in order; unanswered ones take their default. */
  answers?: boolean[];
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

export async function runInProcess(argv: string[], options: InProcessOptions): Promise<CliOutcome & { questions: string[] }> {
  let stdout = '';
  let stderr = '';
  const questions: string[] = [];
  const answers = [...(options.answers ?? [])];
  const deps: EnvCliDeps = {
    core: fakeCore,
    cwd: options.cwd,
    env: options.env ?? { TERM_PROGRAM: 'Apple_Terminal', SHELL: '/bin/zsh' },
    socketPath: options.socketPath,
    stdout: { write: (text: string) => (stdout += text), isTTY: options.isTTY ?? false },
    stderr: { write: (text: string) => (stderr += text), isTTY: options.isTTY ?? false },
    confirm: async (question, fallback) => {
      questions.push(question);
      return answers.shift() ?? fallback;
    },
    now: Date.now,
  };
  const code = await runEnvCli(deps, { argv, hasTerminal: false });
  return { code, stdout, stderr, questions };
}
