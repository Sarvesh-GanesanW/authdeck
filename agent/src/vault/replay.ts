/**
 * The rules (docs/authenticator.md, "Deciding what is real"). The principle: an identity that is
 * cut off, by a removal or by a fork, can never change anything outside a true-symmetric
 * conflict. Its later membership changes are void (marked `voided`, for the app to tell), its
 * account changes rejected (`caught` in a symmetric conflict). Nothing here depends on an entry's
 * `time`, on how senior its author is, or on the order files were read: a membership change is
 * judged by what its author had seen (its causal past), and `time` only orders concurrent
 * account edits.
 *
 * A replay:
 *   1. Finds every identity once: the founder, then each identity a verified entry brings in.
 *   2. Orders all verified entries (order.ts).
 *   3. Layer (a), membership (decideMembership). A removal applies iff it passes its own view,
 *      replayed from its causal past alone (judgeRemoval, after cheap prechecks and with at most
 *      8 failed judgements per author), and its author is not cut off by an applied removal it
 *      hadn't seen unless it is a true-symmetric counter-removal (settleCutOffRemovals: a grounded
 *      labelling of the attacks between removals, monotone, with one least fixed point; mutual
 *      attacks, i.e. true symmetry, all apply; a removal by a device that only a cut-off device's
 *      unseen lines brought in is attacked the same way). A counter-removal survives only when it
 *      targets the remover that cut it, directly or through whom that remover is in.
 *
 *      Judging and settling form one fixed point, defined by causal order (R6-E): a removal r is
 *      judged against the verdicts of the removals in its own past, settled within that past
 *      (settledPast), and each of those was judged the same way on its own, smaller past. The
 *      causal order is well founded (an entry's past holds only entries before it), so judging
 *      in that order gives every removal exactly one verdict, and judging again with those
 *      verdicts changes none: there is a single fixed point, reached in one pass. It is monotone
 *      in the past: adding entries outside r's past cannot change r's verdict. The folder-wide
 *      settle then runs once over all verdicts, as before. Full-check verdicts are cached by
 *      removal hash and fork cuts (they depend on nothing else), and at most 64 failed ones count
 *      in any removal's past.
 *
 *      Fork proofs are cutoffs at max(forkSeq - 1, the highest seq that applied entries by
 *      identities not cut off built on), found as the greatest fixed point from no cut
 *      (forkFixedPoint). A seq that identities still standing at that fixed point (in, the line
 *      within their cutoff, and not in only through the forker's lines from the forked seq) built
 *      on in both versions is contested and cut at forkSeq - 1; one identity naming both never
 *      contests. Contest is judged at the fixed point only, never carried over from an earlier
 *      round (decideWithForks). At the forked seq only the named version is read
 *      (namedForkVersions), counting the names in logs the other version itself brings in.
 *      Per-identity shares hold here too (overShare). Cutoffs
 *      come from applied removals (removalCutoffs): what the removal had seen of its target,
 *      never below what the remover's own remover had seen (rule 1), except in true symmetry
 *      (rule 2: the remover's removal exists only through the target's unseen lines), where
 *      nothing is protected and every side goes. Other membership changes are then checked in
 *      one causal pass (runPass) against their view and their author's standing; concurrent
 *      recovery phrases are ranked and cut until a fixed point, with a fail-safe for a cycle
 *      (decideContext says why it ends with one answer). A device is in only once its own
 *      hello binds its sealing key.
 *   4. Layer (b), keys (keyChain): the chain of key changes that applied, each on the one before
 *      and numbered one past it. Per epoch, a change that saw another at its own epoch replaced
 *      it; of those no other one saw, one is picked (no removed recipient, then a recovery
 *      phrase, then the lower hash). A change that strands a joined device is not on the chain:
 *      it left that device out, and no later approval carrying that key (of that epoch or
 *      newer) reached it.
 *   5. Layer (c): applies every other entry in the total order.
 */
import { fromBase64Url, toBase64Url } from './bytes';
import { MEMBERSHIP_KINDS, type BodyByKind, type DeviceAddBody, type ParsedBody, type Role, type RotationFields, type VaultKind } from './bodies';
import {
  canonicalLine,
  claimedRole,
  findFounder,
  forkProofProblem,
  verifyChain,
  vaultIdFor,
  VerifyCache,
  type ForkProof,
  type KnownIdentity,
  type Rejection,
  type VaultLogs,
  type VerifiedEntry,
} from './chain';
import { deviceIdFor, type Box, type SealedKey } from './crypto';
import { digestEntry, entryHash, entryShapeProblem, isId, isPlainObject, MAX_IDENTITIES, type EntryKind, type SignedEntry } from './entry';
import { follows, orderEntries, type CausalOrder, type Placed, type SeenConflict } from './order';
import { DEFAULT_QUOTA_LIMITS } from './quota';
import { judgeSealProof, type SealProof } from './sealProof';

export interface Member {
  deviceId: string;
  /** base64url public keys. */
  ed: string;
  x: string;
  role: Role;
  name: Box;
  /** Who added it (the founder adds itself). */
  addedBy: string;
  /**
   * True once its own device.hello applied, confirming the sealing key it was approved with
   * (the founder from the start). Only joined devices count as in the vault: new keys reach them,
   * and they can sign changes. An approved device that hasn't joined holds only its approval's key.
   */
  joined: boolean;
  removed: boolean;
  /** Devices whose applied removals took it out; empty when it left by signing two histories. */
  removedBy: string[];
  /** Every applied approval of it, oldest first (the founder: none). A joiner checks these. */
  approvals?: Approval[];
}

/** An applied device.add: who approved, with which keys and role, and the vault key it gave. */
export interface Approval {
  /** The device.add's entry hash: what the device's hello names. */
  hash: string;
  by: string;
  ed: string;
  x: string;
  role: Role;
  epoch: number;
  key: SealedKey;
}

export interface RecoveryIdentity {
  deviceId: string;
  ed: string;
  x: string;
}

/** An account change that passed the rules, in replay order. Opened later with the vault key. */
export type AccountChange =
  | { kind: 'account.put'; account: string; box: Box; author: string; seq: number; time: number; hash: string }
  | { kind: 'account.delete'; account: string; author: string; seq: number; time: number; hash: string };

export interface HistoryItem {
  hash: string;
  author: string;
  seq: number;
  /** The author's own clock: it orders concurrent edits and is shown, never trusted. */
  time: number;
  kind: EntryKind;
  /** The device or account the entry is about, when there is one. */
  subject?: string;
  status: 'applied' | 'rejected' | 'waiting';
  reason?: string;
  /**
   * Set on an account change rejected only because its author was taken out in a symmetric
   * conflict (removed by a device that was itself removed at the same time). The change is kept in
   * the folder; the app offers it back for review, never applies it by itself.
   */
  caught?: true;
  /**
   * Set on a membership change (removal, approval, phrase or key change) voided because its
   * author was cut off by an applied removal it hadn't seen (rule 1): the app tells the user and
   * offers to make it again; nothing is redone by itself.
   */
  voided?: true;
  /**
   * Solo vaults (review P3): an applied account change by a device a restore took out that the
   * app offers back for review ("Bring back"): every delete, and every change among that device's
   * last RESTORE_REVIEW_LINES account lines by seq (never by its clock, which the thief sets). A
   * thief holding the old phone may have made it; it stays applied, and nothing is undone by itself.
   */
  restoreReview?: true;
  /** For a waiting entry that names an entry not in the folder yet: whose, and which seq. */
  waitsFor?: { deviceId: string; seq: number };
}

/** The latest entry of one identity: its seq, hash and claimed time. */
export interface Head {
  seq: number;
  hash: string;
  time: number;
}

/** What every device, and the agent, agrees the vault is. Holds no secrets. */
export interface VaultState {
  vaultId: string;
  /** False when no valid `vault.create` was found. */
  created: boolean;
  kind: VaultKind;
  founder: string;
  name: Box | null;
  /** The current key's epoch: the end of the chain of rotations that each saw the one before. */
  epoch: number;
  members: Record<string, Member>;
  recovery: RecoveryIdentity | null;
  /** Sealed epoch keys: epoch -> recipient device id -> sealed key. */
  sealedKeys: Record<number, Record<string, SealedKey>>;
  /** epoch -> the previous epoch's key encrypted under this epoch's key. */
  prevKeys: Record<number, Box>;
  /** epoch -> the published commitment to that epoch's key. A key that doesn't match is refused. */
  keyChecks: Record<number, string>;
  /**
   * Identities removed (devices), replaced (recovery identities) or that signed two histories:
   * the highest seq of theirs that still counts. Every later entry of theirs is rejected.
   */
  cutoffs: Record<string, number>;
  /** Identities proven to have signed two entries at one seq: the first such seq. */
  forked: Record<string, number>;
  /**
   * True when key changes clashed (made at the same time) or the current key reached a device
   * that is no longer in the vault. Account changes pause until an admin device writes a fresh
   * `key.rotate`; the app does that by itself.
   */
  needsFreshKey: boolean;
  /** Active devices that hold no key for the current epoch: an admin device approves them again. */
  unkeyedDevices: string[];
  /** Accounts that exist after replay, with the box of their latest record. */
  accounts: Record<string, { box: Box; author: string; time: number; hash: string }>;
  accountChanges: AccountChange[];
  /** Every entry that reached the rules, in replay order, plus those still waiting. */
  history: HistoryItem[];
  /** Entries refused by the chain checks or the rules. */
  rejected: Rejection[];
  /** Entries whose `seen` contradicts the folder: evidence that someone signed two histories. */
  conflicts: SeenConflict[];
  /** Applied removals made in true symmetry with a removal of their own author (rule 2). */
  counterRemovals: string[];
  /**
   * Recovery phrases the ranking could not settle and so rejected (fail-safe, normally empty).
   * While a key change made after all of them is missing, the vault needs a fresh key.
   */
  unsettledRecovery: string[];
  /** Verified head per identity: what the rollback check remembers and what an author's next entry chains on. */
  heads: Record<string, Head>;
  /** Latest applied entry per identity: what a new entry names in `seen`. */
  appliedHeads: Record<string, Head>;
  /** Verified hashes per identity, by seq. */
  chains: Record<string, string[]>;
  /**
   * Verified lines the folder holds in another text than their canonical form (re-encoded or
   * padded), by identity and seq, with the canonical text to write in their place. Absent when none.
   */
  reencoded?: Record<string, Record<number, string>>;
  /**
   * What applied lines of other identities name of each identity's log (the highest `seen`):
   * those lines, and through `prev` every line below them, are pinned. A cut identity's pinned
   * lines are the only ones the computer takes back from it (logs.ts, a repair).
   */
  pins?: Record<string, { seq: number; hash: string }>;
}

/** Options for a replay. A cache makes repeated replays of a growing folder cheap. */
export interface ReplayOptions {
  cache?: VerifyCache;
  /** Proofs that an identity signed two entries at one seq (the folder's `forks/`, or found locally). */
  forks?: readonly ForkProof[];
  /** Proofs that a key-bearing entry sealed a key that does not open to a recipient (the folder's `seals/`). */
  sealProofs?: readonly SealProof[];
}

type MembershipKind = 'vault.create' | 'device.add' | 'device.hello' | 'device.remove' | 'recovery.set' | 'key.rotate';

function emptyState(vaultId: string): VaultState {
  return {
    vaultId,
    created: false,
    kind: 'personal',
    founder: '',
    name: null,
    epoch: 0,
    members: {},
    recovery: null,
    sealedKeys: {},
    prevKeys: {},
    keyChecks: {},
    cutoffs: {},
    forked: {},
    needsFreshKey: false,
    unkeyedDevices: [],
    accounts: {},
    accountChanges: [],
    history: [],
    rejected: [],
    conflicts: [],
    counterRemovals: [],
    unsettledRecovery: [],
    heads: {},
    appliedHeads: {},
    chains: {},
  };
}

function isMembership(kind: EntryKind): kind is MembershipKind {
  return MEMBERSHIP_KINDS.includes(kind);
}

/** True when `entry` had `other` in its causal past. */
function sees(entry: Placed, other: Placed): boolean {
  return entry !== other && follows(entry, other.item.entry.author, other.item.entry.seq);
}

/** Neither had seen the other. */
function concurrent(a: Placed, b: Placed): boolean {
  return a !== b && !sees(a, b) && !sees(b, a);
}

function bodyOf<K extends EntryKind>(placed: Placed, _kind: K): BodyByKind[K] {
  return placed.item.body as BodyByKind[K];
}

function recoveryIdOf(placed: Placed): string {
  return deviceIdFor(fromBase64Url(bodyOf(placed, 'recovery.set').ed));
}

// ---------------------------------------------------------------------------------------------
// Membership (layer a): who is in the vault, each change judged on what its author had seen.
// ---------------------------------------------------------------------------------------------

/** The most key changes (key.rotate and recovery.set) one identity may write; later ones are refused. */
export const MAX_KEY_CHANGES_PER_AUTHOR = 256;
/** The most removals one identity may write; later ones are refused. */
export const MAX_REMOVALS_PER_AUTHOR = MAX_IDENTITIES;

/** The membership changes of one context (the folder, or one removal's causal past) and the views built from them. */
class MembershipPass {
  create: Placed | null = null;
  kind: VaultKind = 'personal';
  readonly applied: Placed[] = [];
  readonly appliedSet = new Set<Placed>();
  readonly refused = new Map<string, string>();
  /** Device id -> applied entries that brought it in (vault.create, device.add). */
  readonly memberIntros = new Map<string, Placed[]>();
  /** Device id -> its applied device.hello, and the approval whose sealing key it confirmed. */
  readonly hellos = new Map<string, { hello: Placed; intro: Placed }>();
  /** Device id -> applied removals of it. */
  readonly removals = new Map<string, Placed[]>();
  readonly recoverySets: Placed[] = [];
  /** Applied restores of a solo vault: device.add signed by the recovery identity. */
  readonly restores: Placed[] = [];
  /** Applied key.rotate and recovery.set entries. */
  readonly keyChanges: Placed[] = [];
  /** Per author: key changes and removals seen so far, for the per-author caps. */
  private readonly keyChangeCount = new Map<string, number>();

