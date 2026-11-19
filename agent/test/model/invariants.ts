/**
 * The security invariants, checked on a scenario's final folder. Each returns the violations it
 * finds with what was expected and what replay gave. Definitions the docs leave open are made
 * precise here (see INVARIANTS for the one-line statements the report prints).
 *
 * Terms:
 * - "honest removal of X": a device.remove of X signed by an honest device that was an active
 *   admin holding the current key in its own synced view (the simulator only signs those).
 * - "valid" honest removal: one that applies in the folder without any of the thief's lines.
 * - "attacker lines": lines the thief signed after it was stolen, and its puppets' lines.
 * - "truly concurrent": neither line has the other in its causal past (prev + seen, transitively).
 */
import { checkBeacons, type VaultState } from '../../src/vault/index';
import { Causality } from './causal';
import { MODEL_LIMITS, QUOTA_REFUSAL } from './quota';
import { applyOp, attackerLabels, folderView, isAttacker, KEY_CHANGE_KINDS, labelOfId, localView, MEMBERSHIP_CHANGE_KINDS, shareRound, stateOf, viewOf, type Line, type Op, type View, type World } from './world';

export interface Violation {
  invariant: number;
  summary: string;
  expected: string;
  got: string;
}

export const INVARIANTS: Record<number, string> = {
  1: 'The thief stays out: if X is removed in the folder without the thief\'s lines, it is removed with them.',
  2: 'What was cut off stays cut off: no applied line above a cutoff (a removal past its author\'s cutoff is judged by invariant 8), and no key made after an applied removal of X is sealed to X.',
  3: 'Removals protect their past: X\'s lines outside the causal past of an applied removal of X never flip an entry in that past from applied to rejected. Exceptions: the removal is the counter-removal of the remover that cut its author (the rules\' state.counterRemovals), and then every party must end up removed; or the flipped entry\'s author was cut off by an applied removal it hadn\'t seen and it is no such counter-removal, or its author\'s introduction was voided that way (directly or transitively).',
  4: 'Honest-only runs never lose anything: a removal once applied in the folder stays applied, and an account once applied exists after the honest devices sync and remake their rejected puts (unless every author of it was cut off before it or is no longer in the vault).',
  5: 'Same answer everywhere: the same lines (and fork proofs) give an identical state in any read order. Clocks change outcomes only through the tie-break between concurrent key changes: never whether a removal applies, nor whether a device is a member when an approval of it by a device (not a recovery phrase whose own standing the tie-break decides) is involved, unless the applied key changes themselves differ.',
  6: 'Rejected entries have no effect: deleting a rejected tail of a log (that no other line names) leaves the state and every other line\'s status unchanged. Exempt: a line by an author not cut off at it that names a forker at or past its fork seq (evidence of what was published).',
  7: 'Honest devices can always go on: an honest active admin holding the key (or, with none, the current honest recovery phrase) can write a fresh key if needed and then an account put that applies.',
  8: 'The thief can at most force a true-symmetric "all out": after a valid honest removal of it, the thief is removed, never holds the current key unless the vault needs a fresh key (or nobody is left), never has an applied recovery.set the removal had not seen, no puppet it approved unseen by that removal stays active, and none of its removals that had seen the honest removal apply. For any author: a membership change past its author\'s cutoff applies only if it is the counter-removal of the remover that cut it, directly or indirectly (the rules\' state.counterRemovals); any other removal by a cut-off author is void, even if symmetric with a third device\'s removal.',
  9: 'Nothing an out (removed, cut-off, forked or never-in) author sends through the agent changes state, except its counter-removal of the remover that cut it (directly or indirectly; the rules\' state.counterRemovals); lines ahead of it are admitted only if each ends rejected or caught. And an honest counter-removal is always admitted, whatever lines precede it in its own log.',
  10: 'Only a forker is accused, and only for what nobody built on: a fork proof never rejects an entry of the forker that another identity (not cut off) has in the causal past of one of its entries that applied without the proof, so the forker\'s cutoff is the highest seq others built on (at least forkSeq - 1), unless identities not cut off built on more than one version at a seq: that seq is contested, neither version\'s membership or key effect applies and its account lines are caught. It never cuts off an honest device; a `seen` naming a hash that does not exist changes no other device\'s lines; and once honest devices share proofs, each one\'s own copy gives the same membership, key, recovery and accounts as the folder.',
  11: 'Roles hold: in a team vault no membership change signed by a plain member applies, every device keeps the role of its first applied approval, and a malicious member can never stop an honest admin from removing it (not by filling its quota either).',
  12: 'Joins complete: a pending join approved by an honest admin completes (the joiner\'s checkJoinedVault says ok), even if a malicious admin pre-signed a squatting approval, and the honest admin can still remove the squatter.',
  13: 'The honest agent takes what it should: every honest batch from an author still in the vault (placeholders included). (A refused honest counter-removal is reported under invariant 9.)',
  15: 'Beacons raise no false alarm: once every honest device has synced, no honest device\'s beacon check reports a problem against another honest device\'s beacon, or against a removed or cut-off device\'s beacon.',
  16: 'Signatures hold: every applied line (in the folder and in each honest device\'s copy) carries a valid signature by its author, so a line chained on a garbage-signed line never applies either; and every divergence between an author\'s log in an honest copy and in the folder yields a valid fork proof once honest devices sync.',
  17: 'Joined devices hold the key: a device whose hello applied either opens the current key, or is listed in unkeyedDevices and an honest admin (or the owner\'s phrase) can approve it again so that it does.',
  18: 'The caps never lock honest devices out: with model-scale quotas and reserve, the agent never refuses an honest active admin\'s removal of a device still in the vault, nor a restore with the honest recovery phrase, however an attacker filled its quota and the reserve.',
  19: 'Bad seals cost nothing: after a key change whose keyCheck is right but whose key sealed to other recipients (the recovery identity included) is wrong, no honest device loses an account it could read before (it falls back read-only to the newest epoch it opens), an honest admin can still remove the author, a restore with the honest phrase still opens the vault, and once honest devices sync and share seal proofs (seals/<authorId>.json) the line is void, the author is cut off at the line before and their copies agree.',
  20: 'Removals of active devices apply: an honest active admin\'s removal of a device that is active in the final state applies (e.g. a puppet whose removal by a thief was voided).',
  21: 'No ghost contests: a fork seq is contested only by evidence from identities that still stand at the end, are not cut off at the line, and are two different identities (one per version).',
  22: 'Caps recover: once the attackers are removed, the agent never refuses an honest line within its author\'s share because the vault is full, even after a member wrote past its share straight into the folder.',
  23: 'Bytes don\'t matter: a re-encoded honest line (the same signed entry with whitespace) is a bad line in the folder only: it changes no outcome on honest devices, which hold canonical copies, and an honest agent send writes the canonical line back over it.',
  14: 'An exact retry changes nothing: an honest device that sends again the same bytes the agent already stored (its answer was lost) is not refused.',
};

/** Everything the checks share about one folder. */
class Folder {
  readonly view: View;
  readonly state: VaultState;
  readonly causal: Causality;
  readonly lines: Line[];
  private readonly statuses: Map<string, string>;
  private withoutAttackCache: VaultState | null = null;
  private sharedCache: World | null = null;

  constructor(readonly world: World) {
    this.view = folderView(world);
    this.state = stateOf(world, this.view);
    this.causal = new Causality(world);
    this.lines = Object.values(world.lines).flatMap((log) => log.filter((l) => l.seq < (world.published[l.label] ?? 0)));
    this.statuses = statusMap(this.state);
  }

  status(line: Line): string {
    return this.statuses.get(line.hash) ?? 'not read';
  }

  id(label: string): string {
    return this.world.ids[label]!;
  }

  /** The folder with each label's log cut to at most `limits[label]` lines. */
  truncated(limits: Record<string, number>): { view: View; state: VaultState } {
    const counts: Record<string, number> = { ...this.world.published };
    for (const [label, limit] of Object.entries(limits)) counts[label] = Math.min(counts[label] ?? 0, limit);
    const view = viewOf(this.world, counts);
    return { view, state: stateOf(this.world, view) };
  }

  /** The folder without any attacker line. */
  withoutAttack(): VaultState {
    if (this.withoutAttackCache) return this.withoutAttackCache;
    const limits: Record<string, number> = {};
    for (const line of this.lines) if (!line.honest) limits[line.label] = Math.min(limits[line.label] ?? Infinity, line.seq);
    this.withoutAttackCache = this.truncated(limits).state;
    return this.withoutAttackCache;
  }

  /** The world after every honest device has synced twice round (sent what it can, read every proof). */
  shared(): World {
    this.sharedCache ??= shareRound(this.world);
    return this.sharedCache;
  }

  hasAttack(): boolean {
    return this.lines.some((l) => !l.honest);
  }

  removalsOf(label: string, filter: (line: Line) => boolean = () => true): Line[] {
    return this.lines.filter((l) => l.entry.kind === 'device.remove' && l.subject === label && filter(l));
  }

  describe(line: Line): string {
    return `${line.label}#${line.seq} ${line.entry.kind}${line.subject ? ` ${line.subject}` : ''}`;
  }

  describeStatus(state: VaultState, line: Line): string {
    const item = state.history.find((h) => h.hash === line.hash);
    if (!item) return `${this.describe(line)}: not read`;
    return `${this.describe(line)}: ${item.status}${item.reason ? ` (${item.reason})` : ''}`;
  }
}

