/**
 * Which ops a scenario can take next, within bounds, and a structural signature of a world so
 * the search visits each distinct scenario shape once.
 */
import { stableJson } from './invariants';
import type { Role } from '../../src/vault/index';
import { attackerLabels, DEVICE_LABELS, folderView, stateOf, viewOf, type AttackKind, type Op, type SeenMode, type SlanderMode, type World } from './world';

export interface Bounds {
  /** Devices that may join, the founder and restored devices included. */
  maxDevices: number;
  /** add, remove, recovery.set, key.rotate, restore and the thief's membership lines. */
  maxMembershipOps: number;
  maxPuts: number;
  /** Honest account.deletes of accounts already added (key-independent lines). */
  deletes?: boolean;
  /** Lines the thief signs after it is stolen. */
  maxAttacks: number;
  /** Ops in a scenario, syncs included. */
  maxSteps: number;
  maxRecoverySets: number;
  /** Allow honest restores with the recovery phrase. */
  restore: boolean;
  /** Let honest admins re-approve unkeyed devices as separate scenario steps (settling always does). */
  reapprove: boolean;
  attackKinds: AttackKind[];
  seenModes: SeenMode[];
  /** Let the thief grind its key changes' hashes below every rival. */
  grind: boolean;
  /** Let the thief withhold lines and release them later. */
  withhold: boolean;
  /** Let the thief sign a second line at the seq of its last sent one (folder mode: the agent refuses it). */
  fork: boolean;
  slanderModes: SlanderMode[];
}

export const FAST_BOUNDS: Bounds = {
  maxDevices: 3,
  maxMembershipOps: 4,
  maxPuts: 1,
  maxAttacks: 1,
  maxSteps: 4,
  maxRecoverySets: 1,
  restore: false,
  reapprove: false,
  attackKinds: ['remove', 'recoverySet'],
  seenModes: ['applied'],
  grind: true,
  withhold: false,
  fork: false,
  slanderModes: ['existing'],
};

/** Team vaults, roles, forks, slander and beacons, kept small enough for the fast test. */
export const FAST_TEAM_BOUNDS: Bounds = {
  ...FAST_BOUNDS,
  maxMembershipOps: 3,
  maxSteps: 4,
  maxRecoverySets: 0,
  attackKinds: ['remove', 'slander', 'beacon', 'forkProof'],
  grind: false,
  fork: true,
};

export const DEEP_BOUNDS: Bounds = {
  maxDevices: 4,
  maxMembershipOps: 5,
  maxPuts: 1,
  deletes: true,
  maxAttacks: 2,
  maxSteps: 9,
  maxRecoverySets: 1,
  restore: true,
  reapprove: true,
  attackKinds: ['remove', 'recoverySet', 'rotate', 'put', 'addPuppet', 'slander', 'beacon', 'squat', 'flood', 'forkProof', 'garbageSig', 'plantKey', 'fillReserve', 'badSeal', 'reencode'],
  seenModes: ['applied', 'heads'],
  grind: true,
  withhold: true,
  fork: true,
  slanderModes: ['existing', 'pastEnd'],
};

function honestDevices(world: World): string[] {
  return world.devices.filter((d) => !(d === world.config.thief && world.attackStarted));
}

/** The next device to join: a fresh label, or a joiner the thief squatted that hasn't joined. */
function nextDeviceLabel(world: World): string | undefined {
  return DEVICE_LABELS.find((label) => !world.ids[label] || (world.squats.includes(label) && !world.devices.includes(label)));
}

