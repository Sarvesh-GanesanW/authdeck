/**
 * Env sets: the file model every reader shares (design: docs/env.md).
 *
 * One set is one file, `.authdeck/<set>.env`, committed to the project's git repo. Names are in
 * clear; each value is AES-256-GCM under a subkey of the set's data key; the data key is sealed
 * once to each member device and once to the owner's recovery identity; the header (the member
 * list) is signed by the owner and every value line by the member who wrote it. The repo is
 * untrusted: a file that fails any check below is refused whole, never partly used.
 *
 * Shared, byte for byte, by the agent and the CLI (agent/src/envcore) and the app
 * (app/src/envcore): `node scripts/check-protocol.mjs` compares them. Types and fixed words only;
 * parsing, signing, sealing and merging live beside this file (slice A).
 */
import type { Box, SealedKey } from '../vault/crypto';

/** The file format this AuthDeck reads and writes. A newer one is refused (`newer-format`). */
export const ENV_FORMAT = 1;

/** Where sets live in a working tree: `.authdeck/<set>.env`. */
export const ENV_FOLDER = '.authdeck';
export const ENV_FILE_EXTENSION = '.env';
/** Teammates' join requests: `.authdeck/requests/<member id>.json`, each an EnvJoinRequestFile. */
export const ENV_REQUESTS_FOLDER = '.authdeck/requests';

/**
 * Git merges set files with AuthDeck's merge driver. `init` adds the attributes line to the repo's
 * .gitattributes (committed) and the driver to the clone's .git/config (which git never commits,
 * so every clone's `init` sets it again). eol=lf keeps Windows checkouts byte-identical, which
 * signatures need.
 */
export const ENV_MERGE_DRIVER = 'authdeck-env';
export const ENV_GITATTRIBUTES_LINE = `.authdeck/*.env text eol=lf merge=${ENV_MERGE_DRIVER}`;
export const ENV_MERGE_DRIVER_COMMAND = 'authdeck env merge %O %A %B';

/**
 * Caps every reader enforces. `names`, `valueBytes` and `members` are the design's; `valueTotalBytes`
 * and `fileBytes` keep a file, and a push carrying its new values, inside one 1 MiB link message.
 * Sizes are UTF-8 bytes of plain values, and bytes of the file as written.
 */
export const ENV_LIMITS = {
  names: 500,
  valueBytes: 32 * 1024,
  valueTotalBytes: 128 * 1024,
  members: 64,
  fileBytes: 384 * 1024,
  /** Characters. */
  nameLength: 128,
  setNameLength: 64,
  memberLabelLength: 64,
} as const;

export type EnvLimit = 'names' | 'value' | 'values' | 'members' | 'file';

/**
 * Variable names: letters, digits and `_`, not starting with a digit (what shells and dotenv
 * loaders accept). Lower case is allowed so existing .env files import as they are.
 */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Set names double as file names: lower-case letters, digits, `.`, `_` and `-`, starting with a letter or digit. */
export const ENV_SET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Set ids and member ids: 16 bytes in base64url, like vault and device ids (vault/entry.ts isId). */
export type EnvSetId = string;
/** A member device's id: deviceIdFor(its Ed25519 public key), as for vault devices. */
export type EnvMemberId = string;

/** The owner signs the member list; members read and change variables. One owner device per set. */
export type EnvRole = 'owner' | 'member';

/** One device in the member list. Byte fields are unpadded base64url. */
export interface EnvMember {
  id: EnvMemberId;
  role: EnvRole;
  /** "Maya Rao · Pixel 8": the person and the device, cleaned like join names (vault/approval.ts cleanJoinName). */
  label: string;
  /** For the phone and tablet icons; null when the device didn't say. */
  form: 'phone' | 'tablet' | null;
  /** Ed25519 public key: checks the lines this member signs. */
  ed: string;
  /** ristretto255 sealing public key: what the data key is sealed to. */
  x: string;
  /** The data key of the header's epoch, sealed to `x` with vault/crypto sealKey (SealContext: vault = set id, epoch, to = member id). */
  key: SealedKey;
  /** When the owner added this member, by the owner's clock (ms). */
  since: number;
}

/**
 * The owner's recovery identity for this set: the owner's vault recovery identity. It holds a
 * sealed data key, so a new phone restored from the phrase can read the set, and it may sign one
 * kind of authority change: the take-over that makes that new phone the owner. It is always the
 * recovery identity the set's authority names (EnvAuthority).
 */
export interface EnvRecovery {
  id: string;
  ed: string;
  x: string;
  key: SealedKey;
}

