import { fromBase64Url, toBase64Url, utf8Encode } from './bytes';
import { parseBody, type ParsedBody } from './bodies';
import { deviceIdFor, sha256Bytes, signatureCheckFor, verifySignature, type SignatureCheck } from './crypto';
import { digestEntry, entryShapeProblem, MAX_IDENTITIES, type EntryDigest, type SignedEntry } from './entry';

/** Raw lines of every `log/<deviceId>.jsonl` file, keyed by the file's device id. */
export type VaultLogs = Record<string, readonly string[]>;

export interface VerifiedEntry {
  entry: SignedEntry;
  hash: string;
  /** The entry's canonical form: what a copy stores, whatever text the log held. */
  text: string;
  /** The body, checked for its kind. */
  body: ParsedBody;
}

/** An entry, or the rest of a file, that failed a check. `seq` is the line number (0-based). */
export interface Rejection {
  deviceId: string;
  seq: number;
  hash?: string;
  kind?: string;
  reason: string;
}

/**
 * How an identity got into the vault, which decides what its first entry must be: the founder
 * starts with `vault.create`, a device with `device.hello`, and a recovery identity writes only
 * `device.add`.
 */
export type IdentityRole = 'founder' | 'device' | 'recovery';

export interface KnownIdentity {
  deviceId: string;
  ed: Uint8Array;
  role: IdentityRole;
}

export interface ChainResult {
  chain: VerifiedEntry[];
  rejection?: Rejection;
}

const VAULT_ID_DOMAIN = utf8Encode('authdeck/vault/v2');
const VAULT_ID_BYTES = 16;

/** The vault id commits to the founder's key, so nobody else can write a `vault.create` for it. */
export function vaultIdFor(founderEd: Uint8Array, salt: Uint8Array): string {
  return toBase64Url(sha256Bytes(VAULT_ID_DOMAIN, founderEd, salt).subarray(0, VAULT_ID_BYTES));
}

