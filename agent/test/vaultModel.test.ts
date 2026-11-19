/**
 * The vault model checker (test/model): fast exhaustive runs over small scenarios (personal vaults,
 * and team vaults with members, forks, slander and beacons), the costs the docs accept (which must
 * not be flagged), and a deliberately broken rule (which must be).
 * Deep runs: `node --import tsx test/model/run.ts`; its header lists the options.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ModelContext, realReplay, type ReplayFn } from './model/context';
import { FAST_BOUNDS, FAST_TEAM_BOUNDS } from './model/generator';
import { checkWorld } from './model/invariants';
import { writeCounterexamples } from './model/report';
import { formatStats, minimiseAll, searchExhaustive, type SearchOptions } from './model/search';
import { folderView, runOps, stateOf, type Op, type WorldConfig } from './model/world';
import { checkSolo, formatSoloStats, runSolo, searchSoloExhaustive, SOLO_FAST, type SoloOp } from './model/solo';
import { vaultFeatures } from '../src/vault/features';

const FAST_TIME_LIMIT_MS = 30_000;
const FAST_TEAM_TIME_LIMIT_MS = 25_000;

const fastOptions: SearchOptions = {
  bounds: FAST_BOUNDS,
  seed: 'vault-model-fast',
  thieves: ['F', 'D1'],
  modes: ['folder'],
  clocks: ['steady'],
  checks: { readOrders: true, goOn: true },
  clockStride: 0,
  keepPerInvariant: 2,
  timeLimitMs: FAST_TIME_LIMIT_MS,
};

/** Team vaults: the thief is D1, approved as admin or plain member; it may fork, slander and write lying beacons. */
const fastTeamOptions: SearchOptions = {
  ...fastOptions,
  bounds: FAST_TEAM_BOUNDS,
  seed: 'vault-model-fast-team',
  kinds: ['team'],
  thieves: ['D1'],
  keepPerInvariant: 1,
  timeLimitMs: FAST_TEAM_TIME_LIMIT_MS,
};

/**
 * An exact retry is refused today (invariant 14, reported separately): checks of agent-mode
 * scenarios here leave it out so they test what they are about.
 */
const EXACT_RETRY = 14;

function violationsOf(config: WorldConfig, ops: Op[], replay?: ReplayFn) {
  const world = runOps(new ModelContext('vault-model-cases', replay), config, ops);
  assert.ok(world, 'the scenario could not be built on the current rules');
  return checkWorld(world).filter((v) => v.invariant !== EXACT_RETRY);
}

function assertNoneFound(options: SearchOptions): void {
  const result = searchExhaustive(options);
  console.log(formatStats(result.stats));
  if (result.found.length === 0) return;
  const examples = minimiseAll(result.found, options.checks);
  const paths = writeCounterexamples(examples, mkdtempSync(join(tmpdir(), 'vault-model-')));
  assert.fail(
    `${examples.length} minimised counterexample(s):\n${examples.map((e, i) => `- invariant ${e.violation.invariant}: ${e.violation.summary}\n  expected: ${e.violation.expected}\n  got: ${e.violation.got}\n  story: ${paths[i]}`).join('\n')}`,
  );
}

describe('vault model checker: fast bounded run', () => {
  it('finds no invariant violated in every personal-vault scenario within the fast bounds', () => {
    assertNoneFound(fastOptions);
  });

  it('finds no invariant violated in every team-vault scenario (members, forks, slander, beacons) within the fast bounds', () => {
    assertNoneFound(fastTeamOptions);
  });
});

