/** What the screens see (envContract.ts), built from this device's copies. Pure. */
import type { EnvGrantView, EnvMemberView, EnvProblemView, EnvSetView, EnvVariableView } from '../envContract';
import { envFileProblemWords, envLoadsCode, envSetFilePath, type EnvFileProblem, type EnvSetFile } from '../../envcore';
import type { EnvGrant, EnvSetSummary } from '../../protocol';
import type { StoredEnvSet } from './host';
import { repoName, shortPerson } from './words';

/** What the engine knows about a set besides its copy: the computer's file and the people around it. */
export interface SetContext {
  memberId: string | null;
  /** The copy's computer is the active one and it answers env.* now. */
  online: boolean;
  grant: EnvGrant | null;
  /** Join requests waiting, teammate and own-device, when this device owns the set. */
  joinRequestCount: number;
  /** The computer's file failed this device's check, with the commit that brought the line in. */
  computerProblem: { problem: EnvFileProblem; commit: string | null; names?: string[] } | null;
  /** The computer's file wasn't taken because its history couldn't be checked (a sentence saying why). */
  computerNote: string | null;
  /** The computer's file is older than this device's copy. */
  olderOnComputer: boolean;
  /** A wrap in the header doesn't rebuild from the data key: nothing is released from the set. */
  badWraps: boolean;
  /** Owner: the vault's recovery phrase isn't on this set yet (it is put there once the computer is reachable). */
  recoveryPending: boolean;
}

export function problemView(problem: EnvFileProblem, setName: string, commit: string | null, names: string[] | null = null): EnvProblemView {
  const words = envFileProblemWords(problem, { file: setFilePath(setName), set: setName, where: 'phone', ...(commit ? { commit } : {}) });
  if (problem.kind === 'wrong-epoch') {
    // The owner reviews these names, then keeps or drops them (fixOldKeyLines): nothing is re-encrypted unseen.
    return { id: `epoch:${problem.kind}`, kind: 'epoch', severity: 'error', title: words.title, text: words.message, hint: 'Review the values under the old key, then keep or drop them.', names };
  }
  return { id: `file:${problem.kind}`, kind: 'file', severity: 'error', title: words.title, text: words.message, hint: words.hint };
}

/** An old-key line: the owner's device fixes it by itself; anyone else waits for the owner. */
export function epochWaitProblem(problem: EnvFileProblem, ownerLabel: string | null, names: string[] | null): EnvProblemView {
  const owner = ownerLabel ?? 'the owner';
  return {
    id: `epoch:${problem.kind}`,
    kind: 'epoch',
    severity: 'warning',
    title: `Waiting for ${owner} to fix the set`,
    text: `A variable was changed while ${owner} made a new key, so it is still under the old key. Nothing more is taken from the computer's file until ${owner} reviews it on their phone; this device uses its own copy meanwhile.`,
    hint: `Ask ${owner} to review the set on their phone.`,
    names,
  };
}

export function historyUncheckedProblem(note: string): EnvProblemView {
  return {
    id: 'file:history-unchecked',
    kind: 'file',
    severity: 'error',
    title: "The computer's file wasn't taken",
    text: `${note} This device keeps using its own copy meanwhile.`,
  };
}

export function recoveryPendingProblem(computerName: string): EnvProblemView {
  return {
    id: 'recovery-pending',
    kind: 'file',
    severity: 'warning',
    title: 'Recovery phrase not on this set yet',
    text: `Your vault's recovery phrase can't take this set over yet. AuthDeck puts it on the set the next time ${computerName} is connected.`,
  };
}

export function badWrapsProblem(setName: string): EnvProblemView {
  return {
    id: 'file:bad-wraps',
    kind: 'file',
    severity: 'error',
    title: "A member's key doesn't match",
    text: `The member list of ${setName} gives a device a key that doesn't match this device's. Nothing is released from it.`,
    hint: `Ask the owner to open ${setName} on their phone and remove that device.`,
  };
}

export function olderCopyProblem(setName: string, computerName: string): EnvProblemView {
  return {
    id: 'older-copy',
    kind: 'older-copy',
    severity: 'warning',
    title: 'The computer has an older copy',
    text: `${computerName} has an older ${setFilePath(setName)} than this device. Releases use this device's copy.`,
    hint: 'Pull the latest commit on the computer.',
  };
}

