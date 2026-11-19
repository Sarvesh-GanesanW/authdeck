/**
 * Deep run of the vault model checker.
 *
 *   cd agent && node --import tsx test/model/run.ts [options]
 *
 * Options (defaults: the deep preset):
 *   --preset fast|team|deep   start from these bounds (team: the fast test's team, fork, slander and beacon run)
 *   --preset solo-fast|solo-deep  the solo-vault model (test/model/solo.ts: one device plus the phrase;
 *                             the stolen old phone, the old phrase and a hostile computer). With it:
 *                             --mode exhaustive|random, --steps N, --walks N, --seed S, --time-limit SECONDS,
 *                             --keep N, --out DIR
 *   --mode exhaustive|random  exhaustive within bounds, or seeded random walks
 *   --devices N               devices that may join, founder included
 *   --membership N            membership ops (honest and thief) per scenario
 *   --puts N --attacks N --steps N --recovery-sets N
 *   --attack-kinds remove,recoverySet,rotate,put,addPuppet,slander,beacon,squat,flood,forkProof,
 *                  garbageSig,plantKey,fillReserve,badSeal,reencode (fillReserve or flood turns on the
 *                  agent's caps at model scale; with caps, floods and fills may also go straight in)
 *   --kinds personal,team     vault kinds: team vaults add plain members (the thief may be one)
 *   --no-fork                 the thief never signs two lines at one seq
 *   --thieves F,D1,D2         which device is stolen, one search per choice ("none": honest only)
 *   --modes folder,agent      thief writes straight into the folder, through an honest agent, or both
 *   --clocks steady,skewed,thiefAhead,backwards
 *   --clock-stride N          compare membership across clocks every N-th checked folder (0: off)
 *   --walks N                 random mode: number of walks
 *   --seed S --time-limit SECONDS --keep N (counterexamples kept per invariant)
 *   --no-go-on                skip invariant 7 (the slowest check)
 *   --out DIR                 where stories and PoCs go
 *   --replay-module PATH      check another replayVault (a candidate rule set) instead of src/vault;
 *                             a logs.ts and approval.ts beside it supply planAppend and checkJoinedVault too
 *
 * Exits 1 when any invariant is violated.
 */
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadReplay, type ReplayFn } from './context';
import { DEEP_BOUNDS, FAST_BOUNDS, FAST_TEAM_BOUNDS, type Bounds } from './generator';
import { INVARIANTS } from './invariants';
import { writeCounterexamples } from './report';
import { formatStats, minimiseAll, searchExhaustive, searchRandom, type SearchOptions, type ThiefMode } from './search';
import type { VaultKind } from '../../src/vault/index';
import { ATTACK_KINDS, CLOCK_POLICIES, type AttackKind, type ClockPolicy } from './world';

const DEFAULT_OUT = join(tmpdir(), 'authdeck-vault-model');

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}". Options start with --; see the header of test/model/run.ts.`);
    const name = arg.slice(2);
    if (name.startsWith('no-')) args.set(name, 'true');
    else args.set(name, argv[++i] ?? '');
  }
  return args;
}