describe('vault model checker: costs the docs accept are not flagged', () => {
  const honest: WorldConfig = { kind: 'personal', thief: null, clock: 'steady', agent: false };
  const stolenFounder: WorldConfig = { kind: 'personal', thief: 'F', clock: 'steady', agent: false };

  it('two honest devices that remove each other at the same time are both out', () => {
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D1' },
      { t: 'remove', by: 'F', target: 'D1', push: false },
      { t: 'remove', by: 'D1', target: 'F', push: true },
      { t: 'sync', device: 'F' },
    ];
    assert.deepEqual(violationsOf(honest, ops), []);
  });

  it('a thief that removes its remover truly concurrently takes both out, and nothing is flagged', () => {
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D1' },
      { t: 'remove', by: 'D1', target: 'F', push: true },
      // The thief's copy ends before D1's removal: neither saw the other.
      { t: 'attack', kind: 'remove', target: 'D1', cut: { F: 2, D1: 1 }, seenMode: 'applied', grind: false, publish: true },
    ];
    assert.deepEqual(violationsOf(stolenFounder, ops), []);
  });

  it('a computer that withholds a removal lets the removed device read what is added meanwhile', () => {
    const withheld: Op[] = [
      { t: 'add', by: 'F', device: 'D1' },
      { t: 'add', by: 'F', device: 'D2' },
      // D1's removal of the stolen phone never reaches the folder; D2 keeps adding accounts.
      { t: 'remove', by: 'D1', target: 'F', push: false },
      { t: 'put', by: 'D2', account: 'a1', push: true },
    ];
    assert.deepEqual(violationsOf(stolenFounder, withheld), []);
    // When the removal finally arrives, the account written meanwhile is remade under the new key.
    assert.deepEqual(violationsOf(stolenFounder, [...withheld, { t: 'sync', device: 'D1' }]), []);
  });

  it('through an honest agent, a removed device\'s true-symmetric counter-removal is taken and every party is out', () => {
    // The stolen F withholds its removal of D1, signed before D1 approved D2; D2 removes F; F sends.
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D1' },
      { t: 'attack', kind: 'remove', target: 'D1', cut: { F: 2 }, seenMode: 'applied', grind: false, publish: false },
      { t: 'add', by: 'D1', device: 'D2' },
      { t: 'remove', by: 'D2', target: 'F', push: true },
      { t: 'release' },
    ];
    const config: WorldConfig = { ...stolenFounder, agent: true };
    const world = runOps(new ModelContext('vault-model-cases'), config, ops);
    assert.ok(world, 'the scenario could not be built on the current rules');
    assert.ok(world.admissions.length > 0, 'the agent refused the counter-removal');
    const state = stateOf(world, folderView(world));
    for (const label of ['F', 'D1']) assert.equal(state.members[world.ids[label]!]!.removed, true, `${label} should be out`);
    assert.deepEqual(violationsOf(config, ops), []);
  });
});

describe('vault model checker: team vaults', () => {
  const memberThief: WorldConfig = { kind: 'team', thief: 'D1', clock: 'steady', agent: false, beacons: true };

  it('a plain member\'s removal of an admin is rejected, and its lying beacon raises no alarm once it is removed', () => {
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D1', role: 'member' },
      { t: 'add', by: 'F', device: 'D2', role: 'admin' },
      { t: 'attack', kind: 'remove', target: 'F', cut: { F: 3, D1: 1, D2: 1 }, seenMode: 'applied', grind: false, publish: true },
      { t: 'attack', kind: 'beacon', target: 'F', cut: { F: 3, D1: 1, D2: 1 }, seenMode: 'applied', grind: false, publish: true },
      { t: 'remove', by: 'D2', target: 'D1', pull: true, push: true },
    ];
    assert.deepEqual(violationsOf(memberThief, ops), []);
  });

  it('a member naming a hash that does not exist in seen changes no honest line', () => {
    for (const slander of ['existing', 'pastEnd'] as const) {
      const ops: Op[] = [
        { t: 'add', by: 'F', device: 'D1', role: 'member' },
        { t: 'attack', kind: 'slander', slander, target: 'F', cut: { F: 2, D1: 1 }, seenMode: 'applied', grind: false, publish: true },
        { t: 'put', by: 'F', account: 'a1', pull: true, push: true },
      ];
      assert.deepEqual(violationsOf(memberThief, ops), [], `slander ${slander}`);
    }
  });
});

/**
 * A toy rule for the sanity check: a removed device that signs anything after its removal is
 * back in. Everything else is the real replay.
 */
const resurrectingReplay: ReplayFn = (vaultId, logs, cache) => {
  const state = realReplay(vaultId, logs, cache);
  for (const member of Object.values(state.members)) {
    const cutoff = state.cutoffs[member.deviceId];
    if (member.removed && cutoff !== undefined && (logs[member.deviceId]?.length ?? 0) > cutoff + 1) {
      member.removed = false;
      delete state.cutoffs[member.deviceId];
    }
  }
  return state;
};

/**
 * The mirror of R1 (round-3 puppet_mirror.ts): honest A (F) removes the thief X (D1); X, on its
 * stale copy, sets its own phrase and approves its puppet P, and P removes A.
 */