/** A device's two public keys, unpadded base64url: Ed25519 `ed` and ristretto255 sealing `x`. */
export interface EnvPublicKeys {
  ed: string;
  x: string;
}

/**
 * A set's birth certificate. Nothing in it can change, and the set id is its hash
 * (authority.ts envSetIdOf), so whoever names a set id must hold the owner key that signed it.
 */
export interface EnvBirth {
  /** The first owner device. */
  owner: EnvPublicKeys;
  /** The recovery identity that may take the set over; null for an owner with no recovery phrase. */
  recovery: EnvPublicKeys | null;
  /** When the set was made, by the owner's clock (ms). */
  time: number;
  /** 16 random bytes, base64url: two sets made by one owner in the same millisecond still differ. */
  nonce: string;
  /** The first owner's signature (domain `authdeck/env/birth/v1`). */
  sig: string;
}

/**
 * One change of who holds a set, after its birth:
 * - `takeover`: the recovery identity of the authority before makes a new device the owner;
 * - `recovery`: the owner names a new recovery identity (or none), so an old phrase loses its power.
 */
export interface EnvAuthorityChange {
  kind: 'takeover' | 'recovery';
  /** 1 for the first change, then 2, 3, … */
  n: number;
  /** Hash of the certificate before (the birth's for n = 1): base64url SHA-256. */
  prev: string;
  /** The owner from here on (a take-over's new owner; for a recovery change, the same owner). */
  owner: EnvPublicKeys;
  /** The recovery identity from here on. */
  recovery: EnvPublicKeys | null;
  time: number;
  /** A take-over by the previous recovery identity, a recovery change by the previous owner. */
  sig: string;
}

/**
 * Who may sign the set's headers: the birth, then every change in order. Every header carries it
 * whole, so each file proves its own authority without any other version of the file.
 */
export interface EnvAuthority {
  birth: EnvBirth;
  changes: EnvAuthorityChange[];
}

/**
 * The header: who is in the set. Every change to it adds 1 to `rev`; a change that removes someone
 * also adds 1 to `epoch` (a new data key, every value encrypted again). Headers are ordered by
 * (authority epoch, rev), the authority epoch being `authority.changes.length`: a header of an
 * owner that was taken over from never counts as newer than the take-over.
 */
export interface EnvHeader {
  format: typeof ENV_FORMAT;
  /** envSetIdOf(authority.birth). */
  set: EnvSetId;
  /** Matches the file name: `.authdeck/<name>.env`. */
  name: string;
  rev: number;
  epoch: number;
  authority: EnvAuthority;
  /** Ordered as written; exactly one has role 'owner', the device the authority names last. */
  members: EnvMember[];
  /** The authority's current recovery identity with its wrap; null exactly when that is null. */
  recovery: EnvRecovery | null;
  /** When the header was signed, by the signer's clock (ms). */
  time: number;
  /** The owner's member id: only the owner signs headers. */
  signer: string;
  sig: string;
}

/** One variable as the file holds it. Deletions stay as tombstones, so a merge can't bring an older value back. */
export interface EnvValueLine {
  name: string;
  /** Starts at 1; each change adds 1. A merge keeps the higher version (EnvMergeOutcome). */
  version: number;
  /** The member who signed this line. */
  author: EnvMemberId;
  /** By the author's clock (ms). */
  time: number;
  /**
   * The value under the data key of `box.epoch`, which must be the header's epoch. Its context
   * binds the set id, the epoch, the name and the version, so a value can't be moved to another
   * name, set or version. Null for a deleted variable.
   */
  box: Box | null;
  /** The author's signature over the set id, epoch, name, version, ciphertext, author and time. */
  sig: string;
}

/** A parsed and checked set file. */
export interface EnvSetFile {
  header: EnvHeader;
  /** In file order, tombstones included. */
  values: EnvValueLine[];
}

/** A variable in plain text: what a release delivers, `push` and `init` send, and `pull` writes. */
export interface EnvPlainValue {
  name: string;
  value: string;
}

/**
 * Values sealed for one recipient: a fresh transfer key sealed to the recipient's sealing key
 * (the CLI's one-time key, or the agent's grant key) and a box under that key holding the UTF-8
 * JSON of EnvPlainValue[] in file order.
 */
export interface EnvSealedValues {
  key: SealedKey;
  box: Box;
}

/**
 * What every phone, tablet and computer remembers per set, to refuse a rollback: the highest
 * header it accepted and the highest version of each name (tombstones included). Anything lower
 * is refused (`older-header`, `older-value`).
 */
export interface EnvAcceptedHead {
  set: EnvSetId;
  rev: number;
  epoch: number;
  /** The accepted header's authority epoch (authority.changes.length): the first half of its order. */
  authority: number;
  /** Hash of the accepted header at `rev`. */
  headerHash: string;
  versions: Record<string, number>;
}

