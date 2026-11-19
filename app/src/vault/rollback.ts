import { fromBase64Url } from './bytes';
import { forkProofProblem, type ForkProof, type KnownIdentity, type VaultLogs, type VerifyCache } from './chain';
import { deviceIdFor } from './crypto';
import type { VaultState } from './replay';

/** The latest (seq, hash) a device has applied for each device. Kept in secure storage. */
export type RememberedHeads = Record<string, { seq: number; hash: string }>;

export interface RollbackProblem {
  deviceId: string;
  /** rolled-back: the log is shorter than before. changed: a known entry now has a different hash. */
  kind: 'rolled-back' | 'changed';
  remembered: { seq: number; hash: string };
  /** The verified head now in the folder, or null when the device's log is gone or broken from the start. */
  found: { seq: number; hash: string } | null;
}

export interface RollbackCheck {
  problems: RollbackProblem[];
  /** What to remember after this read: the newer of the two heads per device. */
  heads: RememberedHeads;
}

/**
 * Rule 5: compares what this device applied before with the verified logs now. A shorter log or
 * a different hash at a known seq means history was rolled back or changed.
 */
export function checkRollback(remembered: RememberedHeads, state: VaultState): RollbackCheck {
  const problems: RollbackProblem[] = [];
  const heads: RememberedHeads = { ...remembered };
  for (const [deviceId, before] of Object.entries(remembered)) {
    const chain = state.chains[deviceId] ?? [];
    const found = state.heads[deviceId] ?? null;
    if (chain.length <= before.seq) problems.push({ deviceId, kind: 'rolled-back', remembered: before, found });
    else if (chain[before.seq] !== before.hash) problems.push({ deviceId, kind: 'changed', remembered: before, found });
  }
  const troubled = new Set(problems.map((p) => p.deviceId));
  for (const [deviceId, head] of Object.entries(state.heads)) {
    if (troubled.has(deviceId)) continue;
    if (!heads[deviceId] || head.seq > heads[deviceId]!.seq) heads[deviceId] = head;
  }
  return { problems, heads };
}

/**
 * Lines this device should write back to repair the folder from its own verified copy: for each
 * device, the local lines from the first one the folder lacks or has wrong.
 */
export function repairLines(local: VaultLogs, localState: VaultState, remoteState: VaultState): Record<string, { from: number; lines: string[] }> {
  const repairs: Record<string, { from: number; lines: string[] }> = {};
  for (const [deviceId, hashes] of Object.entries(localState.chains)) {
    const remote = remoteState.chains[deviceId] ?? [];
    let from = 0;
    while (from < hashes.length && remote[from] === hashes[from]) from++;
    if (from < hashes.length) repairs[deviceId] = { from, lines: (local[deviceId] ?? []).slice(from, hashes.length) };
  }
  return repairs;
}

export type { ForkProof } from './chain';

/** One copy of the logs: the raw lines and their verified hashes per identity. */
interface LogCopy {
  logs: VaultLogs;
  state: VaultState;
}

/**
 * Compares two verified copies of the logs (this device's and the folder's). Both are checked
 * against the same key, so a divergence between them was signed by the identity: a fork. The
 * folder can't forge that, so the proof names the identity, not the folder. Found per identity,
 * the first that holds:
 * - both copies verified different entries at one seq;
 * - one copy's verified log stops early, and a line after that point which the identity signed
 *   differs from the other copy's verified entry at its seq, or does not follow the other copy's
 *   verified entry before it. So a signed line chaining on a line the identity never signed
 *   still proves the fork.
 * `cache` saves signature checks a replay with the same cache already made.
 */
export function findForks(a: VaultLogs, aState: VaultState, b: VaultLogs, bState: VaultState, cache?: VerifyCache): ForkProof[] {
  const mine: LogCopy = { logs: a, state: aState };
  const theirs: LogCopy = { logs: b, state: bState };
  const forks: ForkProof[] = [];
  for (const deviceId of Object.keys(aState.chains)) {
    if (!Object.hasOwn(bState.chains, deviceId)) continue;
    const proof = sameSeqFork(deviceId, mine, theirs) ?? signedPastBreak(deviceId, mine, theirs, cache) ?? signedPastBreak(deviceId, theirs, mine, cache);
    if (proof) forks.push(proof);
  }
  return forks;
}

/** The first seq both copies verified with different entries. */
function sameSeqFork(deviceId: string, a: LogCopy, b: LogCopy): ForkProof | null {
  const ours = a.state.chains[deviceId]!;
  const other = b.state.chains[deviceId]!;
  const shared = Math.min(ours.length, other.length);
  for (let seq = 0; seq < shared; seq++) {
    if (ours[seq] !== other[seq]) return { deviceId, seq, lines: [a.logs[deviceId]![seq]!, b.logs[deviceId]![seq]!] };
  }
  return null;
}

/**
 * A line of `broken` past its verified part, signed by the identity, that contradicts `whole`'s
 * verified log: a different entry at a seq `whole` verified, or one that does not follow
 * `whole`'s entry before it. Only lines up to one past `whole`'s verified log can contradict it,
 * so at most that many signatures are checked, each once per cache.
 */
function signedPastBreak(deviceId: string, broken: LogCopy, whole: LogCopy, cache: VerifyCache | undefined): ForkProof | null {
  const verified = whole.state.chains[deviceId]!;
  const wholeLines = whole.logs[deviceId] ?? [];
  const rawLines = broken.logs[deviceId] ?? [];
  const last = Math.min(rawLines.length - 1, verified.length);
  let identity: KnownIdentity | null | undefined;
  for (let seq = broken.state.chains[deviceId]!.length; seq <= last; seq++) {
    const line = rawLines[seq]!;
    if (seq < verified.length && line === wholeLines[seq]) continue;
    identity ??= identityOf(deviceId, whole) ?? identityOf(deviceId, broken);
    if (!identity) return null;
    const candidates: ForkProof[] = [];
    if (seq < verified.length) candidates.push({ deviceId, seq, lines: [wholeLines[seq]!, line] });
    if (seq > 0) candidates.push({ deviceId, seq, lines: [wholeLines[seq - 1]!, line] });
    const proof = candidates.find((candidate) => forkProofProblem(whole.state.vaultId, identity!, candidate, cache) === null);
    if (proof) return proof;
  }
  return null;
}

/**
 * The identity's key as a copy knows it: a member's, the current recovery identity's, or a
 * replaced recovery identity's from the verified `recovery.set` that named it.
 */
function identityOf(deviceId: string, copy: LogCopy): KnownIdentity | null {
  const ed = copy.state.members[deviceId]?.ed ?? (copy.state.recovery?.deviceId === deviceId ? copy.state.recovery.ed : null) ?? replacedRecoveryKey(deviceId, copy);
  return ed ? { deviceId, ed: fromBase64Url(ed), role: 'device' } : null;
}

function replacedRecoveryKey(deviceId: string, copy: LogCopy): string | null {
  for (const [author, hashes] of Object.entries(copy.state.chains)) {
    for (const line of (copy.logs[author] ?? []).slice(0, hashes.length)) {
      if (!line.includes('"recovery.set"')) continue;
      const entry = JSON.parse(line) as { kind: string; body: { ed?: unknown } };
      const ed = entry.body.ed;
      if (entry.kind === 'recovery.set' && typeof ed === 'string' && deviceIdFor(fromBase64Url(ed)) === deviceId) return ed;
    }
  }
  return null;
}