function statusMap(state: VaultState): Map<string, string> {
  return new Map(state.history.map((h) => [h.hash, h.status]));
}

function statusIn(state: VaultState, line: Line): string {
  return state.history.find((h) => h.hash === line.hash)?.status ?? 'not read';
}

/**
 * The ruling on S2: an entry may turn rejected after the fact when its author is cut off by an
 * applied removal the entry hadn't seen, and the entry is not a true-symmetric counter-removal.
 * This holds for honest authors too.
 */
function voidedByCutoff(folder: Folder, line: Line): boolean {
  const cutoff = folder.state.cutoffs[line.entry.author];
  if (cutoff === undefined || line.seq <= cutoff) return false;
  const removals = folder.removalsOf(line.label, (r) => folder.status(r) === 'applied');
  if (!removals.some((r) => !folder.causal.sees(line, r))) return false;
  return !qualifyingCounter(folder, line);
}

/**
 * The ruling extending the S2 exemption: an entry may also turn rejected after the fact when its
 * author's introduction is voided, directly or transitively, by an applied removal that cut off
 * the introducer before that introduction: every approval of the author is rejected, each because
 * its own author was cut off (voidedByCutoff) or was itself never really in.
 */
function introVoided(folder: Folder, label: string, depth = 0): boolean {
  if (depth > 8) return false;
  const approvals = folder.lines.filter((a) => a.entry.kind === 'device.add' && a.subject === label);
  if (approvals.length === 0) return false;
  return approvals.every((a) => folder.status(a) !== 'applied' && (voidedByCutoff(folder, a) || introVoided(folder, a.label, depth + 1)));
}

/** voidedByCutoff, or its author was never really in (introVoided). */
function voidedAfterTheFact(folder: Folder, line: Line): boolean {
  return voidedByCutoff(folder, line) || introVoided(folder, line.label);
}

/** Whether the app-facing state shows a voided change ("undone, redo?"). Field names to agree with the fixer. */
function surfacedAsVoided(state: VaultState, hash: string): boolean {
  const item = state.history.find((h) => h.hash === hash) as (Record<string, unknown> & { hash: string }) | undefined;
  if (item && (item.voided || item.undone)) return true;
  const lists = state as unknown as Record<string, unknown>;
  return ['voided', 'undone'].some((field) => Array.isArray(lists[field]) && (lists[field] as unknown[]).some((v) => v === hash || (typeof v === 'object' && v !== null && (v as { hash?: string }).hash === hash)));
}

// ---------------------------------------------------------------------------------------------

function thiefStaysOut(folder: Folder): Violation[] {
  const thief = folder.world.config.thief;
  if (!thief || !folder.hasAttack()) return [];
  const id = folder.id(thief);
  const clean = folder.withoutAttack();
  if (!clean.members[id]?.removed || folder.state.members[id]?.removed) return [];
  const removals = folder.removalsOf(thief, (l) => l.honest);
  // Removals voided because their own author was cut off (the S2 ruling) don't count.
  if (removals.every((r) => statusIn(clean, r) !== 'applied' || voidedByCutoff(folder, r))) return [];
  return [
    {
      invariant: 1,
      summary: `the thief ${thief} is active again although honest removals of it apply without its lines`,
      expected: `${thief} removed (without the thief's lines: ${removals.map((r) => folder.describeStatus(clean, r)).join('; ')})`,
      got: `${thief} active; ${removals.map((r) => folder.describeStatus(folder.state, r)).join('; ')}`,
    },
  ];
}

function cutOffStaysCutOff(folder: Folder): Violation[] {
  const { state, world, causal } = folder;
  const out: Violation[] = [];
  const labelOf = new Map(Object.entries(world.ids).map(([label, id]) => [id, label]));
  for (const [id, cutoff] of Object.entries(state.cutoffs)) {
    const label = labelOf.get(id) ?? id;
    const removalsOfIt = folder.removalsOf(label, (r) => folder.status(r) === 'applied');
    const forkSeq = state.forked[id];
    for (const line of folder.lines) {
      if (line.label !== label || line.seq <= cutoff || folder.status(line) !== 'applied') continue;
      // Amended (S2): past its author's cutoff only a true-symmetric counter-removal applies.
      const afterFork = forkSeq !== undefined && line.seq >= forkSeq;
      if (!afterFork && qualifyingCounter(folder, line)) continue;
      if (MEMBERSHIP_CHANGE_KINDS.includes(line.entry.kind)) {
        const seen = removalsOfIt.some((r) => causal.sees(line, r));
        out.push({ invariant: 8, summary: `${folder.describe(line)}, past its author's cutoff ${cutoff}${seen ? '' : ' (made before it saw its removal)'}, applies but is no counter-removal of the remover that cut it`, expected: `${folder.describe(line)} rejected`, got: folder.describeStatus(state, line) });
        continue;
      }
      void removalsOfIt;
      out.push({ invariant: 2, summary: `${label} has an applied entry above its cutoff ${cutoff}`, expected: `${folder.describe(line)} rejected`, got: folder.describeStatus(state, line) });
    }
  }
  for (const member of Object.values(state.members)) {
    if (!member.removed) continue;
    const label = labelOf.get(member.deviceId) ?? member.deviceId;
    if (state.cutoffs[member.deviceId] === undefined) out.push({ invariant: 2, summary: `${label} is removed but has no cutoff`, expected: `a cutoff for ${label}`, got: 'none' });
    const removals = folder.removalsOf(label, (r) => folder.status(r) === 'applied');
    for (const line of folder.lines) {
      if (folder.status(line) !== 'applied') continue;
      const body = line.entry.body as { epoch?: number; keys?: Record<string, unknown> };
      const sealsToIt = KEY_CHANGE_KINDS.includes(line.entry.kind) ? body.keys?.[member.deviceId] !== undefined : line.entry.kind === 'device.add' && line.subject === label;
      const isVaultKey = line.entry.kind === 'device.add' || (body.epoch !== undefined && state.keyChecks[body.epoch] === (line.entry.body as { keyCheck?: string }).keyCheck);
      if (!sealsToIt || !isVaultKey) continue;
      const after = removals.find((r) => causal.sees(line, r));
      if (after) out.push({ invariant: 2, summary: `a vault key made after ${label}'s removal is sealed to ${label}`, expected: `no key of epoch ${body.epoch} for ${label} (${folder.describe(after)} came first)`, got: `${folder.describeStatus(state, line)} gives ${label} that key` });
    }
  }
  return out;
}

/**
 * True when device `y` stands behind `removal`: it signed it, or it approved the removal's author
 * in a line that `other` (the opposite removal) had not seen.
 */
function standsBehind(folder: Folder, y: string, removal: Line, other: Line): Line[] | null {
  if (removal.label === y) return [];
  // Only an approval an admin could make enables anything.
  const approval = folder.lines.find((a) => a.label === y && a.entry.kind === 'device.add' && a.subject === removal.label && !folder.causal.sees(other, a) && mayBeAdmin(folder, y));
  return approval ? [approval] : null;
}

/** A line at or after its author's proven fork that nobody else built on: its author gave it up. */
function selfForked(folder: Folder, line: Line): boolean {
  const forkSeq = folder.state.forked[line.entry.author];
  return forkSeq !== undefined && line.seq >= forkSeq && folder.status(line) !== 'applied';
}

/** A removal by a plain team member is rejected by role, so it takes part in no conflict. */
function byAdmin(folder: Folder, removal: Line): boolean {
  return mayBeAdmin(folder, removal.label);
}

/** The identity is an admin, or (not in the vault) was approved as one by a device that may be an admin. */
function mayBeAdmin(folder: Folder, label: string, depth = 0): boolean {
  const member = folder.state.members[folder.world.ids[label] ?? ''];
  if (member) return member.role === 'admin';
  if (depth > 8) return false;
  return folder.lines.some((a) => a.entry.kind === 'device.add' && a.subject === label && (a.entry.body as { role?: string }).role === 'admin' && (folder.world.recoveries.some((r) => r.label === a.label) || mayBeAdmin(folder, a.label, depth + 1)));
}

/**
 * A true-symmetric conflict around `removal` (T1 removes T2): a removal made truly concurrently
 * that T2 stands behind and that removes T1 or the device that approved T1 unseen. Directly (T2
 * removes T1) or indirectly (T2 approves T3 unseen, T3 removes T1). Returns every party.
 */
function symmetricConflict(folder: Folder, removal: Line): { parties: string[]; lines: Line[] } | null {
  if (!byAdmin(folder, removal) || selfForked(folder, removal)) return null;
  for (const other of folder.lines) {
    if (other.entry.kind !== 'device.remove' || !other.subject || !byAdmin(folder, other) || selfForked(folder, other) || !folder.causal.concurrent(removal, other)) continue;
    const forward = standsBehind(folder, removal.subject!, other, removal);
    const back = forward && standsBehind(folder, other.subject!, removal, other);
    if (!forward || !back) continue;
    const parties = [...new Set([removal.label, removal.subject!, other.label, other.subject!])];
    return { parties, lines: [other, ...forward, ...back] };
  }
  return null;
}

/**
 * The ruling on class 5: past its author's cutoff, a removal survives only as part of the symmetric
 * conflict with the removal that cut its author (it targets that remover, directly or through the
 * devices it enabled). The rules' own definition decides which: state.counterRemovals
 * (replay.ts symmetricConflicts / enabledThrough), not a second copy here.
 */