  constructor(
    readonly vaultId: string,
    readonly founder: string | null,
    readonly forkCuts: ReadonlyMap<string, number>,
    /** Identity -> highest seq that still counts (removals, replaced recovery phrases, forks). */
    readonly cutoffs: ReadonlyMap<string, number>,
  ) {}

  memberIntroIds(): IterableIterator<string> {
    return this.memberIntros.keys();
  }

  intros(id: string): readonly Placed[] {
    return this.memberIntros.get(id) ?? [];
  }

  removalsOf(id: string): readonly Placed[] {
    return this.removals.get(id) ?? [];
  }

  /** The device's keys and role: those its own hello confirmed, else its first approval's. */
  keysOf(id: string): { ed: string; x: string; role: Role } | null {
    const intro = this.hellos.get(id)?.intro ?? this.intros(id)[0];
    if (!intro) return null;
    if (intro.item.entry.kind === 'vault.create') {
      const body = bodyOf(intro, 'vault.create');
      return { ed: body.ed, x: body.x, role: 'admin' };
    }
    const body = bodyOf(intro, 'device.add');
    return { ed: body.ed, x: body.x, role: body.role };
  }

  knownIn(view: Placed, id: string): boolean {
    return this.intros(id).some((p) => sees(view, p));
  }

  /** True when the device had joined in the view: the founder, or its own hello applied (rule 4). */
  joinedIn(view: Placed, id: string): boolean {
    if (id === this.founder && this.create && (view === this.create || sees(view, this.create))) return true;
    const hello = this.hellos.get(id)?.hello;
    return !!hello && (view === hello || sees(view, hello));
  }

  joined(id: string): boolean {
    return (id === this.founder && !!this.create) || this.hellos.has(id);
  }

  removedIn(view: Placed, id: string): boolean {
    return this.removalsOf(id).some((p) => sees(view, p));
  }

  activeIn(view: Placed, id: string): boolean {
    return this.knownIn(view, id) && this.joinedIn(view, id) && !this.removedIn(view, id);
  }

  adminIn(view: Placed, id: string): boolean {
    return this.activeIn(view, id) && this.keysOf(id)?.role === 'admin';
  }

  /**
   * The devices a new key must reach in the view: those that had joined and were not removed, and
   * those approved but not joined yet whose approver was still active (they join on that key's
   * approval otherwise, and a key change made before their hello must not strand them). Once the
   * approver is removed, a device that never joined is left out (rule 4). A device a fork proof
   * cut off is left out too, except in its own lines (those within its cut still count).
   */
  stayingIn(view: Placed, except?: string): string[] {
    return [...this.memberIntros.keys()].filter((id) => id !== except && (!this.forkCuts.has(id) || id === view.item.entry.author) && (this.activeIn(view, id) || this.pendingIn(view, id, except)));
  }

  /** Approved, not joined yet, and its approver is active (and not the device being removed). */
  pendingIn(view: Placed, id: string, except?: string): boolean {
    if (this.joinedIn(view, id) || this.removedIn(view, id)) return false;
    const live = this.intros(id).filter((p) => sees(view, p) && p.item.entry.kind === 'device.add' && p.item.entry.author !== except && this.activeIn(view, p.item.entry.author));
    // Approvals that disagree on its sealing key: nobody can tell which is its own until its hello says.
    return live.length > 0 && live.every((p) => bodyOf(p, 'device.add').x === bodyOf(live[0]!, 'device.add').x);
  }


  /** The recovery identity in the view: the latest applied recovery.set it had seen. */
  recoveryIn(view: Placed): { deviceId: string; placed: Placed } | null {
    for (let i = this.recoverySets.length - 1; i >= 0; i--) {
      const placed = this.recoverySets[i]!;
      if (sees(view, placed)) return { deviceId: recoveryIdOf(placed), placed };
    }
    return null;
  }

  /** A device.add signed by the recovery identity of a solo vault: it adds a device and removes the others. */
  isRestore(placed: Placed): boolean {
    return this.kind === 'solo' && placed.item.entry.kind === 'device.add' && this.recoveryIn(placed)?.deviceId === placed.item.entry.author;
  }

  wasRecoveryIn(view: Placed, id: string): boolean {
    return this.recoverySets.some((p) => sees(view, p) && recoveryIdOf(p) === id);
  }

  /** Counts a key change of the author and says whether it is over the cap. */
  overKeyChangeCap(placed: Placed): boolean {
    const author = placed.item.entry.author;
    const count = (this.keyChangeCount.get(author) ?? 0) + 1;
    this.keyChangeCount.set(author, count);
    return count > MAX_KEY_CHANGES_PER_AUTHOR;
  }

  record(placed: Placed): void {
    this.applied.push(placed);
    this.appliedSet.add(placed);
    const { entry } = placed.item;
    const push = (map: Map<string, Placed[]>, id: string) => {
      const list = map.get(id);
      if (list) list.push(placed);
      else map.set(id, [placed]);
    };
    if (entry.kind === 'vault.create') {
      this.create = placed;
      this.kind = bodyOf(placed, 'vault.create').kind;
      push(this.memberIntros, entry.author);
    } else if (entry.kind === 'device.add') {
      const device = bodyOf(placed, 'device.add').device;
      // A restore in a solo vault (the recovery identity's approval) takes out every earlier device it knew.
      if (this.isRestore(placed)) {
        for (const id of [...this.memberIntros.keys()]) if (id !== device && this.knownIn(placed, id)) push(this.removals, id);
        this.restores.push(placed);
      }
      push(this.memberIntros, device);
    } else if (entry.kind === 'device.remove') push(this.removals, bodyOf(placed, 'device.remove').device);
    else if (entry.kind === 'recovery.set') {
      this.recoverySets.push(placed);
      this.keyChanges.push(placed);
    } else if (entry.kind === 'key.rotate') this.keyChanges.push(placed);
  }

  recordHello(placed: Placed, intro: Placed): void {
    this.record(placed);
    this.hellos.set(placed.item.entry.author, { hello: placed, intro });
  }
}

class RuleError extends Error {}

function refuse(reason: string): never {
  throw new RuleError(reason);
}

function requireAdminIn(pass: MembershipPass, view: Placed): void {
  const author = view.item.entry.author;
  if (!pass.knownIn(view, author)) refuse('the author is not a device of this vault');
  if (pass.removedIn(view, author)) refuse('the author was removed from the vault before this entry');
  if (!pass.joinedIn(view, author)) refuse('the author had not joined the vault yet');
  if (pass.keysOf(author)?.role !== 'admin') refuse('only an admin device can do this');
}

/** A rotation's own shape: the previous key is boxed under the new epoch, which follows an earlier one. */
function checkRotationShape(body: RotationFields): void {
  if (body.epoch < 1) refuse('a key change must start a new epoch');
  if (body.prevKey.epoch !== body.epoch) refuse('the previous key must be encrypted under the new epoch');
}

/** The new key must reach every device staying in the view (and, when exact, nobody else but `alsoTo`). */
function checkSealedTo(body: RotationFields, staying: string[], alsoTo: string | null, exact: boolean, forked: ReadonlyMap<string, number> = new Map()): void {
  for (const id of staying) if (!body.keys[id]) refuse('the new key is not sealed to every device staying in the vault');
  if (alsoTo && !body.keys[alsoTo]) refuse('the new key must be sealed to the recovery key too');
  if (!exact) return;
  // A device a fork proof cut off need not get the key; one that did (made before the proof) is let be.
  const allowed = new Set([...staying, ...(alsoTo ? [alsoTo] : []), ...forked.keys()]);
  for (const to of Object.keys(body.keys)) if (!allowed.has(to)) refuse('the new key is sealed to a device that has not joined or is not staying in the vault');
}

const SOLO_ADD = 'in a solo vault only the recovery phrase adds a device, by restoring the vault';
const SOLO_REMOVE = 'in a solo vault a device is removed only by restoring the vault with the recovery phrase';
const SOLO_ROTATE = 'in a solo vault only the recovery phrase changes the key';
const SOLO_PHRASE = 'in a solo vault only the current recovery phrase sets a new one';
const SOLO_FIRST_PHRASE = 'the founding device sets the first recovery phrase right after it creates the vault, and never again';

/**
 * A restore in a solo vault (0.3.0): signed by the current recovery identity, for a new device.
 * It removes every earlier device after what it had seen of it (MembershipPass.record,
 * recoveryCutoffs). The agent takes it only with the recovery identity's key.rotate right after
 * it (logs.ts checkSolo), so the key it hands on is replaced by one only the new device and the
 * phrase hold; until that key change is in, the current key reached a removed device and the
 * vault needs a fresh key.
 */
function checkRestore(pass: MembershipPass, body: DeviceAddBody, placed: Placed): void {
  const { author } = placed.item.entry;
  if (pass.recoveryIn(placed)?.deviceId !== author) refuse(SOLO_ADD);
  if (pass.memberIntros.has(body.device)) refuse('a restore adds a new device; this one was in the vault before');
  if (body.role !== 'admin') refuse('the device a restore adds is an admin');
}

/** Only the current recovery identity sets a new phrase; the founder sets the first one, as its second entry. */
function checkSoloPhraseChange(pass: MembershipPass, placed: Placed): void {
  const { author, seq } = placed.item.entry;
  const current = pass.recoveryIn(placed);
  if (current) {
    if (current.deviceId !== author) refuse(SOLO_PHRASE);
    return;
  }
  if (author !== pass.founder || seq !== 1) refuse(SOLO_FIRST_PHRASE);
}

type ViewRule<K extends MembershipKind> = (pass: MembershipPass, body: BodyByKind[K], placed: Placed) => void;

/** Checks each change against its own view: the applied changes in its causal past. Throws RuleError. */
const VIEW_RULES: { [K in MembershipKind]: ViewRule<K> } = {
  'vault.create': (pass, body, placed) => {
    const { entry } = placed.item;
    if (pass.create) refuse('the vault was already created');
    if (entry.author !== pass.founder || entry.seq !== 0) refuse('vault.create must be the founder\'s first entry');
    const ed = fromBase64Url(body.ed);
    if (deviceIdFor(ed) !== entry.author) refuse('the founder key does not match the author');
    if (vaultIdFor(ed, fromBase64Url(body.salt)) !== pass.vaultId) refuse('the founder key and salt do not give this vault id');
    if (body.name.epoch !== 0 || body.deviceName.epoch !== 0) refuse('the names must be encrypted under epoch 0');
  },
  'device.add': (pass, body, placed) => {
    const author = placed.item.entry.author;
    if (pass.kind === 'solo') checkRestore(pass, body, placed);
    else if (pass.recoveryIn(placed)?.deviceId !== author) requireAdminIn(pass, placed);
    if (deviceIdFor(fromBase64Url(body.ed)) !== body.device) refuse('the device id does not match its key');
    if (pass.removedIn(placed, body.device)) refuse('that device was removed; it must make new keys to join again');
    if (pass.recoveryIn(placed)?.deviceId === body.device || pass.wasRecoveryIn(placed, body.device)) refuse('the recovery identity can\'t be added as a device');
    if (pass.knownIn(placed, body.device) && pass.forkCuts.has(body.device)) refuse('that device signed two different histories; it must make new keys to join again');
    if (pass.joinedIn(placed, body.device)) {
      // A joined device a rotation left without the current key is approved again to receive it.
      // A re-approval never moves a device to other keys or another role.
      const known = pass.keysOf(body.device)!;
      if (known.ed !== body.ed || known.x !== body.x) refuse('a device approved again must keep its keys');
      if (known.role !== body.role) refuse('a device approved again keeps its role');
      // Approving it again on a key it already holds is allowed: the key it was given may not open.
    }
    if (pass.kind === 'personal' && body.role !== 'admin') refuse('every device in a personal vault is an admin');
    if (body.name.epoch !== body.epoch) refuse('the name is not encrypted under the key it is given');
  },
  'device.hello': () => {
    // Checked in helloIntro: it needs to say which approval it confirms.
  },
  'device.remove': (pass, body, placed) => {
    if (pass.kind === 'solo') refuse(SOLO_REMOVE);
    requireAdminIn(pass, placed);
    if (body.device === placed.item.entry.author) refuse('a device can\'t remove itself; remove it from another device');
    if (!pass.knownIn(placed, body.device) || pass.removedIn(placed, body.device)) refuse('that device is not a device of this vault');
    const staying = pass.stayingIn(placed, body.device);
    if (staying.length === 0) refuse('the last device can\'t be removed');
    if (pass.kind === 'team' && pass.keysOf(body.device)?.role === 'admin' && !staying.some((id) => pass.keysOf(id)?.role === 'admin')) refuse('the last admin can\'t be removed');
    checkRotationShape(body);
    // Not exact: a removal takes access away, and a key that reached someone it shouldn't is replaced.
    checkSealedTo(body, staying, null, false);
  },
  'recovery.set': (pass, body, placed) => {
    // A recovery identity may sign this (chain.ts RECOVERY_KINDS) only in a solo vault: in the
    // others, requireAdminIn refuses it, since the recovery identity is never a device.
    if (pass.kind === 'solo') checkSoloPhraseChange(pass, placed);
    else requireAdminIn(pass, placed);
    const recoveryId = deviceIdFor(fromBase64Url(body.ed));
    if (pass.memberIntros.has(recoveryId)) refuse('the recovery key belongs to a device');
    if (pass.recoveryIn(placed)?.deviceId === recoveryId) refuse('this is already the vault\'s recovery phrase');
    if (pass.wasRecoveryIn(placed, recoveryId)) refuse('that recovery phrase was replaced before; make a new one');
    checkRotationShape(body);
    checkSealedTo(body, pass.stayingIn(placed), recoveryId, true, pass.forkCuts);
  },
  'key.rotate': (pass, body, placed) => {
    // As for recovery.set: a recovery identity's key change counts only in a solo vault.
    if (pass.kind === 'solo') {
      if (pass.recoveryIn(placed)?.deviceId !== placed.item.entry.author) refuse(SOLO_ROTATE);
    } else requireAdminIn(pass, placed);
    checkRotationShape(body);
    checkSealedTo(body, pass.stayingIn(placed), pass.recoveryIn(placed)?.deviceId ?? null, true, pass.forkCuts);
  },
};

