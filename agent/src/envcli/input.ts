/** Reading a .env the person names (push, init --from) into values the set's rules allow. */
import fs from 'node:fs/promises';

import { envFileProblemWords, type EnvFileProblem, type EnvPlainValue } from '../envcore/types';
import { resolveFromCwd, type EnvCliDeps } from './context';
import { parseDotenv, type DotenvProblem } from './dotenv';
import { EnvCliFailure, usage } from './failure';

/** Reads `file` (as typed) and checks names and sizes against ENV_LIMITS. */
export async function readEnvInput(deps: EnvCliDeps, file: string): Promise<EnvPlainValue[]> {
  const text = await readInput(resolveFromCwd(deps, file), file);
  const read = parseDotenv(text);
  if (!read.ok) throw inputProblem(file, read.problem);
  const problem = deps.core.checkValues(read.values);
  if (problem) throw valuesProblem(file, problem);
  return read.values;
}

async function readInput(absolute: string, shown: string): Promise<string> {
  try {
    return await fs.readFile(absolute, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') throw new EnvCliFailure({ code: 'no-input', path: shown });
    throw err;
  }
}

function inputProblem(path: string, problem: DotenvProblem): EnvCliFailure {
  switch (problem.kind) {
    case 'bad-name':
      return new EnvCliFailure({ code: 'bad-name', path, line: problem.line, name: problem.name });
    case 'unclosed-quote':
    case 'after-quote':
      return new EnvCliFailure({ code: 'bad-dotenv', path, line: problem.line, reason: problem.kind });
  }
}

/**
 * The core's verdict on values the parser accepted. Names were checked line by line already, so
 * what is left in practice is the caps; anything else is worded as the core's problem.
 */
function valuesProblem(path: string, problem: EnvFileProblem): EnvCliFailure {
  if (problem.kind === 'too-large' && (problem.limit === 'names' || problem.limit === 'value' || problem.limit === 'values')) {
    return new EnvCliFailure({ code: 'too-large', path, limit: problem.limit, name: problem.name ?? null });
  }
  if (problem.kind === 'bad-name' || problem.kind === 'duplicate-name') return new EnvCliFailure({ code: 'bad-name', path, line: problem.line, name: problem.name });
  return usage(`${path}: ${envFileProblemWords(problem, { file: path, set: path, where: 'computer' }).message}`);
}
