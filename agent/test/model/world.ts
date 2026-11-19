/**
 * The simulator: a vault folder, each honest device's synced copy of it, and one optional
 * compromised device (the thief: a stolen phone, or a malicious team member). Every entry is
 * signed with the real builders on the view the signer really has, so the rules under test
 * decide everything.
 *
 * Honest devices sign on exactly what they have synced, send their own lines when they sync,
 * never sign two entries at one seq, publish the fork proofs they find and, with beacons on, sign
 * a head beacon after each sync that sent everything. The thief signs with its own keys whenever
 * it likes, on any prefix of the published logs (plus its whole own log), and may withhold its
 * lines, sign a second line at a seq it already sent (a fork), name hashes that don't exist in
 * `seen` (slander) and sign lying beacons.
 *
 * In agent mode every line, honest or not, reaches the folder through the real planAppend, one
 * batch per log, as the agent receives them.
 */
import { afterOwnEntry, buildAccountDelete, buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, buildKeyRotate, buildRecoverySet, createVault, newAccountId } from '../../src/vault/build';
import {
  buildRecoverySetFromPhrase,
  checkJoinedVault,
  entryHash,
  findForks,
  restoreWithPhrase,
  serializeEntry,
  signBeacon,
  signEntry,
  type Beacon,
  type EntryRef,
  type ForkProof,
  type Role,
  type SignedEntry,
  type VaultKind,
  type VaultState,
  toBase64Url,
  type DeviceKeys,
} from '../../src/vault/index';
import { seededRandom, type ModelContext } from './context';
import { ownSealProofs, type SealProof } from '../../src/vault/sealProof';

export const FOUNDER = 'F';
/** Honest device labels in the order devices join; the founder is F. */
export const DEVICE_LABELS = ['D1', 'D2', 'D3', 'D4', 'D5'];
export const PUPPET_LABELS = ['P1', 'P2'];
export const KEY_CHANGE_KINDS: readonly string[] = ['device.remove', 'recovery.set', 'key.rotate'];
export const MEMBERSHIP_CHANGE_KINDS: readonly string[] = ['device.add', 'device.remove', 'recovery.set', 'key.rotate'];

export type ClockPolicy = 'steady' | 'skewed' | 'thiefAhead' | 'backwards';
export const CLOCK_POLICIES: readonly ClockPolicy[] = ['steady', 'skewed', 'thiefAhead', 'backwards'];

/**
 * slander: an account.put whose `seen` names a hash the target's log doesn't have. beacon: a lying
 * head beacon. squat: an approval of a pending joiner with the thief's own sealing key, before the
 * honest approval. flood: many account.puts at once (a member filling its quota). forkProof: a
 * second version of one of its own lines, at any seq, published as a fork proof. garbageSig: a folder
 * writer puts a line with a garbage signature in the thief's log and a validly signed line chained
 * on it (with `fork`, in place of its last sent line). plantKey: an approval of a pending joiner with
 * its real keys but a key sealed to it that is not the vault key, dated early (sorted first).
 * fillReserve: FILL_LINES key rotations in a row, to fill the agent's reserve (invariant 18).
 * badSeal: a key.rotate (or, with `sealAs: 'recoverySet'`, a recovery.set with the thief's own phrase)
 * whose keyCheck is right but whose key sealed to other recipients is another key (invariant 19).
 * reencode: a folder writer rewrites an honest device's published lines with whitespace (the same
 * signed entries, other bytes; invariant 23).
 */
export type AttackKind = 'remove' | 'recoverySet' | 'rotate' | 'put' | 'addPuppet' | 'slander' | 'beacon' | 'squat' | 'flood' | 'forkProof' | 'garbageSig' | 'plantKey' | 'fillReserve' | 'badSeal' | 'reencode';
export const ATTACK_KINDS: readonly AttackKind[] = ['remove', 'recoverySet', 'rotate', 'put', 'addPuppet', 'slander', 'beacon', 'squat', 'flood', 'forkProof', 'garbageSig', 'plantKey', 'fillReserve', 'badSeal', 'reencode'];
/** badSeal: a key change with a correct keyCheck but a wrong key sealed to every other recipient ('all'), or only to the recovery identity ('recovery'). */
export type SealVictims = 'all' | 'recovery';
/** Key rotations in one fillReserve (with its hello, past an identity's model reserve of 4, see quota.ts). */
export const FILL_LINES = 4;
/** Lines in one flood. */
export const FLOOD_LINES = 40;
/** Which heads the thief names in `seen`: the applied ones (as the app does) or every verified head. */
export type SeenMode = 'applied' | 'heads';
/** A slander names a fake hash at a seq the target's log has, or past its end. */
/** ownFork: a puppet names the thief's own second version from its fork proof (a ghost contest, invariant 21). */
export type SlanderMode = 'existing' | 'pastEnd' | 'ownFork';

/**
 * When an honest device signs offline or online: `pull` syncs right before signing (sending what
 * it had pending and reading the folder), `push` sends the new line right after.
 */
export interface Timing {
  pull?: boolean;
  push?: boolean;
}

export type Op =
  /** `role`: team vaults approve admins or plain members; personal vaults only admins. */
  | { t: 'add'; by: string; device: string; role?: Role }
  /** An admin approves again a device a rotation left without the current key (the app does it by itself). */
  | { t: 'reapprove'; by: string; device: string }
  | ({ t: 'remove'; by: string; target: string } & Timing)
  | ({ t: 'recoverySet'; by: string; recovery: string } & Timing)
  | ({ t: 'rotate'; by: string } & Timing)
  /** `remake`: write an account again under the current key, as the app does when the rules reject a put. */
  | ({ t: 'put'; by: string; account: string; remake?: boolean } & Timing)
  /** An account.delete of an account the model added (needs no key). */
  | ({ t: 'delete'; by: string; account: string } & Timing)
  | { t: 'restore'; device: string }
  | { t: 'sync'; device: string }
  /**
   * `as`: one of the thief's puppets signs instead (removals only). `fork`: sign at the seq of the
   * thief's last sent line instead of after it. `slander`: where the fake `seen` points.
   */
  | {
      t: 'attack';
      kind: AttackKind;
      target?: string;
      as?: string;
      cut: Record<string, number>;
      seenMode: SeenMode;
      grind: boolean;
      publish: boolean;
      fork?: boolean;
      slander?: SlanderMode;
      forkAt?: number;
      /** badSeal: which key change, and whose seals are wrong. */
      sealAs?: 'rotate' | 'recoverySet';
      victims?: SealVictims;
      /** Agent mode: write straight into the folder anyway (a member with folder write access). */
      direct?: boolean;
    }
  | { t: 'release' };

export interface WorldConfig {
  kind: VaultKind;
  /** The device that will be stolen (or turn malicious), or null for an honest-only run. */
  thief: string | null;
  clock: ClockPolicy;
  /**
   * How lines reach the folder: straight in (the thief has folder write access, or a hostile
   * computer), or through an honest agent's planAppend, every honest and thief line alike.
   */
  agent: boolean;
  /** Honest devices sign head beacons after each sync that sent everything. */
  beacons?: boolean;
  /** Agent mode: the agent also applies its caps, at model scale (quota.ts). */
  quota?: boolean;
}

/** A thief line an honest agent admitted, and what was wrong with its author in the folder before (invariant 9). */
export interface Admission {
  hash: string;
  problem: string | null;
  /** Lines sent together share a batch number. */
  batch: number;
}

/** An honest batch the agent refused (invariant 13), with the folder as it was. */
export interface HonestRefusal {
  label: string;
  hashes: string[];
  reason: string;
  /** What was wrong with the author in the folder before, if anything. */
  problem: string | null;
  /** Per-label published counts when it was sent. */
  folder: Record<string, number>;
  /** An exact retry of lines the agent had just stored. */
  retry: boolean;
}

