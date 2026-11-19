/**
 * Env sets' contract: what the env engine (src/auth/env, slice D) gives the screens
 * (src/screens/env, slice E). Screens import types from here and the hook from ./useEnv; they
 * never touch src/envcore, src/vault or the agent connection. Design: docs/env.md.
 *
 * Where each surface lives:
 *   screens/env/EnvSetsSection.tsx    the ".env sets" section of VaultScreen (under Accounts on
 *                                     phones, top of the middle column on tablets); opens the
 *                                     set, variable, member and own-device join sheets itself
 *   screens/env/EnvRequestSheet.tsx   export function EnvRequestSheet(props: { request: EnvRequestView; onClose(): void })
 *   screens/env/EnvJoinApproveSheet.tsx export function EnvJoinApproveSheet(props: { request: EnvJoinRequestView; onClose(): void })
 * AuthHost mounts the last two above every screen, from `incoming` and `joinRequests`, whether the
 * vault is open or locked. Until the engine lands, screens build against screens/env/mock.ts.
 */
import type { EnvRole } from '../envcore/types';
import type { EnvRequestKind } from '../protocol';

/** A revealed value hides itself after this long. */
export const ENV_REVEAL_MS = 30 * 1000;

/** Env keys open with the vault and lock with it (app lock). Requests still arrive while locked (EnvRequestView.needsUnlock). */
export type EnvStatus = 'loading' | 'locked' | 'open';

/** An open "Allow for 15 minutes" on a computer. */
export interface EnvGrantView {
  grantId: string;
  computerName: string;
  endsAt: number;
  /** The paired device that allowed it. */
  by: string;
  /** "npm run dev", "npm test": the commands that used it, newest first. */
  usedBy: string[];
}

/**
 * Something wrong or worth knowing about a set, most serious first. Words come from envcore's
 * envFileProblemWords for file problems; the engine writes the others.
 * file: the computer's file failed this device's check (nothing is released until it's fixed);
 * older-copy: the computer's file is older than this device's copy (releases use this device's);
 * offline: the computer can't be reached (variables show as of `syncedAt`, changes wait here);
 * epoch: values are under an old key. The owner reviews them (fixOldKeyLines): nothing is
 * encrypted again without that review.
 */
export interface EnvProblemView {
  id: string;
  kind: 'file' | 'older-copy' | 'offline' | 'epoch';
  severity: 'error' | 'warning';
  title: string;
  text: string;
  hint?: string;
  /** epoch: the names under the old key, for the owner's review; null otherwise. */
  names?: string[] | null;
}

/** A set in the Vault's ".env sets" list. */
export interface EnvSetView {
  id: string;
  name: string;
  /** "acme/api", from the git remote; null for a repo without one. */
  repo: string | null;
  /** ".authdeck/acme-api.env" */
  file: string;
  computerName: string;
  computerOnline: boolean;
  /**
   * 'removed': this device was taken out; what it saw stays readable here until deleteRemovedSet.
   * 'outside': on a paired computer, but this device isn't in it: it can ask to join
   * (requestJoin) or, with the owner's recovery phrase, take it over (becomeOwner).
   */
  role: EnvRole | 'removed' | 'outside';
  /** The owner device's label, "Maya Rao · Pixel 8", from the set's header; null when this device can't read it. */
  ownerLabel: string | null;
  variableCount: number;
  memberCount: number;
  grant: EnvGrantView | null;
  lastReleasedAt: number | null;
  /** When this device last read the set from the computer. */
  syncedAt: number | null;
  /** Owner only: join requests waiting. */
  joinRequestCount: number;
  problems: EnvProblemView[];
  /** Set when role is 'removed': "Ben Okafor's Pixel 9 removed this phone in commit 3d2f8aa". */
  removedNote: string | null;
  /**
   * Set when role is 'outside' because this device refused to take the set (history floor, two
   * sets under one id, history too long, owner not a device of this vault): the refusal sentence.
   * Cleared once the file is taken or no longer refused.
   */
  refusedNote: string | null;
}

export interface EnvVariableView {
  name: string;
  version: number;
  /** The signer's person name, short: "Maya". */
  by: string;
  byMemberId: string;
  time: number;
  /** The name changes how programs start (NODE_OPTIONS, LD_PRELOAD, …): flagged on the phone; `run` skips it unless allowed. */
  loadsCode: boolean;
}

export interface EnvMemberView {
  id: string;
  /** "Maya Rao · Pixel 8" */
  label: string;
  form: 'phone' | 'tablet' | null;
  role: EnvRole;
  thisDevice: boolean;
  /** When the owner added it. */
  since: number;
}

/** One commit in a set's history, checked against its signatures on this device. */
export interface EnvHistoryItemView {
  commit: string;
  time: number;
  /** "Changed STRIPE_WEBHOOK_SECRET", "Added Priya Nair", "Removed Lucía Ortiz and made a new key". */
  text: string;
  /** The signer's label: "Maya Rao · Pixel 8"; the git author when nothing in the commit is signed. */
  by: string;
  /** False when a line in the commit isn't signed by a member. */
  signed: boolean;
}

