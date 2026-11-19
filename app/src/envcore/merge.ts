/**
 * The git merge driver's decision (`authdeck env merge %O %A %B`). Pure: the CLI reads the three
 * files, calls mergeEnvFiles, and writes `merged.file` over %A (exit 0) or leaves the conflict
 * (exit 1) for `two-headers` and `refused`.
 */
import { compareBytes } from './bytesOrder';
import { EnvFileRefused } from './errors';
import { writeEnvFile } from './format';
import { envValueLineHash } from './signing';
import type { EnvMergeOutcome, EnvSetFile, EnvValueLine } from './types';
import { compareEnvHeaders, envAuthorityEpoch, envAuthorityFork } from './authority';
import { verifyEnvText, type EnvTrust } from './verify';

/** The three versions git hands the driver. `base` is null when the file didn't exist in the merge base; settleEnvHeaders uses it. */
export interface EnvMergeInput {
  base: string | null;
  ours: string;
  theirs: string;
  /** This computer's trust in the set, when it has one: each side is checked against it. */
  trust: EnvTrust | null;
}

/**
 * Merges two sides of one set file.
 * - Each side must pass verifyEnvFile (against `trust`) and name the same set, else `refused` with
 *   its problem (ours checked first; another set id is `header-chain`). `base` is not read:
 *   tombstones carry deletions, so the two sides decide everything.
 * - Headers: identical, or one is newer by (authority epoch, rev) and its authority continues the
 *   other's (at the same authority epoch, its key epoch didn't go back), and that header is kept.
 *   Two different headers at one (authority epoch, rev) under one authority give `two-headers`;
 *   two authorities that went separate ways are `refused` with `authority-fork`; a key epoch that
 *   went back under one authority is `header-chain`.
 * - Values, per name: the higher version wins; at equal versions the later `time`, then the lower
 *   envValueLineHash (byte order). Tombstones take part like any line. Names keep ours's order,
 *   with theirs's new names after, in theirs's order.
 * - A line under an older epoch than the kept header (a member's edit made while the owner
 *   re-keyed) stays when it wins its name: the merge succeeds, readers then refuse the file with
 *   `wrong-epoch` until the owner's rekeyEnvSet boxes it again. So `wrong-epoch` is the one
 *   problem a side may have here; any other is `refused`. A tombstone from the side with the older
 *   epoch is dropped instead, as the re-key dropped its own.
 * - The merged text is writeEnvFile of the result.
 * Never throws.
 */
export function mergeEnvFiles(input: EnvMergeInput): EnvMergeOutcome {
  const options = { allowOldEpoch: true };
  const ours = verifyEnvText(input.ours, input.trust, options);
  if (!ours.ok) return { kind: 'refused', problem: ours.problem };
  const theirs = verifyEnvText(input.theirs, input.trust, options);
  if (!theirs.ok) return { kind: 'refused', problem: theirs.problem };
  const a = ours.set.file.header;
  const b = theirs.set.file.header;
  if (a.set !== b.set) return { kind: 'refused', problem: { kind: 'header-chain', rev: b.rev } };
  let header = a;
  if (ours.set.headerHash !== theirs.set.headerHash) {
    const order = compareEnvHeaders(a, b);
    const [lower, higher] = order < 0 ? [a, b] : [b, a];
    const fork = envAuthorityFork(a, b);
    if (fork) return { kind: 'refused', problem: { kind: 'authority-fork', ...fork } };
    if (order === 0) return { kind: 'two-headers', rev: a.rev };
    const sameAuthority = envAuthorityEpoch(lower) === envAuthorityEpoch(higher);
    if (sameAuthority && higher.epoch < lower.epoch) return { kind: 'refused', problem: { kind: 'header-chain', rev: higher.rev } };
    header = higher;
  }
  const members = new Set(header.members.map((member) => member.id));
  const values = mergeValueLines(ours.set.file, theirs.set.file, { keptEpoch: header.epoch, members });
  try {
    return { kind: 'merged', file: writeEnvFile({ header, values }) };
  } catch (err) {
    if (err instanceof EnvFileRefused) return { kind: 'refused', problem: err.problem };
    throw err;
  }
}

/** A line and the epoch its signature is bound to (its box's, or for a tombstone its file's header). */
interface Candidate {
  line: EnvValueLine;
  epoch: number;
  set: string;
}

/**
 * Per name, the winning line of two files: the higher version, then the later time, then the lower
 * envValueLineHash. Lines by authors outside `members` don't take part (a removed member's edit),
 * nor do tombstones bound to an epoch below `keptEpoch` (a re-key dropped its own; pass 0 to keep
 * them all). Names keep ours's order, then theirs's new names in theirs's order.
 */
export function mergeValueLines(ours: EnvSetFile, theirs: EnvSetFile, rules: { keptEpoch: number; members: ReadonlySet<string> }): EnvValueLine[] {
  const winners = new Map<string, Candidate>();
  for (const file of [ours, theirs]) {
    for (const line of file.values) {
      const candidate = { line, epoch: line.box?.epoch ?? file.header.epoch, set: file.header.set };
      if (!rules.members.has(line.author)) continue;
      if (!line.box && candidate.epoch < rules.keptEpoch) continue;
      const current = winners.get(line.name);
      if (!current || beats(candidate, current)) winners.set(line.name, candidate);
    }
  }
  return [...winners.values()].map((winner) => winner.line);
}

function beats(a: Candidate, b: Candidate): boolean {
  if (a.line.version !== b.line.version) return a.line.version > b.line.version;
  if (a.line.time !== b.line.time) return a.line.time > b.line.time;
  return compareBytes(envValueLineHash(a.line, a), envValueLineHash(b.line, b)) < 0;
}
