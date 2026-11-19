/**
 * Checking a whole set file, and remembering what was accepted so a rollback is refused. The repo
 * is untrusted: a file that fails any check is refused whole, with the first problem found.
 *
 * What a device remembers per set is an EnvTrust: the frozen EnvAcceptedHead (rev, epoch, header
 * hash, versions) plus the accepted header itself, whose authority a later header must continue.
 *
 * Nothing here needs another version of the file: each header proves its set id and its signer
 * through its own authority (authority.ts), and headers are ordered by (authority epoch, rev).
 */
import { fromBase64Url } from '../vault/bytes';
import { signatureCheckFor, type SignatureCheck } from '../vault/crypto';
import { compareEnvHeaders, envAuthorityEpoch, envAuthorityFork, envAuthorityHolders, envAuthorityValid, sameEnvKeys } from './authority';
import { EnvFileRefused } from './errors';
import { envFileHash, parseEnvFile, type EnvParsedFile } from './format';
import { envHeaderHash, envHeaderSignatureValid, envValueSignedBytes } from './signing';
import type { EnvAcceptedHead, EnvFileProblem, EnvHeader, EnvMember, EnvSetFile, EnvValueLine } from './types';

/** What a device keeps per set between reads. Store both parts; nextEnvTrust makes the next one. */
export interface EnvTrust {
  head: EnvAcceptedHead;
  /** The header at head.rev; envHeaderHash(header) === head.headerHash. */
  header: EnvHeader;
}

/** A file that passed every check. */
export interface EnvVerifiedSet {
  file: EnvSetFile;
  /** Where each part sat in the text, for messages. */
  parsed: EnvParsedFile;
  /** envFileHash of the text. */
  fileHash: string;
  /** envHeaderHash of file.header. */
  headerHash: string;
  owner: EnvMember;
  /** Lines that aren't deletions, in file order. */
  live: EnvValueLine[];
}

export type EnvVerifyResult = { ok: true; set: EnvVerifiedSet } | { ok: false; problem: EnvFileProblem };

/**
 * Checks a set file's text: everything parseEnvFile checks, then
 * - the header (`header-unsigned`): its authority proves the set id (envAuthorityValid); its one
 *   owner is the device the authority names last, and it signed the header; its recovery identity
 *   is the one the authority names last (null exactly when that is);
 * - against `trust` (none on first sight: the file is taken as it is, trust on first use): another
 *   set is `header-chain`; an authority that went another way than the trusted one is
 *   `authority-fork`; a lower authority epoch, or at the same one a lower rev, is `older-header`; at the
 *   same authority epoch, the same rev must be the same header and the key epoch can't go back
 *   (`header-chain`);
 * - every value line: its author is a member (`not-a-member`), its signature checks
 *   (`unsigned-line`), a box is under the header's epoch (`wrong-epoch`);
 * - versions against trust.head.versions, in any epoch (re-keys keep every name, tombstones
 *   included, at its version): lower is `older-value`, and a remembered name missing from the file
 *   is `older-value` with found 0 at the header line.
 * Never throws.
 */
export function verifyEnvFile(text: string, trust: EnvTrust | null): EnvVerifyResult {
  return verifyEnvText(text, trust, { allowOldEpoch: false });
}

/** A file whose only faults are lines under an older key, and the names of those lines. */
export type EnvRekeyCheck =
  | {
      ok: true;
      set: EnvVerifiedSet;
      oldEpoch: string[];
      /**
       * Every name in `oldEpoch`: anyone removed while those lines were under the old key still
       * holds it and can read them from the repo, so all of them are rotated. Line times are the
       * author's clock and can't narrow this down.
       */
      rotate: string[];
      /** @deprecated The same list as `rotate`, kept under its first name. */
      writtenAfterRemoval: string[];
    }
  | { ok: false; problem: EnvFileProblem };

