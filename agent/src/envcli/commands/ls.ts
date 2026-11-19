/** `authdeck env ls`: the sets in this repo, as the agent and the person's devices know them. */
import fs from 'node:fs/promises';

import type { EnvListParams, EnvListResult, EnvListRow } from '../../envSocketContract';
import { envFileProblemWords } from '../../envcore/types';
import { waitForAgent, type EnvCliDeps } from '../context';
import { findRepo, listSetNames, setFilePath } from '../git';
import { WAITING } from '../waiting';
import { clockTime, printable, shownPath } from '../words';

const HEADINGS = ['SET', 'VARS', 'MEMBERS', 'YOU', 'ON THIS COMPUTER'] as const;
/** Columns aligned to the right (the numbers). */
const RIGHT_ALIGNED = new Set([1, 2]);
const COLUMN_GAP = '  ';

export async function envLs(deps: EnvCliDeps): Promise<number> {
  const repo = await findRepo(deps.cwd);
  const names = await listSetNames(repo.repoRoot);
  if (names.length === 0) {
    deps.stdout.write(`There is no env set in ${repo.repoRoot}. Run authdeck env init to make one.\n`);
    return 0;
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const path = setFilePath(repo.repoRoot, name);
      return { path, file: await fs.readFile(path, 'utf8') };
    }),
  );
  const params: EnvListParams = { repoRoot: repo.repoRoot, remote: repo.remote, files };
  const result = await waitForAgent(deps, 'ls', params, { wording: WAITING.release, stream: deps.stderr });
  deps.stdout.write(lsTable(result, repo.repoRoot));
  return 0;
}

/** The table and the join requests line, as the design prints them. */
export function lsTable(result: EnvListResult, repoRoot: string): string {
  const rows = result.sets.map((row) => [printable(row.name), String(row.variables), String(row.members), row.yourRole ?? '-', onThisComputer(row, repoRoot)]);
  const widths = HEADINGS.map((heading, column) => Math.max(heading.length, ...rows.map((row) => row[column]!.length)));
  const format = (cells: readonly string[]) =>
    cells
      .map((cell, column) => (RIGHT_ALIGNED.has(column) ? cell.padStart(widths[column]!) : column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join(COLUMN_GAP)
      .trimEnd();
  const lines = [format(HEADINGS), ...rows.map(format)];
  const requests = joinRequestsLine(result.joinRequests);
  if (requests) lines.push(requests);
  return `${lines.join('\n')}\n`;
}

function onThisComputer(row: EnvListRow, repoRoot: string): string {
  if (row.problem) {
    const words = envFileProblemWords(row.problem, { file: shownPath(repoRoot, row.path), set: row.name, where: 'computer' });
    return `refused: ${words.title}`;
  }
  if (row.yourRole === null) return 'not a member';
  return row.grantEndsAt === null ? 'asks each time' : `allowed until ${clockTime(row.grantEndsAt)}`;
}

/** "1 join request waiting: Chen Wei (iPhone 16) for acme-api". */
function joinRequestsLine(requests: EnvListResult['joinRequests']): string | null {
  if (requests.length === 0) return null;
  const who = requests.map(({ label, setName }) => `${personAndDevice(label)} for ${printable(setName)}`).join(', ');
  return `${requests.length} join request${requests.length === 1 ? '' : 's'} waiting: ${who}`;
}

/** "Chen Wei · iPhone 16" → "Chen Wei (iPhone 16)". */
function personAndDevice(label: string): string {
  const [person, device] = printable(label).split(' · ');
  return device ? `${person} (${device})` : person!;
}