/** Every op worth trying next; applyOp still refuses the ones that can't happen. */
export function candidateOps(world: World, bounds: Bounds): Op[] {
  const ops: Op[] = [];
  if (world.trace.length >= bounds.maxSteps) return ops;
  const honest = honestDevices(world);
  // A standalone sync only matters when it sends something; reading is folded into each op's pull.
  for (const device of honest) if ((world.published[device] ?? 0) < (world.lines[device]?.length ?? 0)) ops.push({ t: 'sync', device });
  const { counters } = world;
  const membershipLeft = counters.membership < bounds.maxMembershipOps;
  const next = nextDeviceLabel(world);
  const canJoin = world.devices.length < bounds.maxDevices && next !== undefined;
  if (membershipLeft) {
    for (const by of honest) {
      if (canJoin) for (const role of rolesFor(world)) ops.push({ t: 'add', by, device: next, role });
      for (const target of [...world.devices, ...world.puppets]) if (target !== by) ops.push(...timed({ t: 'remove', by, target }));
      if (counters.recoverySets < bounds.maxRecoverySets) ops.push(...timed({ t: 'recoverySet', by, recovery: `R${counters.recoverySets + 1}` }));
      ops.push(...timed({ t: 'rotate', by }));
      if (bounds.reapprove) for (const device of world.devices) if (device !== by) ops.push({ t: 'reapprove', by, device });
    }
    if (bounds.restore && canJoin) ops.push({ t: 'restore', device: next });
  }
  if (counters.puts < bounds.maxPuts) for (const by of honest) ops.push(...timed({ t: 'put', by, account: `a${counters.puts + 1}` }));
  if (bounds.deletes) for (const account of Object.keys(world.accounts).filter((a) => !world.deleted?.includes(a))) for (const by of honest) ops.push(...timed({ t: 'delete', by, account }));
  if (world.config.thief && world.devices.includes(world.config.thief) && counters.attacks < bounds.maxAttacks) ops.push(...attackOps(world, bounds, membershipLeft));
  if (bounds.withhold && hasWithheld(world)) ops.push({ t: 'release' });
  return ops;
}

function rolesFor(world: World): Role[] {
  return world.config.kind === 'team' ? ['admin', 'member'] : ['admin'];
}

/** The four ways an honest device can sign: on a stale or fresh view, sending now or later. */
function timed<T extends Op>(op: T): T[] {
  return [false, true].flatMap((pull) => [false, true].map((push) => ({ ...op, pull, push })));
}

function hasWithheld(world: World): boolean {
  return attackerLabels(world).some((label) => (world.published[label] ?? 0) < (world.lines[label]?.length ?? 0));
}