function qualifyingCounter(folder: Folder, line: Line): boolean {
  return line.entry.kind === 'device.remove' && folder.state.counterRemovals.includes(line.hash);
}

/** Whether `line`'s author was cut off at it (its seq is past the author's cutoff). */
function cutOffAt(folder: Folder, line: Line): boolean {
  const cutoff = folder.state.cutoffs[line.entry.author];
  return cutoff !== undefined && line.seq > cutoff;
}

/**
 * The ruling on class 7: a forker's seq is contested when lines by identities not cut off at those
 * lines built on more than one version of it (the folder's, and another one named by hash). Lines
 * that end rejected for another reason still count as evidence. Returns forker label -> fork seq.
 */
function contestedForkSeqs(folder: Folder, standingOnly = true): Map<string, number> {
  const { world, state, causal } = folder;
  const out = new Map<string, number>();
  // inv21 (R6-A): evidence only from identities still standing at the end (in the vault, not removed, cut off or forked, or the current recovery identity).
  const stands = (id: string) => (state.members[id] !== undefined && !state.members[id]!.removed && state.cutoffs[id] === undefined && state.forked[id] === undefined) || state.recovery?.deviceId === id;
  for (const [id, forkSeq] of Object.entries(state.forked)) {
    const label = labelOfId(world, id);
    const folderLine = folder.lines.find((l) => l.label === label && l.seq === forkSeq);
    const onFolder = new Set<string>();
    const onOther = new Set<string>();
    for (const q of folder.lines) {
      if (q.label === label || cutOffAt(folder, q) || (standingOnly && !stands(q.entry.author))) continue;
      const ref = q.entry.seen[id];
      const at = ref && ref.seq >= forkSeq ? world.lines[label]?.[ref.seq] : undefined;
      if (ref && ref.seq >= forkSeq && !(at && at.hash === ref.hash)) onOther.add(q.entry.author);
      else if ((ref && ref.seq >= forkSeq) || (folderLine && causal.sees(q, folderLine))) onFolder.add(q.entry.author);
      // Its own approval (or anything else it built on) came through the folder version.
      if (folderLine && q.seq > 0 && causal.sees(folder.lines.find((l) => l.label === q.label && l.seq === 0) ?? q, folderLine)) onFolder.add(q.entry.author);
    }
    // Never from one identity naming both versions: an identity on both sides is no evidence.
    const both = new Set([...onFolder].filter((a) => onOther.has(a)));
    const contested = [...onFolder].some((a) => !both.has(a)) && [...onOther].some((b) => !both.has(b));
    if (contested) out.set(label, forkSeq);
  }
  return out;
}

/** inv6 exemption (class 7 ruling): a line by an author not cut off at it that names a forker at or past its fork seq is evidence of what was published. */
function forkEvidence(folder: Folder, line: Line): boolean {
  if (cutOffAt(folder, line)) return false;
  return Object.entries(folder.state.forked).some(([id, forkSeq]) => (line.entry.seen[id]?.seq ?? -1) >= forkSeq);
}

function removalsProtectTheirPast(folder: Folder): Violation[] {
  const { causal, world, state } = folder;
  const out: Violation[] = [];
  for (const removal of folder.lines.filter((l) => l.entry.kind === 'device.remove' && l.subject && !selfForked(folder, l))) {
    const target = removal.subject!;
    const seenOfTarget = causal.past(removal)[target] ?? -1;
    const without = folder.truncated({ [target]: seenOfTarget + 1 });
    if (statusIn(without.state, removal) !== 'applied') continue;
    // Only the rules' qualifying counter-removals form the conflict whose parties must all end out.
    const conflict = qualifyingCounter(folder, removal) ? (symmetricConflict(folder, removal) ?? { parties: [removal.label, removal.subject!], lines: [] }) : null;
    if (conflict) {
      const active = conflict.parties.filter((p) => world.ids[p] && state.members[world.ids[p]!] && !state.members[world.ids[p]!]!.removed);
      if (active.length > 0) {
        out.push({
          invariant: 3,
          summary: `a true-symmetric conflict (${conflict.parties.join(', ')}) around ${folder.describe(removal)} leaves ${active.join(', ')} active`,
          expected: `${conflict.parties.join(', ')} all removed`,
          got: `${active.join(', ')} active; ${[removal, ...conflict.lines].map((l) => folder.describeStatus(state, l)).join('; ')}`,
        });
      }
      continue;
    }
    const flipped = folder.lines.filter((e) => (e === removal || causal.sees(removal, e)) && e.seq < (without.view.counts[e.label] ?? 0) && statusIn(without.state, e) === 'applied' && folder.status(e) !== 'applied' && !voidedAfterTheFact(folder, e));
    if (flipped.length === 0) continue;
    out.push({
      invariant: 3,
      summary: `${target}'s later lines reject entries in the causal past of ${removal.label}'s removal of ${target}`,
      expected: flipped.map((e) => `${folder.describe(e)}: applied`).join('; '),
      got: flipped.map((e) => folder.describeStatus(state, e)).join('; '),
    });
  }
  return out;
}

function honestRunsLoseNothing(folder: Folder): Violation[] {
  const { world, state } = folder;
  if (world.attackStarted) return [];
  const out: Violation[] = [];
  for (const hash of world.everAppliedRemovals) {
    const line = folder.lines.find((l) => l.hash === hash)!;
    if (folder.status(line) !== 'applied' && !voidedAfterTheFact(folder, line)) out.push({ invariant: 4, summary: `an applied removal (${folder.describe(line)}) stopped applying after a later sync`, expected: `${folder.describe(line)}: applied`, got: folder.describeStatus(state, line) });
  }
  // Every voided membership change by an honest device is shown, so the app can offer to redo it.
  for (const line of folder.lines) {
    if (!line.honest || !MEMBERSHIP_CHANGE_KINDS.includes(line.entry.kind) || folder.status(line) !== 'rejected' || !voidedByCutoff(folder, line)) continue;
    if (surfacedAsVoided(state, line.hash)) continue;
    out.push({ invariant: 4, summary: `${folder.describe(line)} was voided (its author was cut off by a removal it hadn't seen), but the state doesn't show it as undone`, expected: `${folder.describe(line)} marked voided/undone in the state, so the app can offer to redo it`, got: folder.describeStatus(state, line) });
  }
  const missing = world.everAccounts.filter((label) => !state.accounts[world.accounts[label]!]);
  if (missing.length === 0) return out;
  const settled = settle(world, missing);
  const settledState = stateOf(settled, folderView(settled));
  for (const label of missing) {
    if (settledState.accounts[world.accounts[label]!]) continue;
    const puts = folder.lines.filter((l) => l.entry.kind === 'account.put' && l.subject === label);
    const excused = puts.every((p) => {
      const member = settledState.members[world.ids[p.label]!];
      const cutoff = settledState.cutoffs[world.ids[p.label]!];
      return !member || member.removed || (cutoff !== undefined && p.seq > cutoff);
    });
    if (excused) continue;
    out.push({ invariant: 4, summary: `account ${label} was applied, then disappeared and could not be remade`, expected: `account ${label} exists`, got: puts.map((p) => folder.describeStatus(settledState, p)).join('; ') });
  }
  return out;
}

/** Every honest device syncs, a fresh key is written if needed, and authors remake missing accounts. */
function settle(world: World, missing: string[]): World {
  let current = world;
  // Settling only runs before any theft, so the future thief is still an honest device here.
  const honest = world.devices;
  const step = (op: Op) => {
    current = applyOp(current, op) ?? current;
  };
  for (const device of honest) step({ t: 'sync', device });
  for (const device of honest) {
    step({ t: 'rotate', by: device });
    step({ t: 'sync', device });
  }
  for (const by of honest) for (const device of honest) step({ t: 'reapprove', by, device });
  for (const device of honest) step({ t: 'sync', device });
  for (const label of missing) {
    const authors = folderAuthors(world, label);
    for (const by of authors) {
      const before = current;
      step({ t: 'put', by, account: label, remake: true });
      if (current !== before) {
        step({ t: 'sync', device: by });
        break;
      }
    }
  }
  return current;
}

function folderAuthors(world: World, account: string): string[] {
  return Object.values(world.lines)
    .flat()
    .filter((l) => l.entry.kind === 'account.put' && l.subject === account && l.honest)
    .map((l) => l.label);
}

/** A key-sorted JSON form, so two states compare by content. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

function readOrders(logs: Record<string, string[]>): Record<string, string[]>[] {
  const ids = Object.keys(logs);
  const orders = [[...ids].reverse(), [...ids.slice(1), ...ids.slice(0, 1)], [...ids].sort()];
  return orders.map((order) => Object.fromEntries(order.map((id) => [id, logs[id]!])));
}

/**
 * The state for comparing read orders. `rejected` is compared as a set: replay lists the logs no
 * entry introduces in the order it reads them, which changes nothing a device decides.
 */
function comparable(state: VaultState): string {
  return stableJson({ ...state, rejected: state.rejected.map((r) => stableJson(r)).sort() });
}

function sameEverywhere(folder: Folder): Violation[] {
  const reference = comparable(folder.state);
  for (const logs of readOrders(folder.view.logs)) {
    const other = folder.world.ctx.replayFresh(folder.world.vaultId, logs, folder.world.proofs, folder.world.seals);
    if (comparable(other) !== reference) {
      return [{ invariant: 5, summary: 'reading the logs in another order gives another state', expected: `the same state for read order ${Object.keys(logs).map((id) => folder.world.ctx.labelOf(id)).join(',')}`, got: firstDifference(folder.state, other) }];
    }
  }
  return [];
}