const puppetMirror: Op[] = [
  { t: 'add', by: 'F', device: 'D1' },
  { t: 'remove', by: 'F', target: 'D1', push: true },
  { t: 'attack', kind: 'recoverySet', cut: { F: 2 }, seenMode: 'applied', grind: false, publish: false },
  { t: 'attack', kind: 'addPuppet', cut: { F: 2 }, seenMode: 'applied', grind: false, publish: false },
  { t: 'attack', kind: 'remove', as: 'P1', target: 'F', cut: { F: 2 }, seenMode: 'applied', grind: false, publish: true },
];

describe('vault model checker: regressions', () => {
  it('puppet mirror, thief writing the folder: A, X and P all end up out, and nothing is flagged', () => {
    const config: WorldConfig = { kind: 'personal', thief: 'D1', clock: 'steady', agent: false };
    const world = runOps(new ModelContext('vault-model-cases'), config, puppetMirror);
    assert.ok(world, 'the puppet mirror could not be built on the current rules');
    const state = stateOf(world, folderView(world));
    for (const label of ['F', 'D1', 'P1']) assert.equal(state.members[world.ids[label]!]?.removed ?? true, true, `${label} should be out`);
    assert.deepEqual(checkWorld(world), []);
  });

  it('puppet mirror through an honest agent: the thief\'s stale lines are refused, and nothing is flagged', () => {
    const config: WorldConfig = { kind: 'personal', thief: 'D1', clock: 'steady', agent: true };
    const world = runOps(new ModelContext('vault-model-cases'), config, puppetMirror);
    assert.ok(world, 'the puppet mirror could not be built on the current rules');
    assert.ok(world.refusals > 0, 'the agent admitted the removed thief\'s line');
    assert.equal(world.published.D1, world.lines.D1!.findIndex((l) => !l.honest), 'no line the thief signed after its removal reached the folder');
    assert.deepEqual(checkWorld(world).filter((v) => v.invariant !== EXACT_RETRY), []);
  });
});

/**
 * Round-4 review findings (scratchpad/security-review-4), as model scenarios. Each must hold once
 * the rules are fixed; until then the named invariant fails here.
 */
describe('vault model checker: round-4 findings', () => {
  it('S6: a thief\'s self-fork proof rejects nothing others built on (invariant 10)', () => {
    const config: WorldConfig = { kind: 'personal', thief: 'F', clock: 'steady', agent: false };
    const ops: Op[] = [
      { t: 'recoverySet', by: 'F', recovery: 'R1', push: true },
      { t: 'add', by: 'F', device: 'D1' },
      { t: 'add', by: 'D1', device: 'D2' },
      { t: 'put', by: 'D2', account: 'a1', push: true },
      { t: 'remove', by: 'D1', target: 'F', pull: true, push: true },
      { t: 'attack', kind: 'forkProof', forkAt: 1, cut: {}, seenMode: 'applied', grind: false, publish: true },
    ];
    assert.deepEqual(violationsOf(config, ops), []);
  });

  it('S2: a removed team admin\'s stale removal of an uninvolved member does not apply (invariant 8)', () => {
    const config: WorldConfig = { kind: 'team', thief: 'D3', clock: 'steady', agent: false };
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D1', role: 'admin' },
      { t: 'add', by: 'F', device: 'D2', role: 'member' },
      { t: 'add', by: 'F', device: 'D3', role: 'admin' },
      { t: 'remove', by: 'D1', target: 'D3', pull: true, push: true },
      { t: 'put', by: 'D2', account: 'a1', push: true },
      { t: 'attack', kind: 'remove', target: 'D2', cut: { F: 4, D1: 1, D2: 1 }, seenMode: 'applied', grind: false, publish: true },
    ];
    assert.deepEqual(violationsOf(config, ops), []);
  });

  it('S1: a stale removal of an uninvolved device can\'t ride along with a counter-removal through the agent (invariant 9)', () => {
    const config: WorldConfig = { kind: 'personal', thief: 'D2', clock: 'steady', agent: true };
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D1' },
      { t: 'add', by: 'F', device: 'D2' },
      { t: 'remove', by: 'D1', target: 'D2', pull: true, push: true },
      { t: 'put', by: 'F', account: 'a1', pull: true, push: true },
      { t: 'attack', kind: 'remove', target: 'F', cut: { F: 3, D1: 1 }, seenMode: 'applied', grind: false, publish: false },
      { t: 'attack', kind: 'remove', target: 'D1', cut: { F: 3, D1: 1 }, seenMode: 'applied', grind: false, publish: true },
    ];
    assert.deepEqual(violationsOf(config, ops), []);
  });

  it('S3: a join an honest admin approves completes although a malicious admin squatted it (invariant 12)', () => {
    const config: WorldConfig = { kind: 'team', thief: 'D1', clock: 'steady', agent: true };
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D1', role: 'admin' },
      { t: 'attack', kind: 'squat', target: 'D2', cut: { F: 2, D1: 1 }, seenMode: 'applied', grind: false, publish: true },
      { t: 'add', by: 'F', device: 'D2', role: 'member' },
    ];
    assert.deepEqual(violationsOf(config, ops), []);
  });

  it('S5 (model scale): a member that floods its quota can still be removed by an admin (invariant 11)', () => {
    const config: WorldConfig = { kind: 'team', thief: 'D1', clock: 'steady', agent: true };
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D1', role: 'member' },
      { t: 'attack', kind: 'flood', cut: { F: 2, D1: 1 }, seenMode: 'applied', grind: false, publish: true },
    ];
    assert.deepEqual(violationsOf(config, ops), []);
  });
});