function attackOps(world: World, bounds: Bounds, membershipLeft: boolean): Op[] {
  const thief = world.config.thief!;
  const ops: Op[] = [];
  const publishes = bounds.withhold ? [true, false] : [true];
  // A self-fork proof doesn't depend on the thief's view: one op per own line.
  if (bounds.attackKinds.includes('forkProof')) {
    for (const label of attackerLabels(world)) {
      for (let seq = 0; seq < (world.published[label] ?? 0); seq++) ops.push({ t: 'attack', kind: 'forkProof', ...(label !== thief ? { as: label } : {}), forkAt: seq, cut: {}, seenMode: 'applied', grind: false, publish: true });
    }
  }
  const phrases = attackerLabels(world).filter((l) => l !== thief && !world.puppets.includes(l));
  for (const { cut, active } of distinctCuts(world)) {
    // The thief's own phrase approves a puppet too (so a recovery identity can fork).
    if (membershipLeft && bounds.attackKinds.includes('addPuppet')) for (const as of phrases) ops.push({ t: 'attack', kind: 'addPuppet', as, cut, seenMode: 'applied', grind: false, publish: true });
    // Bad seals by the thief or a puppet (invariant 19), a re-encoded honest log (invariant 23).
    if (membershipLeft && bounds.attackKinds.includes('badSeal')) {
      for (const as of [undefined, ...world.puppets]) {
        for (const sealAs of ['rotate', 'recoverySet'] as const) {
          for (const victims of ['all', 'recovery'] as const) ops.push({ t: 'attack', kind: 'badSeal', ...(as ? { as } : {}), sealAs, victims, cut, seenMode: 'applied', grind: false, publish: true });
        }
      }
    }
    if (bounds.attackKinds.includes('reencode')) {
      for (const target of world.devices.filter((d) => d !== thief && !world.padded[d])) ops.push({ t: 'attack', kind: 'reencode', target, cut: {}, seenMode: 'applied', grind: false, publish: true });
    }
    // A puppet names the thief's own second version (a contest by an identity that is later removed: invariant 21).
    if (bounds.attackKinds.includes('slander') && bounds.attackKinds.includes('forkProof')) {
      const proof = world.proofs.find((p) => p.deviceId === world.ids[thief]);
      const seqs = proof ? [proof.seq] : Array.from({ length: world.published[thief] ?? 0 }, (_, i) => i).filter((q) => q > 0);
      for (const as of world.puppets) for (const forkAt of seqs) ops.push({ t: 'attack', kind: 'slander', slander: 'ownFork', target: thief, as, forkAt, cut, seenMode: 'applied', grind: false, publish: true });
    }
    // The thief's puppets fill the reserve too (invariant 18: many admins' reserves together).
    if (membershipLeft && world.config.quota && bounds.attackKinds.includes('fillReserve')) for (const as of world.puppets) ops.push({ t: 'attack', kind: 'fillReserve', as, cut, seenMode: 'applied', grind: false, publish: true });
    // The thief's puppets sign removals too (the mirror of R1: a puppet removes the thief's remover).
    if (membershipLeft) {
      for (const puppet of world.puppets) {
        for (const target of active.filter((t) => t !== puppet && t !== thief)) {
          for (const publish of publishes) ops.push({ t: 'attack', kind: 'remove', as: puppet, target, cut, seenMode: 'applied', grind: false, publish });
        }
      }
    }
    const forks = bounds.fork && !world.config.agent && canFork(world) ? [false, true] : [false];
    for (const seenMode of bounds.seenModes) {
      for (const kind of bounds.attackKinds) {
        if (kind === 'forkProof' || kind === 'badSeal' || kind === 'reencode') continue;
        if (kind === 'fillReserve' && !world.config.quota) continue;
        if (kind !== 'put' && kind !== 'slander' && kind !== 'beacon' && kind !== 'flood' && kind !== 'garbageSig' && !membershipLeft) continue;
        if ((kind === 'beacon' || kind === 'squat' || kind === 'plantKey' || kind === 'flood' || kind === 'garbageSig' || kind === 'fillReserve') && seenMode !== 'applied') continue;
        const next = DEVICE_LABELS.find((label) => !world.ids[label]);
        const targets =
          kind === 'remove' || kind === 'slander' || kind === 'beacon'
            ? active.filter((t) => t !== thief && !world.puppets.includes(t) && world.devices.includes(t))
            : kind === 'squat' || kind === 'plantKey'
              ? next && world.devices.length < bounds.maxDevices ? [next] : []
              : [undefined];
        const grinds = bounds.grind && (kind === 'remove' || kind === 'recoverySet' || kind === 'rotate') ? [false, true] : [false];
        const slanders: (SlanderMode | undefined)[] = kind === 'slander' ? bounds.slanderModes : [undefined];
        for (const target of targets) {
          for (const grind of grinds) {
            for (const fork of kind === 'beacon' || kind === 'addPuppet' || kind === 'squat' || kind === 'plantKey' || kind === 'flood' || kind === 'fillReserve' ? [false] : forks) {
              for (const slander of slanders) {
                const publishOptions = kind === 'beacon' ? [true] : publishes;
                // A member with folder write access writes past its share straight in (invariant 22).
                const directs = world.config.quota && (kind === 'flood' || kind === 'fillReserve') ? [false, true] : [false];
                for (const publish of publishOptions) for (const direct of directs) ops.push({ t: 'attack', kind, ...(target ? { target } : {}), cut, seenMode, grind, publish, ...(fork ? { fork } : {}), ...(slander ? { slander } : {}), ...(direct && publish ? { direct } : {}) });
              }
            }
          }
        }
      }
    }
  }
  return ops;
}

/** The thief can fork when its last line is in the folder and some honest device has read it. */
function canFork(world: World): boolean {
  const thief = world.config.thief!;
  const length = world.lines[thief]?.length ?? 0;
  if (length < 2 || (world.published[thief] ?? 0) !== length) return false;
  return Object.entries(world.synced).some(([device, synced]) => device !== thief && (synced[thief] ?? 0) >= length);
}

/**
 * Causally closed prefixes of the published logs (the thief always has its own and its puppets' whole logs),
 * one per distinct `seen` they give. `active` lists the devices active in that view.
 */
export function distinctCuts(world: World): { cut: Record<string, number>; active: string[] }[] {
  const thief = world.config.thief!;
  const own = attackerLabels(world);
  const labels = Object.keys(world.lines).filter((l) => !own.includes(l) && (world.published[l] ?? 0) > 0);
  void thief;
  const out = new Map<string, { cut: Record<string, number>; active: string[] }>();
  const counts: Record<string, number> = Object.fromEntries(own.map((l) => [l, world.lines[l]?.length ?? 0]));
  const visit = (i: number) => {
    if (i === labels.length) {
      if (!closed(world, counts)) return;
      const view = viewOf(world, counts);
      const state = stateOf(world, view);
      const key = stableJson(state.appliedHeads);
      if (out.has(key)) return;
      const active = Object.entries(world.ids)
        .filter(([, id]) => state.members[id] && !state.members[id]!.removed)
        .map(([label]) => label);
      out.set(key, { cut: { ...counts }, active });
      return;
    }
    const label = labels[i]!;
    const min = label === 'F' ? 1 : 0;
    for (let n = min; n <= world.published[label]!; n++) {
      counts[label] = n;
      visit(i + 1);
    }
    delete counts[label];
  };
  visit(0);
  return [...out.values()];
}