/** One signed line and what the model knows about it. */
export interface Line {
  label: string;
  seq: number;
  text: string;
  entry: SignedEntry;
  hash: string;
  /** Signed by an honest identity on its own synced view (false: the thief or its puppets). */
  honest: boolean;
  /** The device, recovery identity or account the line is about, as a label. */
  subject?: string;
  /** Index of the op that signed it. */
  step: number;
  /** The thief ground its hash below every other key change. */
  ground?: boolean;
  /** Its `seen` names a hash that isn't the named log's line (or a seq past its end). */
  slander?: boolean;
  /** Its signature is garbage (garbageSig). */
  garbage?: boolean;
  /** A key change with wrong keys sealed to others (badSeal). */
  badSeal?: boolean;
}

export interface Counters {
  membership: number;
  puts: number;
  attacks: number;
  recoverySets: number;
}

export interface World {
  readonly ctx: ModelContext;
  readonly config: WorldConfig;
  readonly vaultId: string;
  /** label -> deviceId of every identity with a log. */
  readonly ids: Record<string, string>;
  /** Each log as the folder has it (a forked line replaced by the thief's other version). */
  readonly lines: Record<string, Line[]>;
  /** label -> how many of its lines are in the folder. */
  readonly published: Record<string, number>;
  /** Honest device label -> how many lines of each log it has synced. */
  readonly synced: Record<string, Record<string, number>>;
  /** Honest device label -> its own copy of a log the thief forked under it (the version it read first). */
  readonly copies: Record<string, Record<string, Line[]>>;
  /** Fork proofs honest devices published (the folder's `forks/`, one per identity). */
  readonly proofs: ForkProof[];
  /** Bad-seal proofs honest recipients published (the folder's `seals/<authorId>.json`: each author's earliest). */
  readonly seals: SealProof[];
  /** Honest devices' canonical copies of lines a folder writer later re-encoded: label -> device -> lines it held. */
  readonly canonicalHeld: Record<string, Record<string, number>>;
  /** Re-encoded lines an honest agent send left non-canonical in the folder (inv23). */
  readonly paddedSurvived: { label: string; seq: number; by: string }[];
  /** Thief label -> the seq where it really signed two lines. */
  readonly forkedAt: Record<string, number>;
  /** label -> its latest head beacon. */
  readonly beacons: Record<string, Beacon>;
  /** Devices that joined (the founder first), the thief included, puppets not. */
  readonly devices: string[];
  readonly puppets: string[];
  readonly recoveries: { label: string; honest: boolean }[];
  /** Account label -> account id. */
  readonly accounts: Record<string, string>;
  readonly attackStarted: boolean;
  readonly trace: Op[];
  readonly counters: Counters;
  /** Honest-only runs: removals and accounts that were ever applied in the folder (invariant 4). */
  readonly everAppliedRemovals: string[];
  readonly everAccounts: string[];
  /** Agent mode: thief lines the agent admitted, and how many thief sends it refused. */
  readonly admissions: Admission[];
  readonly refusals: number;
  /** Agent mode: honest batches the agent refused. */
  readonly honestRefusals: HonestRefusal[];
  /** Joiners the thief approved first with its own sealing key. */
  readonly squats: string[];
  /** Joins whose joiner found its approval wrong (checkJoinedVault said intercepted). */
  readonly intercepted: { device: string; by: string; reason: string }[];
  /** Joiners the thief approved first with their real keys but a key that isn't the vault's (plantKey). */
  readonly planted: string[];
  /** Accounts an honest device deleted. */
  deleted?: string[];
  /** label -> seqs of its published lines a folder writer re-encoded with whitespace (reencode). */
  readonly padded: Record<string, number[]>;
}