describe('vault model checker: round-5 findings', () => {
  const cut = { F: 99, D1: 99, D2: 99, P1: 99, P2: 99 };
  const attack = (op: Partial<Extract<Op, { t: 'attack' }>> & { kind: Extract<Op, { t: 'attack' }>['kind'] }): Op => ({ t: 'attack', cut, seenMode: 'applied', grind: false, publish: true, ...op });

  it('N2: a garbage-signed line vouched for by the next signed line never applies (invariant 16)', () => {
    const config: WorldConfig = { kind: 'personal', thief: 'D1', clock: 'steady', agent: false };
    assert.deepEqual(violationsOf(config, [{ t: 'add', by: 'F', device: 'D1' }, attack({ kind: 'garbageSig' })]), []);
  });

  it('N2: a garbage-signed second version of a line others read yields a fork proof, and copies converge (invariants 16 and 10)', () => {
    const config: WorldConfig = { kind: 'personal', thief: 'D1', clock: 'steady', agent: false };
    const ops: Op[] = [{ t: 'add', by: 'F', device: 'D1' }, attack({ kind: 'put' }), { t: 'sync', device: 'F' }, attack({ kind: 'garbageSig', fork: true })];
    assert.deepEqual(violationsOf(config, ops), []);
  });

  it('N4: a joiner a malicious admin approved first with a wrong key either opens the key or can be approved again (invariant 17)', () => {
    const config: WorldConfig = { kind: 'team', thief: 'D1', clock: 'steady', agent: false };
    const ops: Op[] = [{ t: 'add', by: 'F', device: 'D1', role: 'admin' }, attack({ kind: 'plantKey', target: 'D2' }), { t: 'add', by: 'F', device: 'D2', role: 'admin' }];
    assert.deepEqual(violationsOf(config, ops), []);
  });

  it('N1 (model scale): an attacker and its puppets filling the reserve can\'t stop an honest admin removing it (invariant 18)', () => {
    const config: WorldConfig = { kind: 'personal', thief: 'D1', clock: 'steady', agent: true, quota: true };
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D1' },
      attack({ kind: 'addPuppet' }),
      attack({ kind: 'addPuppet' }),
      attack({ kind: 'fillReserve' }),
      attack({ kind: 'fillReserve', as: 'P1' }),
      attack({ kind: 'fillReserve', as: 'P2' }),
      { t: 'remove', by: 'F', target: 'D1', pull: true, push: true },
    ];
    assert.deepEqual(violationsOf(config, ops), []);
  });
});