function firstDifference(a: VaultState, b: VaultState): string {
  for (const key of Object.keys(a) as (keyof VaultState)[]) {
    if (stableJson(a[key]) !== stableJson(b[key])) return `field "${key}" differs`;
  }
  return 'states differ';
}

/** What a run decided, by line position (label#seq) and device label, so two clock policies can be compared. */
interface Outcome {
  status: Map<string, string>;
  members: Map<string, string>;
  /** The applied recovery.set and key.rotate lines: the tie-break's result. */
  keyChanges: string;
  /** Device label -> the labels of every identity that signed a device.add of it. */
  approvers: Map<string, string[]>;
}

function outcomeOf(world: World): Outcome {
  const state = stateOf(world, folderView(world));
  const byHash = new Map(state.history.map((h) => [h.hash, h.status]));
  const status = new Map<string, string>();
  const approvers = new Map<string, string[]>();
  for (const log of Object.values(world.lines)) {
    for (const line of log) {
      if (line.seq >= (world.published[line.label] ?? 0)) continue;
      status.set(`${line.label}#${line.seq}`, byHash.get(line.hash) ?? 'not read');
      if (line.entry.kind === 'device.add' && line.subject) approvers.set(line.subject, [...(approvers.get(line.subject) ?? []), line.label]);
    }
  }
  const members = new Map(Object.entries(world.ids).filter(([, id]) => state.members[id]).map(([label, id]) => [label, state.members[id]!.removed ? 'removed' : 'active']));
  const keyChanges = [...status.entries()]
    .filter(([pos, st]) => st === 'applied' && ['recovery.set', 'key.rotate'].includes(lineAt(world, pos)?.entry.kind ?? ''))
    .map(([pos]) => pos)
    .sort()
    .join(',');
  return { status, members, keyChanges, approvers };
}

function lineAt(world: World, position: string): Line | undefined {
  const [label, seq] = position.split('#');
  return world.lines[label!]?.[Number(seq)];
}

/**
 * Invariant 5 for clocks (amended): the same ops under two clock policies. A removal's status must
 * match. A device's membership must match, unless the tie-break between concurrent key changes
 * came out differently and every approval of the device was signed by a recovery identity (whose
 * standing that tie-break decides).
 */
export function clockDifference(world: World, other: World): string | null {
  const a = outcomeOf(world);
  const b = outcomeOf(other);
  for (const [pos, st] of a.status) {
    const line = lineAt(world, pos);
    if (line?.entry.kind !== 'device.remove' || !b.status.has(pos) || b.status.get(pos) === st) continue;
    return `${pos} device.remove ${line.subject}: ${st} under ${world.config.clock}, ${b.status.get(pos)} under ${other.config.clock}`;
  }
  const recoveryLabels = new Set(world.recoveries.map((r) => r.label));
  for (const [label, member] of a.members) {
    const theirs = b.members.get(label);
    if (theirs === undefined || theirs === member) continue;
    const viaPhrase = (a.approvers.get(label) ?? []).every((by) => recoveryLabels.has(by));
    if (a.keyChanges !== b.keyChanges && viaPhrase) continue;
    return `${label}: ${member} under ${world.config.clock}, ${theirs} under ${other.config.clock} (applied key changes ${a.keyChanges === b.keyChanges ? 'the same' : 'differ'})`;
  }
  return null;
}

function projection(state: VaultState): string {
  const { members, cutoffs, forked, epoch, recovery, sealedKeys, prevKeys, keyChecks, needsFreshKey, unkeyedDevices, accounts } = state;
  return stableJson({ members, cutoffs, forked, epoch, recovery, sealedKeys, prevKeys, keyChecks, needsFreshKey, unkeyedDevices, accounts });
}

function rejectedHaveNoEffect(folder: Folder): Violation[] {
  const { world, state } = folder;
  const out: Violation[] = [];
  const reference = projection(state);
  // A forker's rejected tail is named by its fork proof, so deleting it changes what the proof proves.
  const forkers = new Set(world.proofs.map((p) => labelOfId(world, p.deviceId)));
  for (const label of Object.keys(world.lines).filter((l) => !forkers.has(l))) {
    const log = folder.lines.filter((l) => l.label === label).sort((a, b) => a.seq - b.seq);
    for (let i = log.length - 1; i >= 0 && folder.status(log[i]!) === 'rejected'; i--) {
      const cut = log[i]!;
      const named = folder.lines.some((l) => l.label !== label && (l.entry.seen[world.ids[label]!]?.seq ?? -1) >= cut.seq);
      if (named) continue;
      // Built-on evidence of a fork (class 7 ruling): what was published, not a change made by the line's content.
      if (log.slice(i).some((l) => forkEvidence(folder, l))) continue;
      const without = folder.truncated({ [label]: cut.seq });
      const flipped = folder.lines.filter((l) => l.seq < (without.view.counts[l.label] ?? 0) && normalise(statusIn(without.state, l)) !== normalise(folder.status(l)));
      if (projection(without.state) === reference && flipped.length === 0) continue;
      out.push({
        invariant: 6,
        summary: `deleting the rejected line ${folder.describe(cut)} (and the rejected lines after it) changes the state`,
        expected: 'the same state without it',
        got: flipped.length > 0 ? flipped.map((l) => `${folder.describe(l)}: ${folder.status(l)} with it, ${statusIn(without.state, l)} without`).join('; ') : firstDifference(state, without.state),
      });
    }
  }
  return out;
}

/** A line whose identity no applied entry introduces is not in history; it counts as rejected. */
function normalise(status: string): string {
  return status === 'not read' ? 'rejected' : status;
}

const FRESH_DEVICE = 'Z1';
const FRESH_ACCOUNT = 'zz';

function honestCanGoOn(folder: Folder): Violation[] {
  const { world } = folder;
  // Before the theft the future thief is an honest device like any other.
  const honest = world.devices.filter((d) => d !== world.config.thief || !world.attackStarted);
  const failures: string[] = [];
  let candidates = 0;
  for (const device of honest) {
    const attempt = goOn(reapproved(world, device, honest), device);
    if (attempt === 'not a candidate') continue;
    candidates++;
    if (attempt === 'ok') return [];
    failures.push(`${device}: ${attempt}`);
  }
  if (candidates === 0) {
    const restored = applyOp(world, { t: 'restore', device: FRESH_DEVICE });
    if (!restored) {
      const state = folder.state;
      const honestRecovery = world.recoveries.some((r) => r.honest && world.ids[r.label] === state.recovery?.deviceId);
      if (!honestRecovery) return [];
      failures.push('restore with the current honest recovery phrase failed');
    } else {
      const attempt = goOn(restored, FRESH_DEVICE);
      if (attempt === 'ok') return [];
      failures.push(`restored ${FRESH_DEVICE}: ${attempt}`);
    }
  }
  return [{ invariant: 7, summary: 'no honest device can write to the vault any more', expected: 'an honest admin (or a restore) writes a fresh key if needed, then an account that applies', got: failures.join('; ') }];
}

/** The world after the first other honest admin, or the owner's phrase, re-approves `device` (unchanged if none can). */
function reapproved(world: World, device: string, honest: string[]): World {
  const synced = applyOp(world, { t: 'sync', device }) ?? world;
  // The owner's current recovery phrase can approve it again too.
  for (const by of [...honest, ...world.recoveries.filter((r) => r.honest).map((r) => r.label)]) {
    if (by === device) continue;
    const next = applyOp(synced, { t: 'reapprove', by, device });
    if (next) return next;
  }
  return world;
}

/** One honest device syncs, writes a fresh key if the vault needs one, then an account. */
function goOn(world: World, device: string): string {
  let current = applyOp(world, { t: 'sync', device }) ?? world;
  const state = stateOf(current, folderView(current));
  const member = state.members[world.ids[device]!];
  // A device whose hello the rules rejected never got in.
  if (!member || member.removed || member.role !== 'admin' || !member.joined) return 'not a candidate';
  if (state.needsFreshKey) {
    const rotated = applyOp(current, { t: 'rotate', by: device });
    if (!rotated) return 'it can\'t open the current key to write a fresh one';
    current = applyOp(rotated, { t: 'sync', device }) ?? rotated;
    const after = stateOf(current, folderView(current));
    const rotation = current.lines[device]!.at(-1)!;
    if (statusIn(after, rotation) !== 'applied') return `its fresh key.rotate is ${statusIn(after, rotation)}`;
    if (after.needsFreshKey) return 'the vault still needs a fresh key after its key.rotate';
    const thief = world.config.thief;
    if (thief && after.members[world.ids[thief]!]?.removed && after.sealedKeys[after.epoch]?.[world.ids[thief]!]) return 'its fresh key reaches the removed thief';
  }
  const put = applyOp(current, { t: 'put', by: device, account: FRESH_ACCOUNT });
  if (!put) return 'it holds no current key (or the vault still needs a fresh key)';
  const published = applyOp(put, { t: 'sync', device }) ?? put;
  const final = stateOf(published, folderView(published));
  const line = published.lines[device]!.at(-1)!;
  if (statusIn(final, line) !== 'applied') return `its account.put is ${statusIn(final, line)}`;
  return 'ok';
}

