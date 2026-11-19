/**
 * A floor from git history, for a device that has no trust in a set yet (a first adoption, or a
 * take-over on a restored phone). Trust on first use would take a file as it is, so a repo writer
 * could swap a deleted variable's tombstone back for its older value line. The history of the
 * file in git holds the tombstone, signed, and the floor carries it forward.
 *
 * Every history version that verifies on its own and names the same set counts. A set id is the
 * hash of its birth certificate, so only the set's own owners (and its recovery identity) can make
 * a version that verifies under it: a forged version is simply left out, and versions git never
 * held (headers changed twice between commits) are not needed. A version whose authority went
 * another way than the file's (a take-over signed with a recovery phrase the owner had already
 * replaced, or a recovery change signed by an owner device a take-over retired) doesn't count
 * either; it is a fork, recorded in the floor, and refuses the file: only someone holding one of
 * the set's keys can make one, and no rule can say which side is the owner's.
 */
import { compareEnvHeaders, envAuthorityEpoch, envAuthorityFork, type EnvAuthorityFork } from './authority';
import { EnvFileRefused } from './errors';
import { parseEnvFile, type EnvParsedFile } from './format';
import type { EnvFileProblem, EnvHeader } from './types';
import { verifyEnvText } from './verify';

/** One version of the set file from git. */
export interface EnvHistoryFile {
  commit: string;
  text: string;
}

export interface EnvHistoryFloor {
  /** Per name, the highest version any counted history file holds, tombstones included. */
  versions: Record<string, number>;
  /** The authority epoch of `header`. */
  authority: number;
  /** The rev of `header`. */
  rev: number;
  /** The newest header, by (authority epoch, rev), among the counted files and the file's own. */
  header: EnvHeader;
  /** The commits that counted, in the order given. */
  commits: string[];
  /**
   * Versions that verify under the set id on another line of authority than the file's: each
   * distinct fork once (by its first diverging change), with the first commit that showed it.
   * Any fork refuses the file (checkEnvFloor, `authority-fork`).
   */
  forks: (EnvAuthorityFork & { commit: string })[];
}

function parsedFrom(file: EnvParsedFile | string): EnvParsedFile {
  if (typeof file !== 'string') return file;
  const result = parseEnvFile(file);
  if (!result.ok) throw new EnvFileRefused(result.problem);
  return result.parsed;
}

/** A floor built one history file at a time, holding only the floor itself (per name, one version). */
export interface EnvFloorBuilder {
  /** Counts one history file, or leaves it out (see envHistoryFloor for which files and lines count). */
  add(entry: EnvHistoryFile): void;
  /** The floor of everything added so far; a fresh object each call. */
  floor(): EnvHistoryFloor;
}

/**
 * The incremental form of envHistoryFloor, for history read page by page: add each file in any
 * order, then read floor(). Throws EnvFileRefused when `file` itself doesn't parse.
 */
export function createEnvFloorBuilder(file: EnvParsedFile | string): EnvFloorBuilder {
  const own = parsedFrom(file).file.header;
  const members = new Set(own.members.map((member) => member.id));
  const versions = new Map<string, number>();
  const commits: string[] = [];
  const forks = new Map<string, EnvAuthorityFork & { commit: string }>();
  let newest = own;
  return {
    add(entry) {
      const result = verifyEnvText(entry.text, null, { allowOldEpoch: true });
      if (!result.ok) return;
      const { header, values } = result.set.file;
      if (header.set !== own.set) return;
      const fork = envAuthorityFork(own, header);
      if (fork) {
        const key = `${fork.change}/${fork.ours}/${fork.theirs}`;
        if (!forks.has(key)) forks.set(key, { ...fork, commit: entry.commit });
        return;
      }
      commits.push(entry.commit);
      if (compareEnvHeaders(header, newest) > 0) newest = header;
      for (const line of values) {
        if (!members.has(line.author) || (!line.box && header.epoch < own.epoch)) continue;
        versions.set(line.name, Math.max(versions.get(line.name) ?? 0, line.version));
      }
    },
    floor() {
      // fromEntries defines own properties, so a name like __proto__ stays an ordinary key.
      return { versions: Object.fromEntries(versions), authority: envAuthorityEpoch(newest), rev: newest.rev, header: newest, commits: [...commits], forks: [...forks.values()] };
    },
  };
}

/**
 * The floor `history` sets for `file`: from every history file that passes its own checks (old-key
 * lines allowed) and names the same set on the same line of authority, the highest version per
 * name and the newest header. Lines by authors who aren't members of the file's header don't count
 * (a merge drops a removed member's edit), nor do deletions from a file at a lower key epoch than
 * this one (a deletion made while the owner re-keyed is lost by design; one made before is kept by
 * the re-key and counted from the newer file). Files on another line of authority are listed in
 * `forks`. Throws EnvFileRefused when `file` itself doesn't parse.
 */
export function envHistoryFloor(file: EnvParsedFile | string, history: readonly EnvHistoryFile[]): EnvHistoryFloor {
  const builder = createEnvFloorBuilder(file);
  for (const entry of history) builder.add(entry);
  return builder.floor();
}

/**
 * Refuses a file whose history holds another line of authority (`authority-fork`, the first one
 * found), or below its history floor: a header older than the floor's by (authority epoch,
 * rev) is `older-header`;
 * a name below its floor version is `older-value` at its line, and a floor name missing from the
 * file is `older-value` with found 0 at the header line. Null when the file is at or above the floor.
 */
export function checkEnvFloor(file: EnvParsedFile | string, floor: EnvHistoryFloor): EnvFileProblem | null {
  let parsed: EnvParsedFile;
  try {
    parsed = parsedFrom(file);
  } catch (err) {
    if (err instanceof EnvFileRefused) return err.problem;
    throw err;
  }
  const { header, values } = parsed.file;
  const [fork] = floor.forks;
  if (fork) return { kind: 'authority-fork', change: fork.change, ours: fork.ours, theirs: fork.theirs };
  if (compareEnvHeaders(header, floor.header) < 0) return { kind: 'older-header', seen: floor.rev, found: header.rev };
  const lines = new Map(values.map((line, index) => [line.name, { version: line.version, n: parsed.valueLines[index]! }]));
  for (const [name, seen] of Object.entries(floor.versions)) {
    const found = lines.get(name);
    if (!found) return { kind: 'older-value', line: parsed.headerLine, name, seen, found: 0 };
    if (found.version < seen) return { kind: 'older-value', line: found.n, name, seen, found: found.version };
  }
  return null;
}