describe('vault model checker: round-6 findings', () => {
  const cut = { F: 99, D1: 99, D2: 99, P1: 99, P2: 99 };
  const attack = (op: Partial<Extract<Op, { t: 'attack' }>> & { kind: Extract<Op, { t: 'attack' }>['kind'] }): Op => ({ t: 'attack', cut, seenMode: 'applied', grind: false, publish: true, ...op });
  const personal: WorldConfig = { kind: 'personal', thief: 'D1', clock: 'steady', agent: true };
  const keyed: Op[] = [{ t: 'recoverySet', by: 'F', recovery: 'R1', push: true }, { t: 'put', by: 'F', account: 'a1', push: true }, { t: 'add', by: 'F', device: 'D1' }];

  it.todo('R6-D: a key.rotate with a wrong key sealed to everyone else costs nothing (invariant 19; open in 0.4, multi-device only: the epoch a seal proof voids stays in state.epoch and keyChecks)', () => {
    assert.deepEqual(violationsOf(personal, [...keyed, attack({ kind: 'badSeal', sealAs: 'rotate', victims: 'all' })]), []);
  });

  it.todo('R6-D: a key.rotate with a wrong key sealed to the recovery identity only costs nothing (invariant 19; open in 0.4, multi-device only: findBadSeals is not wired up, so a bad seal sent only to the recovery identity is never caught)', () => {
    assert.deepEqual(violationsOf(personal, [...keyed, attack({ kind: 'badSeal', sealAs: 'rotate', victims: 'recovery' })]), []);
  });

  it.todo('R6-D: a recovery.set with a wrong key sealed to the others costs nothing (invariant 19; open in 0.4, multi-device only: the epoch a seal proof voids stays in state.epoch and keyChecks)', () => {
    assert.deepEqual(violationsOf(personal, [...keyed, attack({ kind: 'badSeal', sealAs: 'recoverySet', victims: 'all' })]), []);
  });

  it('R6-E: a puppet whose removal by the thief was voided can still be removed (invariant 20)', () => {
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D2' },
      { t: 'put', by: 'F', account: 'a1', push: true },
      { t: 'add', by: 'F', device: 'D1' },
      attack({ kind: 'addPuppet' }),
      { t: 'sync', device: 'F' },
      { t: 'remove', by: 'F', target: 'D1' },
      attack({ kind: 'remove', target: 'P1' }),
      { t: 'delete', by: 'D2', account: 'a1', pull: true, push: true },
      { t: 'sync', device: 'F' },
    ];
    assert.deepEqual(violationsOf(personal, ops), []);
  });

  it('R6-A: a fork seq named by a puppet that ends up out is not contested (invariant 21)', () => {
    const config: WorldConfig = { kind: 'personal', thief: 'F', clock: 'steady', agent: true };
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D2' },
      { t: 'put', by: 'D2', account: 'a1', push: true },
      attack({ kind: 'addPuppet' }),
      attack({ kind: 'slander', slander: 'ownFork', target: 'F', as: 'P1', forkAt: 1 }),
      attack({ kind: 'forkProof', forkAt: 1 }),
    ];
    assert.deepEqual(violationsOf(config, ops), []);
  });

  it('R6-B (model scale): once a member that wrote past its share straight into the folder is removed, the vault takes honest lines again (invariant 22)', () => {
    const config: WorldConfig = { kind: 'team', thief: 'D1', clock: 'steady', agent: true, quota: true };
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D1', role: 'member' },
      attack({ kind: 'flood', direct: true }),
      attack({ kind: 'flood', direct: true }),
      { t: 'remove', by: 'F', target: 'D1', pull: true, push: true },
      { t: 'put', by: 'F', account: 'a1', push: true },
    ];
    assert.deepEqual(violationsOf(config, ops), []);
  });

  it('R6-F: honest lines re-encoded with whitespace in the folder count as the same lines (invariant 23)', () => {
    const config: WorldConfig = { kind: 'team', thief: 'D2', clock: 'steady', agent: false };
    const ops: Op[] = [
      { t: 'add', by: 'F', device: 'D1', role: 'member' },
      { t: 'put', by: 'D1', account: 'a1', push: true },
      { t: 'add', by: 'F', device: 'D2', role: 'admin' },
      attack({ kind: 'reencode', target: 'D1' }),
      { t: 'put', by: 'D1', account: 'a2', push: true },
    ];
    assert.deepEqual(violationsOf(config, ops), []);
  });
});