function thiefDamagesOnlyAvailability(folder: Folder): Violation[] {
  const { world, state, causal } = folder;
  const thief = world.config.thief;
  if (!thief) return [];
  const clean = folder.withoutAttack();
  const valid = folder.removalsOf(thief, (r) => r.honest && statusIn(clean, r) === 'applied' && !voidedByCutoff(folder, r));
  if (valid.length === 0) return keyNotMadeByOutThief(folder);
  const id = folder.id(thief);
  const out: Violation[] = [];
  if (state.members[id] && !state.members[id]!.removed) {
    out.push({ invariant: 8, summary: `the thief ${thief} is active after a valid honest removal of it`, expected: `${thief} removed`, got: `${thief} active; ${valid.map((r) => folder.describeStatus(state, r)).join('; ')}` });
  }
  // Clashing removals can leave the vault on an old key the thief always had. That is safe only while
  // needsFreshKey stops new secrets (or nobody is left); invariant 7 checks the fresh key excludes it.
  const anyoneActive = Object.values(state.members).some((m) => !m.removed);
  if (state.sealedKeys[state.epoch]?.[id] && anyoneActive && !state.needsFreshKey) {
    out.push({ invariant: 8, summary: `the thief ${thief} holds the current key after a valid honest removal of it, and the vault does not ask for a fresh one`, expected: `epoch ${state.epoch} not sealed to ${thief}, or needsFreshKey`, got: `sealed to ${thief}, needsFreshKey false` });
  }
  for (const puppet of world.puppets) {
    const member = state.members[folder.id(puppet)];
    const add = folder.lines.find((l) => l.entry.kind === 'device.add' && l.subject === puppet && !l.honest);
    const unseen = add && valid.find((r) => !causal.sees(r, add));
    if (member && !member.removed && unseen) out.push({ invariant: 8, summary: `the thief's puppet ${puppet} is active although ${folder.describe(unseen)} never saw its approval`, expected: `${puppet} out`, got: `${puppet} active; ${folder.describeStatus(state, add)}` });
  }
  for (const line of folder.lines) {
    if (line.honest || line.label !== thief || folder.status(line) !== 'applied') continue;
    if (line.entry.kind === 'recovery.set') {
      const unseen = valid.find((r) => !causal.sees(r, line));
      if (unseen) out.push({ invariant: 8, summary: `the thief's recovery.set applies after ${folder.describe(unseen)}`, expected: `${folder.describe(line)} rejected`, got: folder.describeStatus(state, line) });
    }
    if (line.entry.kind === 'device.remove') {
      const knew = valid.find((r) => causal.sees(line, r));
      if (knew) out.push({ invariant: 8, summary: `the thief's removal of ${line.subject} applies although it had seen ${folder.describe(knew)}`, expected: `${folder.describe(line)} rejected (not truly concurrent)`, got: folder.describeStatus(state, line) });
    }
  }
  out.push(...keyNotMadeByOutThief(folder));
  const recoveryLabel = world.recoveries.find((r) => world.ids[r.label] === state.recovery?.deviceId);
  if (recoveryLabel && !recoveryLabel.honest) {
    out.push({ invariant: 8, summary: `the vault's recovery phrase is the thief's (${recoveryLabel.label})`, expected: 'an honest recovery phrase or none', got: `recovery identity ${recoveryLabel.label}` });
  }
  return out;
}

/**
 * The thief knows any key it made. While it is out of the vault (removed, or never a member), the
 * current key must not be one of its key changes unless the vault asks for a fresh one.
 */
function keyNotMadeByOutThief(folder: Folder): Violation[] {
  const { world, state } = folder;
  const thief = world.config.thief;
  if (!thief || state.needsFreshKey) return [];
  const member = state.members[folder.id(thief)];
  if (member && !member.removed) return [];
  // The current key is the one whose published commitment is keyChecks[epoch].
  const check = state.keyChecks[state.epoch];
  const maker = folder.lines.find((l) => KEY_CHANGE_KINDS.includes(l.entry.kind) && folder.status(l) === 'applied' && (l.entry.body as { keyCheck?: string }).keyCheck === check);
  if (!maker || maker.honest) return [];
  // A puppet the honest remover saw and left in is the documented cost (puppet mirror), not this invariant.
  if (maker.label !== thief && state.members[folder.id(maker.label)] && !state.members[folder.id(maker.label)]!.removed) return [];
  return [{ invariant: 8, summary: `the current key (epoch ${state.epoch}) was made by ${folder.describe(maker)}, so the thief, which is out of the vault, knows it`, expected: 'a key the thief never saw, or needsFreshKey', got: `${folder.describeStatus(state, maker)}; needsFreshKey false` }];
}

export interface CheckOptions {
  /** Re-run replay in other read orders (invariant 5). */
  readOrders: boolean;
  /** Try an honest append after the scenario (invariant 7). */
  goOn: boolean;
}

function lineByHash(world: World, hash: string): Line | undefined {
  for (const log of Object.values(world.lines)) for (const l of log) if (l.hash === hash) return l;
  return undefined;
}

/**
 * Invariant 9 (class 6 ruling): nothing an out author sends through the agent changes state, except
 * its qualifying counter-removal; the lines ahead of it (riders, any kind) are admitted only if they
 * end rejected or caught. The other half (an honest counter-removal is always admitted, whatever
 * precedes it in its own log) is checked in agentTakesHonestLines.
 */
function agentAdmitsNoStaleLine(folder: Folder): Violation[] {
  const out: Violation[] = [];
  for (const a of folder.world.admissions.filter((x) => x.problem !== null)) {
    const line = lineByHash(folder.world, a.hash);
    if (!line || line.seq >= (folder.world.published[line.label] ?? 0)) continue;
    if (qualifyingCounter(folder, line) || folder.status(line) !== 'applied') continue;
    out.push({ invariant: 9, summary: `the honest agent admitted ${folder.describe(line)} although ${a.problem}, and it changes state`, expected: 'refused, or admitted only as a rider that ends rejected or caught (or as the counter-removal of the remover that cut its author)', got: `admitted; now ${folder.describeStatus(folder.state, line)}` });
  }
  return out;
}

/** The parts of a state every honest device must agree on once proofs are shared. */
function agreedPart(world: World, state: VaultState): string {
  const members = Object.fromEntries(Object.values(state.members).map((m) => [labelOfId(world, m.deviceId), `${m.role}/${m.removed ? 'removed' : 'active'}`]));
  const forked = Object.fromEntries(Object.entries(state.forked).map(([id, seq]) => [labelOfId(world, id), seq]));
  const accounts = Object.fromEntries(Object.entries(state.accounts).map(([id, a]) => [id, a.hash]));
  return stableJson({ members, forked, epoch: state.epoch, recovery: state.recovery ? labelOfId(world, state.recovery.deviceId) : null, needsFreshKey: state.needsFreshKey, accounts });
}

function falseForks(world: World, state: VaultState, where: string): Violation[] {
  const out: Violation[] = [];
  for (const [id, seq] of Object.entries(state.forked)) {
    const label = labelOfId(world, id);
    if (world.forkedAt[label] === seq) continue;
    out.push({ invariant: 10, summary: `${where} counts ${label} as forked at seq ${seq}${isAttacker(world, label) ? '' : ', an honest device'}`, expected: world.forkedAt[label] === undefined ? `${label} not forked (it never signed two lines at one seq)` : `${label} forked at seq ${world.forkedAt[label]}`, got: `forked at seq ${seq}` });
  }
  return out;
}

/**
 * S6: without the proofs, take every entry that applied, by an identity that is not forked and was
 * not past its cutoff; every line of a forker in its causal past must still apply with the proofs.
 */
function proofsKeepWhatOthersBuiltOn(folder: Folder): Violation[] {
  const { world, state, causal } = folder;
  if (world.proofs.length === 0) return [];
  const view = folderView(world);
  const without = world.ctx.replayFolder(world.vaultId, view.logs, `${view.key}#without-proofs`, []);
  const forkers = new Set(world.proofs.map((p) => labelOfId(world, p.deviceId)));
  const out: Violation[] = [];
  const reported = new Set<string>();
  // A contested seq: neither version's membership or key effect applies, and its account lines are caught.
  const contested = contestedForkSeqs(folder);
  const ghostContested = new Map([...contestedForkSeqs(folder, false)].filter(([label]) => !contested.has(label)));
  for (const [label, seq] of contested) {
    const line = folder.lines.find((l) => l.label === label && l.seq === seq);
    if (!line) continue;
    const item = state.history.find((h) => h.hash === line.hash);
    const account = line.entry.kind.startsWith('account.');
    const ok = account ? item?.status !== 'applied' && item?.caught === true : item?.status !== 'applied';
    if (!ok) out.push({ invariant: 10, summary: `${label}'s seq ${seq} is contested (lines built on two versions of it), but ${folder.describe(line)} ${account ? 'is not caught' : 'applies'}`, expected: account ? `${folder.describe(line)} rejected and caught` : `${folder.describe(line)} rejected (neither version applies)`, got: `${item?.status ?? 'not read'}${item?.caught ? ', caught' : ''}` });
  }
  for (const a of folder.lines) {
    if (forkers.has(a.label) || statusIn(without, a) !== 'applied') continue;
    const cut = without.cutoffs[a.entry.author];
    if (cut !== undefined && a.seq > cut) continue;
    for (const forker of forkers) {
      const builtOn = causal.past(a)[forker] ?? -1;
      const contestedAt = contested.get(forker);
      for (const line of folder.lines.filter((l) => l.label === forker && l.seq <= builtOn && (contestedAt === undefined || l.seq < contestedAt))) {
        if (reported.has(line.hash) || statusIn(without, line) !== 'applied' || folder.status(line) === 'applied') continue;
        reported.add(line.hash);
        // Contested only through evidence from identities no longer standing: invariant 21 (R6-A).
        const ghost = (ghostContested.get(forker) ?? Infinity) <= line.seq;
        out.push({ invariant: ghost ? 21 : 10, summary: `${ghost ? 'a seq contested only by identities that no longer stand: ' : ''}the fork proof against ${forker} rejects ${folder.describe(line)}, which ${folder.describe(a)} built on`, expected: `${folder.describe(line)} applied (cutoff at least ${builtOn}); ${folder.describe(a)} applies without the proof`, got: `${folder.describeStatus(state, line)}; ${folder.describeStatus(state, a)}` });
      }
    }
  }
  return out;
}