/** Every line in the cut names only lines in the cut. */
function closed(world: World, counts: Record<string, number>): boolean {
  const labelOf = new Map(Object.entries(world.ids).map(([label, id]) => [id, label]));
  for (const [label, count] of Object.entries(counts)) {
    for (const line of (world.lines[label] ?? []).slice(0, count)) {
      for (const [id, ref] of Object.entries(line.entry.seen)) {
        if ((counts[labelOf.get(id) ?? ''] ?? 0) <= ref.seq) return false;
      }
    }
  }
  return true;
}

/** A world's shape without hashes: same shape, same scenario up to key material. */
export function signature(world: World): string {
  const labelOf = new Map(Object.entries(world.ids).map(([label, id]) => [id, label]));
  const describe = (hash: string) => {
    for (const log of Object.values(world.lines)) for (const l of log) if (l.hash === hash) return `${l.label}${l.seq}`;
    return hash;
  };
  const logs = Object.keys(world.lines)
    .sort()
    .map((label) => {
      const lines = world.lines[label]!.map((l) => {
        const seen = Object.entries(l.entry.seen)
          .map(([id, ref]) => `${labelOf.get(id)}${ref.seq}`)
          .sort()
          .join('.');
        const role = l.entry.kind === 'device.add' ? `:${(l.entry.body as { role?: string }).role}` : '';
        return `${l.entry.kind}${role}/${l.subject ?? ''}/${seen}${l.honest ? '' : '!'}${l.ground ? 'g' : ''}${l.slander ? 's' : ''}`;
      });
      return `${label}[${world.published[label] ?? 0}]${lines.join(';')}`;
    });
  const synced = Object.keys(world.synced)
    .sort()
    .map((label) => `${label}:${stableJson(world.synced[label])}`);
  const copies = Object.keys(world.copies)
    .sort()
    .map((device) => `${device}:${Object.entries(world.copies[device]!).map(([log, lines]) => `${log}${lines.length}${lines.at(-1)?.entry.kind}`).join('.')}`);
  const beacons = Object.keys(world.beacons)
    .sort()
    .map((label) => `${label}:${stableJson(Object.fromEntries(Object.entries(world.beacons[label]!.heads).map(([id, ref]) => [labelOf.get(id), ref.seq])))}@${world.beacons[label]!.epoch}`);
  return [
    `${world.config.kind}/${world.config.thief}/${world.config.clock}/${world.config.agent}/${world.attackStarted}/${world.refusals}/${world.honestRefusals.length}`,
    copies.join('|'),
    world.proofs.map((p) => `${labelOf.get(p.deviceId)}@${p.seq}`).join(','),
    stableJson(world.forkedAt),
    `${world.squats.join(',')}/${world.intercepted.map((i) => i.device).join(',')}`,
    beacons.join('|'),
    stableJson(world.counters),
    world.devices.join(','),
    logs.join('|'),
    synced.join('|'),
    world.everAppliedRemovals.map(describe).sort().join(','),
    [...world.everAccounts].sort().join(','),
  ].join('#');
}

/** The folder's content key: a check only needs to rerun when this changes. */
export function folderKey(world: World): string {
  const beacons = Object.entries(world.beacons)
    .map(([label, b]) => `${label}:${b.sig.slice(0, 12)}`)
    .sort()
    .join(',');
  const copies = Object.entries(world.copies)
    .map(([device, logs]) => `${device}:${Object.entries(logs).map(([log, lines]) => `${log}${lines.length}`).join('.')}`)
    .sort()
    .join(',');
  return `${folderView(world).key}#${world.squats.length}/${world.intercepted.length}#${world.everAppliedRemovals.length}/${world.everAccounts.length}#${world.admissions.length}/${world.honestRefusals.length}#${beacons}#${copies}`;
}