/**
 * A teammate's request to join, committed as `.authdeck/requests/<member>.json`. The device signs
 * it with its own key (proof it holds the key); the owner approves only after the person reads
 * the six key words their phone shows, which come from `ed` and `x` (66 bits).
 */
export interface EnvJoinRequestFile {
  format: typeof ENV_FORMAT;
  set: EnvSetId;
  member: EnvMemberId;
  label: string;
  form: 'phone' | 'tablet' | null;
  ed: string;
  x: string;
  time: number;
  sig: string;
}

/** Words a teammate reads out when asking to join: six BIP-39 words. */
export const ENV_KEY_WORD_COUNT = 6;

/** What the merge driver decides for three versions of one set file. */
export type EnvMergeOutcome =
  /** Per name, the higher version wins; at equal versions the later signed time, then the lower line hash. */
  | { kind: 'merged'; file: string }
  /** Two different headers at one rev: the merge stops and the owner's phone settles it with a new key. */
  | { kind: 'two-headers'; rev: number }
  /** A side failed its checks: the merge stops and git keeps the conflict. */
  | { kind: 'refused'; problem: EnvFileProblem };

// ---------------------------------------------------------------------------
// Why a file is refused, and the words for it
// ---------------------------------------------------------------------------

/**
 * Every reason a reader refuses a set file. `line` is 1-based. A refused file releases nothing
 * and accepts no change until it is fixed; on the computer it ends the command with exit 65.
 */
export type EnvFileProblem =
  /** A line that is not a comment, the header or a value line. `detail` says what is wrong, in a few words. */
  | { kind: 'unreadable'; line: number; detail: string }
  /** Git left `<<<<<<<` in it: the clone has no merge driver yet. */
  | { kind: 'conflict-markers'; line: number }
  | { kind: 'newer-format'; format: number }
  | { kind: 'too-large'; limit: EnvLimit; name?: string }
  | { kind: 'bad-name'; line: number; name: string }
  | { kind: 'duplicate-name'; line: number; name: string }
  /** The member list isn't signed by the set's owner, or its authority doesn't prove the set id. */
  | { kind: 'header-unsigned' }
  /** The member list at `rev` doesn't follow the one this device accepted. */
  | { kind: 'header-chain'; rev: number }
  /** Rollback: a member list older than the one this device accepted. */
  | { kind: 'older-header'; seen: number; found: number }
  /**
   * Two lines of ownership: an authority that went another way than this file's (or than the one
   * this device accepted), at change `change`, with each side's kind of change there. Made only
   * with a key the set retired, so one of its keys is in someone else's hands; no side is taken.
   */
  | { kind: 'authority-fork'; change: number; ours: 'takeover' | 'recovery'; theirs: 'takeover' | 'recovery' }
  /** A value line whose signature is missing or doesn't check. */
  | { kind: 'unsigned-line'; line: number; name: string }
  /** A value line signed by a device that isn't in the member list. `author` is the id it names. */
  | { kind: 'not-a-member'; line: number; name: string; author: string }
  /** Rollback: a variable at a lower version than this device accepted. */
  | { kind: 'older-value'; line: number; name: string; seen: number; found: number }
  /** A value still under an earlier data key, which a removed member could read. */
  | { kind: 'wrong-epoch'; line: number; name: string; epoch: number; current: number };

/** Where a problem is being told. */
export interface EnvProblemContext {
  /** The file as the person knows it: ".authdeck/acme-api.env". */
  file: string;
  /** The set's name. */
  set: string;
  /** Short hash of the commit that brought the line in (git blame), when known. */
  commit?: string;
  /** The device saying it: the CLI on a computer, or a phone or tablet. */
  where: 'computer' | 'phone';
}

/** A problem in words: a short title (phone banners), the full sentence, and what to do. */
export interface EnvWords {
  title: string;
  message: string;
  hint: string;
}

