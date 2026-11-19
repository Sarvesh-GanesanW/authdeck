/**
 * The search: exhaustive depth-first over every scenario within bounds (each distinct shape
 * once), or seeded random walks beyond them. Violations are minimised by deleting ops and
 * simplifying the thief's choices while the same invariant still fails.
 */
import { ModelContext, type ReplayFn } from './context';
import { candidateOps, folderKey, signature, type Bounds } from './generator';
import type { VaultKind } from '../../src/vault/index';
import { checkWorld, clockDifference, type CheckOptions, type Violation } from './invariants';
import { applyOp, CLOCK_POLICIES, newWorld, runOps, type ClockPolicy, type Op, type World, type WorldConfig } from './world';

export interface SearchOptions {
  bounds: Bounds;
  seed: string;
  /** Which device is stolen in each run; null runs honest-only. */
  thieves: (string | null)[];
  /** Personal vaults, team vaults (roles), or both. Default personal. */
  kinds?: VaultKind[];
  /** How the thief's lines reach the folder: written straight in, through an honest agent, or both. */
  modes: ThiefMode[];
  clocks: ClockPolicy[];
  checks: CheckOptions;
  /** Compare membership under every clock policy for every n-th checked state (0: never). */
  clockStride: number;
  /** Counterexamples to minimise per invariant. */
  keepPerInvariant: number;
  replay?: ReplayFn;
  /** Stop after this long, reporting the search as cut short. */
  timeLimitMs?: number;
  /** Stop at the first violation (for the toy-rule sanity test). */
  stopAtFirst?: boolean;
}

export interface Counterexample {
  config: WorldConfig;
  seed: string;
  ops: Op[];
  violation: Violation;
  /** The violations of the unminimised scenario it came from. */
  originalSteps: number;
}

export type ThiefMode = 'folder' | 'agent';

export interface SearchStats {
  roots: number;
  statesVisited: number;
  statesDistinct: number;
  statesPruned: number;
  opsTried: number;
  opsRefused: number;
  foldersChecked: number;
  clockComparisons: number;
  replays: number;
  violationsByInvariant: Record<number, number>;
  elapsedMs: number;
  cutShort: boolean;
}

export interface Found {
  config: WorldConfig;
  /** The context seed the scenario was run with: it fixes every key, so it reproduces. */
  seed: string;
  ops: Op[];
  violation: Violation;
}

export interface SearchResult {
  stats: SearchStats;
  found: Found[];
}

class Search {
  readonly stats: SearchStats = { roots: 0, statesVisited: 0, statesDistinct: 0, statesPruned: 0, opsTried: 0, opsRefused: 0, foldersChecked: 0, clockComparisons: 0, replays: 0, violationsByInvariant: {}, elapsedMs: 0, cutShort: false };
  readonly found: Found[] = [];
  readonly started = Date.now();
  private replaysBefore = 0;

  constructor(public ctx: ModelContext, readonly options: SearchOptions) {}

  /** Switches to fresh keys (random walks), keeping the counts. */
  useContext(ctx: ModelContext): void {
    this.replaysBefore += this.ctx.replayCount;
    this.ctx = ctx;
  }

  result(): SearchResult {
    this.stats.replays = this.replaysBefore + this.ctx.replayCount;
    this.stats.elapsedMs = Date.now() - this.started;
    return { stats: this.stats, found: this.found };
  }

  timeUp(): boolean {
    if (this.options.stopAtFirst && this.found.length > 0) return true;
    if (this.options.timeLimitMs !== undefined && Date.now() - this.started > this.options.timeLimitMs) {
      this.stats.cutShort = true;
      return true;
    }
    return false;
  }

  /** Checks a world's folder once per distinct folder, recording violations. */
  check(world: World, checked: Set<string>): void {
    const key = folderKey(world);
    if (checked.has(key)) return;
    checked.add(key);
    this.stats.foldersChecked++;
    const violations = checkWorld(world, this.options.checks);
    const stride = this.options.clockStride;
    if (stride > 0 && this.stats.foldersChecked % stride === 0) violations.push(...this.compareClocks(world));
    for (const violation of violations) this.record(world, violation);
  }