describe('vault model checker: solo vaults (0.3.0)', () => {
  let multiDevice = false;
  before(() => {
    multiDevice = vaultFeatures.multiDevice;
    vaultFeatures.multiDevice = false;
  });
  after(() => {
    vaultFeatures.multiDevice = multiDevice;
  });
  // S7r (what a computer that rolls back, withholds or re-encodes can cost) is reported, not failed.
  const hard = (ops: SoloOp[]) => {
    const world = runSolo(new ModelContext('solo-test'), { ...SOLO_FAST, maxSteps: 30, maxThief: 10, maxPuts: 5, maxRestores: 2, maxComputer: 5, maxPhraseThief: 3 }, ops);
    assert.ok(world, 'the scenario could not be built');
    return checkSolo(world).filter((v) => v.invariant !== 'S7r');
  };

  it('finds no S1–S7 violation in any solo scenario within the fast bounds (stolen phone, old phrase, hostile computer)', () => {
    const result = searchSoloExhaustive('solo-fast', { ...SOLO_FAST, maxSteps: 3 }, 30, 1);
    console.log(`# solo: ${formatSoloStats(result.stats)}`);
    const hard = result.found.filter((f) => f.violation.invariant !== 'S7r');
    assert.deepEqual(hard.map((f) => `${f.violation.invariant}: ${f.violation.summary} after ${JSON.stringify(f.ops)}`), []);
  });

  it('the stolen old phone can\'t undo a restore, whatever it writes, forks or plants', () => {
    const ops: SoloOp[] = [
      { t: 'put' },
      { t: 'steal' },
      { t: 'thief', kind: 'put', basis: 'stale', delivery: 'hold' },
      { t: 'restore' },
      { t: 'thiefRelease' },
      { t: 'thief', kind: 'add', basis: 'folder', delivery: 'direct' },
      { t: 'thief', kind: 'recoverySet', basis: 'folder', delivery: 'agent' },
      { t: 'thief', kind: 'remove', basis: 'folder', delivery: 'direct', target: 'R' },
      { t: 'thief', kind: 'badSeal', basis: 'folder', delivery: 'direct' },
      { t: 'thief', kind: 'fork', basis: 'stale', delivery: 'direct' },
      { t: 'thief', kind: 'forkProof', basis: 'stale', delivery: 'direct' },
      { t: 'junkProof' },
      { t: 'put' },
      { t: 'sync' },
    ];
    assert.deepEqual(hard(ops), []);
  });

  it('after a phrase change the old phrase restores nothing and signs nothing that applies', () => {
    const ops: SoloOp[] = [{ t: 'put' }, { t: 'phrase' }, { t: 'oldPhrase', kind: 'restore', delivery: 'agent' }, { t: 'oldPhrase', kind: 'phrase', delivery: 'direct' }, { t: 'restore' }];
    assert.deepEqual(hard(ops), []);
  });

  it('the stolen old phone, writing the folder, can\'t erase a line of its own that the restore saw (S4)', () => {
    // The thief replaces F's last pre-cut line in the folder with junk; the restored phone holds it but can't write it back.
    const ops: SoloOp[] = [{ t: 'put' }, { t: 'steal' }, { t: 'restore' }, { t: 'thief', kind: 'truncate', basis: 'stale', delivery: 'direct' }];
    assert.deepEqual(hard(ops), []);
  });

  it('a second restore cuts the first restored phone too', () => {
    const ops: SoloOp[] = [{ t: 'put' }, { t: 'restore' }, { t: 'put' }, { t: 'restore' }, { t: 'put' }];
    assert.deepEqual(hard(ops), []);
  });
});

describe('vault model checker: sanity', () => {
  it('catches a deliberately broken rule (a removed device comes back by signing)', () => {
    const result = searchExhaustive({
      ...fastOptions,
      bounds: { ...FAST_BOUNDS, maxSteps: 3, maxPuts: 0, attackKinds: ['remove'] },
      thieves: ['F'],
      replay: resurrectingReplay,
    });
    const caught = result.found.find((f) => f.violation.invariant === 1);
    assert.ok(caught, `the checker missed a rule that lets a removed thief back in (found: ${result.found.map((f) => f.violation.invariant).join(', ') || 'nothing'})`);
    // The same scenario under the real rules keeps the thief out: the toy rule, not the scenario, is at fault.
    const real = runOps(new ModelContext(caught.seed), caught.config, caught.ops);
    assert.ok(real, 'the toy scenario could not be built on the real rules');
    assert.equal(checkWorld(real).filter((v) => v.invariant === 1).length, 0);
  });
});