function onlyForkersAccused(folder: Folder): Violation[] {
  const { world, state, causal } = folder;
  const out = [...falseForks(world, state, 'the folder'), ...proofsKeepWhatOthersBuiltOn(folder)];
  // Only a slander that is its author's last line in the folder: cutting it then removes nothing else of the thief's.
  for (const slander of folder.lines.filter((l) => l.slander && l.seq === (world.published[l.label] ?? 0) - 1)) {
    const without = folder.truncated({ [slander.label]: slander.seq });
    // A line that named the slanderer's log at that seq waits without it: not the slander's doing.
    const flipped = folder.lines.filter((h) => h.honest && h.seq < (without.view.counts[h.label] ?? 0) && !causal.sees(h, slander) && statusIn(without.state, h) !== 'waiting' && normalise(statusIn(without.state, h)) !== normalise(folder.status(h)));
    // Honest lines that built on the slander line wait without it; their effects are theirs, not the slander's.
    const builtOn = folder.lines.some((h) => h.honest && causal.sees(h, slander) && folder.status(h) === 'applied');
    if (flipped.length === 0 || builtOn) continue;
    out.push({ invariant: 10, summary: `${folder.describe(slander)}, naming a hash that does not exist, changes honest lines that never saw it`, expected: flipped.map((h) => `${folder.describe(h)}: ${statusIn(without.state, h)}`).join('; '), got: flipped.map((h) => folder.describeStatus(state, h)).join('; ') });
  }
  if (Object.keys(world.forkedAt).length === 0) return out;
  const shared = folder.shared();
  const sharedState = stateOf(shared, folderView(shared));
  out.push(...falseForks(shared, sharedState, 'the folder after every honest device synced'));
  const reference = agreedPart(shared, sharedState);
  for (const device of honestActiveDevices(shared, sharedState)) {
    if ((shared.published[device] ?? 0) < (shared.lines[device]?.length ?? 0)) continue;
    const local = stateOf(shared, localView(shared, device));
    out.push(...falseForks(shared, local, `${device}'s own copy`));
    const mine = agreedPart(shared, local);
    if (mine !== reference) out.push({ invariant: 10, summary: `after sharing fork proofs, ${device}'s own copy disagrees with the folder`, expected: `the folder's ${reference}`, got: `${device}: ${mine}` });
  }
  return out;
}

function honestActiveDevices(world: World, state: VaultState): string[] {
  // Joined: a device whose hello the rules rejected never got in, so it can't act.
  return world.devices.filter((d) => !isAttacker(world, d) && !(d === world.config.thief && world.attackStarted) && state.members[world.ids[d]!] && !state.members[world.ids[d]!]!.removed && state.members[world.ids[d]!]!.joined);
}

function rolesHold(folder: Folder): Violation[] {
  const { world, state } = folder;
  if (world.config.kind !== 'team') return [];
  const out: Violation[] = [];
  for (const line of folder.lines) {
    if (!MEMBERSHIP_CHANGE_KINDS.includes(line.entry.kind) || folder.status(line) !== 'applied') continue;
    if (state.members[line.entry.author]?.role !== 'member') continue;
    out.push({ invariant: 11, summary: `a plain member's ${line.entry.kind} applies`, expected: `${folder.describe(line)} rejected (only an admin device can do this)`, got: folder.describeStatus(state, line) });
  }
  for (const member of Object.values(state.members)) {
    const label = labelOfId(world, member.deviceId);
    // The role is the one the device's own hello confirmed (an approval it had seen), else its first approval's.
    const approvals = folder.lines.filter((l) => l.entry.kind === 'device.add' && l.subject === label && folder.status(l) === 'applied');
    const hello = folder.lines.find((l) => l.label === label && l.entry.kind === 'device.hello' && folder.status(l) === 'applied');
    const confirmed = hello ? approvals.filter((a) => folder.causal.sees(hello, a)) : approvals.filter((a) => !approvals.some((b) => b !== a && folder.causal.sees(a, b)));
    const roles = new Set(confirmed.map((a) => (a.entry.body as { role?: string }).role));
    if (roles.size > 0 && !roles.has(member.role)) out.push({ invariant: 11, summary: `${label} has role ${member.role}, but no approval it accepted gave it that role (${[...roles].join(', ')})`, expected: [...roles].join(' or '), got: member.role });
    // A role a thief granted must not override one an honest admin granted that the device accepted.
    const honestRoles = new Set(confirmed.filter((a) => a.honest).map((a) => (a.entry.body as { role?: string }).role));
    if (honestRoles.size === 1 && !honestRoles.has(member.role) && roles.has(member.role)) out.push({ invariant: 11, summary: `${label} has role ${member.role} from the thief's approval, overriding the role ${[...honestRoles][0]} an honest admin gave it`, expected: [...honestRoles][0]!, got: member.role });
  }
  return out;
}

/**
 * After the scenario, an honest admin that holds the key syncs and removes the thief. null: no
 * honest admin could try; otherwise what happened to the removal.
 */
function removeThief(folder: Folder): string | null {
  const { world, state } = folder;
  const thief = world.config.thief;
  if (!thief || !world.attackStarted || !state.members[folder.id(thief)] || state.members[folder.id(thief)]!.removed) return null;
  for (const admin of honestActiveDevices(world, state)) {
    const synced = applyOp(world, { t: 'sync', device: admin }) ?? world;
    const removed = applyOp(synced, { t: 'remove', by: admin, target: thief, push: true });
    if (!removed) continue;
    const line = removed.lines[admin]!.at(-1)!;
    const after = stateOf(removed, folderView(removed));
    if (line.seq >= (removed.published[admin] ?? 0)) return `${admin}'s removal of ${thief} is refused: ${removed.honestRefusals.at(-1)?.reason ?? 'not sent'}`;
    const status = statusIn(after, line);
    return status === 'applied' ? 'ok' : `${admin}'s removal of ${thief} is ${after.history.find((h) => h.hash === line.hash)?.reason ?? status}`;
  }
  return null;
}

function memberCantBlockItsRemoval(folder: Folder): Violation[] {
  const { world, state } = folder;
  const thief = world.config.thief;
  if (world.config.kind !== 'team' || !thief || state.members[folder.id(thief)]?.role !== 'member') return [];
  const result = removeThief(folder);
  if (result === null || result === 'ok') return [];
  return [{ invariant: 11, summary: `an honest admin can't remove the malicious member ${thief}`, expected: `the removal of ${thief} applies`, got: result }];
}

function joinsComplete(folder: Folder): Violation[] {
  const { world } = folder;
  const out: Violation[] = [];
  for (const join of world.intercepted) {
    if (isAttacker(world, join.by) || (join.by === world.config.thief && world.attackStarted)) continue;
    const approval = folder.lines.find((l) => l.label === join.by && l.entry.kind === 'device.add' && l.subject === join.device && l.honest);
    if (!approval || folder.status(approval) !== 'applied') continue;
    out.push({ invariant: 12, summary: `${join.device}'s join, approved by the honest admin ${join.by}, never completes${world.squats.includes(join.device) ? ' (the thief squatted it first)' : ''}`, expected: `${join.device}'s checkJoinedVault says ok and it writes its hello`, got: `intercepted: ${join.reason}` });
  }
  if (world.squats.length > 0) {
    const result = removeThief(folder);
    if (result !== null && result !== 'ok') out.push({ invariant: 12, summary: `after squatting ${world.squats.join(', ')}, the thief ${world.config.thief} can't be removed by an honest admin`, expected: `the removal of ${world.config.thief} applies`, got: result });
  }
  return out;
}

function beaconsRaiseNoFalseAlarm(folder: Folder): Violation[] {
  const { world } = folder;
  if (!world.config.beacons || Object.keys(world.beacons).length === 0) return [];
  const shared = folder.shared();
  const out: Violation[] = [];
  const sharedState = stateOf(shared, folderView(shared));
  const files = Object.fromEntries(Object.entries(shared.beacons).map(([label, beacon]) => [shared.ids[label]!, JSON.stringify(beacon)]));
  for (const device of honestActiveDevices(shared, sharedState)) {
    // The device reads the folder right before it checks, as each sync does.
    const fresh = applyOp(shared, { t: 'sync', device }) ?? shared;
    const local = stateOf(fresh, localView(fresh, device));
    const check = checkBeacons(local, files, shared.ids[device]!);
    for (const problem of check.problems) {
      const signer = labelOfId(shared, problem.device);
      const signerOut = local.members[problem.device]?.removed !== false || local.cutoffs[problem.device] !== undefined;
      if (isAttacker(shared, signer) && !signerOut) continue;
      const what = `${problem.kind}${problem.entry ? ` ${labelOfId(shared, problem.entry.deviceId)}#${problem.entry.seq}` : ''}${problem.epoch !== undefined ? ` epoch ${problem.epoch}` : ''}`;
      out.push({ invariant: 15, summary: `${device}'s beacon check reports ${what} from ${signerOut ? 'a removed or cut-off' : 'an honest'} device ${signer}`, expected: 'no problem', got: `${what} (from ${signer})` });
    }
  }
  return out;
}