/** The approval a hello confirms: one in its past for this device with the sealing key the hello names (rule 4). */
function helloIntro(pass: MembershipPass, placed: Placed): Placed {
  const { entry } = placed.item;
  if (entry.seq !== 0) refuse('device.hello must be the device\'s first entry');
  const { x, approval } = bodyOf(placed, 'device.hello');
  const seen = pass.intros(entry.author).filter((p) => sees(placed, p));
  if (seen.length === 0) refuse('it was written before its device was added');
  if (pass.removedIn(placed, entry.author)) refuse('the device was removed before it joined');
  // The hello names the approval it checked; keys, role, name and key all come from that one.
  const match = seen.find((p) => p.item.hash === approval && p.item.entry.kind === 'device.add');
  if (!match) refuse('the approval it names is not an applied approval of this device that it had seen');
  if (bodyOf(match, 'device.add').x !== x) refuse('the device was approved with a sealing key that is not its own, so it never joins; it must make new keys and ask again');
  return match;
}

/** What stops an entry by its author's standing, before its own rule: forks, cutoffs and the caps. */
function standingProblem(pass: MembershipPass, placed: Placed): string | null {
  const { entry } = placed.item;
  const forkSeq = pass.forkCuts.get(entry.author);
  if (forkSeq !== undefined && entry.seq >= forkSeq) return `its author signed two different entries at seq ${forkSeq}, so nothing it wrote from there counts`;
  if (entry.kind === 'vault.create') return null;
  if (!pass.create) return 'the vault was not created yet at this point';
  const cutoff = pass.cutoffs.get(entry.author);
  if (cutoff !== undefined && entry.seq > cutoff) return STANDING_CUT_REASON;
  if ((entry.kind === 'key.rotate' || entry.kind === 'recovery.set') && pass.overKeyChangeCap(placed)) return `its author already made ${MAX_KEY_CHANGES_PER_AUTHOR} key changes, the most one device may`;
  return null;
}

function viewProblem(pass: MembershipPass, placed: Placed): string | null {
  const { entry } = placed.item;
  try {
    (VIEW_RULES[entry.kind as MembershipKind] as ViewRule<MembershipKind>)(pass, placed.item.body as BodyByKind[MembershipKind], placed);
    return null;
  } catch (err) {
    if (err instanceof RuleError) return err.message;
    throw err;
  }
}

/** Removals decided so far: each is judged once, on its own causal past, and never again. */
type RemovalVerdicts = Map<Placed, string | null>;

/**
 * Cutoffs from applied removals (rule 1). A removal Q of Y by X cuts Y after what Q had seen of Y,
 * but never below what an applied removal of X that hadn't seen Q had seen of Y: once X is out,
 * nothing X signed without seeing that can take back what its remover had seen. Except in true
 * symmetry: when that removal of X exists only through Y's lines Q hadn't seen (Y itself, or a
 * device Y approved unseen by Q), neither side protects anything and both go.
 */
function removalCutoffs(removals: readonly Placed[], entries: readonly Placed[], founder: string | null): Map<string, number> {
  const byTarget = new Map<string, Placed[]>();
  for (const q of removals) {
    const target = bodyOf(q, 'device.remove').device;
    const list = byTarget.get(target);
    if (list) list.push(q);
    else byTarget.set(target, [q]);
  }
  const introsSeen = approvalsSeen(entries);
  const cutoffs = new Map<string, number>();
  for (const q of removals) {
    const target = bodyOf(q, 'device.remove').device;
    const remover = q.item.entry.author;
    let cut = q.past[target] ?? -1;
    // Rule 1: the remover's own removal, made without seeing this one, protects what it had seen
    // of the target, unless that removal exists only through the target's lines this one hadn't
    // seen (direct or indirect mutual removal: true symmetry, and both sides go).
    for (const r of byTarget.get(remover) ?? []) {
      if (sees(r, q) || enabledThrough(r, r.item.entry.author, target, q.past[target] ?? -1, introsSeen, founder, 0)) continue;
      cut = Math.max(cut, r.past[target] ?? -1);
    }
    cutoffs.set(target, Math.min(cutoffs.get(target) ?? Number.MAX_SAFE_INTEGER, cut));
  }
  return cutoffs;
}

/**
 * Work the replays in this process have done, counted rather than timed so the cost tests hold
 * on a busy machine: removals judged by a full replay of their past, and membership changes
 * looked at by a pass (the bulk of that work). Only ever added to; read and reset by tests.
 */
export const replayWork = { fullJudgements: 0, passSteps: 0 };

function runPass(vaultId: string, founder: string | null, forkCuts: ReadonlyMap<string, number>, entries: readonly Placed[], cutoffs: ReadonlyMap<string, number>, verdicts: RemovalVerdicts, outranked: ReadonlyMap<Placed, string>): MembershipPass {
  replayWork.passSteps += entries.length;
  const pass = new MembershipPass(vaultId, founder, forkCuts, cutoffs);
  for (const placed of entries) {
    const { entry, hash } = placed.item;
    if (entry.kind === 'device.remove') {
      const verdict = verdicts.has(placed) ? verdicts.get(placed)! : 'it was not decided';
      if (verdict === null) pass.record(placed);
      else pass.refused.set(hash, verdict);
      continue;
    }
    const lost = outranked.get(placed);
    if (lost) {
      pass.refused.set(hash, lost);
      continue;
    }
    let reason = standingProblem(pass, placed);
    if (!reason && entry.kind === 'device.hello') {
      try {
        pass.recordHello(placed, helloIntro(pass, placed));
        continue;
      } catch (err) {
        if (!(err instanceof RuleError)) throw err;
        reason = err.message;
      }
    }
    reason ??= viewProblem(pass, placed);
    if (reason) pass.refused.set(hash, reason);
    else pass.record(placed);
  }
  return pass;
}

/**
 * Recovery phrases set at the same time (layer b, among applied ones only): in hash order, one is
 * kept unless it was made at the same time as one already kept. The others are refused.
 */
function outrankedSets(pass: MembershipPass): Map<Placed, string> {
  const out = new Map<Placed, string>();
  const kept: Placed[] = [];
  for (const set of [...pass.recoverySets].sort((a, b) => (a.item.hash < b.item.hash ? -1 : 1))) {
    if (kept.some((k) => concurrent(k, set))) out.set(set, 'another recovery phrase set at the same time was kept instead; it will be made again');
    else kept.push(set);
  }
  return out;
}

/**
 * A kept recovery.set takes out every recovery identity it had seen, after what it had seen of
 * it (after the set itself, when that identity signed it: a solo phrase change). In a solo vault a
 * restore takes out every earlier device it knew the same way.
 */
function recoveryCutoffs(pass: MembershipPass): Map<string, number> {
  const cuts = new Map<string, number>();
  const cut = (id: string, seq: number) => cuts.set(id, Math.min(cuts.get(id) ?? Number.MAX_SAFE_INTEGER, seq));
  for (const set of pass.recoverySets) {
    for (const earlier of pass.recoverySets) {
      if (earlier === set || !sees(set, earlier)) continue;
      const id = recoveryIdOf(earlier);
      cut(id, set.item.entry.author === id ? set.item.entry.seq : (set.past[id] ?? -1));
    }
  }
  for (const restore of pass.restores) {
    const device = bodyOf(restore, 'device.add').device;
    for (const id of pass.memberIntroIds()) if (id !== device && pass.knownIn(restore, id)) cut(id, restore.past[id] ?? -1);
  }
  return cuts;
}

function mergeCuts(...maps: ReadonlyMap<string, number>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const map of maps) for (const [id, seq] of map) out.set(id, Math.min(out.get(id) ?? Number.MAX_SAFE_INTEGER, seq));
  return out;
}

function sameCuts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  return a.size === b.size && [...a].every(([id, seq]) => b.get(id) === seq);
}

/**
 * Bound on the rounds of recovery ranking, as a guard only (see decideContext). Tests may lower it
 * to reach the fail-safe path.
 */
export const recoveryRanking = { maxRounds: 256 };

const UNSETTLED_REASON = 'it could not be settled against other recovery phrases set at the same time, so the vault takes none of them; set a new phrase';

/** The applied recovery.sets of a pass, as a key that tells two rounds apart. */
function roundKey(pass: MembershipPass, recovery: ReadonlyMap<string, number>, outranked: ReadonlyMap<Placed, string>): string {
  const sets = pass.recoverySets.map((p) => p.item.hash).sort().join(',');
  const cuts = [...recovery].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, seq]) => `${id}:${seq}`).join(',');
  return `${outranked.size}|${sets}|${cuts}`;
}

/**
 * Decides one context. Removals come decided (each on its own past); their cutoffs are fixed
 * before anything else is looked at. Then one pass in the causal order decides every other
 * change on its view, its author's standing and the cutoffs.
 *
 * Recovery phrases set at the same time are ranked (outrankedSets) and a kept phrase cuts off the
 * identities it replaced (recoveryCutoffs); both can change which phrases apply, so the pass is
 * repeated. Why this ends, with one answer:
 *   - Each round is a deterministic function of the round before (sorted by hash and causal
 *     order, never by read order), so every replay of the same folder walks the same rounds.
 *   - `outranked` only grows, and is bounded by the number of recovery.sets. Between two growths
 *     the rounds move in a finite space (which phrases apply, which cuts), so they reach either a
 *     fixed point or a cycle; a cycle is detected by a repeated round.
 *   - A fixed point is the answer: every phrase it keeps passes the rules under the cuts it makes.
 *   - A cycle (or the guard bound) is the fail-safe: every phrase whose standing changed within
 *     the cycle is rejected (`outranked` grows, so this happens at most once per recovery.set),
 *     and the ranking starts again. The result is marked `unsettled`, the vault needs a fresh key
 *     (secrets pause) until a key change made after all those phrases, and the app warns.
 * The result is always a finished fixed point of the last round, never a state mid-iteration.
 */
function decideContext(vaultId: string, founder: string | null, forkCuts: ReadonlyMap<string, number>, entries: readonly Placed[], verdicts: RemovalVerdicts): { pass: MembershipPass; cutoffs: Map<string, number>; unsettled: Placed[] } {
  const applied = entries.filter((p) => p.item.entry.kind === 'device.remove' && verdicts.get(p) === null);
  const fixed = mergeCuts(removalCutoffs(applied, entries, founder), new Map([...forkCuts].map(([id, seq]) => [id, seq - 1])));
  let recovery = new Map<string, number>();
  let outranked = new Map<Placed, string>();
  const unsettled: Placed[] = [];
  let pass = runPass(vaultId, founder, forkCuts, entries, fixed, verdicts, outranked);
  const allSets = entries.filter((p) => p.item.entry.kind === 'recovery.set');
  if (allSets.length === 0) return { pass, cutoffs: fixed, unsettled };
  for (;;) {
    const rounds = new Map<string, number>();
    const passes: MembershipPass[] = [];
    let settled = false;
    let cycleStart = 0;
    for (let round = 0; round < recoveryRanking.maxRounds; round++) {
      const key = roundKey(pass, recovery, outranked);
      const seenAt = rounds.get(key);
      if (seenAt !== undefined) {
        cycleStart = seenAt;
        break;
      }
      rounds.set(key, passes.length);
      passes.push(pass);
      const nextOutranked = new Map([...outranked, ...outrankedSets(pass)]);
      const nextRecovery = recoveryCutoffs(pass);
      if (nextOutranked.size === outranked.size && sameCuts(nextRecovery, recovery)) {
        settled = true;
        break;
      }
      outranked = nextOutranked;
      recovery = nextRecovery;
      pass = runPass(vaultId, founder, forkCuts, entries, mergeCuts(fixed, recovery), verdicts, outranked);
    }
    if (settled) return { pass, cutoffs: mergeCuts(fixed, recovery), unsettled };
    // Fail safe: reject every phrase whose standing changed within the cycle (or, if none can be
    // told apart, every phrase not rejected yet), then rank again from the start.
    const cycle = passes.slice(cycleStart);
    const appliedIn = cycle.map((p) => new Set(p.recoverySets));
    let unstable = allSets.filter((p) => !outranked.has(p) && appliedIn.some((a) => a.has(p)) && appliedIn.some((a) => !a.has(p)));
    if (unstable.length === 0) unstable = allSets.filter((p) => !outranked.has(p));
    if (unstable.length === 0) return { pass, cutoffs: mergeCuts(fixed, recovery), unsettled };
    outranked = new Map([...outranked, ...unstable.map((p) => [p, UNSETTLED_REASON] as const)]);
    unsettled.push(...unstable);
    recovery = new Map();
    pass = runPass(vaultId, founder, forkCuts, entries, fixed, verdicts, outranked);
  }
}

/**
 * A removal is judged once, on the replay of its own causal past: exactly what its author was
 * looking at. Cheap view checks run first (S4): a removal whose author is out or not an admin in
 * its view, or whose target its view never approved or already removed, fails the full check
 * too, so it is refused without replaying anything. An author whose removals keep failing the
 * full check gets at most MAX_FAILED_JUDGEMENTS of them replayed; the rest are refused.
 */