/** A set opened on this device. Values stay out: reveal() reads one at a time. */
export interface EnvSetDetail {
  set: EnvSetView;
  variables: EnvVariableView[];
  members: EnvMemberView[];
}

/** What a push changes, by name, worked out on this device. */
export interface EnvChangeView {
  name: string;
  change: 'add' | 'change' | 'remove';
  /** As EnvVariableView.loadsCode: the sheet flags it. */
  loadsCode: boolean;
}

/**
 * A request from a computer, for EnvRequestSheet. run and pull offer Allow for 15 minutes (the
 * default), Allow once and Deny; push, create and join-keys offer Approve and Deny.
 */
export interface EnvRequestView {
  id: string;
  kind: EnvRequestKind;
  computerName: string;
  setId: string | null;
  setName: string;
  askedAt: number;
  expiresAt: number;
  /** The vault is locked: the sheet shows only who asks and Unlock or Deny until it opens. */
  needsUnlock: boolean;
  /** run: "npm run dev"; others: the authdeck command as typed. */
  command: string;
  folder: string;
  /** "Terminal · zsh", as the computer reports it; null when it didn't say. */
  startedIn: string | null;
  /** pull: the file written, and whether git ignores it (a warning when not). */
  target: { path: string; gitignored: boolean } | null;
  /** How many variables a release gives, or a new set holds. */
  variableCount: number;
  /** push only. */
  changes: EnvChangeView[] | null;
  /** The computer's file is older than this device's copy; the values come from this device's. */
  olderOnComputer: boolean;
  /** The file failed this device's check: only Deny is offered, and this says why. */
  problem: EnvProblemView | null;
  /** The set file, ".authdeck/acme-api.env"; null for a create before the file exists. */
  file: string | null;
}

export type EnvRequestAnswer = 'grant' | 'once' | 'approve' | 'deny';

/** What answer() settled. push: the names it changed, for the diff shown after signing. */
export interface EnvAnswerResult {
  changes: EnvChangeView[] | null;
}

/**
 * A request that left `incoming` without this device answering it, kept until dismissEnded (or
 * about a minute) so an open sheet can say why: another device answered (`by` names it), it ran
 * out, or the command stopped on the computer.
 */
export interface EnvEndedRequestView {
  id: string;
  reason: 'answered' | 'expired' | 'cancelled';
  by: string | null;
  endedAt: number;
}

/** Someone asking to join a set this device owns. */
export interface EnvJoinRequestView {
  id: string;
  /** teammate: a request file in the repo, compared by key words; own-device: the check code, live. */
  via: 'teammate' | 'own-device';
  setId: string;
  setName: string;
  /** "Chen Wei · iPhone 16" */
  label: string;
  form: 'phone' | 'tablet' | null;
  /** teammate: the six words their phone shows. */
  keyWords: string[] | null;
  /** teammate: the commit that brought the request in, short. */
  commit: string | null;
  /** own-device: six digits once both sides exchanged nonces; null before. */
  code: string | null;
  /** own-device only. */
  expiresAt: number | null;
  /** teammate: this (owner) device's six words, for the owner to read out so the teammate checks them too. */
  ownerKeyWords: string[] | null;
  /** The vault is locked: the sheet offers Unlock or Decline until it opens. */
  needsUnlock: boolean;
}

/** This device asking to join a set as one of the person's own devices (the new device's side). */
export interface EnvJoinState {
  setId: string;
  setName: string;
  /** The approving device's name, once it answered. */
  peerName: string | null;
  code: string | null;
  stage: 'waiting' | 'compare' | 'done' | 'failed' | 'expired';
  /** Plain sentence when failed. */
  error?: string;
  expiresAt: number | null;
}

/** A teammate's join request this device made (for `init` on their computer): the words to read out. */
export interface EnvOwnRequestView {
  setId: string;
  setName: string;
  computerName: string;
  keyWords: string[];
  madeAt: number;
  /** The owner this request was made against, and its six words: the teammate checks them when the owner reads them out. */
  ownerLabel: string;
  ownerKeyWords: string[];
  /** The teammate confirmed the owner's words (confirmOwnerWords): only then is the set taken once the owner adds this device. */
  ownerConfirmed: boolean;
}

export interface EnvSnapshot {
  status: EnvStatus;
  /** Sets on every paired computer, and sets this device was removed from. */
  sets: EnvSetView[];
  /** Requests from computers waiting for this device, oldest first; also while locked. */
  incoming: EnvRequestView[];
  /** Requests that ended without this device's answer, newest first. */
  ended: EnvEndedRequestView[];
  /** Owner only: join requests waiting, oldest first. */
  joinRequests: EnvJoinRequestView[];
  /** This device's own join in progress, if any. */
  join: EnvJoinState | null;
  /** Join requests this device made for teammates' sets, still waiting for their owner. */
  ownRequests: EnvOwnRequestView[];
  /** A paired computer's AuthDeck Agent is too old for env sets: the section asks to update it. */
  agentTooOld: boolean;
  /**
   * The person's name, shown with the device name in member labels ("Maya Rao · Pixel 8"). Null
   * until set: the first create, join or approval asks for it once (setPersonName).
   */
  personName: string | null;
}