function agentTakesHonestLines(folder: Folder): Violation[] {
  const { world } = folder;
  const out: Violation[] = [];
  for (const refusal of world.honestRefusals) {
    const lines = refusal.hashes.map((h) => lineByHash(world, h)).filter((l): l is Line => l !== undefined);
    const names = lines.map((l) => folder.describe(l)).join(', ');
    // The caps are judged by invariant 18 (only removals and restores are protected; a full vault may refuse the rest).
    if (refusal.reason.startsWith(QUOTA_REFUSAL)) continue;
    if (refusal.retry) {
      out.push({ invariant: 14, summary: `the agent refuses an exact retry of ${names}, lines it had just stored`, expected: 'taken (an exact retry changes nothing)', got: `refused: ${refusal.reason}` });
      continue;
    }
    // The docs let the agent refuse an approval naming a device whose log is already in the folder (it would be rejected).
    const bringsInLog = lines.some((l) => l.entry.kind === 'device.add' && l.subject && (refusal.folder[l.subject] ?? 0) > 0);
    if (refusal.problem === null && !bringsInLog) {
      out.push({ invariant: 13, summary: `the agent refuses ${names} from ${refusal.label}, which is still in the vault`, expected: 'taken (applied, or kept as a placeholder)', got: `refused: ${refusal.reason}` });
      continue;
    }
    if (refusal.problem === null) continue;
    const last = lines.at(-1);
    if (!last || last.entry.kind !== 'device.remove' || !last.subject) continue;
    const hypothetical = new Folder({ ...world, published: { ...refusal.folder, [refusal.label]: last.seq + 1 } });
    const line = hypothetical.lines.find((l) => l.hash === last.hash);
    if (!line || !qualifyingCounter(hypothetical, line)) continue;
    out.push({ invariant: 9, summary: `the agent refuses ${refusal.label}'s counter-removal ${folder.describe(last)} of the remover that cut it${lines.length > 1 ? `, sent behind its own earlier lines ${lines.slice(0, -1).map((l) => folder.describe(l)).join(', ')}` : ''}`, expected: `taken (${refusal.problem}, but it is the counter-removal of the remover that cut it; earlier lines ride along rejected or caught)`, got: `refused: ${refusal.reason}` });
  }
  return out;
}

/** Invariant 16. */
function signaturesHold(folder: Folder): Violation[] {
  const { world } = folder;
  const garbled = Object.values(world.lines).flat().filter((l) => l.garbage);
  const forked = Object.values(world.copies).some((logs) => Object.values(logs).some((log) => log.some((l) => l.garbage)));
  if (garbled.length === 0 && !forked) return [];
  const out: Violation[] = [];
  const garbledSeq = (log: Line[]) => log.findIndex((l) => l.garbage);
  const judge = (state: VaultState, logs: Record<string, Line[]>, where: string) => {
    for (const log of Object.values(logs)) {
      const bad = garbledSeq(log);
      if (bad < 0) continue;
      const statuses = statusMap(state);
      const applied = log.slice(bad).filter((l) => statuses.get(l.hash) === 'applied');
      if (applied.length > 0) out.push({ invariant: 16, summary: `in ${where}, ${applied.map((l) => folder.describe(l)).join(', ')} applies although ${folder.describe(log[bad]!)} carries a garbage signature`, expected: `${folder.describe(log[bad]!)} and every line chained on it not applied`, got: applied.map((l) => `${folder.describe(l)}: applied`).join('; ') });
    }
  };
  const published: Record<string, Line[]> = {};
  for (const [label, log] of Object.entries(world.lines)) published[label] = log.slice(0, world.published[label] ?? 0);
  judge(folder.state, published, 'the folder');
  // After honest devices sync: every divergence by an author yields a valid fork proof.
  const shared = folder.shared();
  const sharedState = stateOf(shared, folderView(shared));
  for (const device of honestActiveDevices(shared, sharedState)) {
    const copies = shared.copies[device] ?? {};
    const own: Record<string, Line[]> = {};
    for (const [label, log] of Object.entries(copies)) own[label] = log;
    if (Object.keys(own).length > 0) judge(stateOf(shared, localView(shared, device)), own, `${device}'s own copy`);
    for (const [label, log] of Object.entries(copies)) {
      const folderLog = shared.lines[label] ?? [];
      const at = log.findIndex((l, i) => i < (shared.published[label] ?? 0) && folderLog[i]?.hash !== l.hash);
      if (at < 0) continue;
      if (sharedState.forked[shared.ids[label]!] !== undefined) continue;
      if (![...log, ...folderLog].some((l) => l.garbage)) continue;
      out.push({ invariant: 16, summary: `${device}'s copy of ${label}'s log and the folder's differ at seq ${at}, and no valid fork proof exists (one side carries a garbage signature)`, expected: `a valid fork proof against ${label}, or the garbage-signed side never counting`, got: `${device} has ${folder.describe(log[at]!)}, the folder ${folderLog[at] ? folder.describe(folderLog[at]!) : 'nothing'}; forked: ${JSON.stringify(sharedState.forked)}` });
    }
  }
  return out;
}

/** Invariant 17. */
function joinedDevicesHoldKey(folder: Folder): Violation[] {
  const { world, state, view } = folder;
  if (state.needsFreshKey) return [];
  const out: Violation[] = [];
  for (const device of honestActiveDevices(world, state)) {
    const id = folder.id(device);
    const member = state.members[id]!;
    if (!member.joined || world.ctx.currentKey(state, view.key, world.ctx.device(device))) continue;
    // A bad seal it can prove: once it syncs, its proof voids the line and it opens the key again.
    const synced = applyOp(world, { t: 'sync', device });
    if (synced) {
      const after = stateOf(synced, folderView(synced));
      if (synced.seals.length > world.seals.length && (after.needsFreshKey || world.ctx.currentKey(after, folderView(synced).key, world.ctx.device(device)))) continue;
    }
    if (!state.unkeyedDevices.includes(id)) {
      out.push({ invariant: 17, summary: `${device} joined but can't open the current key (epoch ${state.epoch}), and is not listed as unkeyed`, expected: `${device} opens the key, or is in unkeyedDevices so it can be approved again`, got: `unkeyedDevices: [${state.unkeyedDevices.map((d) => labelOfId(world, d)).join(', ')}]` });
      continue;
    }
    // An honest admin (or the owner's honest phrase) approves it again.
    const approvers = [...honestActiveDevices(world, state).filter((d) => d !== device && state.members[folder.id(d)]!.role === 'admin'), ...world.recoveries.filter((r) => r.honest).map((r) => r.label)];
    let fixed = false;
    for (const by of approvers) {
      const after = applyOp(world, { t: 'reapprove', by, device });
      if (!after) continue;
      const afterView = folderView(after);
      if (world.ctx.currentKey(stateOf(after, afterView), afterView.key, world.ctx.device(device))) {
        fixed = true;
        break;
      }
    }
    if (!fixed) out.push({ invariant: 17, summary: `${device} is listed as unkeyed, but no honest admin or phrase can approve it again so that it opens the key`, expected: `a re-approval of ${device} that gives it the current key`, got: approvers.length === 0 ? 'no honest approver' : `tried ${approvers.join(', ')}: none worked` });
  }
  return out;
}

/** Invariant 18. */
function capsNeverLockOut(folder: Folder): Violation[] {
  const { world } = folder;
  if (!world.config.quota) return [];
  const out: Violation[] = [];
  for (const refusal of world.honestRefusals) {
    if (!refusal.reason.startsWith(QUOTA_REFUSAL)) continue;
    const before = viewOf(world, refusal.folder);
    const state = stateOf(world, before);
    for (const hash of refusal.hashes) {
      const line = lineByHash(world, hash);
      if (!line) continue;
      const author = state.members[line.entry.author];
      const restore = line.entry.kind === 'device.add' && world.recoveries.some((r) => r.label === line.label && r.honest);
      const target = line.entry.kind === 'device.remove' && line.subject ? state.members[folder.id(line.subject)] : undefined;
      const removal = !!target && !target.removed && !!author && !author.removed && author.role === 'admin';
      if (!restore && !removal) continue;
      out.push({ invariant: 18, summary: `the agent's caps refuse ${restore ? 'a restore with the honest phrase' : "an honest admin's removal"}: ${folder.describe(line)}`, expected: 'taken: removals by an honest active admin and restores always fit the reserve', got: `refused: ${refusal.reason}` });
    }
  }
  return out;
}

/** An honest active admin's removal of `target`, synced and sent: its status, or null if no honest admin can build one. */
function honestRemoval(world: World, target: string): { by: string; status: string } | null {
  const state = stateOf(world, folderView(world));
  for (const admin of honestActiveDevices(world, state).filter((d) => d !== target && state.members[world.ids[d]!]!.role === 'admin')) {
    // On what it reads now: sync first (a no-op sync is fine), then remove and send.
    const synced = applyOp(world, { t: 'sync', device: admin }) ?? world;
    // Sending what it held back may already have removed the target (its own earlier removal).
    if (stateOf(synced, folderView(synced)).members[world.ids[target]!]?.removed) return { by: admin, status: 'applied' };
    const after = applyOp(synced, { t: 'remove', by: admin, target, push: true });
    if (!after) {
      const view = folderView(synced);
      const held = world.ctx.currentKey(stateOf(synced, view), view.key, world.ctx.device(admin));
      return { by: admin, status: held ? 'not built' : 'not built (it holds no key that matches the keyCheck)' };
    }
    const line = after.lines[admin]!.at(-1)!;
    return { by: admin, status: statusIn(stateOf(after, folderView(after)), line) };
  }
  return null;
}