  record(world: World, violation: Violation): void {
    this.stats.violationsByInvariant[violation.invariant] = (this.stats.violationsByInvariant[violation.invariant] ?? 0) + 1;
    if (this.found.filter((f) => f.violation.invariant === violation.invariant).length >= this.options.keepPerInvariant) return;
    this.found.push({ config: world.config, seed: this.ctx.seed, ops: [...world.trace], violation });
  }

  compareClocks(world: World): Violation[] {
    this.stats.clockComparisons++;
    return clockViolations(this.ctx, world);
  }
}

/** Invariant 5 for clocks (amended): the same ops under every other clock policy; see clockDifference. */
export function clockViolations(ctx: ModelContext, world: World): Violation[] {
  for (const clock of CLOCK_POLICIES) {
    if (clock === world.config.clock) continue;
    const other = runOps(ctx, { ...world.config, clock }, world.trace);
    if (!other) continue;
    const difference = clockDifference(world, other);
    if (difference) return [{ invariant: 5, summary: `clocks change more than the key-change tie-break (${world.config.clock} vs ${clock})`, expected: 'the same removals applied and the same members, unless only the tie-break between concurrent key changes differs', got: difference }];
  }
  return [];
}

/** The root configurations: every kind x mode x clock x thief. */
function roots(options: SearchOptions): WorldConfig[] {
  const out: WorldConfig[] = [];
  const beacons = options.bounds.attackKinds.includes('beacon');
  // The agent's caps at model scale, whenever the attacker may try to fill them.
  const quota = options.bounds.attackKinds.includes('fillReserve') || options.bounds.attackKinds.includes('flood');
  for (const kind of options.kinds ?? ['personal']) {
    for (const mode of options.modes) for (const clock of options.clocks) for (const thief of options.thieves) out.push({ kind, thief, clock, agent: mode === 'agent', ...(beacons ? { beacons } : {}), ...(quota && mode === 'agent' ? { quota } : {}) });
  }
  return out;
}

/** Exhaustive search over every scenario within the bounds. */
export function searchExhaustive(options: SearchOptions): SearchResult {
  const ctx = new ModelContext(options.seed, options.replay);
  const search = new Search(ctx, options);
  for (const config of roots(options)) {
    {
      search.stats.roots++;
      const seen = new Set<string>();
      const checked = new Set<string>();
      const stack: World[] = [newWorld(ctx, config)];
      while (stack.length > 0 && !search.timeUp()) {
        const world = stack.pop()!;
        search.stats.statesVisited++;
        const sig = signature(world);
        if (seen.has(sig)) {
          search.stats.statesPruned++;
          continue;
        }
        seen.add(sig);
        search.stats.statesDistinct++;
        search.check(world, checked);
        for (const op of candidateOps(world, options.bounds)) {
          search.stats.opsTried++;
          const next = applyOp(world, op);
          if (next) stack.push(next);
          else search.stats.opsRefused++;
        }
      }
    }
  }
  return search.result();
}