/** A folder or a device's copy: per-label line counts, and the logs they give. */
export interface View {
  counts: Record<string, number>;
  logs: Record<string, string[]>;
  key: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const CLOCK_START = 1_700_000_000_000;
const STEP_MS = 1000;
const SKEW: Record<string, number> = { F: 0, D1: 3_600_000, D2: -3_600_000, D3: 86_400_000, D4: -86_400_000 };
const THIEF_AHEAD_MS = 10_000_000_000;

export function newWorld(ctx: ModelContext, config: WorldConfig): World {
  const founder = ctx.device(FOUNDER);
  const created = createVault({ founder, kind: config.kind, name: 'Home', deviceName: FOUNDER, random: seededRandom(`${ctx.seed}/create`), time: CLOCK_START });
  const line: Line = { label: FOUNDER, seq: 0, text: serializeEntry(created.entry), entry: created.entry, hash: entryHash(created.entry), honest: true, step: -1 };
  return {
    ctx,
    config,
    vaultId: created.vaultId,
    ids: { [FOUNDER]: founder.deviceId },
    lines: { [FOUNDER]: [line] },
    published: { [FOUNDER]: 1 },
    synced: { [FOUNDER]: { [FOUNDER]: 1 } },
    copies: {},
    proofs: [],
    seals: [],
    canonicalHeld: {},
    paddedSurvived: [],
    forkedAt: {},
    beacons: {},
    devices: [FOUNDER],
    puppets: [],
    recoveries: [],
    accounts: {},
    attackStarted: false,
    trace: [],
    counters: { membership: 0, puts: 0, attacks: 0, recoverySets: 0 },
    everAppliedRemovals: [],
    everAccounts: [],
    admissions: [],
    refusals: 0,
    honestRefusals: [],
    squats: [],
    intercepted: [],
    planted: [],
    padded: {},
  };
}

/** Every identity the thief signs for: its device, its puppets and its own recovery phrases. */
export function attackerLabels(world: World): string[] {
  if (!world.config.thief) return [];
  return [world.config.thief, ...world.puppets, ...world.recoveries.filter((r) => !r.honest).map((r) => r.label)];
}

export function isAttacker(world: World, label: string): boolean {
  return (label === world.config.thief && world.attackStarted) || world.puppets.includes(label) || world.recoveries.some((r) => r.label === label && !r.honest);
}

function proofsKey(world: World): string {
  const seals = world.seals.length === 0 ? '' : `#seals:${world.seals.map((p) => `${p.entry.slice(0, 10)}>${labelOfId(world, p.to)}`).join(',')}`;
  return (world.proofs.length === 0 ? '' : `#forks:${world.proofs.map((p) => `${labelOfId(world, p.deviceId)}@${p.seq}`).join(',')}`) + seals;
}

/** The logs for per-label counts, keyed by device id in label order. `own` replaces whole logs (a device's own copy of a forked log). */
export function viewOf(world: World, counts: Record<string, number>, own: Record<string, Line[]> = {}, canonical = false, self?: string): View {
  const logs: Record<string, string[]> = {};
  const keyParts: string[] = [];
  for (const label of Object.keys(world.lines).sort()) {
    const source = own[label] ?? world.lines[label]!;
    const count = Math.min(counts[label] ?? 0, source.length);
    if (count === 0) continue;
    const lines = source.slice(0, count);
    // Lines a folder writer re-encoded: everyone reads the folder's bytes (devices adopt them on sync).
    // A device keeps its own lines as it signed them, and the canonical copies it read before they were re-encoded.
    const held = self ? world.canonicalHeld[label]?.[self] ?? 0 : 0;
    const padded = canonical || own[label] || label === self ? undefined : world.padded[label]?.filter((q) => q >= held);
    logs[world.ids[label]!] = lines.map((l) => (padded?.includes(l.seq) ? padText(l.text) : l.text));
    keyParts.push(`${label}:${lines[lines.length - 1]!.hash}${padded?.length ? `~pad${held}:${padded.filter((q) => q < count).length}` : ''}`);
  }
  return { counts, logs, key: keyParts.join(',') + proofsKey(world) };
}

/** The same JSON with whitespace: other bytes, the same signed entry. */
export function padText(text: string): string {
  return JSON.stringify(JSON.parse(text), null, 1);
}

export function folderView(world: World): View {
  return viewOf(world, world.published);
}

export function localView(world: World, label: string): View {
  return viewOf(world, { ...world.synced[label], [label]: world.lines[label]?.length ?? 0 }, world.copies[label], false, label);
}

export function stateOf(world: World, view: View): VaultState {
  return world.ctx.replayFolder(world.vaultId, view.logs, view.key, world.proofs, world.seals);
}

export function labelOfId(world: World, deviceId: string): string {
  for (const [label, id] of Object.entries(world.ids)) if (id === deviceId) return label;
  return world.ctx.labelOf(deviceId);
}

function clock(world: World, label: string): number {
  const step = world.trace.length;
  const steady = CLOCK_START + step * STEP_MS;
  switch (world.config.clock) {
    case 'steady':
      return steady;
    case 'skewed':
      return steady + (SKEW[label] ?? 0);
    case 'thiefAhead':
      return label === world.config.thief || world.puppets.includes(label) ? steady + THIEF_AHEAD_MS : steady;
    case 'backwards':
      return CLOCK_START + 1_000_000 - step * STEP_MS;
  }
}

/**
 * The random seed for an op. Whether a line is sent now, withheld or ground doesn't change how
 * it is built, so those variants share a seed (and, through the build memo, the signed entry).
 */
function seedFor(world: World, op: Op): string {
  const { push: _push, publish: _publish, grind: _grind, ...built } = op as Op & { push?: boolean; publish?: boolean; grind?: boolean };
  return `${world.ctx.seed}/${world.trace.length}/${JSON.stringify(built)}`;
}

function randomFor(world: World, op: Op): ReturnType<typeof seededRandom> {
  return seededRandom(seedFor(world, op));
}

/** Builds through the context memo, keyed by the op's seed and the signer's view. */
function built<T>(world: World, op: Op, view: View, build: () => T): T {
  return world.ctx.memo(`${seedFor(world, op)}|${view.key}`, build);
}

function clone(world: World): Mutable<World> {
  return {
    ...world,
    ids: { ...world.ids },
    lines: Object.fromEntries(Object.entries(world.lines).map(([k, v]) => [k, [...v]])),
    published: { ...world.published },
    synced: Object.fromEntries(Object.entries(world.synced).map(([k, v]) => [k, { ...v }])),
    copies: Object.fromEntries(Object.entries(world.copies).map(([k, v]) => [k, { ...v }])),
    proofs: [...world.proofs],
    seals: [...world.seals],
    canonicalHeld: Object.fromEntries(Object.entries(world.canonicalHeld).map(([k, v]) => [k, { ...v }])),
    paddedSurvived: [...world.paddedSurvived],
    forkedAt: { ...world.forkedAt },
    beacons: { ...world.beacons },
    devices: [...world.devices],
    puppets: [...world.puppets],
    recoveries: [...world.recoveries],
    accounts: { ...world.accounts },
    trace: [...world.trace],
    counters: { ...world.counters },
    admissions: [...world.admissions],
    honestRefusals: [...world.honestRefusals],
    squats: [...world.squats],
    intercepted: [...world.intercepted],
    planted: [...world.planted],
    padded: { ...world.padded },
    ...(world.deleted ? { deleted: [...world.deleted] } : {}),
  };
}

function append(world: Mutable<World>, label: string, entry: SignedEntry, extra: { honest: boolean; subject?: string; ground?: boolean; slander?: boolean; garbage?: boolean; badSeal?: boolean }): Line {
  const log = (world.lines[label] ??= []);
  if (entry.seq !== log.length) throw new Error(`model bug: ${label} signed seq ${entry.seq} but has ${log.length} lines`);
  const line: Line = { label, seq: entry.seq, text: serializeEntry(entry), entry, hash: entryHash(entry), step: world.trace.length, ...extra };
  log.push(line);
  if (world.synced[label]) world.synced[label]![label] = log.length;
  return line;
}

/** What makes an author's new lines inadmissible in a state: removed, cut off or forked. */
export function authorProblem(state: VaultState, deviceId: string): string | null {
  if (!state.members[deviceId] && state.recovery?.deviceId !== deviceId) return 'its author is not a device of the vault';
  if (state.members[deviceId]?.removed) return 'its author is removed';
  if (state.cutoffs[deviceId] !== undefined) return `its author is cut off at seq ${state.cutoffs[deviceId]}`;
  if (state.forked[deviceId] !== undefined) return 'its author forked';
  return null;
}

/**
 * Sends an honest identity's unsent lines. Straight into the folder, or through the agent as one
 * batch. A refused batch stays unsent. A removed device that signed removals before it saw its own
 * removal sends them again on their own (re-paired, as the app offers), up to the last of them.
 * After each admitted batch the device, not hearing back, sends the same bytes again: an exact
 * retry, which the agent must take too. Returns false when nothing was sent.
 */
function sendHonest(world: Mutable<World>, label: string): boolean {
  const unsent = (world.lines[label] ?? []).slice(world.published[label] ?? 0);
  if (unsent.length === 0) return false;
  if (!world.config.agent) {
    world.published[label] = world.lines[label]!.length;
    beaconAfterSend(world, label);
    return true;
  }
  const sent = sendThroughAgent(world, label, unsent);
  if (sent) beaconAfterSend(world, label);
  return sent;
}

/** A device that has sent everything signs a beacon for its copy, as the app does after each such sync. */
function beaconAfterSend(world: Mutable<World>, label: string): void {
  if (world.config.beacons && world.devices.includes(label) && (world.published[label] ?? 0) === (world.lines[label]?.length ?? 0)) writeBeacon(world, label);
}

function sendThroughAgent(world: Mutable<World>, label: string, unsent: Line[]): boolean {
  const view = folderView(world);
  const problem = authorProblem(stateOf(world, view), world.ids[label]!);
  const tryBatch = (batch: Line[]): boolean => {
    const result = world.ctx.append(world.vaultId, view.logs, batch.map((l) => l.entry), world.proofs, !!world.config.quota, world.seals);
    if (!result.ok) {
      world.honestRefusals.push({ label, hashes: batch.map((l) => l.hash), reason: result.reason, problem, folder: { ...world.published }, retry: false });
      return false;
    }
    world.published[label] = batch[batch.length - 1]!.seq + 1;
    // The agent writes the canonical line over a re-encoded one (inv23): what it wrote back is the folder now.
    agentRewrites(world, label, result.logs);
    const after = folderView(world);
    const retry = world.ctx.append(world.vaultId, after.logs, batch.map((l) => l.entry), world.proofs, !!world.config.quota, world.seals);
    if (!retry.ok) world.honestRefusals.push({ label, hashes: batch.map((l) => l.hash), reason: retry.reason, problem: null, folder: { ...world.published }, retry: true });
    return true;
  };
  if (tryBatch(unsent)) return true;
  const lastRemoval = unsent.map((l) => l.entry.kind).lastIndexOf('device.remove');
  if (problem === null || lastRemoval < 0 || lastRemoval === unsent.length - 1) return false;
  return tryBatch(unsent.slice(0, lastRemoval + 1));
}

/**
 * Reads the folder. A device whose own copy of a log differs from the folder's at some seq (the
 * thief signed two lines there) publishes the fork proof and keeps its own copy. With beacons on,
 * a device that has sent everything then signs a beacon for what it read.
 */
function pull(world: Mutable<World>, label: string): void {
  const own = world.copies[label] ?? {};
  const synced: Record<string, number> = { ...world.published, [label]: world.lines[label]?.length ?? 0 };
  for (const [log, lines] of Object.entries(own)) synced[log] = lines.length;
  world.synced[label] = synced;
  if (Object.keys(own).length > 0) publishForkProofs(world, label);
  publishSealProofs(world, label);
  if (world.config.beacons && (world.published[label] ?? 0) === (world.lines[label]?.length ?? 0)) writeBeacon(world, label);
}

function publishForkProofs(world: Mutable<World>, label: string): void {
  const local = localView(world, label);
  const folder = folderView(world);
  const found = findForks(local.logs, stateOf(world, local), folder.logs, stateOf(world, folder));
  for (const proof of found) {
    if (world.proofs.some((p) => p.deviceId === proof.deviceId)) continue;
    world.proofs.push(proof);
  }
}

/**
 * A recipient whose seal in some key-bearing entry doesn't open to that entry's key proves it
 * (sealProof.ts ownSealProofs) and writes the proof to `seals/<authorId>.json`: each author's earliest.
 */
function publishSealProofs(world: Mutable<World>, label: string): void {
  const view = localView(world, label);
  const state = stateOf(world, view);
  const found = world.ctx.memo(`seals|${label}|${view.key}`, () => {
    try {
      return ownSealProofs(state, view.logs, world.ctx.device(label));
    } catch {
      return [];
    }
  });
  for (const proof of found) {
    const line = lineByHash(world, proof.entry);
    if (!line) continue;
    const at = world.seals.findIndex((p) => lineByHash(world, p.entry)?.label === line.label);
    if (at < 0) world.seals.push(proof);
    else if (lineByHash(world, world.seals[at]!.entry)!.seq > line.seq) world.seals[at] = proof;
  }
}

function lineByHash(world: World, hash: string): Line | undefined {
  for (const lines of Object.values(world.lines)) {
    const found = lines.find((l) => l.hash === hash);
    if (found) return found;
  }
  return undefined;
}

/** After an honest agent send: re-encoded lines the agent wrote back canonical are canonical again; any it left are recorded. */
function agentRewrites(world: Mutable<World>, by: string, logs: Record<string, string[]>): void {
  for (const [label, seqs] of Object.entries(world.padded)) {
    const written = logs[world.ids[label]!] ?? [];
    const left: number[] = [];
    for (const seq of seqs) {
      const text = written[seq];
      if (text === undefined || text === world.lines[label]![seq]!.text) continue;
      left.push(seq);
      if (!world.paddedSurvived.some((p) => p.label === label && p.seq === seq)) world.paddedSurvived.push({ label, seq, by });
    }
    if (left.length === 0) delete world.padded[label];
    else world.padded[label] = left;
  }
}

function writeBeacon(world: Mutable<World>, label: string): void {
  const view = localView(world, label);
  const time = clock(world, label);
  world.beacons[label] = world.ctx.memo(`beacon|${label}|${time}|${view.key}`, () => signBeacon(stateOf(world, view), world.ctx.device(label), time));
}

/** An honest device acting now: its synced view, state and current key, or null if it can't. Membership changes need an admin. */
function honestActor(world: World, label: string, needAdmin = true, readOnly = false): { view: View; state: VaultState; key: Uint8Array } | null {
  if (!world.devices.includes(label) || (label === world.config.thief && world.attackStarted)) return null;
  const view = localView(world, label);
  const state = stateOf(world, view);
  const member = state.members[world.ids[label]!];
  if (!member || member.removed || (needAdmin && member.role !== 'admin')) return null;
  const key = world.ctx.currentKey(state, view.key, world.ctx.device(label), readOnly);
  return key ? { view, state, key } : null;
}

/** What the approver showed the joiner when they compared codes. */
function challengeOf(world: World, approver: string): Parameters<typeof checkJoinedVault>[2] {
  const keys = world.ctx.device(approver);
  return { ed: toBase64Url(keys.edPublic), x: toBase64Url(keys.xPublic), vault: world.vaultId, vaultName: 'Home', name: approver, nonce: 'model' };
}

/**
 * A new device reads the folder and writes its hello, if the folder shows it approved. Joining
 * through an approver it compared codes with, it first checks the approval as the app does
 * (checkJoinedVault); an intercepted join never writes its hello.
 */
function join(world: Mutable<World>, device: string, approver?: string): boolean {
  world.synced[device] = { ...world.published, [device]: 0 };
  const view = localView(world, device);
  const state = stateOf(world, view);
  const member = state.members[world.ids[device]!];
  if (!member || member.removed) return false;
  let approval: string | undefined;
  if (approver) {
    const check = (world.ctx.replay.checkJoinedVault ?? checkJoinedVault)(state, world.ctx.device(device), challengeOf(world, approver));
    if (check.status === 'intercepted') {
      world.intercepted.push({ device, by: approver, reason: check.reason });
      return false;
    }
    if (check.status !== 'ok') return false;
    approval = check.approval;
  }
  const time = clock(world, device);
  // The hello confirms the approval checkJoinedVault named (else the builder's choice); none to confirm: it can't join.
  let hello: SignedEntry;
  try {
    hello = world.ctx.memo(`hello|${device}|${time}|${view.key}|${approval ?? ''}`, () => buildDeviceHello(state, world.ctx.device(device), time, approval));
  } catch {
    return false;
  }
  append(world, device, hello, { honest: true });
  world.devices.push(device);
  sendHonest(world, device);
  pull(world, device);
  return true;
}

function recordHonestHistory(world: Mutable<World>): void {
  if (world.attackStarted) return;
  const state = stateOf(world, folderView(world));
  const removals = new Set(world.everAppliedRemovals);
  for (const item of state.history) if (item.kind === 'device.remove' && item.status === 'applied') removals.add(item.hash);
  const accounts = new Set(world.everAccounts);
  for (const [label, id] of Object.entries(world.accounts)) if (state.accounts[id]) accounts.add(label);
  world.everAppliedRemovals = [...removals];
  world.everAccounts = [...accounts];
}

type Handler<T extends Op['t']> = (world: Mutable<World>, op: Extract<Op, { t: T }>) => boolean;

const HANDLERS: { [T in Op['t']]: Handler<T> } = {
  sync: (world, { device }) => {
    if (!world.synced[device] || (device === world.config.thief && world.attackStarted)) return false;
    const before = JSON.stringify([world.published[device], world.synced[device], world.proofs.length, world.seals.length, world.honestRefusals.length]);
    sendHonest(world, device);
    pull(world, device);
    return JSON.stringify([world.published[device], world.synced[device], world.proofs.length, world.seals.length, world.honestRefusals.length]) !== before;
  },
  add: (world, { by, device, role = 'admin' }) => {
    // A joiner the thief squatted is still pending: its honest approval goes ahead.
    if ((world.ids[device] && !world.squats.includes(device)) || world.devices.includes(device) || !world.synced[by]) return false;
    // Approving is done online: the approver syncs first. A no-op sync is fine here.
    HANDLERS.sync(world, { t: 'sync', device: by });
    const actor = honestActor(world, by);
    if (!actor) return false;
    const keys = world.ctx.device(device);
    world.ids[device] = keys.deviceId;
    const op: Op = { t: 'add', by, device, role };
    const entry = built(world, op, actor.view, () => buildDeviceAdd(actor.state, world.ctx.device(by), { device: keys, role, name: device, currentKey: actor.key, random: randomFor(world, op), time: clock(world, by) }));
    append(world, by, entry, { honest: true, subject: device });
    world.counters.membership++;
    // A refused approval stays unsent (invariant 13 judges the refusal); the new device can't join.
    return sendHonest(world, by) ? join(world, device, by) || true : true;
  },
  reapprove: (world, { by, device }) => {
    const id = world.ids[device];
    if (!id || by === device) return false;
    if (world.recoveries.some((r) => r.label === by)) return reapproveWithPhrase(world, by, device);
    if (!world.synced[by]) return false;
    HANDLERS.sync(world, { t: 'sync', device: by });
    const actor = honestActor(world, by);
    if (!actor) return false;
    const member = actor.state.members[id];
    if (!member || member.removed || !actor.state.unkeyedDevices.includes(id)) return false;
    const op: Op = { t: 'reapprove', by, device };
    const entry = built(world, op, actor.view, () => buildDeviceAdd(actor.state, world.ctx.device(by), { device: world.ctx.device(device), role: member.role, name: device, currentKey: actor.key, random: randomFor(world, op), time: clock(world, by) }));
    append(world, by, entry, { honest: true, subject: device });
    sendHonest(world, by);
    world.counters.membership++;
    return true;
  },
  remove: (world, op) => {
    const actor = honestActor(world, op.by, true, true);
    const targetId = world.ids[op.target];
    if (!actor || !targetId || op.target === op.by) return false;
    const target = actor.state.members[targetId];
    if (!target || target.removed) return false;
    const { entry } = built(world, op, actor.view, () => buildDeviceRemove(actor.state, world.ctx.device(op.by), { device: targetId, currentKey: actor.key, random: randomFor(world, op), time: clock(world, op.by) }));
    append(world, op.by, entry, { honest: true, subject: op.target });
    world.counters.membership++;
    return true;
  },
  recoverySet: (world, op) => {
    const actor = honestActor(world, op.by);
    if (!actor || world.ids[op.recovery]) return false;
    const { phrase, keys } = world.ctx.recovery(op.recovery, world.vaultId);
    const { entry } = built(world, op, actor.view, () => buildRecoverySetFromPhrase(actor.state, world.ctx.device(op.by), { phrase, currentKey: actor.key, random: randomFor(world, op), time: clock(world, op.by) }));
    world.ids[op.recovery] = keys.deviceId;
    world.recoveries.push({ label: op.recovery, honest: true });
    append(world, op.by, entry, { honest: true, subject: op.recovery });
    world.counters.membership++;
    world.counters.recoverySets++;
    return true;
  },
  rotate: (world, op) => {
    // A device on its read-only fallback still writes the fresh key.
    const actor = honestActor(world, op.by, true, true);
    if (!actor || !actor.state.needsFreshKey) return false;
    const { entry } = built(world, op, actor.view, () => buildKeyRotate(actor.state, world.ctx.device(op.by), { currentKey: actor.key, random: randomFor(world, op), time: clock(world, op.by) }));
    append(world, op.by, entry, { honest: true });
    world.counters.membership++;
    return true;
  },
  put: (world, op) => {
    // Plain team members write accounts too.
    const actor = honestActor(world, op.by, false);
    if (!actor || actor.state.needsFreshKey || !!world.accounts[op.account] !== !!op.remake) return false;
    const random = randomFor(world, op);
    const account = world.accounts[op.account] ?? newAccountId(random);
    world.accounts[op.account] = account;
    const record = { issuer: op.account, label: 'model', secret: 'JBSWY3DPEHPK3PXP', type: 'totp' as const, algorithm: 'SHA1' as const, digits: 6, period: 30, counter: 0 };
    const entry = built(world, op, actor.view, () => buildAccountPut(actor.state, world.ctx.device(op.by), { account, record, currentKey: actor.key, random, time: clock(world, op.by) }));
    append(world, op.by, entry, { honest: true, subject: op.account });
    if (!op.remake) world.counters.puts++;
    return true;
  },
  delete: (world, op) => {
    const account = world.accounts[op.account];
    if (!account || world.deleted?.includes(op.account)) return false;
    if (!world.devices.includes(op.by) || (op.by === world.config.thief && world.attackStarted)) return false;
    const view = localView(world, op.by);
    const state = stateOf(world, view);
    const member = state.members[world.ids[op.by]!];
    if (!member || member.removed || !member.joined) return false;
    const entry = built(world, op, view, () => buildAccountDelete(state, world.ctx.device(op.by), { account, time: clock(world, op.by) }));
    append(world, op.by, entry, { honest: true, subject: op.account });
    world.deleted = [...(world.deleted ?? []), op.account];
    return true;
  },
  restore: (world, op) => {
    if (world.ids[op.device]) return false;
    const view = folderView(world);
    const state = stateOf(world, view);
    const current = world.recoveries.find((r) => r.honest && world.ids[r.label] === state.recovery?.deviceId);
    if (!current) return false;
    const { phrase } = world.ctx.recovery(current.label, world.vaultId);
    const keys = world.ctx.device(op.device);
    let entry: SignedEntry;
    try {
      entry = restoreWithPhrase(state, { phrase, device: keys, name: op.device, random: randomFor(world, op), time: clock(world, current.label) }).entry;
    } catch {
      return false;
    }
    world.ids[op.device] = keys.deviceId;
    append(world, current.label, entry, { honest: true, subject: op.device });
    world.counters.membership++;
    return sendHonest(world, current.label) ? join(world, op.device) : true;
  },
  attack: (world, op) => attack(world, op),
  release: (world) => publishAttacker(world),
};

/** The owner approves an unkeyed device again with the current honest recovery phrase, online. */
function reapproveWithPhrase(world: Mutable<World>, recovery: string, device: string): boolean {
  const view = folderView(world);
  const state = stateOf(world, view);
  const honest = world.recoveries.some((r) => r.label === recovery && r.honest);
  if (!honest || state.recovery?.deviceId !== world.ids[recovery] || !state.unkeyedDevices.includes(world.ids[device]!)) return false;
  const keys = world.ctx.recovery(recovery, world.vaultId).keys;
  const currentKey = world.ctx.currentKey(state, view.key, keys);
  if (!currentKey) return false;
  const op: Op = { t: 'reapprove', by: recovery, device };
  const entry = built(world, op, view, () => buildDeviceAdd(state, keys, { device: world.ctx.device(device), role: state.members[world.ids[device]!]!.role, name: device, currentKey, random: randomFor(world, op), time: clock(world, recovery) }));
  append(world, recovery, entry, { honest: true, subject: device });
  sendHonest(world, recovery);
  world.counters.membership++;
  return true;
}

/**
 * Sends the thief's and its puppets' unsent lines. Straight into the folder, or in agent mode one
 * batch per log (oldest first) through planAppend; a refused batch is cut down to its longest
 * admitted prefix, as the thief would try. Returns false when nothing changed.
 */
function publishAttacker(world: Mutable<World>, direct = false): boolean {
  const labels = attackerLabels(world);
  const pending = labels.filter((label) => (world.published[label] ?? 0) < (world.lines[label]?.length ?? 0));
  if (pending.length === 0) return false;
  if (!world.config.agent || direct) {
    for (const label of pending) world.published[label] = world.lines[label]!.length;
    return true;
  }
  const firstStep = (label: string) => world.lines[label]![world.published[label] ?? 0]!.step;
  let sent = 0;
  for (const label of pending.sort((a, b) => firstStep(a) - firstStep(b))) {
    const unsent = world.lines[label]!.slice(world.published[label] ?? 0);
    const view = folderView(world);
    const problem = authorProblem(stateOf(world, view), world.ids[label]!);
    for (let n = unsent.length; n > 0; n--) {
      const batch = unsent.slice(0, n);
      if (!world.ctx.append(world.vaultId, view.logs, batch.map((l) => l.entry), world.proofs, !!world.config.quota, world.seals).ok) {
        world.refusals++;
        continue;
      }
      const id = world.admissions.length;
      for (const line of batch) world.admissions.push({ hash: line.hash, problem, batch: id });
      world.published[label] = batch[n - 1]!.seq + 1;
      sent++;
      break;
    }
  }
  return sent > 0;
}

const GRIND_ATTEMPTS = 400;

/** Re-signs `entry` at later times until its hash is below every other key change in the world. */
function grind(world: World, entry: SignedEntry, thief: string): SignedEntry | null {
  const rivals = Object.values(world.lines)
    .flat()
    .filter((l) => l.label !== thief && KEY_CHANGE_KINDS.includes(l.entry.kind))
    .map((l) => l.hash);
  if (rivals.length === 0) return null;
  const lowest = rivals.sort()[0]!;
  return world.ctx.memo(`grind|${entryHash(entry)}|${lowest}`, () => grindBelow(world, entry, thief, lowest));
}

function grindBelow(world: World, entry: SignedEntry, thief: string, lowest: string): SignedEntry | null {
  const { sig: _sig, ...unsigned } = entry;
  for (let i = 0; i < GRIND_ATTEMPTS; i++) {
    const candidate = signEntry({ ...unsigned, time: unsigned.time + i }, world.ctx.device(thief));
    if (entryHash(candidate) < lowest) return candidate;
  }
  return null;
}

/** An honest device the thief can name in a slander or a lying beacon: one with lines in the folder. */
function slanderTarget(world: World, op: Extract<Op, { t: 'attack' }>): boolean {
  if (op.slander === 'ownFork') return op.kind === 'slander' && op.target === world.config.thief && !!op.as && (world.proofs.some((p) => p.deviceId === world.ids[op.target!]) || (op.forkAt !== undefined && op.forkAt < (world.published[op.target] ?? 0)));
  return !!op.target && world.devices.includes(op.target) && !isAttacker(world, op.target) && op.target !== world.config.thief && (world.published[op.target] ?? 0) > 0;
}

/** The label a thief's line is about: a removal's target or a new recovery, account or puppet label. null: no such op. */
function attackSubject(world: World, op: Extract<Op, { t: 'attack' }>): string | undefined | null {
  switch (op.kind) {
    case 'remove':
      return op.target && world.ids[op.target] && op.target !== (op.as ?? world.config.thief) ? op.target : null;
    case 'recoverySet':
      return `RX${world.recoveries.filter((r) => !r.honest).length + 1}`;
    case 'rotate':
      return undefined;
    case 'put':
      return `x${Object.keys(world.accounts).length + 1}`;
    case 'addPuppet':
      return PUPPET_LABELS.find((p) => !world.ids[p]) ?? null;
    case 'slander':
    case 'beacon':
      return slanderTarget(world, op) ? op.target : null;
    case 'squat':
    case 'plantKey':
      return op.target && !world.ids[op.target] && DEVICE_LABELS.includes(op.target) ? op.target : null;
    case 'garbageSig':
    case 'flood':
      return `x${Object.keys(world.accounts).length + 1}`;
    case 'forkProof':
    case 'fillReserve':
      return undefined;
    case 'badSeal':
      return op.sealAs === 'recoverySet' ? `RX${world.recoveries.filter((r) => !r.honest).length + 1}` : undefined;
    case 'reencode':
      return op.target && world.devices.includes(op.target) && !isAttacker(world, op.target) && (world.published[op.target] ?? 0) > 0 && !world.padded[op.target] ? op.target : null;
  }
}

/** The keys a thief identity signs with: a device's, or its own recovery phrase's. */
function signerKeys(world: World, label: string): DeviceKeys {
  return world.recoveries.some((r) => r.label === label) ? world.ctx.recovery(label, world.vaultId).keys : world.ctx.device(label);
}

interface AttackInputs {
  state: VaultState;
  keys: ReturnType<ModelContext['device']>;
  random: ReturnType<typeof seededRandom>;
  currentKey: Uint8Array;
  time: number;
  subject: string | undefined;
}

const THIEF_RECORD = { label: 'thief', secret: 'JBSWY3DPEHPK3PXP', type: 'totp' as const, algorithm: 'SHA1' as const, digits: 6, period: 30, counter: 0 };

/** Signs the thief's line with the real builders on the state it chose. */
function signAttack(world: World, op: Extract<Op, { t: 'attack' }>, inputs: AttackInputs): SignedEntry {
  const { state, keys, random, currentKey, time, subject } = inputs;
  switch (op.kind) {
    case 'remove':
      return buildDeviceRemove(state, keys, { device: world.ids[subject!]!, currentKey, random, time }).entry;
    case 'recoverySet':
      return buildRecoverySet(state, keys, { recovery: world.ctx.recovery(subject!, world.vaultId).keys, currentKey, random, time }).entry;
    case 'rotate':
      return buildKeyRotate(state, keys, { currentKey, random, time }).entry;
    case 'put':
      return buildAccountPut(state, keys, { account: newAccountId(random), record: { issuer: subject!, ...THIEF_RECORD }, currentKey, random, time });
    case 'addPuppet':
      return buildDeviceAdd(state, keys, { device: world.ctx.device(subject!), role: 'admin', name: subject!, currentKey, random, time });
    case 'slander':
      return slander(world, op, inputs);
    case 'squat': {
      // The joiner's signing key from its join request, with the thief's own sealing key.
      const joiner = world.ctx.device(subject!);
      return buildDeviceAdd(state, keys, { device: { deviceId: joiner.deviceId, edPublic: joiner.edPublic, xPublic: keys.xPublic }, role: 'member', name: subject!, currentKey, random, time: 1 });
    }
    case 'plantKey': {
      // The joiner's real keys, but a key sealed to it that is not the vault key, dated early.
      const joiner = world.ctx.device(subject!);
      return buildDeviceAdd(state, keys, { device: joiner, role: world.config.kind === 'team' ? 'member' : 'admin', name: subject!, currentKey: random(32), random, time: 1 });
    }
    case 'badSeal':
      return badSealEntry(world, op, inputs);
    case 'beacon':
    case 'flood':
    case 'forkProof':
    case 'garbageSig':
    case 'fillReserve':
    case 'reencode':
      throw new Error('model bug: not a single line');
  }
}

/**
 * A key change with the right keyCheck but, for the victims, the key of a second rotation sealed to
 * them (it opens, to another key). Built only with the real builders: two rotations on one state.
 */
function badSealEntry(world: World, op: Extract<Op, { t: 'attack' }>, inputs: AttackInputs): SignedEntry {
  const { state, keys, random, currentKey, time, subject } = inputs;
  const build = () =>
    op.sealAs === 'recoverySet'
      ? buildRecoverySet(state, keys, { recovery: world.ctx.recovery(subject!, world.vaultId).keys, currentKey, random, time })
      : buildKeyRotate(state, keys, { currentKey, random, time });
  const real = build();
  const other = build();
  const body = real.entry.body as { keys: Record<string, unknown> };
  const otherKeys = (other.entry.body as { keys: Record<string, unknown> }).keys;
  // A recovery.set's own new phrase gets the right key (the thief keeps it); the old recovery identity is a victim.
  const recoveryId = op.sealAs === 'recoverySet' ? world.ctx.recovery(subject!, world.vaultId).keys.deviceId : undefined;
  const mixed: Record<string, unknown> = {};
  let changed = false;
  for (const [id, sealed] of Object.entries(body.keys)) {
    const victim = id !== keys.deviceId && (op.victims === 'recovery' ? id === state.recovery?.deviceId && id !== recoveryId : true) && !(op.sealAs === 'recoverySet' && id === recoveryId);
    mixed[id] = victim ? otherKeys[id] : sealed;
    changed ||= victim;
  }
  if (!changed) throw new Error('no other recipient to seal a wrong key to');
  const { sig: _sig, ...unsigned } = real.entry;
  return signEntry({ ...unsigned, body: { ...unsigned.body, keys: mixed } as typeof unsigned.body }, keys);
}

/** An account.put whose `seen` names, for the target, a hash its log doesn't have: at a seq it has, or past its end. */
function slander(world: World, op: Extract<Op, { t: 'attack' }>, inputs: AttackInputs): SignedEntry {
  const { state, keys, random, currentKey, time, subject } = inputs;
  const put = buildAccountPut(state, keys, { account: newAccountId(random), record: { issuer: `s-${subject}`, ...THIEF_RECORD }, currentKey, random, time });
  const target = world.ids[subject!]!;
  const proof = world.proofs.find((p) => p.deviceId === target);
  if (op.slander === 'ownFork') {
    // The second version forkProof signs (Ed25519 signatures are deterministic), named before or after the proof is out.
    const second: EntryRef = proof ? { seq: proof.seq, hash: entryHash(JSON.parse(proof.lines[1]!) as SignedEntry) } : { seq: op.forkAt!, hash: entryHash(secondVersion(world, subject!, op.forkAt!)) };
    const { sig: _s, ...rest } = put;
    return signEntry({ ...rest, seen: { ...rest.seen, [target]: second } }, keys);
  }
  const length = Math.min(op.cut[subject!] ?? 0, world.published[subject!] ?? 0);
  const seq = op.slander === 'pastEnd' ? (world.published[subject!] ?? 0) + 1 : length - 1;
  if (seq < 0) throw new Error('nothing of the target to slander');
  // A well-formed hash that is not the target's line at that seq: the thief's own first line.
  const fake: EntryRef = { seq, hash: world.lines[world.config.thief!]![0]!.hash };
  const { sig: _sig, ...unsigned } = put;
  return signEntry({ ...unsigned, seen: { ...unsigned.seen, [target]: fake } }, keys);
}

/** A lying head beacon: a newer epoch and a head of the target's log that the folder doesn't have. */
function lyingBeacon(world: World, state: VaultState, subject: string, time: number): Beacon {
  const target = world.ids[subject]!;
  const head = state.heads[target];
  const heads = { ...state.heads, [target]: { seq: (head?.seq ?? -1) + 1, hash: world.lines[world.config.thief!]![0]!.hash, time } };
  return signBeacon({ ...state, epoch: state.epoch + 1, heads }, world.ctx.device(world.config.thief!), time);
}

/**
 * The thief forks: its last sent line is replaced in the folder by another line at the same seq.
 * Honest devices that had read the first version keep it in their own copy.
 */
function forkLastLine(world: Mutable<World>, signer: string): number | null {
  const log = world.lines[signer]!;
  const seq = log.length - 1;
  if (seq < 1 || (world.published[signer] ?? 0) !== log.length) return null;
  for (const [device, synced] of Object.entries(world.synced)) {
    if (device === signer || (synced[signer] ?? 0) <= seq || world.copies[device]?.[signer]) continue;
    world.copies[device] = { ...world.copies[device], [signer]: log.slice(0, synced[signer]) };
  }
  world.lines[signer] = log.slice(0, seq);
  world.published[signer] = seq;
  world.forkedAt[signer] = Math.min(world.forkedAt[signer] ?? seq, seq);
  return seq;
}

function attack(world: Mutable<World>, op: Extract<Op, { t: 'attack' }>): boolean {
  const thief = world.config.thief;
  if (!thief || !world.devices.includes(thief)) return false;
  const signer = op.as ?? thief;
  const asPhrase = !!op.as && world.recoveries.some((r) => r.label === op.as && !r.honest);
  if (op.as && !(world.puppets.includes(op.as) && ((op.kind === 'remove' && op.target !== op.as) || op.kind === 'fillReserve' || op.kind === 'badSeal' || op.kind === 'flood' || (op.kind === 'slander' && op.slander === 'ownFork'))) && !(asPhrase && (op.kind === 'addPuppet' || op.kind === 'forkProof'))) return false;
  // A fork replaces the line in the folder at once: a withheld second version would be a rollback, which the app repairs (not modelled).
  if (op.fork && (op.as || !op.publish || op.kind === 'beacon' || op.kind === 'addPuppet' || op.kind === 'forkProof')) return false;
  if (op.kind === 'forkProof') return forkProof(world, signer, op.forkAt ?? -1);
  if (op.kind === 'reencode') {
    const target = attackSubject(world, op);
    if (!target) return false;
    world.attackStarted = true;
    world.padded[target] = Array.from({ length: world.published[target] ?? 0 }, (_, i) => i);
    // Devices that already read those lines hold them canonical.
    world.canonicalHeld[target] = Object.fromEntries(world.devices.map((d) => [d, d === target ? world.lines[target]!.length : (world.synced[d]?.[target] ?? 0)]));
    world.counters.attacks++;
    return true;
  }
  const counts: Record<string, number> = {};
  for (const label of Object.keys(world.lines)) counts[label] = Math.min(op.cut[label] ?? 0, world.published[label] ?? 0);
  // The thief knows every line it, its puppets and its phrase signed, sent or not; a fork signs again at its last one.
  for (const label of attackerLabels(world)) counts[label] = (world.lines[label]?.length ?? 0) - (op.fork && label === signer ? 1 : 0);
  const view = viewOf(world, counts);
  const state = stateOf(world, view);
  // A cut that leaves out the signer's own introduction doesn't read its log: it can't chain its line.
  const signerLines = counts[signer] ?? 0;
  if (signerLines > 0 && state.heads[world.ids[signer]!]?.seq !== signerLines - 1) return false;
  const subject = attackSubject(world, op);
  if (subject === null) return false;
  const time = clock(world, signer);
  if (op.kind === 'beacon') {
    world.attackStarted = true;
    world.beacons[thief] = world.ctx.memo(`lying-beacon|${seedFor(world, op)}|${view.key}`, () => lyingBeacon(world, state, subject!, time));
    world.counters.attacks++;
    return true;
  }
  const stateForBuild: VaultState = op.seenMode === 'heads' ? { ...state, appliedHeads: state.heads } : state;
  const keys = signerKeys(world, signer);
  if (op.kind === 'flood') return flood(world, op, stateForBuild, keys, time, view.key);
  if (op.kind === 'garbageSig') return garbageSig(world, op, signer, stateForBuild, keys, time, view.key);
  if (op.kind === 'fillReserve') return fillReserve(world, op, signer, stateForBuild, keys, time, view.key);
  const random = randomFor(world, op);
  // Without the current key the thief still signs: replay can't check the key it boxes.
  const currentKey = world.ctx.currentKey(state, view.key, keys) ?? random(32);
  let entry: SignedEntry | null;
  try {
    entry = world.ctx.memo(`${seedFor(world, op)}|${view.key}|${subject ?? ''}`, () => signAttack(world, op, { state: stateForBuild, keys, random, currentKey, time, subject }));
  } catch {
    return false;
  }
  if (!entry) return false;
  let ground = false;
  if (op.grind) {
    const lower = grind(world, entry, signer);
    if (!lower) return false;
    entry = lower;
    ground = true;
  }
  if (op.fork && forkLastLine(world, signer) === null) return false;
  world.attackStarted = true;
  if (op.kind === 'recoverySet' || (op.kind === 'badSeal' && op.sealAs === 'recoverySet')) {
    world.ids[subject!] = world.ctx.recovery(subject!, world.vaultId).keys.deviceId;
    world.recoveries.push({ label: subject!, honest: false });
  }
  if (op.kind === 'put') world.accounts[subject!] = (entry.body as { account: string }).account;
  if (op.kind === 'squat' || op.kind === 'plantKey') {
    world.ids[subject!] = world.ctx.device(subject!).deviceId;
    // The joiner is still pending: its honest approval goes ahead.
    world.squats.push(subject!);
    if (op.kind === 'plantKey') world.planted.push(subject!);
  }
  if (op.kind === 'addPuppet') {
    world.ids[subject!] = world.ctx.device(subject!).deviceId;
    world.puppets.push(subject!);
  }
  append(world, signer, entry, { honest: false, ...(subject ? { subject } : {}), ...(ground ? { ground } : {}), ...(op.kind === 'slander' ? { slander: true } : {}), ...(op.kind === 'badSeal' ? { badSeal: true } : {}) });
  if (op.kind === 'addPuppet') {
    const puppetView = viewOf(world, { ...counts, [signer]: world.lines[signer]!.length });
    append(world, subject!, buildDeviceHello(stateOf(world, puppetView), world.ctx.device(subject!), time, entryHash(entry)), { honest: false });
  }
  if (op.publish) publishAttacker(world, !!op.direct);
  world.counters.attacks++;
  if (op.kind !== 'put' && op.kind !== 'slander') world.counters.membership++;
  return true;
}

/** The thief signs FLOOD_LINES account.puts in a row and sends them. */
function flood(world: Mutable<World>, op: Extract<Op, { t: 'attack' }>, state: VaultState, keys: DeviceKeys, time: number, viewKey: string): boolean {
  const thief = world.config.thief!;
  const currentKey = world.ctx.currentKey(state, viewKey, keys);
  if (!currentKey) return false;
  const entries = world.ctx.memo(`flood|${seedFor(world, op)}|${viewKey}`, () => {
    const random = randomFor(world, op);
    const out: SignedEntry[] = [];
    let draft = state;
    for (let i = 0; i < FLOOD_LINES; i++) {
      const entry = buildAccountPut(draft, keys, { account: newAccountId(random), record: { issuer: `flood-${i}`, ...THIEF_RECORD }, currentKey, random, time });
      out.push(entry);
      draft = afterOwnEntry(draft, entry);
    }
    return out;
  });
  world.attackStarted = true;
  for (const entry of entries) append(world, thief, entry, { honest: false, subject: 'flood' });
  if (op.publish) publishAttacker(world, !!op.direct);
  world.counters.attacks++;
  return true;
}

/**
 * A folder writer puts a line with a garbage signature in the signer's log, and a validly signed
 * line (by the signer's real key) chained on it. With `fork`, the pair takes the place of the
 * signer's last sent line: devices that read that line keep it, and no valid fork proof can be
 * made from a garbage-signed line.
 */
function garbageSig(world: Mutable<World>, op: Extract<Op, { t: 'attack' }>, signer: string, state: VaultState, keys: DeviceKeys, time: number, viewKey: string): boolean {
  const currentKey = world.ctx.currentKey(state, viewKey, keys);
  if (!currentKey) return false;
  const pair = world.ctx.memo(`garbage|${seedFor(world, op)}|${viewKey}`, () => {
    const random = randomFor(world, op);
    const signed = buildAccountPut(state, keys, { account: newAccountId(random), record: { issuer: 'garbage', ...THIEF_RECORD }, currentKey, random, time });
    const garbled: SignedEntry = { ...signed, sig: toBase64Url(random(64)) };
    const next = buildAccountPut(afterOwnEntry(state, garbled), keys, { account: newAccountId(random), record: { issuer: 'chained', ...THIEF_RECORD }, currentKey, random, time });
    return [garbled, next] as const;
  });
  if (op.fork) {
    const seq = forkLastLine(world, signer);
    if (seq === null) return false;
    // The garbage line is signed by nobody: the first seq the signer really signed twice is the line after it.
    world.forkedAt[signer] = seq + 1;
  }
  world.attackStarted = true;
  append(world, signer, pair[0], { honest: false, subject: 'garbage', garbage: true });
  append(world, signer, pair[1], { honest: false, subject: 'chained' });
  if (op.publish) publishAttacker(world, !!op.direct);
  world.counters.attacks++;
  return true;
}

/** The signer writes FILL_LINES key rotations in a row (each on the key the one before made) and sends them. */
function fillReserve(world: Mutable<World>, op: Extract<Op, { t: 'attack' }>, signer: string, state: VaultState, keys: DeviceKeys, time: number, viewKey: string): boolean {
  const first = world.ctx.currentKey(state, viewKey, keys);
  if (!first) return false;
  const entries = world.ctx.memo(`fill|${signer}|${seedFor(world, op)}|${viewKey}`, () => {
    const random = randomFor(world, op);
    const out: SignedEntry[] = [];
    let draft = state;
    let currentKey = first;
    for (let i = 0; i < FILL_LINES; i++) {
      const rotation = buildKeyRotate(draft, keys, { currentKey, random, time });
      out.push(rotation.entry);
      currentKey = rotation.newKey;
      draft = afterOwnEntry({ ...draft, epoch: draft.epoch + 1 }, rotation.entry);
    }
    return out;
  });
  world.attackStarted = true;
  for (const entry of entries) append(world, signer, entry, { honest: false });
  if (op.publish) publishAttacker(world, !!op.direct);
  world.counters.attacks++;
  world.counters.membership++;
  return true;
}

/**
 * The thief signs a second version of its own line at `seq` (any seq it has in the folder) and
 * publishes the pair as a fork proof (vault.forks.write takes one about any identity the vault
 * knows). The folder keeps the first version.
 */
/** The thief's second version of its line at `seq`: the same entry a moment later. */
function secondVersion(world: World, signer: string, seq: number): SignedEntry {
  const { sig: _sig, ...unsigned } = world.lines[signer]![seq]!.entry;
  return signEntry({ ...unsigned, time: unsigned.time + 1 }, signerKeys(world, signer));
}

function forkProof(world: Mutable<World>, signer: string, seq: number): boolean {
  const original = world.lines[signer]?.[seq];
  if (!original || seq >= (world.published[signer] ?? 0) || world.proofs.some((p) => p.deviceId === world.ids[signer])) return false;
  const second = secondVersion(world, signer, seq);
  world.attackStarted = true;
  world.proofs.push({ deviceId: world.ids[signer]!, seq, lines: [original.text, serializeEntry(second)] });
  world.forkedAt[signer] = Math.min(world.forkedAt[signer] ?? seq, seq);
  world.counters.attacks++;
  return true;
}

/** Applies `op`, returning the new world, or null when the op can't happen in this world. */
export function applyOp(world: World, op: Op): World | null {
  const next = clone(world);
  const timing = op as Timing & { by?: string };
  // A pull that reads nothing new is the same scenario as no pull.
  if (timing.pull && !HANDLERS.sync(next, { t: 'sync', device: timing.by! })) return null;
  const ok = (HANDLERS[op.t] as Handler<Op['t']>)(next, op as never);
  if (!ok) return null;
  if (timing.push) sendHonest(next, timing.by!);
  next.trace.push(op);
  recordHonestHistory(next);
  return next;
}

/** Replays a whole op list from a fresh world; null when some op can't happen. */
export function runOps(ctx: ModelContext, config: WorldConfig, ops: readonly Op[]): World | null {
  let world: World | null = newWorld(ctx, config);
  for (const op of ops) {
    world = applyOp(world, op);
    if (!world) return null;
  }
  return world;
}

/** Every honest device syncs, twice round, so each has sent what it can and read every fork proof. */
export function shareRound(world: World): World {
  let current = world;
  const honest = world.devices.filter((d) => !(d === world.config.thief && world.attackStarted));
  for (let round = 0; round < 2; round++) {
    for (const device of honest) current = applyOp(current, { t: 'sync', device }) ?? current;
  }
  return current;
}