/** Invariant 19. */
function badSealsCostNothing(folder: Folder): Violation[] {
  const { world, state, view } = folder;
  const bad = folder.lines.filter((l) => l.badSeal);
  if (bad.length === 0) return [];
  const out: Violation[] = [];
  for (const line of bad) {
    const author = line.label;
    // a. accounts each honest device could read without the bad seal (the author's log cut before it).
    const clean = folder.truncated({ [author]: line.seq });
    for (const device of honestActiveDevices(world, clean.state)) {
      const before = world.ctx.readable(clean.state, clean.view.key, world.ctx.device(device));
      const now = world.ctx.readable(state, view.key, world.ctx.device(device));
      const lost = [...before].filter((a) => !now.has(a) && state.accounts[a]);
      if (lost.length > 0) out.push({ invariant: 19, summary: `${device} can no longer read ${lost.length} account(s) it read before ${folder.describe(line)}`, expected: `${device} reads every account it read before (falling back read-only to the last epoch it opens)`, got: `missing ${lost.length}` });
    }
    // b. an honest admin can still remove the author.
    const member = state.members[folder.id(author)];
    if (member && !member.removed) {
      const removal = honestRemoval(world, author);
      if (honestActiveDevices(world, state).some((d) => state.members[folder.id(d)]!.role === 'admin') && (!removal || removal.status !== 'applied')) out.push({ invariant: 19, summary: `after ${folder.describe(line)}, no honest admin's removal of ${author} applies`, expected: `an honest admin removes ${author}`, got: removal ? `${removal.by}'s removal: ${removal.status}` : 'no honest admin could build a removal' });
    }
    // c. a restore with the honest phrase opens the vault.
    const honestPhrase = world.recoveries.find((r) => r.honest && world.ids[r.label] === state.recovery?.deviceId);
    if (honestPhrase) {
      const restored = applyOp(world, { t: 'restore', device: FRESH_DEVICE });
      const restoredView = restored ? folderView(restored) : null;
      const opens = restored && restoredView && world.ctx.currentKey(stateOf(restored, restoredView), restoredView.key, world.ctx.device(FRESH_DEVICE));
      if (!opens) out.push({ invariant: 19, summary: `after ${folder.describe(line)}, a restore with the honest phrase ${honestPhrase.label} doesn't open the vault`, expected: 'the restored device holds the current key', got: restored ? 'it joined but holds no key that matches the keyCheck' : 'the restore could not be made' });
    }
    // d. after honest devices sync: the author cut off at the line before, and copies agree.
    const shared = folder.shared();
    const sharedState = stateOf(shared, folderView(shared));
    const id = folder.id(author);
    const cut = sharedState.cutoffs[id] ?? (sharedState.forked[id] !== undefined ? sharedState.forked[id]! - 1 : undefined);
    const status = statusIn(sharedState, line);
    // Nobody who can prove it got a bad seal (e.g. only the recovery identity did): a device holding the key sees it and asks for a fresh key instead.
    const proven = shared.seals.some((p) => p.entry === line.hash);
    const healed = !proven && (sharedState.needsFreshKey || sharedState.epoch > (line.entry.body as { epoch?: number }).epoch!);
    if (!healed && (status === 'applied' || cut === undefined || cut > line.seq - 1)) out.push({ invariant: 19, summary: `once honest devices synced, ${folder.describe(line)} is ${status} and its author's cutoff is ${cut ?? 'none'}`, expected: `${folder.describe(line)} void, ${author} cut off at seq ${line.seq - 1} (a proof), or a fresh key asked for (no one could prove it)`, got: `${status}; cutoff ${cut ?? 'none'}; seal proofs ${shared.seals.length}; needs a fresh key ${sharedState.needsFreshKey}` });
  }
  return out;
}

/** Invariant 20: every attacker identity active at the end can be removed by an honest admin. */
function activeDevicesRemovable(folder: Folder): Violation[] {
  const { world, state } = folder;
  if (!world.attackStarted) return [];
  const out: Violation[] = [];
  for (const label of attackerLabels(world)) {
    const member = state.members[world.ids[label] ?? ''];
    if (!member || member.removed || !member.joined) continue;
    const removal = honestRemoval(world, label);
    if (!removal || removal.status === 'applied') continue;
    out.push({ invariant: 20, summary: `${label} is active, but ${removal.by}'s removal of it is ${removal.status}`, expected: `the removal of ${label} applies`, got: removal.status });
  }
  return out;
}

/** Invariant 22. */
function capsRecover(folder: Folder): Violation[] {
  const { world } = folder;
  if (!world.config.quota) return [];
  const out: Violation[] = [];
  for (const refusal of world.honestRefusals) {
    if (!refusal.reason.startsWith(QUOTA_REFUSAL) || !/full/.test(refusal.reason)) continue;
    const state = stateOf(world, viewOf(world, refusal.folder));
    const attackersOut = attackerLabels(world).every((l) => { const m = state.members[world.ids[l] ?? '']; return !m || m.removed; });
    if (!attackersOut) continue;
    const author = state.members[world.ids[refusal.label] ?? ''];
    const share = author?.role === 'admin' ? MODEL_LIMITS.admin.lines : MODEL_LIMITS.member.lines;
    if ((refusal.folder[refusal.label] ?? 0) + refusal.hashes.length > share) continue;
    out.push({ invariant: 22, summary: `with every attacker removed, the agent refuses ${refusal.label}'s lines within its share because the vault is full`, expected: 'taken: removed identities no longer fill the vault', got: `refused: ${refusal.reason}` });
  }
  return out;
}

/**
 * Invariant 23 (as the R6-F agent proposed): a re-encoded honest line is a bad line in the folder
 * only. On every honest device, honest lines it holds have the status they have with canonical
 * bytes, and an honest agent send writes the canonical line back over a re-encoded one.
 */
function bytesDontMatter(folder: Folder): Violation[] {
  const { world } = folder;
  if (Object.keys(world.canonicalHeld).length === 0) return [];
  const out: Violation[] = [];
  for (const p of world.paddedSurvived) out.push({ invariant: 23, summary: `${p.by}'s send through the agent left ${p.label}#${p.seq} re-encoded in the folder`, expected: 'the agent writes the canonical line over it', got: 'the whitespace copy stays' });
  for (const device of world.devices.filter((d) => !isAttacker(world, d))) {
    const local = localView(world, device);
    const counts = Object.fromEntries(Object.entries(local.logs).map(([id, lines]) => [labelOfId(world, id), lines.length]));
    const canonical = viewOf(world, counts, world.copies[device], true, device);
    const state = stateOf(world, local);
    const reference = stateOf(world, { ...canonical, key: `${canonical.key}#canonical` });
    const flipped = folder.lines.filter((l) => l.honest && (counts[l.label] ?? 0) > l.seq && normalise(statusIn(reference, l)) !== normalise(statusIn(state, l)));
    if (flipped.length > 0) out.push({ invariant: 23, summary: `on ${device}'s copy, re-encoded lines change honest outcomes`, expected: 'the same outcome as with the canonical bytes', got: flipped.map((l) => `${folder.describe(l)}: ${statusIn(state, l)}, canonically ${statusIn(reference, l)}`).join('; ') });
  }
  return out;
}

export const CHECKS: { invariant: number; run: (folder: Folder) => Violation[]; option?: keyof CheckOptions }[] = [
  { invariant: 1, run: thiefStaysOut },
  { invariant: 2, run: cutOffStaysCutOff },
  { invariant: 3, run: removalsProtectTheirPast },
  { invariant: 4, run: honestRunsLoseNothing },
  { invariant: 5, run: sameEverywhere, option: 'readOrders' },
  { invariant: 6, run: rejectedHaveNoEffect },
  { invariant: 7, run: honestCanGoOn, option: 'goOn' },
  { invariant: 8, run: thiefDamagesOnlyAvailability },
  { invariant: 9, run: agentAdmitsNoStaleLine },
  { invariant: 10, run: onlyForkersAccused },
  { invariant: 11, run: rolesHold },
  { invariant: 11, run: memberCantBlockItsRemoval },
  { invariant: 12, run: joinsComplete },
  { invariant: 15, run: beaconsRaiseNoFalseAlarm },
  { invariant: 16, run: signaturesHold },
  { invariant: 17, run: joinedDevicesHoldKey },
  { invariant: 18, run: capsNeverLockOut },
  { invariant: 19, run: badSealsCostNothing },
  { invariant: 20, run: activeDevicesRemovable },
  { invariant: 22, run: capsRecover },
  { invariant: 23, run: bytesDontMatter },
  // Invariant 14 comes from the same records.
  { invariant: 13, run: agentTakesHonestLines },
];

/** Checks every invariant on the world's folder. */
export function checkWorld(world: World, options: CheckOptions = { readOrders: true, goOn: true }): Violation[] {
  const folder = new Folder(world);
  return CHECKS.filter((c) => !c.option || options[c.option]).flatMap((c) => c.run(folder));
}