/** Small deterministic PRNG for walk choices. */
function walkRandom(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/** Seeded random walks: each walk picks a thief, a clock and random enabled ops up to the bounds. */
export function searchRandom(options: SearchOptions & { walks: number }): SearchResult {
  const WALKS_PER_KEYSET = 100;
  const search = new Search(new ModelContext(`${options.seed}/0`, options.replay), options);
  const pick = walkRandom(options.seed);
  for (let walk = 0; walk < options.walks && !search.timeUp(); walk++) {
    // Fresh keys now and then, so hash order (which breaks ties between key changes) varies too.
    if (walk > 0 && walk % WALKS_PER_KEYSET === 0) search.useContext(new ModelContext(`${options.seed}/${walk}`, options.replay));
    search.stats.roots++;
    const configs = roots(options);
    let world: World = newWorld(search.ctx, configs[Math.floor(pick() * configs.length)]!);
    const checked = new Set<string>();
    for (;;) {
      search.stats.statesVisited++;
      search.check(world, checked);
      const ops = candidateOps(world, options.bounds);
      let next: World | null = null;
      for (let attempt = 0; attempt < 12 && !next && ops.length > 0; attempt++) {
        const op = ops[Math.floor(pick() * ops.length)]!;
        search.stats.opsTried++;
        next = applyOp(world, op);
        if (!next) search.stats.opsRefused++;
      }
      if (!next) break;
      world = next;
    }
  }
  return search.result();
}

// ---------------------------------------------------------------------------------------------
// Minimisation.
// ---------------------------------------------------------------------------------------------

function reproduces(ctx: ModelContext, config: WorldConfig, ops: Op[], invariant: number, checks: CheckOptions): Violation | null {
  const world = runOps(ctx, config, ops);
  if (!world) return null;
  if (invariant === 5 && !checks.readOrders) return null;
  const violations = checkWorld(world, checks);
  if (invariant === 5) violations.push(...clockViolations(ctx, world));
  return violations.find((v) => v.invariant === invariant) ?? null;
}

/** Simpler versions of one thief op: applied seen, no grinding, published, smaller cuts. */
function simplerAttacks(op: Extract<Op, { t: 'attack' }>): Op[] {
  const out: Op[] = [];
  if (op.seenMode !== 'applied') out.push({ ...op, seenMode: 'applied' });
  if (op.fork) out.push({ ...op, fork: false });
  if (op.grind) out.push({ ...op, grind: false });
  if (!op.publish) out.push({ ...op, publish: true });
  for (const [label, count] of Object.entries(op.cut)) if (count > (label === 'F' ? 1 : 0)) out.push({ ...op, cut: { ...op.cut, [label]: count - 1 } });
  return out;
}

/** Deletes ops and simplifies the thief's choices while the same invariant still fails. */
export function minimise(found: Found, checks: CheckOptions, replay?: ReplayFn): Counterexample {
  const ctx = new ModelContext(found.seed, replay);
  const invariant = found.violation.invariant;
  let ops = found.ops;
  let violation = found.violation;
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = ops.length - 1; i >= 0; i--) {
      const candidate = ops.filter((_, j) => j !== i);
      const hit = reproduces(ctx, found.config, candidate, invariant, checks);
      if (hit) {
        ops = candidate;
        violation = hit;
        progress = true;
      }
    }
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if (op.t !== 'attack') continue;
      for (const simpler of simplerAttacks(op)) {
        const candidate = ops.map((o, j) => (j === i ? simpler : o));
        const hit = reproduces(ctx, found.config, candidate, invariant, checks);
        if (hit) {
          ops = candidate;
          violation = hit;
          progress = true;
          break;
        }
      }
    }
  }
  return { config: found.config, seed: ctx.seed, ops, violation, originalSteps: found.ops.length };
}

/** Minimises found violations and drops ones whose minimised scenario has the same shape. */
export function minimiseAll(found: Found[], checks: CheckOptions, replay?: ReplayFn): Counterexample[] {
  const out: Counterexample[] = [];
  const shapes = new Set<string>();
  for (const f of found) {
    const example = minimise(f, checks, replay);
    const world = runOps(new ModelContext(example.seed, replay), example.config, example.ops);
    const shape = `${example.violation.invariant}#${world ? signature(world) : JSON.stringify(example.ops)}`;
    if (shapes.has(shape)) continue;
    shapes.add(shape);
    out.push(example);
  }
  return out;
}

/** The search counts, one line per kind. */
export function formatStats(stats: SearchStats): string {
  const violations = Object.entries(stats.violationsByInvariant)
    .map(([inv, n]) => `inv${inv}: ${n}`)
    .join(', ');
  return [
    `searches (kind x mode x clock x thief, or walks): ${stats.roots}`,
    `states visited ${stats.statesVisited}, distinct ${stats.statesDistinct}, pruned as duplicates ${stats.statesPruned}`,
    `ops tried ${stats.opsTried}, refused ${stats.opsRefused}`,
    `distinct folders checked ${stats.foldersChecked}, clock comparisons ${stats.clockComparisons}, replays ${stats.replays}`,
    `violating folders by invariant: ${violations || 'none'}`,
    `time ${(stats.elapsedMs / 1000).toFixed(1)} s${stats.cutShort ? ' (cut short by --time-limit: not exhaustive)' : ''}`,
  ].join('\n');
}