/**
 * For the owner fixing `wrong-epoch`: accepts a file whose only faults are value lines boxed
 * under an earlier epoch, each signed under that epoch by a member of this header. Everything
 * else is checked as verifyEnvFile checks it (signatures, membership, the header chain against
 * `trust`, rollback). `oldEpoch` lists those names in file order; pass `set.file` to
 * rekeyEnvSet with the keys of those epochs. An old-key line must be above every version `trust`
 * remembers for its name, tombstones included, so a value can't be brought back from history
 * (`older-value`). `_epochStartedAt` is no longer read: a time can't decide what a removed
 * member could read (see `rotate`). Never throws.
 */
export function verifyEnvFileForRekey(text: string, trust: EnvTrust | null, _epochStartedAt?: number): EnvRekeyCheck {
  const result = verifyEnvText(text, trust, { allowOldEpoch: true, oldEpochAboveSeen: true });
  if (!result.ok) return result;
  const { header } = result.set.file;
  const oldEpoch = result.set.live.filter((line) => line.box!.epoch !== header.epoch).map((line) => line.name);
  return { ok: true, set: result.set, oldEpoch, rotate: oldEpoch, writtenAfterRemoval: oldEpoch };
}

export interface EnvVerifyOptions {
  /** Let value lines under an earlier epoch through (signature checked under that epoch). */
  allowOldEpoch: boolean;
  /** Such a line must be above every version remembered for its name, so history can't revive a value. */
  oldEpochAboveSeen?: boolean;
}

/**
 * verifyEnvFile with one option for the merge driver: `allowOldEpoch` lets a value line boxed
 * under an earlier epoch through (its signature is checked under that epoch), since the merge
 * keeps such a line for the owner to re-key. Every other check stands.
 */
export function verifyEnvText(text: string, trust: EnvTrust | null, options: EnvVerifyOptions): EnvVerifyResult {
  const parsed = parseEnvFile(text);
  if (!parsed.ok) return parsed;
  try {
    return { ok: true, set: verifyParsed(parsed.parsed, text, trust, options) };
  } catch (err) {
    if (err instanceof EnvFileRefused) return { ok: false, problem: err.problem };
    throw err;
  }
}

function refuse(problem: EnvFileProblem): never {
  throw new EnvFileRefused(problem);
}

function verifyParsed(parsed: EnvParsedFile, text: string, trust: EnvTrust | null, options: EnvVerifyOptions): EnvVerifiedSet {
  const { file } = parsed;
  const { header } = file;
  if (!headerSignedByItsAuthority(header)) refuse({ kind: 'header-unsigned' });
  const headerHash = envHeaderHash(header);
  if (trust) checkAgainstTrust(header, headerHash, trust);
  checkValueLines(parsed, options.allowOldEpoch);
  if (trust) checkVersions(parsed, trust.head, options.oldEpochAboveSeen);
  const owner = header.members.find((member) => member.role === 'owner')!;
  return { file, parsed, fileHash: envFileHash(text), headerHash, owner, live: file.values.filter((line) => line.box !== null) };
}

/** Its authority proves the set id, names its owner and recovery identity last, and its owner signed it. */
function headerSignedByItsAuthority(header: EnvHeader): boolean {
  if (!envAuthorityValid(header.set, header.authority)) return false;
  const holders = envAuthorityHolders(header.authority);
  const owner = header.members.find((member) => member.role === 'owner')!;
  if (!sameEnvKeys(owner, holders.owner) || !sameEnvKeys(header.recovery, holders.recovery)) return false;
  return header.signer === owner.id && envHeaderSignatureValid(header, fromBase64Url(owner.ed));
}