/** The one home for how a refused file is described, on the computer and on the phone. */
export function envFileProblemWords(problem: EnvFileProblem, context: EnvProblemContext): EnvWords {
  const { file, set, commit, where } = context;
  const self = where === 'phone' ? 'this device' : 'this computer';
  const cameIn = commit ? ` It came in with commit ${commit}.` : '';
  const undo = commit ? 'Revert that commit' : 'Undo the change to that line';
  const setAgain = (name: string) => `set ${name} again ${where === 'phone' ? 'here' : "from a member's phone"}`;
  switch (problem.kind) {
    case 'unreadable':
      return {
        title: "The file can't be read",
        message: `${file} line ${problem.line} isn't a line AuthDeck writes (${problem.detail}).${cameIn}`,
        hint: `${undo}.`,
      };
    case 'conflict-markers':
      return {
        title: 'A merge was left unfinished',
        message: `${file} line ${problem.line} has git conflict markers.`,
        hint: 'Run authdeck env init in this clone once to set up the merge driver, then redo the merge.',
      };
    case 'newer-format':
      return {
        title: 'Written by a newer AuthDeck',
        message: `${file} uses format ${problem.format}; this AuthDeck reads format ${ENV_FORMAT}.`,
        hint: 'Update AuthDeck.',
      };
    case 'too-large':
      return { title: 'The set is too large', message: tooLargeMessage(problem.limit, file, problem.name), hint: `${undo}.` };
    case 'bad-name':
      return {
        title: "A variable name isn't allowed",
        message: `${file} line ${problem.line}: ${problem.name} can't be a variable name.${cameIn}`,
        hint: "Names take letters, digits and _, and don't start with a digit.",
      };
    case 'duplicate-name':
      return { title: 'A variable appears twice', message: `${file} lists ${problem.name} twice (line ${problem.line}).${cameIn}`, hint: `${undo}.` };
    case 'header-unsigned':
      return {
        title: "The member list isn't signed",
        message: `The member list in ${file} isn't signed by the owner of ${set}.${cameIn}`,
        hint: `${commit ? 'Revert that commit' : 'Check out the file from the last commit that worked'}. Only the owner can change who is in a set.`,
      };
    case 'header-chain':
      return {
        title: 'The member list was replaced',
        message: `The member list in ${file} (rev ${problem.rev}) doesn't follow the one ${self} accepted.${cameIn}`,
        hint: `Go back to the last commit that worked, then open ${set} on the owner's phone to settle the member list.`,
      };
    case 'older-header':
      return {
        title: 'An older member list',
        message: `${file} is at member list rev ${problem.found}; ${self} has seen rev ${problem.seen}.`,
        hint: 'Pull the latest commit, then try again.',
      };
    case 'authority-fork':
      return {
        title: 'Two lines of ownership',
        message: `${file} has two competing lines of ownership in its git history (change ${problem.change}: ${changeWords(problem.ours)} on one, ${changeWords(problem.theirs)} on the other), so one of its keys is in someone else's hands. AuthDeck won't take either.`,
        hint: `Make a new set and rotate every value that was in ${set}.`,
      };
    case 'unsigned-line':
      return {
        title: "A line isn't signed by a member",
        message: `${file} line ${problem.line} (${problem.name}) isn't signed by a member of ${set}.${cameIn}`,
        hint: `${undo}, or ${setAgain(problem.name)}.`,
      };
    case 'not-a-member':
      return {
        title: 'A line is signed by someone outside the set',
        message: `${file} line ${problem.line} (${problem.name}) is signed by ${problem.author}, who isn't a member of ${set}.${cameIn}`,
        hint: `${undo}, or ${setAgain(problem.name)}.`,
      };
    case 'older-value':
      return {
        title: 'A variable went back to an older version',
        message: `${file} line ${problem.line} has ${problem.name} at version ${problem.found}; ${self} has seen version ${problem.seen}.${cameIn}`,
        hint: `Pull the latest commit, or ${setAgain(problem.name)}.`,
      };
    case 'wrong-epoch':
      return {
        title: 'A variable uses an old key',
        message: `${file} line ${problem.line} (${problem.name}) is encrypted with key ${problem.epoch}, not the set's current key ${problem.current}.${cameIn}`,
        hint: `Open ${set} on the owner's phone; it encrypts the line again with the current key.`,
      };
  }
}

function changeWords(kind: 'takeover' | 'recovery'): string {
  return kind === 'takeover' ? 'a take-over by the recovery phrase' : 'a new recovery phrase set by the owner';
}

function tooLargeMessage(limit: EnvLimit, file: string, name: string | undefined): string {
  switch (limit) {
    case 'names':
      return `${file} holds more than ${ENV_LIMITS.names} variable names, counting deleted ones (kept so a deleted value can't come back). Make a new set and move the values there.`;
    case 'value':
      return `${name ?? 'A value'} in ${file} is larger than ${ENV_LIMITS.valueBytes / 1024} KB.`;
    case 'values':
      return `The values in ${file} add up to more than ${ENV_LIMITS.valueTotalBytes / 1024} KB.`;
    case 'members':
      return `${file} lists more than ${ENV_LIMITS.members} members.`;
    case 'file':
      return `${file} is larger than ${ENV_LIMITS.fileBytes / 1024} KB.`;
  }
}
