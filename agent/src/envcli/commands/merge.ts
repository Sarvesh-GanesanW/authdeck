/**
 * `authdeck env merge %O %A %B`: git's merge driver for set files. Writes the merged file over
 * %A and exits 0, or leaves %A alone and exits 1 so git keeps the conflict.
 */
import fs from 'node:fs/promises';

import { envFileProblemWords } from '../../envcore/types';
import type { EnvCliDeps } from '../context';

/** What git reads as "merged cleanly" and "conflict". */
export const MERGE_CLEAN = 0;
export const MERGE_CONFLICT = 1;

export async function envMerge(deps: EnvCliDeps, files: { base: string; ours: string; theirs: string }): Promise<number> {
  const [base, ours, theirs] = await Promise.all([files.base, files.ours, files.theirs].map((file) => fs.readFile(file, 'utf8')));
  // Git hands an empty %O when the merge base had no such file.
  const outcome = deps.core.merge(base === '' ? null : base!, ours!, theirs!);
  switch (outcome.kind) {
    case 'merged':
      await fs.writeFile(files.ours, outcome.file);
      return MERGE_CLEAN;
    case 'two-headers':
      deps.stderr.write(
        `✗ AuthDeck can't merge this set file: both sides changed the member list at rev ${outcome.rev}.\n  Open the set on the owner's phone; it settles the member list with a new key.\n`,
      );
      return MERGE_CONFLICT;
    case 'refused': {
      const words = envFileProblemWords(outcome.problem, { file: 'One side of the merge', set: 'this set', where: 'computer' });
      deps.stderr.write(`✗ AuthDeck can't merge this set file. ${words.message}\n  ${words.hint}\n`);
      return MERGE_CONFLICT;
    }
  }
}