function judgeRemoval(context: JudgeContext, removal: Placed): string | null {
  const { vaultId, founder, forkCuts, membership, removalCount, index } = context;
  const { entry } = removal.item;
  const forkSeq = forkCuts.get(entry.author);
  if (forkSeq !== undefined && entry.seq >= forkSeq) return `its author signed two different entries at seq ${forkSeq}, so nothing it wrote from there counts`;
  const count = (removalCount.get(entry.author) ?? 0) + 1;
  removalCount.set(entry.author, count);
  if (count > MAX_REMOVALS_PER_AUTHOR) return `its author already made ${MAX_REMOVALS_PER_AUTHOR} removals, the most one device may`;
  const target = bodyOf(removal, 'device.remove').device;
  const seen = (list: readonly Placed[] | undefined) => (list ?? []).filter((p) => sees(removal, p));
  if (target !== founder && seen(index.adds.get(target)).length === 0) return 'that device is not a device of this vault';
  // Removals in its past count as they stand once settled within that past (R6-E): one that a
  // removal of its own author voids there removes nothing.
  let local: RemovalVerdicts | null = null;
  const stillApplied = (list: Placed[]) => {
    if (list.length === 0) return false;
    local ??= settledPast(context, removal);
    return list.some((p) => local!.get(p) === null);
  };
  if (stillApplied(seen(index.applied.get(target)))) return 'that device is not a device of this vault';
  if (stillApplied(seen(index.applied.get(entry.author)))) return 'the author was removed from the vault before this entry';
  if (entry.author !== founder && !seen(index.adds.get(entry.author)).some((p) => bodyOf(p, 'device.add').role === 'admin')) return 'only an admin device can do this';
  const failed = context.failed.get(entry.author) ?? 0;
  if (failed >= MAX_FAILED_JUDGEMENTS) return `its author already made ${MAX_FAILED_JUDGEMENTS} removals the rules refused`;
  // Counted in its own past, so the verdict still depends only on that past.
  let failedBefore = 0;
  for (const p of context.failedAll) if (sees(removal, p) && ++failedBefore >= MAX_FAILED_JUDGEMENTS_PER_VAULT) return `the vault already holds ${MAX_FAILED_JUDGEMENTS_PER_VAULT} removals the rules refused`;
  // The full check depends only on the removal's own past and the fork cuts: cached by both.
  const key = `${removal.item.hash}|${context.forkKey}`;
  let problem = context.judged.get(key);
  if (problem === undefined) {
    const past = membership.filter((p) => sees(removal, p));
    const { pass } = decideContext(vaultId, founder, forkCuts, past, local ?? settledPast(context, removal));
    problem = pass.create ? viewProblem(pass, removal) : 'the vault was not created yet at this point';
    context.judged.set(key, problem);
    replayWork.fullJudgements++;
  }
  if (problem !== null) {
    context.failed.set(entry.author, failed + 1);
    context.failedAll.push(removal);
  }
  else {
    const list = index.applied.get(target);
    if (list) list.push(removal);
    else index.applied.set(target, [removal]);
  }
  return problem;
}

/**
 * The verdicts of the removals in `removal`'s causal past, settled (settleCutOffRemovals) within
 * that past alone. Each one was judged on its own past the same way, so a verdict depends only on
 * the removal's past: judging in causal order defines each exactly once (see the header).
 * Settling needs two removals that both passed; with fewer, the verdicts stand as judged.
 * Cached by the set of passing removals in the past, which many removals share.
 */
function settledPast(context: JudgeContext, removal: Placed): RemovalVerdicts {
  const { verdicts } = context;
  const past = context.membership.filter((p) => sees(removal, p));
  const earlier = past.filter((p) => p.item.entry.kind === 'device.remove');
  const passing = earlier.filter((p) => verdicts.get(p) === null);
  if (passing.length < 2) return verdicts;
  const key = passing.map((p) => p.item.hash).join(',');
  let settled = context.settled.get(key);
  if (!settled) {
    settled = new Map(earlier.map((p) => [p, verdicts.get(p)!]));
    settleCutOffRemovals(past, settled, context.founder);
    context.settled.set(key, settled);
  }
  return settled;
}

const CUT_OFF_REMOVAL = 'its author had been removed by a change it had not seen, and this is not a removal of that remover';

/**
 * Removals by a cut-off author (rule 1, S2): a removal r by A that passes its own view still
 * fails when an applied removal q of A had not seen r, unless r and q are truly symmetric (q's
 * author is in only through r's target's lines r had not seen: r is a counter-removal). Then r
 * is rejected like any other line past A's cutoff.
 *
 * "Applied" here is decided as the grounded labelling of the attack graph "q cuts r off": a
 * removal is in when every removal that would cut it off is out, and out when one of them is in.
 * Starting from nothing decided, each step only adds labels and never changes one, so it ends
 * after at most as many steps as there are removals, and the labelling it reaches is the least
 * fixed point: unique, whatever order the removals are looked at. Removals left undecided sit on
 * a cycle with no symmetric pair in it (A cuts B cuts C cuts A, none brought in by another);
 * they all apply (everyone involved is out), the same outcome as true symmetry.
 */
function settleCutOffRemovals(membership: readonly Placed[], verdicts: RemovalVerdicts, founder: string | null): void {
  const valid = membership.filter((p) => p.item.entry.kind === 'device.remove' && verdicts.get(p) === null);
  if (valid.length < 2) return;
  const byTarget = new Map<string, Placed[]>();
  for (const q of valid) {
    const target = bodyOf(q, 'device.remove').device;
    const list = byTarget.get(target);
    if (list) list.push(q);
    else byTarget.set(target, [q]);
  }
  const introsSeen = approvalsSeen(membership);
  const attackers = new Map<Placed, Placed[]>();
  for (const r of valid) {
    const { author, seq } = r.item.entry;
    const target = bodyOf(r, 'device.remove').device;
    const limit = r.past[target] ?? -1;
    // q cuts r off when q removes r's author before r, or removes a device through whose lines
    // past q's cut r's author is in at all (a puppet of a cut-off device, never really in).
    const list: Placed[] = [];
    for (const [x, removals] of byTarget) {
      for (const q of removals) {
        if (q === r) continue;
        const cut = q.past[x] ?? -1;
        const cutsOff = x === author ? cut < seq : enabledThrough(r, author, x, cut, introsSeen, founder, 0);
        if (cutsOff && !enabledThrough(q, q.item.entry.author, target, limit, introsSeen, founder, 0)) list.push(q);
      }
    }
    if (list.length > 0) attackers.set(r, list);
  }
  if (attackers.size === 0) return;
  const label = new Map<Placed, boolean>();
  for (const r of valid) if (!attackers.has(r)) label.set(r, true);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [r, list] of attackers) {
      if (label.has(r)) continue;
      if (list.some((q) => label.get(q) === true)) {
        label.set(r, false);
        changed = true;
      } else if (list.every((q) => label.get(q) === false)) {
        label.set(r, true);
        changed = true;
      }
    }
  }
  for (const [r, isIn] of label) if (!isIn) verdicts.set(r, CUT_OFF_REMOVAL);
}

/** Removals one author may have refused by the full check before the rest are refused unread. */
const MAX_FAILED_JUDGEMENTS = 8;
/** Removals the whole vault may have refused by the full check, counted in each removal's past. */
const MAX_FAILED_JUDGEMENTS_PER_VAULT = 64;

/** Full-check verdicts by removal hash and fork cuts, kept with a VerifyCache across replays. */
type JudgeCache = Map<string, string | null>;
const judgeCaches = new WeakMap<VerifyCache, JudgeCache>();

function judgeCacheFor(cache: VerifyCache): JudgeCache {
  let judged = judgeCaches.get(cache);
  if (!judged) judgeCaches.set(cache, (judged = new Map()));
  // A bound, so a long-running agent's cache can't grow without end.
  if (judged.size > 100_000) judged.clear();
  return judged;
}

interface JudgeContext {
  vaultId: string;
  founder: string | null;
  forkCuts: ReadonlyMap<string, number>;
  membership: readonly Placed[];
  verdicts: RemovalVerdicts;
  removalCount: Map<string, number>;
  failed: Map<string, number>;
  /** Every removal the full check refused so far. */
  failedAll: Placed[];
  /** Settled verdicts of a past, by the hashes of the removals in it that passed. */
  settled: Map<string, RemovalVerdicts>;
  judged: JudgeCache;
  /** The fork cuts as a cache key. */
  forkKey: string;
  /** Approvals by device, and removals judged applied so far by target. */
  index: { adds: Map<string, Placed[]>; applied: Map<string, Placed[]> };
}

interface Membership {
  /** The first forked seq of each identity a valid proof names (what the proofs say). */
  provenForks: ReadonlyMap<string, number>;
  /** Key changes a seal proof voided (by hash): each keeps its epoch on the chain, with a key nobody else holds. */
  dead: ReadonlySet<string>;
  deadEntries: readonly Placed[];
  pass: MembershipPass;
  cutoffs: Map<string, number>;
  /** Recovery phrases the ranking could not settle (decideContext's fail-safe). */
  unsettled: Placed[];
}

function decideMembership(vaultId: string, order: CausalOrder, founder: string | null, forkCuts: ReadonlyMap<string, number>, judged: JudgeCache = new Map(), dead: ReadonlySet<string> = new Set()): Membership {
  const membership = order.ordered.filter((p) => isMembership(p.item.entry.kind) && !p.problem);
  const verdicts: RemovalVerdicts = new Map();
  const adds = new Map<string, Placed[]>();
  for (const p of membership) {
    if (p.item.entry.kind !== 'device.add') continue;
    const device = bodyOf(p, 'device.add').device;
    const list = adds.get(device);
    if (list) list.push(p);
    else adds.set(device, [p]);
  }
  const forkKey = [...forkCuts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, seq]) => `${id}:${seq}`).join(',');
  const context: JudgeContext = { vaultId, founder, forkCuts, membership, verdicts, removalCount: new Map(), failed: new Map(), failedAll: [], settled: new Map(), judged, forkKey, index: { adds, applied: new Map() } };
  for (const placed of membership) {
    if (placed.item.entry.kind === 'device.remove') verdicts.set(placed, judgeRemoval(context, placed));
  }
  settleCutOffRemovals(membership, verdicts, founder);
  const deadEntries = dead.size === 0 ? [] : membership.filter((p) => dead.has(p.item.hash) && KEY_BEARING.has(p.item.entry.kind));
  return { ...decideContext(vaultId, founder, forkCuts, membership, verdicts), provenForks: forkCuts, dead, deadEntries };
}

/**
 * Forks (rule 4): a proven fork cuts its identity off like a removal, but never below what
 * others built on. The cut is the highest seq of the forker in the causal past of any entry by
 * an identity still standing, or one before the forked seq if nobody built past it. At the forked
 * seq the folder's version is kept only when someone named it (an entry that named the other
 * version counts as having seen the seq before, order.ts). So a proof never rejects anything
 * other identities built on, and a device that forks its own log can't take back what it
 * approved or the phrase it set.
 *
 * Two steps: first every entry by an identity that is not itself forked counts; then only those
 * by identities still standing after that first decision (in, and within their cutoff), so an
 * accomplice cut off from the vault can't hold the forker's lines up. Both are deterministic.
 */
function decideWithForks(vaultId: string, order: CausalOrder, founder: string | null, proven: ReadonlyMap<string, number>, judged: JudgeCache, sealCuts: SealCuts = NO_SEAL_CUTS): { membership: Membership; contested: Set<string> } {
  if (proven.size === 0) return { membership: { ...decideMembership(vaultId, order, founder, sealCuts.cuts, judged, sealCuts.dead), provenForks: proven }, contested: new Set() };
  // Who named a version of a forker's line the folder doesn't hold (seq >= its forked seq).
  const namedOther = new Map<string, Set<string>>();
  for (const c of order.conflicts) {
    const forkSeq = proven.get(c.names.deviceId);
    if (forkSeq === undefined || c.names.seq < forkSeq) continue;
    let set = namedOther.get(c.hash);
    if (!set) namedOther.set(c.hash, (set = new Set()));
    set.add(c.names.deviceId);
  }
  // Contested seqs are judged at the fixed point only (never carried over from an earlier round,
  // where a ghost may still have seemed to stand): pin them, find the fixed point again, and stop
  // when the contested set it gives is the one pinned. Bounded; the last round's answer stands.
  let pinned = new Set<string>();
  let membership = forkFixedPoint(vaultId, order, founder, proven, judged, pinned, sealCuts);
  for (let round = 0; round < MAX_CONTEST_ROUNDS; round++) {
    const contested = contestedForks(membership, order, proven, namedOther);
    if (sameSet(contested, pinned)) break;
    pinned = contested;
    membership = forkFixedPoint(vaultId, order, founder, proven, judged, pinned, sealCuts);
  }
  return { membership, contested: pinned };
}

const MAX_CONTEST_ROUNDS = 8;

/**
 * Proven bad seals (sealProof.ts): the author is cut at the seq before each such entry, like a
 * fork pinned there that no one's building on can raise; `dead` holds the voided key changes.
 */
interface SealCuts {
  cuts: ReadonlyMap<string, number>;
  dead: ReadonlySet<string>;
}
const NO_SEAL_CUTS: SealCuts = { cuts: new Map(), dead: new Set() };
const KEY_BEARING: ReadonlySet<EntryKind> = new Set<EntryKind>(['key.rotate', 'recovery.set', 'device.remove']);

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * Start with no cut, then cut each forker at the highest of its seqs that entries which apply,
 * by identities not cut off, built on (never below its forked seq; a pinned, contested forker
 * exactly at it). Cuts only fall, so this ends at the greatest fixed point: nothing anyone built
 * on is lost. An identity in only through the forker's own lines at or past its forked seq
 * (directly, or through such an identity) is no evidence for it: a forker never vouches for itself.
 */
function forkFixedPoint(vaultId: string, order: CausalOrder, founder: string | null, proven: ReadonlyMap<string, number>, judged: JudgeCache, pinned: ReadonlySet<string>, sealCuts: SealCuts): Membership {
  // A proven bad seal is a ceiling: nothing raises a cut above it.
  const ceiling = (id: string, seq: number) => Math.min(seq, sealCuts.cuts.get(id) ?? Number.MAX_SAFE_INTEGER);
  let cuts = new Map([...proven].map(([id]) => [id, ceiling(id, pinned.has(id) ? proven.get(id)! : Number.MAX_SAFE_INTEGER)]));
  for (const [id, seq] of sealCuts.cuts) if (!cuts.has(id)) cuts.set(id, seq);
  for (;;) {
    const membership = decideMembership(vaultId, order, founder, cuts, judged, sealCuts.dead);
    const counts = countingEntries(membership);
    const next = new Map(proven);
    for (const p of order.ordered) {
      const author = p.item.entry.author;
      if (proven.has(author) || !counts(p)) continue;
      for (const [id, forkSeq] of proven) {
        const seen = p.past[id];
        if (seen !== undefined && seen >= forkSeq && seen + 1 > next.get(id)!) next.set(id, seen + 1);
      }
    }
    for (const [id, seq] of next) next.set(id, ceiling(id, pinned.has(id) ? proven.get(id)! : Math.min(seq, cuts.get(id)!)));
    for (const [id, seq] of sealCuts.cuts) if (!next.has(id)) next.set(id, seq);
    if (sameCuts(cuts, next)) return { ...membership, provenForks: proven };
    cuts = next;
  }
}