function parseLine(line: string | undefined): unknown {
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * The founder: the identity whose file starts with a `vault.create` whose key and salt give this
 * vault id. Only one key can match, so only one identity is ever the founder.
 */
export function findFounder(vaultId: string, logs: VaultLogs): KnownIdentity | null {
  for (const [deviceId, lines] of Object.entries(logs)) {
    const value = parseLine(lines[0]);
    if (entryShapeProblem(value) !== null) continue;
    const entry = value as SignedEntry;
    if (entry.kind !== 'vault.create' || entry.seq !== 0 || entry.author !== deviceId) continue;
    try {
      const ed = fromBase64Url(String(entry.body.ed));
      const salt = fromBase64Url(String(entry.body.salt));
      if (ed.length === 32 && deviceIdFor(ed) === deviceId && vaultIdFor(ed, salt) === vaultId) return { deviceId, ed, role: 'founder' };
    } catch {
      // Not base64url: not a founding entry.
    }
  }
  return null;
}

/**
 * What a recovery identity may write: approvals (restores) and, in a solo vault, the key change
 * that follows a restore and a new phrase (replay.ts refuses the last two in other vaults).
 */
const RECOVERY_KINDS: readonly SignedEntry['kind'][] = ['device.add', 'key.rotate', 'recovery.set'];

/** The first entry an identity of each role must write. */
const FIRST_KINDS: Record<IdentityRole, readonly SignedEntry['kind'][]> = {
  founder: ['vault.create'],
  device: ['device.hello'],
  recovery: RECOVERY_KINDS,
};

function rolePolicyProblem(entry: SignedEntry, role: IdentityRole): string | null {
  if (entry.seq === 0 && !FIRST_KINDS[role].includes(entry.kind)) return `the first entry of ${role === 'founder' ? 'the founder' : role === 'device' ? 'a device' : 'a recovery identity'} must be ${FIRST_KINDS[role].join(' or ')}`;
  if (entry.kind === 'vault.create' && (role !== 'founder' || entry.seq !== 0)) return 'only the founder\'s first entry may be vault.create';
  if (role === 'recovery' && !RECOVERY_KINDS.includes(entry.kind)) return 'a recovery identity may only write device.add, key.rotate or recovery.set';
  return null;
}

/** A line that passed every check of rule 1 but its signature, with what checking that needs. */
interface CheckedLine {
  item: VerifiedEntry;
  digest: EntryDigest;
}

/** Every check of rule 1 on one line except its signature (verifyChain checks signatures). */
function checkLine(vaultId: string, identity: KnownIdentity, seq: number, line: string, before: VerifiedEntry | undefined): CheckedLine | string {
  if (rawLineTooLong(line)) return 'the line is longer than an entry may be';
  const value = parseLine(line);
  if (value === undefined) return 'the line is not valid JSON';
  const problem = entryShapeProblem(value, { skipCanonical: true });
  if (problem) return `the entry is malformed: ${problem}`;
  const entry = value as SignedEntry;
  if (entry.vault !== vaultId) return 'the entry belongs to another vault';
  if (entry.author !== identity.deviceId) return 'the entry is in another device\'s file';
  if (entry.seq !== seq) return `expected seq ${seq} but found ${entry.seq}; entries are missing or out of order`;
  if (entry.prev !== (before ? before.hash : null)) return 'prev does not match the entry before it';
  if (before && entry.time < before.entry.time) return 'its time is earlier than the entry before it';
  const policy = rolePolicyProblem(entry, identity.role);
  if (policy) return policy;
  const parsed = parseBody(entry);
  if (!parsed.ok) return parsed.reason;
  let digest: EntryDigest;
  try {
    digest = digestEntry(entry);
  } catch (err) {
    return `the entry is malformed: ${(err as Error).message}`;
  }
  // The hash and signature cover only the canonical form, so a padded or re-encoded copy of a
  // signed line reads as that entry (normalised on read); sizes, quotas and the copies devices
  // keep count and store the canonical form (canonicalLine), never the text the log held.
  return { item: { entry, hash: digest.hash, body: parsed.body, text: digest.text }, digest };
}

/** The raw per-line cap (the agent's MAX_ENTRY_BYTES): a longer line is never parsed. */
export const MAX_RAW_LINE_BYTES = 128 * 1024;

export function rawLineTooLong(line: string): boolean {
  if (line.length <= MAX_RAW_LINE_BYTES / 3) return false;
  return line.length > MAX_RAW_LINE_BYTES || utf8Encode(line).length > MAX_RAW_LINE_BYTES;
}

/**
 * A log line in its entry's canonical form, or the line as it is when it isn't an entry. The
 * signature and hash cover only the canonical form, so this changes no verdict: copies store it
 * so sizes and comparisons see one text per entry.
 */
export function canonicalLine(line: string): string {
  if (rawLineTooLong(line)) return line;
  const value = parseLine(line);
  if (value === undefined || entryShapeProblem(value, { skipCanonical: true }) !== null) return line;
  try {
    return digestEntry(value as SignedEntry).text;
  } catch {
    return line;
  }
}

/** The signature verdict for an entry, from the cache when one is given. */
function signatureHolds(identity: KnownIdentity, digest: EntryDigest, cache: VerifyCache | undefined): boolean {
  return cache ? cache.signatureValid(identity.ed, digest) : digest.signatureValid((signature, message) => verifySignature(signature, message, identity.ed));
}

/**
 * Rule 1 for one identity's file: every line is its entry's canonical form, seq counts up from 0, every prev is the hash of the entry
 * before it, time never goes backwards, the body fits its kind, the first entry fits the
 * identity's role, and every entry's own signature is valid. A file is trusted up to just before
 * its first bad line; nothing after a bad line counts, even a signed line chaining on it, so a
 * line the identity didn't sign is never applied and every divergence it did sign is provable
 * (forkProofProblem).
 *
 * Each line's signature is checked once per cache: the cache keeps verified prefixes, and the
 * verdict (good or bad) for every hash it judged, so a junk tail costs one check, once. Without
 * a cache, a fresh one still makes the checks of one file share the key's precomputation.
 */
export function verifyChain(vaultId: string, identity: KnownIdentity, lines: readonly string[], cache = new VerifyCache()): ChainResult {
  const chain = cache.prefix(vaultId, identity, lines);
  let rejection: Rejection | undefined;
  const reject = (seq: number, reason: string) => {
    const after = lines.length - seq - 1;
    const rest = after > 0 ? ` (and the ${after} entr${after === 1 ? 'y' : 'ies'} after it)` : '';
    rejection = { deviceId: identity.deviceId, seq, reason: `${reason}${rest}` };
  };
  for (let seq = chain.length; seq < lines.length; seq++) {
    const checked = checkLine(vaultId, identity, seq, lines[seq]!, chain[seq - 1]);
    if (typeof checked === 'string') {
      reject(seq, checked);
      break;
    }
    if (!cache.signatureValid(identity.ed, checked.digest)) {
      reject(seq, 'the signature is not valid');
      break;
    }
    chain.push(checked.item);
  }
  cache.remember(vaultId, identity, lines, chain);
  return rejection ? { chain, rejection } : { chain };
}

/**
 * Signature verdicts kept at most; past this the verdicts are forgotten and checked again. Far
 * above what a vault's own lines need, so only a folder rewritten with junk again and again
 * reaches it.
 */
const MAX_CACHED_VERDICTS = 200_000;
/** Keys kept ready to check (signatureCheckFor); a vault has at most MAX_IDENTITIES identities. */
const MAX_CACHED_KEYS = 4 * MAX_IDENTITIES;

/**
 * What earlier replays already checked, so a replay after an append checks signatures only on
 * new lines:
 * - verified prefixes of each file. A line is reused only when its text is identical and the
 *   vault, the identity's key and its role are the same, so the result never differs from a
 *   fresh check;
 * - the signature verdict, good or bad, per key and entry hash. The hash covers the signature and
 *   everything it signs, so the verdict never differs either. This covers lines the prefixes
 *   don't: the other copies a device replays (its own, the folder's, the merge), a fork proof's
 *   lines, and a bad line at the end of a file.
 */
export class VerifyCache {
  private readonly chains = new Map<string, { lines: readonly string[]; chain: VerifiedEntry[] }>();
  /** The one vault whose prefixes are kept: another vault's replay drops them, so they never pile up. */
  private chainsVault: string | null = null;
  private readonly verdicts = new Map<string, boolean>();
  private readonly keys = new Map<string, SignatureCheck>();
  /** Signatures actually checked (not answered from the cache): a measure of work, for the cost tests. */
  signatureChecks = 0;

  prefix(vaultId: string, identity: KnownIdentity, lines: readonly string[]): VerifiedEntry[] {
    const cached = this.chains.get(cacheKey(vaultId, identity));
    if (!cached) return [];
    let same = 0;
    const limit = Math.min(cached.chain.length, lines.length);
    while (same < limit && cached.lines[same] === lines[same]) same++;
    return cached.chain.slice(0, same);
  }

  remember(vaultId: string, identity: KnownIdentity, lines: readonly string[], chain: VerifiedEntry[]): void {
    if (this.chainsVault !== vaultId) {
      this.chains.clear();
      this.chainsVault = vaultId;
    }
    this.chains.set(cacheKey(vaultId, identity), { lines: lines.slice(0, chain.length), chain: [...chain] });
  }

  /** Whether `edPublic` signed the entry `digest` describes, checked at most once per key and hash. */
  signatureValid(edPublic: Uint8Array, digest: EntryDigest): boolean {
    const keyId = toBase64Url(edPublic);
    const key = `${keyId}/${digest.hash}`;
    const known = this.verdicts.get(key);
    if (known !== undefined) return known;
    const valid = digest.signatureValid(this.checkFor(keyId, edPublic));
    this.signatureChecks++;
    if (this.verdicts.size >= MAX_CACHED_VERDICTS) this.verdicts.clear();
    this.verdicts.set(key, valid);
    return valid;
  }

  private checkFor(keyId: string, edPublic: Uint8Array): SignatureCheck {
    let check = this.keys.get(keyId);
    if (!check) {
      if (this.keys.size >= MAX_CACHED_KEYS) this.keys.clear();
      check = signatureCheckFor(edPublic);
      this.keys.set(keyId, check);
    }
    return check;
  }
}

function cacheKey(vaultId: string, identity: KnownIdentity): string {
  return `${vaultId}/${identity.deviceId}/${identity.role}/${toBase64Url(identity.ed)}`;
}

/**
 * Proof that an identity signed two histories, in one of two kinds:
 * - two different entries at `seq` (both lines at `seq`);
 * - an entry at `seq - 1` and one at `seq` whose `prev` is not that entry's hash (the first line
 *   at `seq - 1`, the second at `seq`): the identity signed a line at `seq` that does not follow
 *   its own line before it, so it signed two histories from `seq` on.
 * Either way `seq` is the forked seq. rollback.ts finds them.
 */
export interface ForkProof {
  deviceId: string;
  seq: number;
  /** Both signed lines. */
  lines: [string, string];
}

/** A line of a proof, parsed: an entry of this vault by the identity, not yet signature-checked. */
function proofEntry(vaultId: string, identity: KnownIdentity, line: unknown): { entry: SignedEntry; digest: EntryDigest } | string {
  const value = typeof line === 'string' ? parseLine(line) : undefined;
  if (value === undefined || entryShapeProblem(value) !== null) return 'a line of the proof is not an entry';
  const entry = value as SignedEntry;
  if (entry.vault !== vaultId || entry.author !== identity.deviceId) return 'a line of the proof is not that device\'s entry';
  try {
    return { entry, digest: digestEntry(entry) };
  } catch {
    return 'a line of the proof is not an entry';
  }
}

/** Which kind of proof the two entries make at `seq`, or the problem when they make none. */
function forkKindProblem(seq: number, first: { entry: SignedEntry; digest: EntryDigest }, second: { entry: SignedEntry; digest: EntryDigest }): string | null {
  if (second.entry.seq !== seq) return 'the second line of the proof is not at the proof\'s seq';
  if (first.entry.seq === seq) return first.digest.hash === second.digest.hash ? 'the two lines are the same entry' : null;
  if (first.entry.seq === seq - 1) return second.entry.prev === first.digest.hash ? 'the second line follows the first, which is no fork' : null;
  return 'the first line of the proof must be at the proof\'s seq or the one before it';
}

/**
 * Checks a fork proof against the identity's key: both lines are well-formed entries of this
 * vault by that identity, they make one of the two kinds of proof (ForkProof) at the proof's
 * seq, and both carry valid signatures. Only the identity can sign, so a valid proof can't be
 * made by anyone else. Returns the problem, or null.
 */
export function forkProofProblem(vaultId: string, identity: KnownIdentity, proof: ForkProof, cache?: VerifyCache): string | null {
  if (proof.deviceId !== identity.deviceId) return 'the proof is about another device';
  if (!Number.isSafeInteger(proof.seq) || proof.seq < 0) return 'the proof has no valid seq';
  if (!Array.isArray(proof.lines) || proof.lines.length !== 2) return 'the proof must hold two lines';
  const first = proofEntry(vaultId, identity, proof.lines[0]);
  if (typeof first === 'string') return first;
  const second = proofEntry(vaultId, identity, proof.lines[1]);
  if (typeof second === 'string') return second;
  const kind = forkKindProblem(proof.seq, first, second);
  if (kind) return kind;
  // The second line first: when a proof is a guess (findForks), it is the one that may be junk.
  if (!signatureHolds(identity, second.digest, cache) || !signatureHolds(identity, first.digest, cache)) return 'a line of the proof is not signed by that device';
  return null;
}

/** The role an identity's own first line claims: a device starts with device.hello, a recovery identity with one of RECOVERY_KINDS. */
export function claimedRole(firstLine: string | undefined): IdentityRole {
  const value = parseLine(firstLine);
  return entryShapeProblem(value) === null && RECOVERY_KINDS.includes((value as SignedEntry).kind) ? 'recovery' : 'device';
}