export function offlineProblem(computerName: string, syncedAt: number | null): EnvProblemView {
  return {
    id: 'offline',
    kind: 'offline',
    severity: 'warning',
    title: `${computerName} isn't connected`,
    text: `AuthDeck reads sets only from the computer it is connected to now, and ${computerName} isn't it or is offline. ${
      syncedAt ? 'Variables show as of the last time this device read the set. ' : ''
    }Changes you make wait here until AuthDeck connects to ${computerName} again.`,
    hint: `Choose ${computerName} on the deck, or open AuthDeck Agent on it.`,
  };
}

/** The set's path in its repo; a name the core refuses still reads as a path. */
export function setFilePath(setName: string): string {
  try {
    return envSetFilePath(setName);
  } catch {
    return `.authdeck/${setName}.env`;
  }
}

function grantView(grant: EnvGrant, computerName: string): EnvGrantView {
  return { grantId: grant.grantId, computerName, endsAt: grant.endsAt, by: grant.by, usedBy: grant.uses };
}

function roleOf(file: EnvSetFile, copy: StoredEnvSet, memberId: string | null): EnvSetView['role'] {
  if (copy.removed) return 'removed';
  return file.header.members.find((m) => m.id === memberId)?.role ?? 'outside';
}

export function setView(copy: StoredEnvSet, file: EnvSetFile, context: SetContext): EnvSetView {
  const computerName = copy.location?.computerName ?? 'Computer';
  const problems: EnvProblemView[] = [];
  const ownerLabel = file.header.members.find((m) => m.role === 'owner')?.label ?? null;
  const computerProblem = context.computerProblem;
  if (computerProblem?.problem.kind === 'wrong-epoch' && roleOf(file, copy, context.memberId) !== 'owner') problems.push(epochWaitProblem(computerProblem.problem, ownerLabel, computerProblem.names ?? null));
  else if (computerProblem) problems.push(problemView(computerProblem.problem, copy.name, computerProblem.commit, computerProblem.names ?? null));
  if (context.computerNote) problems.push(historyUncheckedProblem(context.computerNote));
  if (context.recoveryPending) problems.push(recoveryPendingProblem(computerName));
  if (context.badWraps) problems.push(badWrapsProblem(copy.name));
  if (context.olderOnComputer) problems.push(olderCopyProblem(copy.name, computerName));
  if (!context.online && !copy.removed) problems.push(offlineProblem(computerName, copy.syncedAt));
  const role = roleOf(file, copy, context.memberId);
  return {
    id: copy.setId,
    name: copy.name,
    repo: repoName(copy.location?.remote ?? null),
    file: setFilePath(copy.name),
    computerName,
    computerOnline: context.online,
    role,
    ownerLabel,
    variableCount: file.values.filter((line) => line.box !== null).length,
    memberCount: file.header.members.length,
    grant: context.grant ? grantView(context.grant, computerName) : null,
    lastReleasedAt: copy.lastReleasedAt,
    syncedAt: copy.syncedAt,
    joinRequestCount: role === 'owner' ? context.joinRequestCount : 0,
    problems,
    removedNote: copy.removed?.note ?? null,
    refusedNote: null,
  };
}

/** A set on the computer this device isn't in: it may ask to join, or take it over with the owner's phrase. */
export function outsideSetView(summary: EnvSetSummary, computerName: string, online: boolean, refusedNote: string | null): EnvSetView {
  return {
    id: summary.setId,
    name: summary.name,
    repo: repoName(summary.remote),
    file: setFilePath(summary.name),
    computerName,
    computerOnline: online,
    role: 'outside',
    ownerLabel: null,
    variableCount: summary.variables,
    memberCount: summary.members,
    grant: null,
    lastReleasedAt: null,
    syncedAt: null,
    joinRequestCount: 0,
    problems: summary.problem ? [problemView(summary.problem.problem, summary.name, summary.problem.commit)] : [],
    removedNote: null,
    refusedNote,
  };
}

export function variableViews(file: EnvSetFile): EnvVariableView[] {
  const labels = new Map(file.header.members.map((m) => [m.id, m.label]));
  return file.values
    .filter((line) => line.box !== null)
    .map((line) => ({
      name: line.name,
      version: line.version,
      by: shortPerson(labels.get(line.author) ?? line.author),
      byMemberId: line.author,
      time: line.time,
      loadsCode: envLoadsCode(line.name),
    }));
}

export function memberViews(file: EnvSetFile, memberId: string | null): EnvMemberView[] {
  return file.header.members.map((m) => ({ id: m.id, label: m.label, form: m.form, role: m.role, thisDevice: m.id === memberId, since: m.since }));
}