/**
 * Whether `id` is in only through `forker`'s lines at or past its forked seq: its approval (or
 * the recovery.set naming it) is such a line, or is by an identity that is (transitively).
 */
function throughForker(membership: Membership, proven: ReadonlyMap<string, number>): (id: string, forker: string) => boolean {
  const { pass } = membership;
  const introducer = new Map<string, Placed>();
  for (const set of pass.recoverySets) introducer.set(recoveryIdOf(set), set);
  const memo = new Map<string, boolean>();
  const check = (id: string, forker: string, depth: number): boolean => {
    const key = `${id}|${forker}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    memo.set(key, false);
    const intro = pass.hellos.get(id)?.intro ?? introducer.get(id);
    let result = false;
    if (intro && intro.item.entry.kind !== 'vault.create') {
      const { author, seq } = intro.item.entry;
      result = (author === forker && seq >= proven.get(forker)!) || (author !== id && depth < MAX_IDENTITIES && check(author, forker, depth + 1));
    }
    memo.set(key, result);
    return result;
  };
  return (id, forker) => check(id, forker, 0);
}

/**
 * The forkers whose forked seq is contested at this fixed point: identities that still stand
 * there (in, and the line within their cutoff), and aren't in only through that forker, built on
 * both versions of it. A line counts even if it ends rejected for another reason. One identity
 * naming both versions never contests.
 */
function contestedForks(membership: Membership, order: CausalOrder, proven: ReadonlyMap<string, number>, namedOther: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const through = throughForker(membership, proven);
  const onOther = new Map<string, Set<string>>();
  const onFolder = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, id: string, author: string) => {
    let set = map.get(id);
    if (!set) map.set(id, (set = new Set()));
    set.add(author);
  };
  for (const p of order.ordered) {
    const author = p.item.entry.author;
    if (proven.has(author) || !standsAt(membership, p)) continue;
    for (const id of namedOther.get(p.item.hash) ?? []) if (!through(author, id)) add(onOther, id, author);
    for (const [id, forkSeq] of proven) {
      const seen = p.past[id];
      if (seen !== undefined && seen >= forkSeq && !through(author, id)) add(onFolder, id, author);
    }
  }
  const contested = new Set<string>();
  for (const [id, other] of onOther) {
    const folder = onFolder.get(id);
    if (folder && new Set([...other, ...folder]).size >= 2) contested.add(id);
  }
  return contested;
}

/** Its author is in the vault (joined, or a recovery identity) and the entry is within its cutoff. */
function standsAt(membership: Membership, p: Placed): boolean {
  const { author, seq } = p.item.entry;
  const inVault = membership.pass.joined(author) || membership.pass.recoverySets.some((r) => recoveryIdOf(r) === author);
  const cutoff = membership.cutoffs.get(author);
  return inVault && (cutoff === undefined || seq <= cutoff);
}

/** Entries that count as having built on what they saw: applied ones, by authors still standing. */
function countingEntries(membership: Membership): (p: Placed) => boolean {
  const applied = new Set(membership.pass.applied);
  const { misnumbered } = keyChain(membership);
  return (p) => {
    if (isMembership(p.item.entry.kind)) return applied.has(p) && !misnumbered.has(p);
    return standsAt(membership, p);
  };
}

// ---------------------------------------------------------------------------------------------
// Keys (layer b): the chain of key changes by devices still standing, each on the one before.
// ---------------------------------------------------------------------------------------------

interface KeyChain {
  /** epoch -> the entry whose key is the vault's key for that epoch (vault.create for 0). */
  canon: Placed[];
  /** Key changes that count for keys, in order. */
  eligible: Placed[];
}

/** A removal's key counts only when its author was still standing when it wrote it. */
function standingAt(membership: Membership, placed: Placed): boolean {
  const { author, seq } = placed.item.entry;
  if (!membership.pass.joined(author)) return false;
  const cutoff = membership.cutoffs.get(author);
  return cutoff === undefined || seq <= cutoff;
}

/**
 * A key change that strands a device (rule 7, "honest devices can always go on"): it left out a
 * device that did join and is still in, and no approval made after it hands that device the key.
 * Another holder could be the author's own puppet, so it doesn't count. Its key never becomes the vault's; its
 * membership effect stands, the vault stays on the earlier key, and the next fresh key comes
 * from a device that holds that one. Judged after layer (a), on the final membership.
 */
function strandsADevice(pass: MembershipPass, active: ReadonlySet<string>, placed: Placed): boolean {
  const { author } = placed.item.entry;
  const keys = (placed.item.body as RotationFields).keys;
  // An approval made after the change hands its key on too, if it carries that key: an approver
  // the change left out seals an older one.
  const epoch = epochOf(placed);
  // A seal counts only when made to the sealing key the device was given (and confirmed).
  const sealedTo = (id: string) => Object.hasOwn(keys, id) && keys[id]!.r === pass.keysOf(id)?.x;
  const holds = (id: string) =>
    sealedTo(id) || pass.intros(id).some((i) => sees(i, placed) && i.item.entry.kind === 'device.add' && (i.item.body as BodyByKind['device.add']).epoch >= epoch);
  for (const id of active) if (id !== author && !holds(id)) return true;
  return false;
}

function epochOf(placed: Placed): number {
  return (placed.item.body as RotationFields).epoch;
}

/**
 * True when `a` should be the vault's key over `b` at one epoch: first one whose key reached no
 * removed device, then a new recovery phrase, then the lower hash.
 */
function keyChangeBeats(a: Placed, b: Placed, removed: ReadonlySet<string>, dead: ReadonlySet<string> = new Set()): boolean {
  if (dead.has(a.item.hash) !== dead.has(b.item.hash)) return !dead.has(a.item.hash);
  const leaks = (p: Placed) => (Object.keys((p.item.body as RotationFields).keys).some((id) => removed.has(id)) ? 1 : 0);
  if (leaks(a) !== leaks(b)) return leaks(a) < leaks(b);
  const rank = (p: Placed) => (p.item.entry.kind === 'recovery.set' ? 0 : 1);
  return rank(a) !== rank(b) ? rank(a) < rank(b) : a.item.hash < b.item.hash;
}

/**
 * The key chain. Candidates for epoch e are the standing key changes numbered e that had seen the
 * key of e - 1; one that another candidate had seen was replaced by it. Of the rest, the best
 * is the key. Then a key change counts only if its epoch is one more than the last key it had seen.
 */
function keyChain(membership: Membership): { chain: KeyChain; misnumbered: Map<Placed, string> } {
  const { pass } = membership;
  const misnumbered = new Map<Placed, string>();
  const canon: Placed[] = pass.create ? [pass.create] : [];
  const active = new Set([...pass.memberIntroIds()].filter((id) => pass.joined(id) && pass.removalsOf(id).length === 0 && !pass.forkCuts.has(id)));
  if (pass.founder && pass.create && pass.removalsOf(pass.founder).length === 0 && !pass.forkCuts.has(pass.founder)) active.add(pass.founder);
  const standing = pass.applied.filter((p) => {
    const kind = p.item.entry.kind;
    if (kind !== 'key.rotate' && kind !== 'recovery.set' && !(kind === 'device.remove' && standingAt(membership, p))) return false;
    return !strandsADevice(pass, active, p);
  });
  // A key change a seal proof voided keeps its epoch, with a key no one else holds, so changes
  // built after it (numbered one past it) stay on the chain; the vault then needs a fresh key.
  for (const p of membership.deadEntries) standing.push(p);
  if (!pass.create) return { chain: { canon, eligible: [] }, misnumbered };
  const removed = new Set([...pass.removals.keys(), ...pass.forkCuts.keys()]);
  const byEpoch = new Map<number, Placed[]>();
  for (const p of standing) {
    const list = byEpoch.get(epochOf(p));
    if (list) list.push(p);
    else byEpoch.set(epochOf(p), [p]);
  }
  for (let epoch = 1; ; epoch++) {
    const before = canon[epoch - 1]!;
    const candidates = (byEpoch.get(epoch) ?? []).filter((p) => sees(p, before));
    if (candidates.length === 0) break;
    // A key change that saw another one at its own epoch replaced it (its author found the
    // earlier one off the chain, say stranding a device, and wrote the epoch again), so of the
    // candidates no other one saw, the best is the key.
    let pick: Placed | null = null;
    for (const c of candidates) {
      const { author, seq } = c.item.entry;
      let replaced = false;
      for (const d of candidates) {
        if (d === c) continue;
        if (d.item.entry.author === author ? d.item.entry.seq > seq : (d.past[author] ?? -1) >= seq) {
          replaced = true;
          break;
        }
      }
      if (!replaced && (!pick || keyChangeBeats(c, pick, removed, membership.dead))) pick = c;
    }
    canon.push(pick!);
  }
  // The last key each had seen: canon[e] seen implies canon[e - 1] seen, so search.
  const viewEpoch = (p: Placed): number => {
    let lo = 0;
    let hi = canon.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sees(p, canon[mid]!)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const eligible: Placed[] = [];
  for (const p of standing) {
    const seen = viewEpoch(p);
    if (epochOf(p) !== seen + 1) {
      misnumbered.set(p, `it starts epoch ${epochOf(p)}, but the last key it had seen was epoch ${seen}`);
      continue;
    }
    eligible.push(p);
  }
  return { chain: { canon, eligible }, misnumbered };
}

/**
 * Why `placed`, encrypted under `epoch`, is not on the vault's key, or null: it must have seen that
 * key's change and not the next one. (An edit made at the same time as a removal still applies:
 * it is already in the folder under a key the removed device held, and rejecting it would hide
 * nothing from that device; what the removed device itself writes after its cutoff is refused.)
 */
function offKeyReason(chain: KeyChain, placed: Placed, epoch: number): string | null {
  const at = chain.canon[epoch];
  if (!at) return `it is encrypted under epoch ${epoch}, which the vault's key never reached`;
  if (at !== placed && !sees(placed, at)) return 'it is encrypted under a key that a change made at the same time replaced; it will be made again';
  const next = chain.canon[epoch + 1];
  if (next && sees(placed, next)) return `it is encrypted under epoch ${epoch}, but the vault is at epoch ${chain.canon.length - 1}`;
  return null;
}

function onKey(chain: KeyChain, placed: Placed, epoch: number): boolean {
  return offKeyReason(chain, placed, epoch) === null;
}

// ---------------------------------------------------------------------------------------------
// Applying everything in the total order (layer c for accounts and names).
// ---------------------------------------------------------------------------------------------

interface Decided {
  pass: MembershipPass;
  chain: KeyChain;
  cutoffs: Record<string, number>;
  /** Entries refused after the passes (misnumbered key rotations), with the reason. */
  refusedLate: Map<Placed, string>;
  /** Account changes and renames past their author's share of the vault (overShare). */
  overShare: ReadonlySet<string>;
}

/** Kinds that never count toward an identity's share: each has its own cap per author. */
const UNSHARED_KINDS = new Set<EntryKind>(['vault.create', 'device.hello', 'device.remove', 'key.rotate', 'recovery.set']);

/**
 * Per-identity shares in replay too (team folders can be written straight): each identity's
 * lines are counted in its own log order, lines and bytes; once over its role's share, its later
 * account changes and renames are rejected. Removals, hellos, approvals and key changes have
 * caps of their own, bounded by identities, so no share ever refuses them. Deterministic: it
 * depends only on each log and the author's final role.
 */
function overShare(chains: Record<string, VerifiedEntry[]>, logs: VaultLogs, pass: MembershipPass): Set<string> {
  const over = new Set<string>();
  for (const [author, chain] of Object.entries(chains)) {
    const share = pass.keysOf(author)?.role === 'member' ? DEFAULT_QUOTA_LIMITS.member : DEFAULT_QUOTA_LIMITS.admin;
    // Canonical bytes: a padded or re-encoded copy of a line counts as its entry (R6-F).
    if (chain.length <= share.lines && chain.reduce((n, item) => n + item.text.length + 1, 0) <= share.bytes) continue;
    let lines = 0;
    let bytes = 0;
    for (const item of chain) {
      if (UNSHARED_KINDS.has(item.entry.kind)) continue;
      lines++;
      bytes += item.text.length + 1;
      if ((lines > share.lines || bytes > share.bytes) && !isMembership(item.entry.kind)) over.add(item.hash);
    }
  }
  return over;
}

class ApplyError extends Error {}

function fail(reason: string): never {
  throw new ApplyError(reason);
}

/** The author must be a joined device whose introduction this entry follows, and not past its cutoff. */
function authorProblem(placed: Placed, decided: Decided): string | null {
  const { author, seq } = placed.item.entry;
  const intros = decided.pass.intros(author);
  if (intros.length === 0) return 'the author is not a device of this vault';
  if (!intros.some((p) => p === placed || sees(placed, p))) return 'it was written before its device was added';
  if (!decided.pass.joined(author)) return 'its device never joined: its own hello did not apply';
  const forkSeq = decided.pass.forkCuts.get(author);
  if (forkSeq !== undefined && seq >= forkSeq) return `its author signed two different entries at seq ${forkSeq}, so nothing it wrote from there counts`;
  const cutoff = decided.cutoffs[author];
  if (cutoff !== undefined && seq > cutoff) return CUT_OFF_REASON;
  return null;
}

type OtherKind = Exclude<EntryKind, MembershipKind>;
type Apply<K extends OtherKind> = (state: VaultState, body: BodyByKind[K], placed: Placed, decided: Decided) => string | undefined;

const OTHER_RULES: { [K in OtherKind]: Apply<K> } = {
  'device.rename': (state, body, placed, { pass, chain }) => {
    const author = placed.item.entry.author;
    if (body.device !== author && !pass.adminIn(placed, author)) fail('only an admin device can rename another device');
    if (!pass.activeIn(placed, body.device) && body.device !== author) fail('that device is not an active device of this vault');
    const target = state.members[body.device];
    if (!target) fail('that device is not an active device of this vault');
    const off = offKeyReason(chain, placed, body.name.epoch);
    if (off) fail(`the name: ${off}`);
    target.name = body.name;
    return body.device;
  },
  'account.put': (state, body, placed, { chain }) => {
    const { entry, hash } = placed.item;
    const off = offKeyReason(chain, placed, body.box.epoch);
    if (off) fail(off);
    state.accounts[body.account] = { box: body.box, author: entry.author, time: entry.time, hash };
    state.accountChanges.push({ kind: 'account.put', account: body.account, box: body.box, author: entry.author, seq: entry.seq, time: entry.time, hash });
    return body.account;
  },
  'account.delete': (state, body, { item: { entry, hash } }) => {
    if (!Object.hasOwn(state.accounts, body.account)) fail('there is no such account');
    delete state.accounts[body.account];
    state.accountChanges.push({ kind: 'account.delete', account: body.account, author: entry.author, seq: entry.seq, time: entry.time, hash });
    return body.account;
  },
};

/** What an applied membership change is about, and the name it sets when it is on the key. */
function applyMembershipEntry(state: VaultState, placed: Placed, decided: Decided): string | undefined {
  const { entry } = placed.item;
  if (entry.kind === 'vault.create' || entry.kind === 'device.hello') return entry.author;
  if (entry.kind === 'device.add') {
    const body = bodyOf(placed, 'device.add');
    const member = state.members[body.device];
    // A re-approval on the current key brings a name the device can read again.
    if (member && decided.pass.intros(body.device)[0] !== placed && onKey(decided.chain, placed, body.name.epoch)) member.name = body.name;
    return body.device;
  }
  if (entry.kind === 'device.remove') return bodyOf(placed, 'device.remove').device;
  if (entry.kind === 'recovery.set') return recoveryIdOf(placed);
  return undefined;
}

function applyInOrder(state: VaultState, placed: Placed, decided: Decided): void {
  const { entry, hash } = placed.item;
  const record: HistoryItem = { hash, author: entry.author, seq: entry.seq, time: entry.time, kind: entry.kind, status: 'applied' };
  state.history.push(record);
  const reject = (reason: string) => {
    record.status = 'rejected';
    record.reason = reason;
    state.rejected.push({ deviceId: entry.author, seq: entry.seq, hash, kind: entry.kind, reason });
  };
  if (placed.problem) return reject(placed.problem);
  if (isMembership(entry.kind)) {
    const late = decided.refusedLate.get(placed);
    if (late) return reject(late);
    if (!decided.pass.appliedSet.has(placed)) return reject(decided.pass.refused.get(hash) ?? 'it was not applied');
    const subject = applyMembershipEntry(state, placed, decided);
    if (subject) record.subject = subject;
    return;
  }
  if (!state.created) return reject('the vault was not created yet at this point');
  if (decided.overShare.has(hash)) return reject('its author had already used its share of the vault');
  const problem = authorProblem(placed, decided);
  if (problem) return reject(problem);
  try {
    const subject = (OTHER_RULES[entry.kind as OtherKind] as Apply<OtherKind>)(state, placed.item.body as BodyByKind[OtherKind], placed, decided);
    if (subject) record.subject = subject;
  } catch (err) {
    if (err instanceof ApplyError) return reject(err.message);
    throw err;
  }
}

/** Builds who is in the vault, the cutoffs and the keys from the decided membership. */
function settleMembership(state: VaultState, membership: Membership, chain: KeyChain): Record<string, number> {
  const { pass } = membership;
  const cutoffs: Record<string, number> = Object.fromEntries(membership.cutoffs);
  const create = pass.create;
  if (!create) return cutoffs;
  const founding = bodyOf(create, 'vault.create');
  state.created = true;
  state.kind = founding.kind;
  state.founder = create.item.entry.author;
  state.name = founding.name;

  for (const [id, intros] of pass.memberIntros) {
    // The approval its own hello confirmed, else the first.
    const first = pass.hellos.get(id)?.intro ?? intros[0]!;
    const keys = pass.keysOf(id)!;
    const name = first.item.entry.kind === 'vault.create' ? founding.deviceName : bodyOf(first, 'device.add').name;
    const approvals = intros.filter((p) => p.item.entry.kind === 'device.add').map((p): Approval => {
      const body = bodyOf(p, 'device.add');
      return { hash: p.item.hash, by: p.item.entry.author, ed: body.ed, x: body.x, role: body.role, epoch: body.epoch, key: body.key };
    });
    const removals = pass.removalsOf(id);
    const removedBy = [...new Set(removals.map((r) => r.item.entry.author))].sort();
    state.members[id] = { deviceId: id, ed: keys.ed, x: keys.x, role: keys.role, name, addedBy: first.item.entry.author, joined: pass.joined(id), removed: removals.length > 0 || pass.forkCuts.has(id), removedBy, approvals };
  }
  const lastSet = pass.recoverySets[pass.recoverySets.length - 1];
  if (lastSet) {
    const body = bodyOf(lastSet, 'recovery.set');
    state.recovery = { deviceId: recoveryIdOf(lastSet), ed: body.ed, x: body.x };
  }
  for (const [id, seq] of membership.provenForks) state.forked[id] = seq;

  // The key chain, then keys given to approved devices on it.
  for (const [epoch, placed] of chain.canon.entries()) {
    if (placed.item.entry.kind === 'vault.create') {
      state.sealedKeys[0] = { [placed.item.entry.author]: founding.key };
      state.keyChecks[0] = founding.keyCheck;
      continue;
    }
    const body = placed.item.body as RotationFields;
    state.sealedKeys[epoch] = { ...body.keys };
    state.prevKeys[epoch] = body.prevKey;
    state.keyChecks[epoch] = body.keyCheck;
  }
  state.epoch = chain.canon.length - 1;
  // A joined device's key at its approval's epoch is the one its hello confirmed; other approvals
  // fill only what is still empty, and only with the device's own sealing key once it joined.
  for (const placed of pass.applied) {
    if (placed.item.entry.kind !== 'device.add') continue;
    const body = bodyOf(placed, 'device.add');
    if (body.epoch > state.epoch || !onKeyOrOlder(chain, placed, body.epoch)) continue;
    const sealed = state.sealedKeys[body.epoch]!;
    const confirmed = pass.hellos.get(body.device)?.intro;
    if (confirmed === placed) sealed[body.device] = body.key;
    else if (!Object.hasOwn(sealed, body.device) && (!confirmed || body.x === pass.keysOf(body.device)?.x)) sealed[body.device] = body.key;
  }

  state.unsettledRecovery = membership.unsettled.map((p) => p.item.hash);
  state.needsFreshKey = needsFreshKey(state, chain) || !settledSince(chain, membership.unsettled);
  return cutoffs;
}

/** A key given on approval counts when the approver had seen that epoch's rotation. */
function onKeyOrOlder(chain: KeyChain, placed: Placed, epoch: number): boolean {
  const at = chain.canon[epoch];
  return !!at && (at === placed || sees(placed, at));
}

/** True when nothing went unsettled, or the current key's change came after every unsettled phrase. */
function settledSince(chain: KeyChain, unsettled: readonly Placed[]): boolean {
  if (unsettled.length === 0) return true;
  const current = chain.canon.at(-1);
  return !!current && unsettled.every((p) => sees(current, p));
}

function needsFreshKey(state: VaultState, chain: KeyChain): boolean {
  if (!chain.canon[state.epoch]) return false;
  // Approved devices still waiting to join hold the key their approval gave them.
  const inVault = new Set(Object.values(state.members).filter((m) => !m.removed).map((m) => m.deviceId));
  if (state.recovery) inVault.add(state.recovery.deviceId);
  // The current key reached someone who is no longer in the vault.
  for (const to of Object.keys(state.sealedKeys[state.epoch] ?? {})) if (!inVault.has(to)) return true;
  // The recovery phrase can't read the current key.
  return !!state.recovery && !state.sealedKeys[state.epoch]?.[state.recovery.deviceId];
}

// ---------------------------------------------------------------------------------------------
// Identities and the whole replay.
// ---------------------------------------------------------------------------------------------

/** The identity a verified entry would bring in, whether or not the rules end up applying it. */
function broughtIn(item: VerifiedEntry): string | null {
  const body = item.body as ParsedBody;
  try {
    if (item.entry.kind === 'device.add') {
      const add = body as BodyByKind['device.add'];
      return deviceIdFor(fromBase64Url(add.ed)) === add.device ? add.device : null;
    }
    if (item.entry.kind === 'recovery.set') return deviceIdFor(fromBase64Url((body as BodyByKind['recovery.set']).ed));
  } catch {
    return null;
  }
  return null;
}

interface Discovered {
  known: Map<string, KnownIdentity>;
  chains: Record<string, VerifiedEntry[]>;
  rejected: Rejection[];
}

/**
 * Verifies each identity's log once: the founder's, then every identity an entry of a verified
 * log brings in. An identity's role (device or recovery) is what its own signed first line
 * claims; the rules then check that the entry bringing it in is of the matching kind.
 */
function discoverIdentities(vaultId: string, logs: VaultLogs, founder: KnownIdentity, cache: VerifyCache): Discovered {
  const known = new Map<string, KnownIdentity>([[founder.deviceId, founder]]);
  const chains: Record<string, VerifiedEntry[]> = {};
  const rejected: Rejection[] = [];
  const queue: KnownIdentity[] = [founder];
  while (queue.length > 0) {
    const identity = queue.shift()!;
    const lines = logs[identity.deviceId];
    if (!lines || lines.length === 0) continue;
    const { chain, rejection } = verifyChain(vaultId, identity, lines, cache);
    chains[identity.deviceId] = chain;
    if (rejection) rejected.push(rejection);
    for (const item of chain) {
      const id = broughtIn(item);
      if (!id || known.has(id) || !logs[id]?.length) continue;
      const ed = item.entry.kind === 'device.add' ? (item.body as BodyByKind['device.add']).ed : (item.body as BodyByKind['recovery.set']).ed;
      const next: KnownIdentity = { deviceId: id, ed: fromBase64Url(ed), role: claimedRole(logs[id]![0]) };
      known.set(id, next);
      queue.push(next);
    }
  }
  return { known, chains, rejected };
}

/**
 * At a forked seq, the version others named is the one that counts (rule 4). When the folder
 * holds the version nobody named and a proof carries the one other identities' entries named,
 * the replay reads the proof's version there instead (and nothing of the forker after it, which
 * chains on the other version). Returns the logs to read, or null when nothing changes.
 */
function namedForkVersions(vaultId: string, logs: VaultLogs, discovered: Discovered, proofs: readonly ForkProof[], cache: VerifyCache): VaultLogs | null {
  let out: VaultLogs | null = null;
  for (const proof of proofs) {
    const identity = discovered.known.get(proof?.deviceId);
    if (!identity || forkProofProblem(vaultId, identity, proof) !== null) continue;
    const { deviceId, seq } = proof;
    // A proof of the second kind (a signed line at seq - 1, and one at seq that doesn't chain on
    // it): when the folder has no valid line at seq - 1, the proof's signed one is the only
    // version there is, so every replay reads it (and nothing after it, which doesn't chain on it).
    const first = parseEntryLine(proof.lines[0]);
    if (first && first.seq === seq - 1) {
      if ((discovered.chains[deviceId] ?? []).length > seq - 1 || (logs[deviceId]?.length ?? 0) < seq - 1) continue;
      out ??= { ...logs };
      out[deviceId] = [...(logs[deviceId] ?? []).slice(0, seq - 1), proof.lines[0]];
      continue;
    }
    const folderLine = logs[deviceId]?.[seq];
    // Compared as entries (canonical text): a re-encoded copy of the folder's line is not another version.
    const other = folderLine === undefined ? undefined : proof.lines.find((line) => canonicalLine(line) !== canonicalLine(folderLine));
    if (folderLine === undefined || other === undefined) continue;
    let parsed: SignedEntry;
    try {
      parsed = JSON.parse(other) as SignedEntry;
    } catch {
      continue;
    }
    const otherHash = entryHash(parsed);
    const folderChain = discovered.chains[deviceId] ?? [];
    let otherNamed = false;
    let folderNamed = false;
    // Identities the other version itself brings in are not in `discovered` (nothing in the folder
    // introduces them); their logs name versions too, so every copy, whichever version it holds,
    // decides the same.
    const chains: [string, readonly VerifiedEntry[]][] = Object.entries(discovered.chains);
    if (parsed.kind === 'device.add' && isPlainObject(parsed.body)) {
      const { device, ed } = parsed.body as Partial<BodyByKind['device.add']>;
      if (isId(device) && !discovered.known.has(device) && typeof ed === 'string' && logs[device]) {
        try {
          chains.push([device, verifyChain(vaultId, { deviceId: device, ed: fromBase64Url(ed), role: 'device' }, logs[device], cache).chain]);
        } catch {
          // A key that doesn't decode brings no one in.
        }
      }
    }
    for (const [author, chain] of chains) {
      if (author === deviceId) continue;
      for (const item of chain) {
        const ref = item.entry.seen[deviceId];
        if (!ref || ref.seq < seq) continue;
        if (ref.seq === seq && ref.hash === otherHash) otherNamed = true;
        if (folderChain[ref.seq]?.hash === ref.hash) folderNamed = true;
      }
    }
    if (!otherNamed || folderNamed) continue;
    out ??= { ...logs };
    out[deviceId] = [...logs[deviceId]!.slice(0, seq), other];
  }
  return out;
}

/**
 * Rule A1.2, solo vaults only: a proven fork of the recovery identity R never cuts R. R is the
 * phrase; a computer that collected two lines R signed at one seq (a refused phrase change or
 * restore, signed again) must not be able to kill it. Instead, at R's forked seq one version
 * counts, the same on every copy:
 *  - The versions are the line the folder's log of R holds at that seq and the lines of every
 *    valid proof about that seq (each signed by R, at that seq). Until the folder holds a line of
 *    R at the seq, the proofs change nothing.
 *  - The winner, in this order:
 *    1. A version an independent identity built on: a verified line that applies names it in
 *       `seen`, or a `device.hello` names it as its approval. The author is not a recovery
 *       identity and stands outside the fork (a member in the vault as it reads with every
 *       version, so no version brings it in), and the line is judged in the reading where the
 *       version it names counts: applied there, its author not cut or forked at or before it. So
 *       a version that cuts the builder (an old phrase's restore) can't void the line that built
 *       on the other one; R's own chaining, junk and devices a version brings in never decide.
 *       Only each builder's earliest verified line naming any version at that seq counts, and a
 *       builder forked at or below that line keeps the line the folder holds (builtOnVersions).
 *    2. Among what is left (the built-on versions, else all): a `recovery.set` beats a restore.
 *    3. Restore against restore: the one whose new device signed more lines beyond its hello
 *       (its log verified against the add's key, starting with a hello approving that add); a
 *       computer can't sign those, nor change their number by withholding R's key change.
 *    4. The lowest entry hash.
 *    The app's own phrase change is built on at once: the active device's next line names it,
 *    and a repair always writes that line back (it applies in its own version's reading). An
 *    adopted solo restore gets a line past its hello at once (its own name again), after the
 *    restore append, never in it: attempts the computer refused and kept never get one, so they
 *    can't tie. If another device's version wins before that line lands, the app signs the
 *    restore again on top of it; if an earlier attempt of the same phone's wins, the app adopts it.
 *  - The replay reads the winner at that seq, then R's folder lines after it, which count only
 *    while they chain on it. The losing versions, and anything built only on them, are rejected:
 *    a losing line the folder held, and the lines of a device only a losing device.add brings in,
 *    show in the history as rejected ("lost to another version"), account lines among them caught.
 * A winning `recovery.set` then cuts R at its own seq, as every applied phrase change does. Proofs
 * of the second kind (a line that doesn't chain on R's line before it) choose nothing and cut
 * nothing for R: R's chain in the folder already reads one history.
 */
function splitRecoveryProofs(founding: string | undefined, discovered: Discovered, proofs: readonly ForkProof[]): { recoveryProofs: ForkProof[]; forks: ForkProof[] } {
  const created = parseEntryLine(founding);
  const solo = created?.kind === 'vault.create' && isPlainObject(created.body) && created.body.kind === 'solo';
  if (!solo) return { recoveryProofs: [], forks: [...proofs] };
  const recoveryProofs: ForkProof[] = [];
  const forks: ForkProof[] = [];
  for (const proof of proofs) {
    if (discovered.known.get(proof?.deviceId)?.role === 'recovery') recoveryProofs.push(proof);
    else forks.push(proof);
  }
  return { recoveryProofs, forks };
}

export const LOST_RECOVERY_VERSION = 'the recovery phrase signed another version of this line, and that one counts';
const BUILT_ON_LOST_VERSION = 'it was built on a line of the recovery phrase that lost to another version';

interface RecoveryFork {
  logs: VaultLogs;
  /** Versions that lost, by hash, with the line the folder held when it was one of them. */
  losers: Map<string, { entry: SignedEntry; inFolder: boolean }>;
}

function soloRecoveryVersions(vaultId: string, logs: VaultLogs, discovered: Discovered, proofs: readonly ForkProof[], cache: VerifyCache, base: ReplayOptions): RecoveryFork | null {
  const bySeq = new Map<string, Map<number, Set<string>>>();
  for (const proof of proofs) {
    const identity = discovered.known.get(proof.deviceId)!;
    if (forkProofProblem(vaultId, identity, proof, cache) !== null) continue;
    const first = parseEntryLine(proof.lines[0]);
    if (!first || first.seq !== proof.seq) continue;
    let seqs = bySeq.get(proof.deviceId);
    if (!seqs) bySeq.set(proof.deviceId, (seqs = new Map()));
    const lines = seqs.get(proof.seq) ?? new Set<string>();
    proof.lines.forEach((line) => lines.add(line));
    seqs.set(proof.seq, lines);
  }
  let out: VaultLogs | null = null;
  const losers = new Map<string, { entry: SignedEntry; inFolder: boolean }>();
  for (const [deviceId, seqs] of [...bySeq].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const identity = discovered.known.get(deviceId)!;
    for (const seq of [...seqs.keys()].sort((a, b) => a - b)) {
      const current = out ?? logs;
      const log = current[deviceId] ?? [];
      if (log.length <= seq) continue;
      const folderLine = log[seq]!;
      const versions = new Map<string, { line: string; entry: SignedEntry }>();
      for (const line of [folderLine, ...seqs.get(seq)!]) {
        const entry = parseEntryLine(line);
        if (!entry || entry.author !== deviceId || entry.seq !== seq || entryShapeProblem(entry) !== null) continue;
        const hash = entryHash(entry);
        if (versions.has(hash)) continue;
        // The folder's line is only a version when R signed it (the proofs' lines were checked).
        if (line === folderLine && !seqs.get(seq)!.has(line) && !signedBy(entry, identity, cache)) continue;
        versions.set(hash, { line, entry });
      }
      if (versions.size < 2) continue;
      // The vault as it reads with each version at this seq (R's folder lines after it count only while they chain on it).
      const forced = new Map<string, VaultState>();
      for (const [hash, { line }] of versions) {
        const withVersion = { ...current, [deviceId]: [...log.slice(0, seq), line, ...log.slice(seq + 1)] };
        forced.set(hash, replayVault(vaultId, withVersion, { cache, forks: base.forks, sealProofs: base.sealProofs }));
      }
      const named = builtOnVersions(deviceId, seq, versions, forced, discovered);
      const winner = pickVersion(vaultId, current, named.length > 0 ? named : [...versions.keys()], versions, cache);
      const folderHash = parseEntryLine(folderLine) ? entryHash(parseEntryLine(folderLine)!) : null;
      for (const [hash, { entry }] of versions) if (hash !== winner) losers.set(hash, { entry, inFolder: hash === folderHash });
      if (winner === folderHash) continue;
      out ??= { ...logs };
      out[deviceId] = [...log.slice(0, seq), versions.get(winner)!.line, ...log.slice(seq + 1)];
    }
  }
  return losers.size === 0 ? null : { logs: out ?? logs, losers };
}

/**
 * Among the versions still in the running (built on, else all): a `recovery.set` beats a restore
 * (a `device.add`); between restores, the one whose new device signed more lines beyond its hello
 * (its log verified against the add's key, starting with a hello that approves that add: only that
 * device can sign them, and unlike whether they apply, a computer can't change their number by
 * withholding R's key change); then the lowest entry hash.
 */
function pickVersion(vaultId: string, logs: VaultLogs, pool: readonly string[], versions: ReadonlyMap<string, { entry: SignedEntry }>, cache: VerifyCache): string {
  let left = [...pool].sort();
  const sets = left.filter((hash) => versions.get(hash)!.entry.kind === 'recovery.set');
  if (sets.length > 0) left = sets;
  else {
    const used = (hash: string): number => {
      const entry = versions.get(hash)!.entry;
      if (entry.kind !== 'device.add' || !isPlainObject(entry.body)) return 0;
      const { device, ed } = entry.body as Partial<BodyByKind['device.add']>;
      if (!isId(device) || typeof ed !== 'string' || !Object.hasOwn(logs, device)) return 0;
      try {
        const chain = verifyChain(vaultId, { deviceId: device, ed: fromBase64Url(ed), role: 'device' }, logs[device]!, cache).chain;
        const hello = chain[0];
        if (!hello || hello.entry.kind !== 'device.hello' || (hello.body as { approval?: unknown }).approval !== hash) return 0;
        return chain.length - 1;
      } catch {
        return 0;
      }
    };
    const most = Math.max(...left.map(used));
    left = left.filter((hash) => used(hash) === most);
  }
  return left[0]!;
}

function signedBy(entry: SignedEntry, identity: KnownIdentity, cache: VerifyCache): boolean {
  try {
    return cache.signatureValid(identity.ed, digestEntry(entry));
  } catch {
    return false;
  }
}

/**
 * The versions of R's line at `seq` that an independent identity built on (see
 * soloRecoveryVersions): a line names the version in `seen`, or is a `device.hello` approved by
 * it. The author must not be a recovery identity and must stand outside the fork: a member in the
 * vault as it reads with every version (`forced`), so no version brings it in. Only the author's
 * earliest verified line naming any version at that seq counts; a later line naming another one
 * is ignored (so a key taken from the phone can't add a second builder after the ack). That line is
 * judged in the reading where the version it names counts: applied there, its author not cut at
 * or before it. A builder forked at or below that line keeps the line the folder holds (as the
 * fork rule keeps what others built on), so a fork proof can't void the ack either. Junk lines,
 * R's own chaining and devices a version brings in never decide.
 */
function builtOnVersions(recoveryId: string, seq: number, versions: ReadonlyMap<string, unknown>, forced: ReadonlyMap<string, VaultState>, discovered: Discovered): string[] {
  const states = [...forced.values()];
  const recoveryIds = new Set<string>([recoveryId]);
  for (const [id, known] of discovered.known) if (known.role === 'recovery') recoveryIds.add(id);
  const independent = (author: string) => states.every((state) => Object.hasOwn(state.members, author));
  const stands = (author: string, line: VerifiedEntry, version: string) => {
    const state = forced.get(version);
    if (!state || !independent(author)) return false;
    // Forked at or below this line: the folder's line still counts (a fork proof can't void the ack).
    if (Object.hasOwn(state.forked, author) && state.forked[author]! <= line.entry.seq) return true;
    if (state.chains[author]?.[line.entry.seq] !== line.hash) return false;
    return !Object.hasOwn(state.cutoffs, author) || state.cutoffs[author]! >= line.entry.seq;
  };
  // Per author, its earliest verified line (the folder's, as every reading holds it) naming a version at this seq.
  const earliest = new Map<string, { item: VerifiedEntry; names: string[] }>();
  for (const [author, chain] of Object.entries(discovered.chains)) {
    if (recoveryIds.has(author)) continue;
    for (const item of chain) {
      const ref = item.entry.seen[recoveryId];
      const byRef = ref && ref.seq === seq && versions.has(ref.hash) ? ref.hash : null;
      const approval = item.entry.kind === 'device.hello' ? (item.body as { approval?: unknown }).approval : undefined;
      const byApproval = typeof approval === 'string' && versions.has(approval) ? approval : null;
      const names = [...new Set([byRef, byApproval].filter((h): h is string => h !== null))];
      if (names.length === 0) continue;
      earliest.set(author, { item, names });
      break;
    }
  }
  const named = new Set<string>();
  for (const [author, { item, names }] of earliest) for (const version of names) if (stands(author, item, version)) named.add(version);
  return [...named];
}

/** The device a `device.add` brings in that nothing else in the folder does, with its log checked against the add's key. */
function deviceBroughtIn(vaultId: string, logs: VaultLogs, discovered: Discovered, entry: SignedEntry, cache: VerifyCache): { deviceId: string; chain: VerifiedEntry[] } | null {
  if (entry.kind !== 'device.add' || !isPlainObject(entry.body)) return null;
  const { device, ed } = entry.body as Partial<BodyByKind['device.add']>;
  if (!isId(device) || discovered.known.has(device) || typeof ed !== 'string' || !logs[device]?.length) return null;
  try {
    return { deviceId: device, chain: verifyChain(vaultId, { deviceId: device, ed: fromBase64Url(ed), role: 'device' }, logs[device]!, cache).chain };
  } catch {
    return null;
  }
}

/** History for what lost at R's forked seqs: the folder's losing lines, and the lines of devices only a losing add brings in. */
function lostRecoveryHistory(vaultId: string, logs: VaultLogs, known: ReadonlyMap<string, KnownIdentity>, fork: RecoveryFork, cache: VerifyCache): { items: HistoryItem[]; devices: Set<string> } {
  const items: HistoryItem[] = [];
  const devices = new Set<string>();
  const discovered: Discovered = { known: new Map(known), chains: {}, rejected: [] };
  for (const [hash, { entry, inFolder }] of fork.losers) {
    if (inFolder) items.push({ hash, author: entry.author, seq: entry.seq, time: entry.time, kind: entry.kind, status: 'rejected', reason: LOST_RECOVERY_VERSION });
    const brought = deviceBroughtIn(vaultId, logs, discovered, entry, cache);
    if (!brought) continue;
    devices.add(brought.deviceId);
    for (const item of brought.chain) {
      const account = item.entry.kind === 'account.put' || item.entry.kind === 'account.delete';
      items.push({ hash: item.hash, author: item.entry.author, seq: item.entry.seq, time: item.entry.time, kind: item.entry.kind, status: 'rejected', reason: BUILT_ON_LOST_VERSION, ...(account ? { caught: true as const } : {}) });
    }
  }
  return { items, devices };
}

function parseEntryLine(line: string | undefined): SignedEntry | null {
  if (typeof line !== 'string') return null;
  try {
    const value = JSON.parse(line) as SignedEntry;
    return value && typeof value === 'object' && typeof value.seq === 'number' ? value : null;
  } catch {
    return null;
  }
}

/** Valid fork proofs: identity -> the first seq it signed twice. */
function forkCutsFrom(vaultId: string, known: Map<string, KnownIdentity>, proofs: readonly ForkProof[]): Map<string, number> {
  const cuts = new Map<string, number>();
  for (const proof of proofs) {
    const identity = known.get(proof?.deviceId);
    if (!identity || forkProofProblem(vaultId, identity, proof) !== null) continue;
    cuts.set(identity.deviceId, Math.min(cuts.get(identity.deviceId) ?? Number.MAX_SAFE_INTEGER, proof.seq));
  }
  return cuts;
}

const CUT_OFF_REASON = 'the author was removed from the vault before this entry';
const STANDING_CUT_REASON = 'its author was removed or replaced, and this entry came after what the change that took it out had seen';

/**
 * True symmetry (rule 2): applied removals `r` (of T, by A) made without seeing an applied
 * removal `q` of A whose author is in the vault only through T's lines `r` hadn't seen (T
 * itself, or a device T approved unseen by `r`). Returns those `r` with the devices on both
 * sides; their account changes the cutoff rejected are marked `caught`, and an honest agent
 * takes such an `r` from an author already out (docs/authenticator.md, "What the computer takes").
 */
function symmetricConflicts(pass: MembershipPass, entries: readonly Placed[]): { counters: Placed[]; sides: Set<string> } {
  const counters: Placed[] = [];
  const sides = new Set<string>();
  const introsSeen = approvalsSeen(entries);
  for (const [target, removals] of pass.removals) {
    for (const r of removals) {
      const author = r.item.entry.author;
      const limit = r.past[target] ?? -1;
      const q = pass.removalsOf(author).find((q) => concurrent(r, q) && enabledThrough(q, q.item.entry.author, target, limit, introsSeen, pass.founder, 0));
      if (!q) continue;
      counters.push(r);
      sides.add(author).add(target);
    }
  }
  return { counters, sides };
}

/** Every approval of a device that `view` saw, applied or not (lookup over `entries`). */
function approvalsSeen(entries: readonly Placed[]): (view: Placed, id: string) => Placed[] {
  const adds = new Map<string, Placed[]>();
  for (const p of entries) {
    if (p.item.entry.kind !== 'device.add') continue;
    const device = bodyOf(p, 'device.add').device;
    const list = adds.get(device);
    if (list) list.push(p);
    else adds.set(device, [p]);
  }
  return (view, id) => (adds.get(id) ?? []).filter((p) => p === view || sees(view, p));
}

/**
 * True when `id`, as `view` knows it, is in the vault only through lines `target` signed after
 * `limit`: it is the target itself, or every approval of it that `view` saw is such a line or
 * comes from a device that is itself in only that way.
 */
function enabledThrough(view: Placed, id: string, target: string, limit: number, introsSeen: (view: Placed, id: string) => readonly Placed[], founder: string | null, depth: number): boolean {
  if (id === target) return true;
  if (id === founder || depth > MAX_IDENTITIES) return false;
  const intros = introsSeen(view, id);
  if (intros.length === 0) return false;
  return intros.every((p) => {
    const { author, seq } = p.item.entry;
    return author === target ? seq > limit : enabledThrough(view, author, target, limit, introsSeen, founder, depth + 1);
  });
}

function markCaught(state: VaultState, pass: MembershipPass, entries: readonly Placed[], contested: ReadonlySet<string> = new Set(), proven: ReadonlyMap<string, number> = new Map()): void {
  const { counters, sides } = symmetricConflicts(pass, entries);
  state.counterRemovals = counters.map((p) => p.item.hash);
  const voidedKinds = new Set(['device.remove', 'device.add', 'recovery.set', 'key.rotate']);
  for (const item of state.history) {
    // Any account line of a side past its cutoff (also when the cut fell before its own hello).
    const cut = Object.hasOwn(state.cutoffs, item.author) ? state.cutoffs[item.author]! : undefined;
    const account = item.kind === 'account.put' || item.kind === 'account.delete';
    if (item.status === 'rejected' && account && sides.has(item.author) && cut !== undefined && item.seq > cut) item.caught = true;
    // A device a solo restore took out (the old phone, maybe in a thief's hands): its account changes after the cut.
    if (item.status === 'rejected' && account && cut !== undefined && item.seq > cut && pass.removalsOf(item.author).some((p) => pass.restores.includes(p))) item.caught = true;
    // A contested forked seq (honest lines built on both versions): the forker's account changes from there are caught.
    if (item.status === 'rejected' && account && contested.has(item.author) && item.seq >= proven.get(item.author)!) item.caught = true;
    if (item.status === 'rejected' && voidedKinds.has(item.kind) && pass.removalsOf(item.author).length > 0 && (item.reason === CUT_OFF_REMOVAL || item.reason === STANDING_CUT_REASON)) item.voided = true;
  }
}

function headOf(item: VerifiedEntry): Head {
  return { seq: item.entry.seq, hash: item.hash, time: item.entry.time };
}

/**
 * Seal proofs that hold (sealProof.ts judgeSealProof), judged on the replay without them: the
 * proof names an entry and its recipient's own sealing key, and shows the seal can't open, so
 * it holds whatever else the folder says. Each author is cut at the seq before its earliest
 * proven entry; the key changes among them keep their epoch as a dead key.
 */
function provenBadSeals(vaultId: string, logs: VaultLogs, options: ReplayOptions): SealCuts {
  const proofs = options.sealProofs ?? [];
  if (proofs.length === 0) return NO_SEAL_CUTS;
  const plain = replayVault(vaultId, logs, { cache: options.cache, forks: options.forks });
  const cuts = new Map<string, number>();
  const dead = new Set<string>();
  for (const proof of proofs) {
    let verdict: ReturnType<typeof judgeSealProof>;
    try {
      verdict = judgeSealProof(plain, logs, proof);
    } catch {
      continue;
    }
    if (!verdict.ok) continue;
    cuts.set(verdict.author, Math.min(cuts.get(verdict.author) ?? Number.MAX_SAFE_INTEGER, verdict.seq));
    dead.add(verdict.hash);
  }
  return cuts.size === 0 ? NO_SEAL_CUTS : { cuts, dead };
}

const BAD_SEAL_REASON = (seq: number) => `its author gave out, at seq ${seq}, a vault key that does not open for a device it sealed it to (proven), so nothing it wrote from there counts`;

/**
 * After a proven bad seal: the author's lines from there say why they are rejected, and account
 * changes made under a voided key change's key (by anyone) are caught, to be offered for review
 * and made again under a key that opens.
 */
/** How many of a restored-out device's last account lines (by seq) are offered back besides its deletes (P3). */
export const RESTORE_REVIEW_LINES = 50;

/** Sets `restoreReview` (see HistoryItem) in a solo vault: in one, only a restore removes a device. */
function markRestoreReview(state: VaultState): void {
  const removed = (id: string) => Object.hasOwn(state.members, id) && state.members[id]!.removed === true;
  const byAuthor = new Map<string, HistoryItem[]>();
  for (const item of state.history) {
    if (item.status !== 'applied' || (item.kind !== 'account.delete' && item.kind !== 'account.put') || !removed(item.author)) continue;
    byAuthor.set(item.author, [...(byAuthor.get(item.author) ?? []), item]);
  }
  for (const items of byAuthor.values()) {
    const recent = new Set(items.sort((a, b) => b.seq - a.seq).slice(0, RESTORE_REVIEW_LINES));
    for (const item of items) if (item.kind === 'account.delete' || recent.has(item)) item.restoreReview = true;
  }
}

function markBadSeals(state: VaultState, ordered: readonly Placed[], sealCuts: SealCuts, proven: ReadonlyMap<string, number>): void {
  const deadEpochs = new Map<number, Placed>();
  for (const p of ordered) if (sealCuts.dead.has(p.item.hash) && KEY_BEARING.has(p.item.entry.kind)) deadEpochs.set((p.item.body as RotationFields).epoch, p);
  const byHash = new Map(ordered.map((p) => [p.item.hash, p]));
  for (const item of state.history) {
    const seq = sealCuts.cuts.get(item.author);
    if (item.status === 'rejected' && seq !== undefined && item.seq >= seq && (proven.get(item.author) ?? Number.MAX_SAFE_INTEGER) >= seq) item.reason = BAD_SEAL_REASON(seq);
    if (item.status !== 'rejected' || (item.kind !== 'account.put' && item.kind !== 'account.delete')) continue;
    const placed = byHash.get(item.hash);
    const epoch = placed?.item.entry.kind === 'account.put' ? (placed.item.body as BodyByKind['account.put']).box.epoch : undefined;
    const voided = epoch === undefined ? undefined : deadEpochs.get(epoch);
    if (placed && voided && (placed === voided || sees(placed, voided))) item.caught = true;
  }
}

/**
 * Verifies every identity's log, orders the entries and applies them. Pure and deterministic:
 * the same logs and fork proofs give the same state on every device, in any read order.
 */
/**
 * The signing key of an identity the folder's logs bring in (a device or a recovery identity,
 * current or replaced), base64url, or null. What a fork proof about it is checked against.
 */
export function identityEd(vaultId: string, rawLogs: VaultLogs, deviceId: string, cache = new VerifyCache()): string | null {
  return identityEds(vaultId, rawLogs, cache).get(deviceId) ?? null;
}

/** Every identity's signing key the folder's logs bring in, in one pass (see identityEd). */
export function identityEds(vaultId: string, rawLogs: VaultLogs, cache = new VerifyCache()): Map<string, string> {
  const logs: VaultLogs = Object.fromEntries(Object.entries(rawLogs).filter(([id]) => isId(id)));
  const founder = findFounder(vaultId, logs);
  if (!founder) return new Map();
  return new Map([...discoverIdentities(vaultId, logs, founder, cache).known].map(([id, known]) => [id, toBase64Url(known.ed)]));
}

export function replayVault(vaultId: string, rawLogs: VaultLogs, options: ReplayOptions = {}): VaultState {
  const cache = options.cache ?? new VerifyCache();
  // Only real ids name logs: a key like "__proto__" from a hostile folder never reaches a lookup.
  let logs: VaultLogs = Object.fromEntries(Object.entries(rawLogs).filter(([deviceId]) => isId(deviceId)));
  const state = emptyState(vaultId);
  const founder = findFounder(vaultId, logs);
  let discovered: Discovered = founder ? discoverIdentities(vaultId, logs, founder, cache) : { known: new Map(), chains: {}, rejected: [] };
  // Solo: proofs about the recovery identity choose a version (soloRecoveryVersions) and never cut it.
  const { recoveryProofs, forks } = splitRecoveryProofs(founder ? logs[founder.deviceId]?.[0] : undefined, discovered, options.forks ?? []);
  const recoveryFork = founder && recoveryProofs.length > 0 ? soloRecoveryVersions(vaultId, logs, discovered, recoveryProofs, cache, { forks, sealProofs: options.sealProofs }) : null;
  if (recoveryFork) {
    logs = recoveryFork.logs;
    discovered = discoverIdentities(vaultId, logs, founder!, cache);
  }
  const swapped = founder ? namedForkVersions(vaultId, logs, discovered, forks, cache) : null;
  if (swapped) {
    logs = swapped;
    discovered = discoverIdentities(vaultId, logs, founder!, cache);
  }
  const { known, chains } = discovered;
  const order = orderEntries(chains, new Map(Object.entries(logs).map(([id, lines]) => [id, lines.length])));
  const proven = forkCutsFrom(vaultId, known, forks);
  const sealCuts = provenBadSeals(vaultId, rawLogs, options);
  const { membership, contested } = decideWithForks(vaultId, order, founder?.deviceId ?? null, proven, judgeCacheFor(cache), sealCuts);
  const { chain, misnumbered } = keyChain(membership);
  const cutoffs = settleMembership(state, membership, chain);
  // A key.rotate numbered wrong changes nobody, so refusing it after the passes changes nothing else.
  const refusedLate = new Map([...misnumbered].filter(([p]) => p.item.entry.kind === 'key.rotate'));
  const decided: Decided = { pass: membership.pass, chain, cutoffs, refusedLate, overShare: overShare(chains, logs, membership.pass) };

  state.rejected.push(...discovered.rejected);
  const lostOnly = recoveryFork ? lostRecoveryHistory(vaultId, logs, known, recoveryFork, cache) : null;
  for (const [deviceId, lines] of Object.entries(logs)) {
    if (known.has(deviceId) || lines.length === 0 || lostOnly?.devices.has(deviceId)) continue;
    state.rejected.push({ deviceId, seq: 0, reason: `no applied entry introduces this device, so its ${lines.length} entr${lines.length === 1 ? 'y is' : 'ies are'} ignored` });
  }
  for (const [deviceId, verified] of Object.entries(chains)) {
    if (verified.length === 0) continue;
    state.heads[deviceId] = headOf(verified[verified.length - 1]!);
    state.chains[deviceId] = verified.map((item) => item.hash);
    const raw = Object.hasOwn(rawLogs, deviceId) ? rawLogs[deviceId]! : [];
    verified.forEach((item, seq) => {
      if (raw[seq] === undefined || raw[seq] === item.text || logs[deviceId]![seq] !== raw[seq]) return;
      state.reencoded ??= {};
      (state.reencoded[deviceId] ??= {})[seq] = item.text;
    });
  }
  for (const placed of order.ordered) {
    applyInOrder(state, placed, decided);
    if (state.history[state.history.length - 1]!.status !== 'applied') continue;
    state.appliedHeads[placed.item.entry.author] = headOf(placed.item);
    for (const [named, ref] of Object.entries(placed.item.entry.seen)) {
      if (named === placed.item.entry.author || !isId(named)) continue;
      state.pins ??= {};
      const pin = Object.hasOwn(state.pins, named) ? state.pins[named] : undefined;
      if (!pin || ref.seq > pin.seq) state.pins[named] = { seq: ref.seq, hash: ref.hash };
    }
  }
  for (const { item, waitsFor } of order.waiting) {
    const { entry, hash } = item;
    const reason = waitsFor ? 'it names an entry that is not in the folder yet' : 'it follows an entry that is still waiting';
    state.history.push({ hash, author: entry.author, seq: entry.seq, time: entry.time, kind: entry.kind, status: 'waiting', reason, ...(waitsFor ? { waitsFor } : {}) });
  }
  if (lostOnly) state.history.push(...lostOnly.items);
  state.cutoffs = cutoffs;
  markCaught(state, membership.pass, order.ordered, contested, proven);
  if (sealCuts.cuts.size > 0) markBadSeals(state, order.ordered, sealCuts, proven);
  if (state.kind === 'solo') markRestoreReview(state);
  state.conflicts = order.conflicts;
  state.unkeyedDevices = Object.values(state.members)
    .filter((m) => !m.removed && state.sealedKeys[state.epoch]?.[m.deviceId]?.r !== m.x)
    .map((m) => m.deviceId)
    .sort();
  return state;
}
