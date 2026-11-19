/**
 * What the env screens show, worked out from the contract's views: which state the section is
 * in, a set row's lines, a request sheet's words and answers, a join request's words. Pure, no
 * React, so each wording and rule is tested on its own (test/screens/env).
 */
import type {
  EnvChangeView,
  EnvEndedRequestView,
  EnvJoinRequestView,
  EnvMemberView,
  EnvOwnRequestView,
  EnvProblemView,
  EnvRequestAnswer,
  EnvRequestView,
  EnvSetDetail,
  EnvSetView,
  EnvSnapshot,
  EnvVariableView,
} from '../../auth/envContract';
import { envFileProblemWords } from '../../envcore/types';

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** How long "Allow for 15 minutes" covers a set; the words on its button and note. */
export const GRANT_MINUTES = 15;

/** The masked look of every value, whatever its length, so the length isn't shown either. */
export const MASKED_VALUE = '••••••••••••••••';

/** How a variable name may look, in envcore's words (the bad-name hint). */
export const VARIABLE_NAME_RULE = envFileProblemWords({ kind: 'bad-name', line: 1, name: '' }, { file: '', set: '', where: 'phone' }).hint;

// ---------------------------------------------------------------------------
// Times and counts
// ---------------------------------------------------------------------------

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "11:58". */
export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "12 Nov". */
export function day(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "today 10:42", "yesterday 18:05", "12 Nov". */
export function when(at: number, now: number): string {
  const today = startOfDay(now);
  if (at >= today) return `today ${clock(at)}`;
  if (at >= today - DAY_MS) return `yesterday ${clock(at)}`;
  return day(at);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** 272 -> "4:32". */
export function minutesSeconds(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "Maya Rao · Pixel 8" -> "Maya Rao": member labels are the person, then the device. */
export function personName(label: string): string {
  return label.split(' · ')[0]!.trim();
}

/** "Ben" from "Ben Okafor · Pixel 9". */
export function firstName(label: string): string {
  return personName(label).split(' ')[0]!;
}

/** "a", "b and c", "a, b and c". */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export type EnvSectionState = 'loading' | 'locked' | 'empty' | 'list';

/** Which body the ".env sets" section draws. */
export function envSectionState(snapshot: Pick<EnvSnapshot, 'status' | 'sets' | 'ownRequests'>): EnvSectionState {
  if (snapshot.status === 'loading') return 'loading';
  if (snapshot.status === 'locked') return 'locked';
  return snapshot.sets.length === 0 && snapshot.ownRequests.length === 0 ? 'empty' : 'list';
}

const ROLE_ORDER: Record<EnvSetView['role'], number> = { owner: 0, member: 0, outside: 1, removed: 2 };

/** Sets you're in first (in the engine's order), then ones you could join, then ones you were removed from. */
export function orderSets(sets: EnvSetView[]): EnvSetView[] {
  return sets
    .map((set, index) => ({ set, index }))
    .sort((a, b) => ROLE_ORDER[a.set.role] - ROLE_ORDER[b.set.role] || a.index - b.index)
    .map(({ set }) => set);
}

export const ROLE_TAG: Record<EnvSetView['role'], string> = { owner: 'owner', member: 'member', outside: 'not in it', removed: 'removed' };

export type LineTone = 'ok' | 'warning' | 'danger' | 'dim';

export interface SetRowView {
  title: string;
  tag: string;
  /** "12 variables · 4 members". */
  detail: string;
  /** The line under it, coloured by `tone`. */
  status: string;
  tone: LineTone;
}

/** "12 variables · 4 members", "4 variables · only you". */
export function setCounts(set: Pick<EnvSetView, 'variableCount' | 'memberCount' | 'role'>): string {
  const members = set.memberCount === 1 && set.role === 'owner' ? 'only you' : plural(set.memberCount, 'member');
  return `${plural(set.variableCount, 'variable')} · ${members}`;
}

/**
 * A row in the set list. The third line is the one thing worth knowing most: a problem, an open
 * grant, the removal, who owns it, or when it was last released.
 */
export function setRow(set: EnvSetView, now: number): SetRowView {
  const base = { title: set.name, tag: ROLE_TAG[set.role], detail: setCounts(set) };
  const problem = set.problems[0];
  if (problem) return { ...base, status: problem.title, tone: problem.severity === 'error' ? 'danger' : 'warning' };
  if (set.role === 'removed') return { ...base, detail: plural(set.variableCount, 'variable'), status: 'You were removed. Read-only here.', tone: 'danger' };
  if (set.role === 'outside' && set.refusedNote) return { ...base, status: REFUSED_TITLE, tone: 'danger' };
  if (set.role === 'outside') return { ...base, status: `On ${set.computerName}. Ask to join to use it.`, tone: 'dim' };
  if (set.grant && set.grant.endsAt > now) return { ...base, status: `Allowed on ${set.grant.computerName} until ${clock(set.grant.endsAt)}`, tone: 'ok' };
  if (!set.computerOnline) return { ...base, status: `${set.computerName} is offline`, tone: 'warning' };
  if (set.role === 'member' && set.ownerLabel) return { ...base, status: `${personName(set.ownerLabel)} owns it`, tone: 'dim' };
  if (set.lastReleasedAt !== null) return { ...base, status: `Last released ${when(set.lastReleasedAt, now)}`, tone: 'dim' };
  return { ...base, status: `Not released yet · on ${set.computerName}`, tone: 'dim' };
}

/** The heading over a refused set's sentence: this device checked the file and wouldn't take it. */
export const REFUSED_TITLE = "This phone didn't take it";

/**
 * The status under a join request this phone made: the refusal when the phone wouldn't take the
 * set, otherwise the wait for its owner once their words were confirmed; null while confirming.
 */
export function ownRequestStatus(request: Pick<EnvOwnRequestView, 'setId' | 'ownerLabel' | 'ownerConfirmed'>, sets: Pick<EnvSetView, 'id' | 'refusedNote'>[]): { text: string; refused: boolean } | null {
  const refusedNote = sets.find((s) => s.id === request.setId)?.refusedNote ?? null;
  if (refusedNote) return { text: refusedNote, refused: true };
  return request.ownerConfirmed ? { text: ownerWords(request.ownerLabel).waiting, refused: false } : null;
}

/** "Chen Wei asks to join" and the line under it, for the banner at the top of the section. */
export function joinBanner(request: EnvJoinRequestView): { title: string; text: string } {
  const who = personName(request.label);
  if (request.via === 'own-device') {
    return { title: `${request.label} asks to join`, text: `${request.setName}, from your other device. Compare the 6-digit code on both screens before you approve.` };
  }
  const from = request.commit ? `, from commit ${request.commit}` : '';
  return { title: `${who} asks to join`, text: `${request.setName}${from}. Compare key words before you approve.` };
}

// ---------------------------------------------------------------------------
// A set
// ---------------------------------------------------------------------------

export interface SetAbilities {
  /** Add, edit and delete variables. */
  editVariables: boolean;
  /** Reveal values (also for a removed set: what it saw stays readable until deleted). */
  reveal: boolean;
  /** Add and remove members. */
  manageMembers: boolean;
  askToJoin: boolean;
  becomeOwner: boolean;
  deleteCopy: boolean;
}

/** What this device may do with a set, by its role. */
export function setAbilities(role: EnvSetView['role']): SetAbilities {
  return {
    editVariables: role === 'owner' || role === 'member',
    reveal: role !== 'outside',
    manageMembers: role === 'owner',
    askToJoin: role === 'outside',
    becomeOwner: role === 'outside' || role === 'member',
    deleteCopy: role === 'removed',
  };
}

/** The sheet's subtitle: "acme/api · .authdeck/acme-api.env", "tidepool/web · read-only on this phone". */
export function setSubtitle(set: EnvSetView): string {
  const where = set.repo ?? set.computerName;
  if (set.role === 'removed') return `${where} · read-only on this phone`;
  if (set.role === 'outside') return `${where} · this phone isn't in it`;
  return `${where} · ${set.file}`;
}

/** "Variables · 12", or for a removed set "Variables, as of 14 Nov". */
export function variablesHeading(set: EnvSetView, count: number): string {
  if (set.role === 'removed' && set.syncedAt !== null) return `Variables, as of ${day(set.syncedAt)}`;
  return `Variables · ${count}`;
}

/** "v4 · Maya · 12 Nov"; while revealed, "Hides in 0:24 · v5 · Maya · today 11:20". */
export function variableMeta(variable: EnvVariableView, now: number, hidesInSeconds: number | null = null): string {
  const meta = `v${variable.version} · ${variable.by} · ${when(variable.time, now)}`;
  return hidesInSeconds === null ? meta : `Hides in ${minutesSeconds(hidesInSeconds)} · ${meta}`;
}

/** A member row's line: "This phone", "Joined 12 Nov". */
export function memberDetail(member: EnvMemberView): string {
  return member.thisDevice ? 'This phone' : `Joined ${day(member.since)}`;
}

/** The grant banner: "Allowed on MacBook Pro until 11:58" and "Used by npm run dev and npm test." */
export function grantWords(grant: NonNullable<EnvSetView['grant']>): { title: string; text: string } {
  const used = grant.usedBy.length > 0 ? `Used by ${listWords(grant.usedBy)}.` : 'Not used yet.';
  return { title: `Allowed on ${grant.computerName} until ${clock(grant.endsAt)}`, text: used };
}

/** Problems most serious first, as the contract orders them; errors before warnings if not. */
export function orderProblems(problems: EnvProblemView[]): EnvProblemView[] {
  return [...problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** Who reads a variable, for the edit sheet: "All 4 members of acme-api", "Only this phone". */
export function readByWords(detail: EnvSetDetail): string {
  const count = detail.members.length || detail.set.memberCount;
  if (count <= 1) return 'Only this phone';
  return `All ${count} members of ${detail.set.name}`;
}

/** The version a save writes: one past the current, or 1 for a new name. */
export function nextVersion(variables: EnvVariableView[], name: string): number {
  return (variables.find((v) => v.name === name)?.version ?? 0) + 1;
}

/** A rotate notice: what happened, the values to change at their providers, and what to do after. */
export interface RotateWords {
  title: string;
  text: string;
  rotate: string[];
  after: string | null;
}

const SET_AGAIN = 'After rotating, edit each one here so members get the new value.';

/** After a removal: what to rotate. */
export function removedRotate(label: string, rotate: string[]): RotateWords {
  const text =
    rotate.length === 0
      ? `${personName(label)}'s device couldn't read any values, so there is nothing to rotate.`
      : `${label} could read ${plural(rotate.length, 'value', 'values')} before it was removed. The set has a new key, but those values were already seen: change each one at its provider, then set it again here.`;
  return { title: `Removed ${personName(label)}`, text, rotate, after: SET_AGAIN };
}

/** After taking a set over with the owner's phrase: who to ask back, and what to rotate. */
export const OLD_OWNER_VALUES =
  "Values the old owner device wrote are kept. If that device may be in someone else's hands, check them and rotate any you're unsure of.";

export function takeOverRotate(setName: string, removed: string[], rotate: string[]): RotateWords {
  const out =
    removed.length === 0
      ? `No other devices were in ${setName}.`
      : `These devices were taken out and need to ask to join again: ${listWords(removed)}.`;
  const values = rotate.length === 0 ? '' : ' The old owner\'s phone could read the values below: change each one at its provider, then set it again here.';
  return { title: "You're the owner now", text: `${out}${values} ${OLD_OWNER_VALUES}`, rotate, after: SET_AGAIN };
}

/** After the owner's review of old-key values: what happened to them, and what to rotate. */
export function oldKeyRotate(keep: boolean, names: string[], rotate: string[]): RotateWords {
  const verb = names.length === 1 ? 'is' : 'are';
  const done = keep ? `${listWords(names)} ${verb} under the current key now.` : `${listWords(names)} ${verb} removed from the set.`;
  if (rotate.length === 0) return { title: keep ? 'Old-key values kept' : 'Old-key values removed', text: `${done} Nothing needs rotating.`, rotate, after: null };
  const why = keep
    ? 'A removed device could read them under the old key: change each one at its provider, then set it again here.'
    : "A removed device can still read them in the repo's git history: if a secret is still used anywhere, rotate it at its provider.";
  return { title: keep ? 'Old-key values kept' : 'Old-key values removed', text: `${done} ${why}`, rotate, after: keep ? SET_AGAIN : null };
}

/** What "Paste lines from a .env" would do: how many are new and how many replace a value. */
export function pasteSummary(parsed: { name: string }[], existing: EnvVariableView[]): string {
  const names = new Set(existing.map((v) => v.name));
  const replacing = parsed.filter((p) => names.has(p.name)).length;
  const adding = parsed.length - replacing;
  if (parsed.length === 0) return 'No variables found yet. Paste NAME=value lines.';
  const parts = [adding > 0 ? `${adding} new` : null, replacing > 0 ? `${replacing} replace${replacing === 1 ? 's' : ''} a value` : null].filter(Boolean);
  return `${plural(parsed.length, 'variable')}: ${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Requests from a computer
// ---------------------------------------------------------------------------

export interface RequestFact {
  label: string;
  value: string;
}

export interface RequestButton {
  answer: EnvRequestAnswer;
  label: string;
  /** The main, accent button. */
  primary: boolean;
}

export interface RequestSheetModel {
  title: string;
  /** Shown under the title before "Ends in". */
  from: string | null;
  facts: RequestFact[];
  /** A warning above the answers: .env not ignored, or the file failed this device's check. */
  warning: { title: string; text: string; tone: 'warn' | 'danger' } | null;
  /** Plain notes above the answers. */
  notes: string[];
  /** Under the answers. */
  footnote: string | null;
  /** In the order they're laid out; the primary one is drawn on its own row for run and pull. */
  buttons: RequestButton[];
}

const DENY: RequestButton = { answer: 'deny', label: 'Deny', primary: false };
const ALLOW_GRANT: RequestButton = { answer: 'grant', label: `Allow for ${GRANT_MINUTES} minutes`, primary: true };
const ALLOW_ONCE: RequestButton = { answer: 'once', label: 'Allow once', primary: false };

const APPROVE_LABEL: Record<'push' | 'create' | 'join-keys', string> = { push: 'Sign change', create: 'Create set', 'join-keys': 'Make keys' };

/** The answers a request offers: release kinds three, the others two, and only Deny when the file failed. */
export function requestButtons(request: Pick<EnvRequestView, 'kind' | 'problem'>): RequestButton[] {
  if (request.problem) return [DENY];
  if (request.kind === 'run' || request.kind === 'pull') return [ALLOW_GRANT, ALLOW_ONCE, DENY];
  return [DENY, { answer: 'approve', label: APPROVE_LABEL[request.kind], primary: true }];
}

/** "MacBook Pro wants acme-api's .env". */
export function requestTitle(request: Pick<EnvRequestView, 'kind' | 'computerName' | 'setName'>): string {
  const { computerName: computer, setName: set } = request;
  switch (request.kind) {
    case 'run':
      return `${computer} wants ${set}'s .env`;
    case 'pull':
      return `${computer} wants to write ${set}'s .env`;
    case 'push':
      return `${computer} wants to change ${set}`;
    case 'create':
      return `${computer} wants to create ${set}`;
    case 'join-keys':
      return `${computer} wants this phone to join ${set}`;
  }
}

/** "Ends in 0:52 if you don't answer". */
export function requestEnds(secondsLeft: number): string {
  return `Ends in ${minutesSeconds(secondsLeft)} if you don't answer`;
}

function fileName(path: string): string {
  return path.split('/').pop() || path;
}

/** Everything the request sheet says, for a request the vault is open for. */
export function requestSheet(request: EnvRequestView): RequestSheetModel {
  const computer = request.computerName;
  const count = plural(request.variableCount, 'variable');
  const file = request.file ?? `the ${request.setName} file`;
  const model: RequestSheetModel = { title: requestTitle(request), from: null, facts: [], warning: null, notes: [], footnote: null, buttons: requestButtons(request) };
  switch (request.kind) {
    case 'run':
      model.facts = [
        { label: 'Command', value: request.command },
        { label: 'Folder', value: request.folder },
        ...(request.startedIn ? [{ label: 'Started in', value: request.startedIn }] : []),
        { label: 'Gets', value: `${count}, into this process only` },
      ];
      model.notes.push(`${computer} reports the command. Allow only one you just started.`);
      model.footnote = grantFootnote(request);
      break;
    case 'pull':
      model.facts = [
        { label: 'File', value: request.target?.path ?? request.folder },
        { label: 'Command', value: request.command },
        { label: 'Gets', value: `${count}, saved to disk, readable only by your user` },
      ];
      if (request.target && !request.target.gitignored) {
        const name = fileName(request.target.path);
        model.warning = {
          title: `${name} isn't in .gitignore`,
          text: `A commit from this folder could publish the values. Add ${name} to .gitignore before you allow this.`,
          tone: 'warn',
        };
      }
      model.footnote = grantFootnote(request);
      break;
    case 'push':
      model.from = `From ${request.command}`;
      model.facts = [
        { label: 'Folder', value: request.folder },
        { label: 'Sends', value: count },
      ];
      model.notes.push(`This phone signs the change as yours. Teammates get it when ${computer} commits and pushes ${file}.`);
      model.footnote = `Changes are answered one at a time, so there is no ${GRANT_MINUTES}-minute option.`;
      break;
    case 'create':
      model.facts = [
        { label: 'Command', value: request.command },
        { label: 'Folder', value: request.folder },
        { label: 'Holds', value: request.variableCount === 0 ? 'No variables yet' : count },
      ];
      model.notes.push(`This phone becomes the owner of ${request.setName}: it signs who is in the set. ${computer} writes the encrypted file into the repo.`);
      break;
    case 'join-keys':
      model.facts = [
        { label: 'Command', value: request.command },
        { label: 'Folder', value: request.folder },
      ];
      model.notes.push(
        `This phone makes its keys for ${request.setName} and ${computer} writes a join request into the repo. Commit and push it; the set's owner adds you after comparing the six key words this phone then shows.`,
      );
      break;
  }
  if (request.olderOnComputer) {
    model.notes.unshift(`${computer}'s file is older than this phone's copy. The values come from this phone's copy.`);
  }
  if (request.problem) {
    const { title, text, hint } = request.problem;
    model.warning = { title, text: hint ? `${text} ${hint}` : text, tone: 'danger' };
    model.notes = [`Nothing in ${request.setName} is released until the file is fixed.`];
    model.footnote = null;
  }
  return model;
}

function grantFootnote(request: Pick<EnvRequestView, 'setName' | 'computerName'>): string {
  return `${GRANT_MINUTES} minutes covers ${request.setName} on ${request.computerName}. It ends early if the computer locks or sleeps, or AuthDeck Agent restarts.`;
}

/** The locked form of every request: who asks, and Unlock or Deny. */
export function lockedRequestText(unlockWords: string): { title: string; text: string } {
  return { title: 'Unlock to see the request', text: `The vault is locked. Unlock with ${unlockWords} to see the command and answer.` };
}

/** After an answer: what the sheet confirms, briefly, before it closes. */
export function answeredWords(request: Pick<EnvRequestView, 'kind' | 'computerName' | 'setName'>, answer: EnvRequestAnswer): string {
  const { computerName: computer, setName: set } = request;
  switch (answer) {
    case 'grant':
      return `Allowed ${set} on ${computer} for ${GRANT_MINUTES} minutes`;
    case 'once':
      return `Allowed ${set} on ${computer} once`;
    case 'deny':
      return `Denied ${computer}'s request`;
    case 'approve':
      return request.kind === 'push' ? `Signed the change to ${set}` : request.kind === 'create' ? `Created ${set}` : `Made this phone's keys for ${set}`;
  }
}

/**
 * A request that ended without an answer from here: why, from the engine's `ended` entry. With
 * none yet (the time ran out on this phone's clock first), it ran out.
 */
export function endedWords(
  ended: Pick<EnvEndedRequestView, 'reason' | 'by'> | null,
  request: Pick<EnvRequestView, 'computerName'>,
): { title: string; text: string } {
  const computer = request.computerName;
  switch (ended?.reason ?? 'expired') {
    case 'answered':
      return {
        title: ended?.by ? `Answered on ${ended.by}` : 'Answered on another device',
        text: 'Nothing more to do here.',
      };
    case 'expired':
      return { title: 'Ran out', text: `Nobody answered in time, so ${computer} got nothing. Run the command again to ask again.` };
    case 'cancelled':
      return { title: 'Stopped on the computer', text: `The command on ${computer} stopped before anyone answered.` };
  }
}

const CHANGE_WORDS: Record<EnvChangeView['change'], { mark: string; words: string }> = {
  add: { mark: '+', words: 'Added' },
  change: { mark: '~', words: 'New value' },
  remove: { mark: '−', words: 'Removed' },
};

/** One line of a push's diff: "+ FEATURE_FLAGS_URL  Added". */
export function changeLine(change: EnvChangeView, source: string | null = null): { mark: string; name: string; words: string } {
  const { mark, words } = CHANGE_WORDS[change.change];
  return { mark, name: change.name, words: change.change === 'remove' && source ? `Removed, not in ${source}` : words };
}

/** ".env.local" from "authdeck env push .env.local --prune"; null when the command names no file. */
export function pushSource(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  const at = parts.indexOf('push');
  const next = at >= 0 ? parts[at + 1] : undefined;
  return next && !next.startsWith('-') ? next : null;
}

// ---------------------------------------------------------------------------
// Join requests
// ---------------------------------------------------------------------------

export interface JoinSheetModel {
  title: string;
  subtitle: string;
  /** What to compare before approving. */
  compare: string;
  /** What approving does. */
  effect: string;
  approveLabel: string;
  declineLabel: string;
}

/** The words of the sheet an owner approves a join on; `computerName` and `setFile` say where to commit, when known. */
export function joinSheet(request: EnvJoinRequestView, computerName: string | null, setFile: string | null): JoinSheetModel {
  const who = personName(request.label);
  const commitTo = setFile && computerName ? ` Commit ${setFile} on ${computerName} to send it.` : '';
  if (request.via === 'own-device') {
    return {
      title: `${request.label} asks to join`,
      subtitle: `${request.setName} · your other device`,
      compare: request.code
        ? `Check that ${request.label} shows this same code before you approve.`
        : `Answer to show a 6-digit code here and on ${request.label}. You approve only after comparing them.`,
      effect: `Approving adds it as a member of ${request.setName} and wraps the set's key for it.${commitTo}`,
      approveLabel: request.code ? 'Approve' : 'Answer',
      declineLabel: 'Decline',
    };
  }
  return {
    title: `${who} asks to join`,
    subtitle: request.commit ? `${request.setName} · from commit ${request.commit}` : request.setName,
    compare: `Ask ${who} to read the six words on their phone and pick each one as you hear it. Approve only if the name and all six words match.`,
    effect: `Approving signs a new member list and wraps the key for ${who}'s phone.${commitTo}`,
    approveLabel: 'Approve',
    declineLabel: 'Decline',
  };
}

// ---------------------------------------------------------------------------
// Your name: asked once, inside the first create, join or approval
// ---------------------------------------------------------------------------

export const PERSON_NAME_MAX = 40;
export const PERSON_NAME_HINT = 'Shown to people you share sets with.';

/** 1 to 40 characters once trimmed, as setPersonName takes. */
export function personNameReady(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= PERSON_NAME_MAX;
}

// ---------------------------------------------------------------------------
// Comparing a teammate's words: the owner picks one of them, so a glance isn't enough
// ---------------------------------------------------------------------------

/** The word the owner picks: the 4th. */
/** The check asks for every one of the six words, in order: one word alone is too few bits. */
export const WORD_COUNT = 6;
export const WORD_MISMATCH = "That word doesn't match. Don't approve unless every word matches.";
/** After the first wrong pick: one more go, from word 1. */
export const LAST_TRY = 'One more try: a second wrong word ends the request.';
/** Owner side, after the second wrong pick. */
export const WORDS_DECLINED = "The words didn't match, so this request was declined.";

/**
 * The real word at `index` and two others from `pool` that aren't among `words`, shuffled.
 * `pick(n)` returns a whole number below n (secure random in the app, seeded in tests).
 */
export function wordChoices(words: string[], index: number, pool: readonly string[], pick: (n: number) => number): string[] {
  const real = words[index];
  if (real === undefined) throw new Error(`There is no word ${index + 1}.`);
  const choices = [real];
  while (choices.length < 3) {
    const word = pool[pick(pool.length)]!;
    if (!choices.includes(word) && !words.includes(word)) choices.push(word);
  }
  for (let i = choices.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [choices[i], choices[j]] = [choices[j]!, choices[i]!];
  }
  return choices;
}

/** "Word 1 of 6: which word did Chen Wei say?" */
export function wordStepQuestion(step: number, label: string): string {
  return `Word ${step + 1} of ${WORD_COUNT}: which word did ${personName(label)} say?`;
}

/** The teammate's side of the check: the owner reads their six words out. */
export function ownerWords(ownerLabel: string): { label: string; check: string; ask: string; wrongWord: string; mismatch: string; waiting: string } {
  const owner = personName(ownerLabel);
  return {
    label: `${owner}'s words`,
    check: `Check ${firstName(ownerLabel)}'s words`,
    ask: `Ask ${owner} to read their six words out, then pick each one as you hear it.`,
    wrongWord: "That word doesn't match. Don't go on unless every word matches.",
    mismatch: `Don't continue. Someone may be pretending to be ${owner}.`,
    waiting: `Waiting for ${owner} to add you.`,
  };
}

// ---------------------------------------------------------------------------
// Names that change how programs start (NODE_OPTIONS, LD_PRELOAD, …)
// ---------------------------------------------------------------------------

/** A push: the phone signs exactly the changes it shows, and stops if the set moved on first. */
export const PUSH_SIGNS_SHOWN =
  'These are exactly the changes this phone signs. If the set changes on the computer first, the phone stops and shows you the new changes.';
export const PUSH_PENDING =
  'This phone works out the changes name by name and shows them here. It signs exactly those changes; if the set changes on the computer first, it stops and shows you the new ones.';

export const LOADS_CODE_LINE = 'Changes how programs start on every computer that runs this set.';

// ---------------------------------------------------------------------------
// Values under an old key: the owner reviews them
// ---------------------------------------------------------------------------

export function oldKeyText(names: string[]): string {
  return `These values were saved under the old key: ${listWords(names)}.`;
}

export function waitingForOwner(set: Pick<EnvSetView, 'ownerLabel'>): string {
  return `Waiting for ${set.ownerLabel ? personName(set.ownerLabel) : 'the owner'} to fix the set.`;
}