function checkAgainstTrust(header: EnvHeader, headerHash: string, trust: EnvTrust): void {
  const { head } = trust;
  if (header.set !== head.set) refuse({ kind: 'header-chain', rev: header.rev });
  const fork = envAuthorityFork(trust.header, header);
  if (fork) refuse({ kind: 'authority-fork', ...fork });
  // With no fork, the higher authority continues the lower: a lower one is older.
  if (compareEnvHeaders(header, trust.header) < 0) refuse({ kind: 'older-header', seen: head.rev, found: header.rev });
  if (envAuthorityEpoch(header) > envAuthorityEpoch(trust.header)) return;
  if (header.rev === head.rev && headerHash !== head.headerHash) refuse({ kind: 'header-chain', rev: header.rev });
  if (header.epoch < head.epoch) refuse({ kind: 'header-chain', rev: header.rev });
}

function checkValueLines(parsed: EnvParsedFile, allowOldEpoch: boolean): void {
  const { header, values } = parsed.file;
  const checks = new Map<string, SignatureCheck>();
  const members = new Map(header.members.map((member) => [member.id, member]));
  for (const [index, line] of values.entries()) {
    const n = parsed.valueLines[index]!;
    const author = members.get(line.author);
    if (!author) refuse({ kind: 'not-a-member', line: n, name: line.name, author: line.author });
    const epoch = line.box?.epoch ?? header.epoch;
    let check = checks.get(author.id);
    if (!check) {
      check = signatureCheckFor(fromBase64Url(author.ed));
      checks.set(author.id, check);
    }
    if (epoch > header.epoch || !check(fromBase64Url(line.sig), envValueSignedBytes(line, { set: header.set, epoch }))) {
      refuse({ kind: 'unsigned-line', line: n, name: line.name });
    }
    if (epoch !== header.epoch && !allowOldEpoch) refuse({ kind: 'wrong-epoch', line: n, name: line.name, epoch, current: header.epoch });
  }
}

/**
 * No name goes back a version and none disappears, across epochs (re-keys and deletions keep
 * every name). With `oldEpochAboveSeen`, a line under an earlier epoch must be above what was seen.
 */
function checkVersions(parsed: EnvParsedFile, head: EnvAcceptedHead, oldEpochAboveSeen = false): void {
  const { header } = parsed.file;
  const found = new Map(parsed.file.values.map((line, index) => [line.name, { line, n: parsed.valueLines[index]! }]));
  for (const [name, seen] of Object.entries(head.versions)) {
    const entry = found.get(name);
    if (!entry) refuse({ kind: 'older-value', line: parsed.headerLine, name, seen, found: 0 });
    const { version, box } = entry.line;
    const isOldEpoch = box !== null && box.epoch !== header.epoch;
    if (version < seen || (oldEpochAboveSeen && isOldEpoch && version === seen)) refuse({ kind: 'older-value', line: entry.n, name, seen, found: version });
  }
}

/**
 * The remembered-heads update after accepting `verified`: rev, epoch, authority epoch and header
 * hash from its header; versions the higher of each name's remembered and file version (tombstones included),
 * in every epoch. Throws (plain Error) when `verified` is older than
 * `previous` (by authority epoch, then rev) or for another set: callers only pass a file verifyEnvFile accepted
 * against `previous`.
 */
export function nextEnvTrust(previous: EnvTrust | null, verified: EnvVerifiedSet): EnvTrust {
  const { header, values } = verified.file;
  if (previous && previous.head.set !== header.set) throw new Error('This file is another set than the one remembered.');
  if (previous && compareEnvHeaders(header, previous.header) < 0) throw new Error('This file is older than the one remembered; verify it before accepting it.');
  const versions = new Map<string, number>(Object.entries(previous?.head.versions ?? {}));
  for (const line of values) versions.set(line.name, Math.max(versions.get(line.name) ?? 0, line.version));
  // fromEntries defines own properties, so a name like __proto__ stays an ordinary key.
  const head: EnvAcceptedHead = { set: header.set, rev: header.rev, epoch: header.epoch, authority: envAuthorityEpoch(header), headerHash: verified.headerHash, versions: Object.fromEntries(versions) };
  return { head, header };
}