export interface EnvActions {
  /** The set with its variables and members, from this device's copy; null for an unknown set. */
  detail(setId: string): EnvSetDetail | null;
  /** Newest first, a page at a time; pass the last item's commit as `before` for more. */
  history(setId: string, before?: string): Promise<{ items: EnvHistoryItemView[]; more: boolean }>;
  /** One value in plain text, for a SecureSheet. Screens hide it after ENV_REVEAL_MS. */
  reveal(setId: string, name: string): Promise<string>;
  /** Plain-sentence problems with a name and value; empty when both are fine. */
  checkVariable(name: string, value: string): string[];
  /** Adds, changes or renames (previousName) a variable: signs a new line and has the agent write it. */
  saveVariable(setId: string, variable: { name: string; value: string; previousName?: string }): Promise<void>;
  /** "Paste lines from a .env": parses without saving. Never throws. */
  parseDotenv(text: string): { values: { name: string; value: string }[]; problems: string[] };
  addVariables(setId: string, values: { name: string; value: string }[]): Promise<void>;
  deleteVariable(setId: string, name: string): Promise<void>;

  /** Owner: the steps a teammate follows, as text to share. */
  teammateSteps(setId: string): string;
  /** Owner: adds the requester (wraps the key for it), removes the request file, in one change. */
  approveJoin(requestId: string): Promise<void>;
  /** Owner: removes the request file (teammate) or stops the join (own device). */
  declineJoin(requestId: string): Promise<void>;
  /** Owner, own-device join: answers the request; the code then shows on both. */
  acceptOwnDeviceJoin(requestId: string): Promise<void>;
  /** New device: asks to join one of the person's sets through the computer both are paired with. */
  requestJoin(setId: string): Promise<void>;
  /** Stops this device's join in progress, or clears a finished one (done, failed, expired). */
  cancelJoin(): void;
  /**
   * Teammate: withdraws this device's request to join a set (the owner's words didn't match, or
   * they changed their mind). Forgets it here, so the set is never taken from that request, and
   * removes the request file on the computer when it can be reached; resolves either way.
   */
  cancelOwnRequest(setId: string): Promise<void>;
  /**
   * Owner: removes a member with a new key, every value encrypted again, and returns the names
   * it could read, to rotate at their providers.
   */
  removeMember(setId: string, memberId: string): Promise<{ rotate: string[] }>;

  /**
   * Answers a request. With app lock on, every answer except 'deny' first asks for the device's
   * own unlock (Face ID, fingerprint or device PIN) inside this call, and rejects with a plain
   * sentence when that is cancelled; 'deny' never asks.
   */
  answer(requestId: string, answer: EnvRequestAnswer): Promise<EnvAnswerResult>;
  /** Clears an entry from `ended`. */
  dismissEnded(requestId: string): void;
  /** push: one new value from the computer, for "Show new values"; null when it isn't in the push. */
  pushedValue(requestId: string, name: string): string | null;
  endGrant(setId: string): Promise<void>;

  /**
   * For a set whose owner device is lost: the owner's recovery phrase makes this device the owner
   * (the set's recovery identity signs the new member list). Every other member is taken out, so
   * nothing written after it reaches a device the file listed; `removed` names them, to ask back.
   * The result also lists every value to rotate. Rejects with a plain sentence when
   * the words aren't that phrase.
   */
  becomeOwner(setId: string, phrase: string[]): Promise<{ removed: string[]; rotate: string[] }>;

  /**
   * Owner, after reviewing an 'epoch' problem: keep encrypts the old-key values again under the
   * current key; drop removes them. Returns the names to rotate: every old-key name, kept or
   * dropped, since a removed member can read them in git history (a dropped one only matters if
   * the secret is still in use somewhere). Asks for the app-lock confirm like removeMember.
   */
  fixOldKeyLines(setId: string, keep: boolean, reviewedNames: string[]): Promise<{ rotate: string[] }>;
  /**
   * Teammate: the owner read out their six words and they matched ownerKeyWords. Until this, a
   * set listing this device is not taken. `shownWords` are the ownerKeyWords the sheet showed; it
   * rejects when they are no longer the owner's (the pin changed since the sheet showed it).
   */
  confirmOwnerWords(setId: string, shownWords: string[]): Promise<void>;

  /** Only for a set this device was removed from: deletes its copy here. */
  deleteRemovedSet(setId: string): Promise<void>;

  /** Sets personName (trimmed, 1–40 characters); rejects with a plain sentence otherwise. */
  setPersonName(name: string): Promise<void>;
}

/*
 * Confirmation: like answer(), approveJoin, acceptOwnDeviceJoin, removeMember, fixOldKeyLines and becomeOwner ask
 * for the device's own unlock first when app lock is on, and reject with a plain sentence when it
 * is cancelled. Variable edits only need the vault open.
 */

export type EnvApi = EnvSnapshot & EnvActions;