function numberArg(args: Map<string, string>, name: string, fallback: number): number {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a whole number, got "${raw}".`);
  return value;
}

function listArg<T extends string>(args: Map<string, string>, name: string, allowed: readonly string[] | null, fallback: T[]): T[] {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const values = raw.split(',').filter(Boolean);
  for (const v of values) if (allowed && !allowed.includes(v)) throw new Error(`--${name}: "${v}" is not one of ${allowed.join(', ')}.`);
  return values as T[];
}

function boundsFrom(args: Map<string, string>): Bounds {
  const preset = args.get('preset') ?? 'deep';
  if (preset !== 'fast' && preset !== 'team' && preset !== 'deep') throw new Error('--preset must be fast, team or deep.');
  const base = preset === 'fast' ? FAST_BOUNDS : preset === 'team' ? FAST_TEAM_BOUNDS : DEEP_BOUNDS;
  return {
    ...base,
    maxDevices: numberArg(args, 'devices', base.maxDevices),
    maxMembershipOps: numberArg(args, 'membership', base.maxMembershipOps),
    maxPuts: numberArg(args, 'puts', base.maxPuts),
    maxAttacks: numberArg(args, 'attacks', base.maxAttacks),
    maxSteps: numberArg(args, 'steps', base.maxSteps),
    maxRecoverySets: numberArg(args, 'recovery-sets', base.maxRecoverySets),
    attackKinds: listArg<AttackKind>(args, 'attack-kinds', ATTACK_KINDS, base.attackKinds),
    fork: base.fork && !args.has('no-fork'),
  };
}

async function soloMain(args: Map<string, string>): Promise<void> {
  const solo = await import('./solo');
  const base = args.get('preset') === 'solo-fast' ? solo.SOLO_FAST : solo.SOLO_DEEP;
  const bounds = { ...base, maxSteps: numberArg(args, 'steps', base.maxSteps) };
  const seed = args.get('seed') ?? 'solo';
  const limit = numberArg(args, 'time-limit', 900);
  const keep = numberArg(args, 'keep', 3);
  const mode = args.get('mode') ?? 'exhaustive';
  const result = mode === 'random' ? solo.searchSoloRandom(seed, bounds, numberArg(args, 'walks', 2000), limit, keep) : solo.searchSoloExhaustive(seed, bounds, limit, keep);
  console.log(`solo ${mode}, ${JSON.stringify({ ...bounds, thiefKinds: undefined })}`);
  console.log(solo.formatSoloStats(result.stats));
  const out = resolve(args.get('out') ?? `${DEFAULT_OUT}/solo`);
  const minimised = result.found.map((f) => solo.minimiseSolo(f));
  const paths = solo.writeSoloCounterexamples(minimised, out, mode);
  console.log(`\n${minimised.length} minimised counterexample(s):`);
  minimised.forEach((f, i) => console.log(`- ${f.violation.invariant}: ${f.violation.summary}\n  ${paths[i]}`));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.get('preset')?.startsWith('solo')) return soloMain(args);
  const bounds = boundsFrom(args);
  const mode = args.get('mode') ?? 'exhaustive';
  const modulePath = args.get('replay-module');
  const replay: ReplayFn | undefined = modulePath ? await loadReplay(resolve(modulePath)) : undefined;
  const thieves = listArg<string>(args, 'thieves', null, ['F', 'D1', 'D2']).map((t) => (t === 'none' ? null : t));
  const clocks = listArg<ClockPolicy>(args, 'clocks', CLOCK_POLICIES, ['steady']);
  const timeLimit = numberArg(args, 'time-limit', 0);
  const options: SearchOptions = {
    bounds,
    seed: args.get('seed') ?? 'vault-model',
    thieves,
    kinds: listArg<VaultKind>(args, 'kinds', ['personal', 'team'], ['personal']),
    modes: listArg<ThiefMode>(args, 'modes', ['folder', 'agent'], ['folder', 'agent']),
    clocks,
    checks: { readOrders: true, goOn: !args.has('no-go-on') },
    clockStride: numberArg(args, 'clock-stride', 25),
    keepPerInvariant: numberArg(args, 'keep', 3),
    ...(replay ? { replay } : {}),
    ...(timeLimit > 0 ? { timeLimitMs: timeLimit * 1000 } : {}),
  };
  console.log(`mode ${mode}; kinds ${options.kinds!.join(',')}; thief modes ${options.modes.join(',')}; bounds ${JSON.stringify(bounds)}; thieves ${thieves.map((t) => t ?? 'none').join(',')}; clocks ${clocks.join(',')}${modulePath ? `; replay ${modulePath}` : ''}`);
  const result = mode === 'random' ? searchRandom({ ...options, walks: numberArg(args, 'walks', 2000) }) : searchExhaustive(options);
  console.log(formatStats(result.stats));
  if (result.found.length === 0) {
    console.log('No invariant violated within these bounds.');
    return;
  }
  const started = Date.now();
  const examples = minimiseAll(result.found, options.checks, replay);
  const paths = writeCounterexamples(examples, args.get('out') ?? DEFAULT_OUT, replay);
  console.log(`\n${examples.length} minimised counterexample(s) in ${((Date.now() - started) / 1000).toFixed(1)} s:`);
  for (const [i, example] of examples.entries()) {
    console.log(`- invariant ${example.violation.invariant} (${INVARIANTS[example.violation.invariant]!.split(':')[0]}): ${example.violation.summary}\n  ${paths[i]}`);
  }
  process.exitCode = 1;
}

await main();
