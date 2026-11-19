/**
 * The env engine on a phone or tablet: this device's copy of each env set, answering a computer's
 * requests, signing changes, members and history. Design: docs/env.md; what it gives the screens:
 * ../envContract.ts.
 *
 * The computer is untrusted. Every file it sends is checked with the env core against what this
 * device accepted before (verifyEnvFile + nextEnvTrust), and anything older is refused or answered
 * from this device's own copy. The device's env identity and the sets' data keys are held in
 * memory only while the vault is open; values are opened one at a time, to show one, to sign a
 * change or to seal a release, and never kept.
 */
import type {
  EnvActions,
  EnvAnswerResult,
  EnvChangeView,
  EnvEndedRequestView,
  EnvHistoryItemView,
  EnvJoinRequestView,
  EnvProblemView,
  EnvRequestAnswer,
  EnvRequestView,
  EnvSetDetail,
  EnvSetView,
  EnvSnapshot,
  EnvStatus,
} from '../envContract';
import {
  addEnvMember,
  changeEnvValues,
  checkEnvJoined,
  createEnvJoinRequest,
  createEnvSet,
  diffEnvFiles,
  envFileProblemWords,
  createEnvFloorBuilder,
  envAuthorityExtends,
  envCrossesAuthority,
  parseEnvFile,
  EnvFileRefused,
  checkEnvFloor,
  envJoinRequestPath,
  envKeyWords,
  envLoadsCode,
  envRecoveryKeys,
  findBadEnvWraps,
  mergeEnvFiles,
  nextEnvTrust,
  openEnvDataKey,
  openEnvValue,
  openEnvValues,
  planEnvPush,
  readEnvJoinRequest,
  removeEnvMember,
  setEnvRecovery,
  rekeyEnvSet,
  verifyEnvFileForRekey,
  sealEnvValues,
  takeOverEnvSet,
  verifyEnvFile,
  writeEnvFile,
  type EnvFileProblem,
  type EnvHeader,
  type EnvFloorBuilder,
  type EnvHistoryFloor,
  type EnvJoinRequestFile,
  type EnvMember,
  type EnvNewMember,
  type EnvTrust,
  type EnvSetFile,
  type EnvValueChanges,
  type EnvVerifiedSet,
} from '../../envcore';
import type {
  EnvAnswer,
  EnvCommit,
  EnvComputerRequest,
  EnvEventMessage,
  EnvGrant,
  EnvJoinKeysRequest,
  EnvJoinRequestEntry,
  EnvPushRequest,
  EnvReleaseRequest,
  EnvSetSummary,
} from '../../protocol';
import { RequestError } from '../../net/client';
import { fromBase64Url, utf8Encode } from '../../vault/bytes';
import { cleanJoinName, type JoinChallenge } from '../../vault/approval';
import type { DeviceKeys } from '../../vault/crypto';
import { checkVariable, parseDotenv } from './dotenv';
import type { EnvComputer, EnvHost, EnvLocation, EnvRecoveryPublic, EnvSetAside, StoredEnvSet, StoredOwnRequest } from './host';
import { OwnJoins } from './ownJoin';
import { badWrapsProblem as problemViewForBadWraps, memberViews, outsideSetView, problemView, setFilePath, setView, variableViews } from './views';
import {
  JOIN_REQUEST_GONE,
  OWNER_WORDS_CHANGED,
  KEPT_CHANGING,
  PLAN_CHANGED,
  REVIEW_CHANGED,
  NOT_A_MEMBER,
  NOT_UNLOCKED,
  ONLY_OWNER,
  REMOVED_READ_ONLY,
  REQUEST_ENDED,
  UNKNOWN_SET,
  WRONG_ANSWER,
  changeSentence,
  commandLine,
  historyTooLong,
  noRecovery,
  notOurOwner,
  notThePhrase,
  offlineSentence,
} from './words';

/** A change is read, built and written again this many times while the file keeps changing (`conflict`). */
export const MAX_WRITE_ATTEMPTS = 3;
/** What a phone reads of a set's history before it is first taken (64 MB); a longer history is refused. */
const HISTORY_BUDGET_BYTES = 64 * 1024 * 1024;
/** Characters of the person's name in member labels. */
export const MAX_PERSON_NAME = 40;
const ANSWER_TIMEOUT_MS = 15_000;
/** A request that ended without this device's answer stays in `ended` this long, so an open sheet can say why. */
export const ENDED_KEEP_MS = 60_000;
const FILE_TIMEOUT_MS = 30_000;

/** What the computer last showed of a set this device holds. */
interface RemoteState {
  fileHash: string;
  problem: { problem: EnvFileProblem; commit: string | null; names?: string[] } | null;
  /** The computer's file wasn't taken because its history couldn't be checked: why, as a sentence. */
  note?: string | null;
  older: boolean;
}

/** A teammate's request file in a set this device owns, checked. */
interface TeammateRequest {
  id: string;
  setId: string;
  path: string;
  request: EnvJoinRequestFile;
  member: EnvNewMember;
  keyWords: string[];
  commit: string | null;
}

interface Incoming {
  request: EnvComputerRequest;
  computerName: string;
  agentId: string;
  olderOnComputer: boolean;
  problem: EnvProblemView | null;
  /** push: what it changes, worked out once the vault is open. */
  changes: EnvChangeView[] | null;
}

/** How a file from the computer compared with this device's copy. */
/**
 * A file this device won't take: a problem with the file, or a sentence when its history couldn't
 * be checked at all (the agent couldn't serve it whole, or it is past the budget).
 */
type Refused = { kind: 'refused'; problem: EnvFileProblem; note?: undefined } | { kind: 'refused'; problem: null; note: string };

/** What the history says about a file: a problem with it, or why it couldn't be read. Null when it stands. */
type HistoryVerdict = { problem: EnvFileProblem; note?: undefined } | { problem: null; note: string };

type Accepted =
  | { kind: 'adopted' | 'same' | 'merged' }
  | { kind: 'older' }
  | Refused
  | { kind: 'outside' }
  | { kind: 'removed' };

const isOlderProblem = (problem: EnvFileProblem) => problem.kind === 'older-header' || problem.kind === 'older-value';
const isConflict = (err: unknown) => err instanceof RequestError && err.code === 'conflict';
const isGone = (err: unknown) => err instanceof RequestError && err.code === 'not_found';

/** The commit that brought a problem's line in, from env.file.read's blame. */
function commitOf(problem: EnvFileProblem, commits: readonly (string | null)[]): string | null {
  return 'line' in problem ? (commits[problem.line - 1] ?? null) : null;
}

function refusedError(refused: { problem: EnvFileProblem | null; note?: string }, setName: string): Error {
  return refused.problem ? refusal(refused.problem, setName) : new Error(refused.note);
}

/** The set name a file gives, for sentences about a file not yet taken; "the set" when it doesn't parse. */
function utf8Bytes(text: string): number {
  return utf8Encode(text).length;
}

function setNameOf(text: string): string {
  const parsed = parseEnvFile(text);
  return parsed.ok ? parsed.parsed.file.header.name : 'the set';
}

function refusal(problem: EnvFileProblem, setName: string): Error {
  const words = envFileProblemWords(problem, { file: setFilePath(setName), set: setName, where: 'phone' });
  return new Error(`${words.message} ${words.hint}`);
}

function wipe(keys: Record<number, Uint8Array>): void {
  for (const key of Object.values(keys)) key.fill(0);
}

export class EnvEngine implements EnvActions {
  private loaded = false;
  private memberId: string | null = null;
  private ownRequests: StoredOwnRequest[] = [];
  private personName: string | null = null;
  /**
   * The vault's recovery identity (public), read when the vault opens and when its phrase changes.
   * `undefined` until read; sets this device owns are brought to it (syncRecovery).
   */
  private vaultRecovery: EnvRecoveryPublic | null | undefined = undefined;
  private copies = new Map<string, StoredEnvSet>();
  /** Copies set aside at load (failed their anchor): what the anchor still vouches for. */
  private setAside = new Map<string, EnvSetAside>();
  /**
   * Sets this device declined to take from the computer (the join pin, history floor, two sets,
   * history too long), with the file it declined: the outside view says why. In memory only; a different file
   * clears it, as does taking the set.
   */
  private refusedTakes = new Map<string, { text: string; note: string }>();
  private verified = new Map<string, EnvVerifiedSet>();
  private identity: DeviceKeys | null = null;
  private dataKeys = new Map<string, Record<number, Uint8Array>>();
  /** Headers whose wraps all rebuilt from the key this device opened (`setId:headerHash`). */
  private wrapsChecked = new Set<string>();
  /** Sets whose header gives someone a wrap that doesn't rebuild: refused until the owner fixes it. */
  private badWraps = new Map<string, string[]>();
  private opening: Promise<void> | null = null;
  private computer: EnvComputer | null = null;
  private outside = new Map<string, { summary: EnvSetSummary; location: EnvLocation }>();
  private remote = new Map<string, RemoteState>();
  private teammates = new Map<string, TeammateRequest[]>();
  private incoming = new Map<string, Incoming>();
  private grants: EnvGrant[] = [];
  private ended: EnvEndedRequestView[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private serialTail: Promise<unknown> = Promise.resolve();
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  readonly joins: OwnJoins;

  constructor(
    private readonly host: EnvHost,
    /** What is read of a set's history before it is first taken (UTF-8 bytes); tests pass a small one. */
    private readonly historyBudgetBytes = HISTORY_BUDGET_BYTES,
  ) {
    this.joins = new OwnJoins({
      random: host.random,
      now: () => host.now(),
      link: host.link,
      identity: () => this.requireIdentity(),
      deviceLabel: () => this.memberLabel(),
      ownedSetName: (setId) => (this.roleIn(setId) === 'owner' ? (this.copies.get(setId)?.name ?? null) : null),
      addMember: (setId, member) => this.exclusive(() => this.addMember(setId, member)).then(() => undefined),
      adoptJoined: (setId, device, challenge) => this.exclusive(() => this.adoptJoined(setId, device, challenge)),
      changed: () => this.changed(),
    });
  }

  // --- Lifecycle ----------------------------------------------------------------------------

  /** Reads the stored copies. Call once before anything else. */
  async load(): Promise<void> {
    const prefs = await this.host.store.loadPrefs();
    this.memberId = prefs.memberId;
    this.ownRequests = prefs.ownRequests;
    this.personName = prefs.personName;
    const { sets, damaged } = await this.host.store.loadSets();
    // Counts only: ids of damaged copies aren't logged. They are dropped, and read again from the computer.
    if (damaged.length > 0) console.warn(`Env sets: ${damaged.length} stored copy(ies) failed their check and were set aside.`);
    for (const set of sets) this.copies.set(set.setId, set);
    for (const { floor } of damaged) if (floor) this.setAside.set(floor.setId, floor);
    this.loaded = true;
    this.changed();
  }

  /** Follows the vault's lock: env keys open with it and are dropped when it locks. */
  async vaultChanged(): Promise<void> {
    if (this.host.vault.status() === 'open') {
      this.opening ??= this.openKeys().finally(() => {
        this.opening = null;
      });
      await this.opening;
    } else {
      this.lockKeys();
    }
    this.changed();
  }

  /** The active computer changed, came online or went away. Env messages go only to an agent listing env sets. */
  async computerChanged(computer: EnvComputer | null): Promise<void> {
    const previous = this.computer;
    this.computer = computer;
    if (previous?.agentId !== computer?.agentId || !computer?.hasEnv) this.forgetComputer();
    this.changed();
    if (computer?.hasEnv) await this.sync();
  }

  /** Every env event from the computer, already shape-checked (net/messages.ts). */
  handleEvent(message: EnvEventMessage): void {
    if (!this.computer?.hasEnv) return;
    switch (message.event) {
      case 'env.request':
        this.addIncoming((message as EnvEventMessage<'env.request'>).data.request);
        return;
      case 'env.request.closed': {
        const { requestId, reason, by } = (message as EnvEventMessage<'env.request.closed'>).data;
        if (this.incoming.has(requestId)) this.endIncoming(requestId, reason, by ?? null);
        return;
      }
      case 'env.grants.changed':
        this.grants = (message as EnvEventMessage<'env.grants.changed'>).data.grants;
        this.changed();
        return;
      case 'env.sets.changed':
        void this.sync().catch((err) => console.warn('Env sets: reading the computer failed:', (err as Error).message));
        return;
      default:
        this.joins.handleEvent(message.event, message.data as never);
    }
  }

  /** Calls `listener` whenever the snapshot may have changed; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.lockKeys();
    this.listeners.clear();
  }

  private changed(): void {
    this.listeners.forEach((listener) => listener());
  }

  /** Changes to copies run one at a time, so two never build on the same base. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serialTail.then(work, work);
    this.serialTail = run.catch(() => undefined);
    return run;
  }

  // --- Keys ---------------------------------------------------------------------------------

  /**
   * The env identity is the vault's device keys, copied once into env storage: the vault may
   * renew its keys (a join, a restore), while a set's member list keeps naming the keys it added.
   */
  private async openKeys(): Promise<void> {
    if (this.identity) return;
    let identity = await this.host.store.loadIdentity();
    if (!identity) {
      identity = await this.host.vault.deviceKeys();
      await this.host.store.saveIdentity(identity);
    }
    const keys = new Map<string, Record<number, Uint8Array>>();
    for (const setId of this.copies.keys()) keys.set(setId, await this.host.store.loadDataKeys(setId));
    if (this.host.vault.status() !== 'open') return;
    this.identity = identity;
    this.dataKeys = keys;
    this.vaultRecovery = await this.host.vault.recovery();
    if (this.memberId !== identity.deviceId) {
      this.memberId = identity.deviceId;
      await this.savePrefs();
      // The agent routes requests by member id: tell it the one this device now holds.
      if (this.computer?.hasEnv) void this.sync().catch(() => undefined);
    }
    this.refreshIncoming();
  }

  private lockKeys(): void {
    this.dataKeys.forEach(wipe);
    this.dataKeys.clear();
    this.identity = null;
    this.joins.dispose();
    for (const item of this.incoming.values()) item.changes = null;
  }

  private requireIdentity(): DeviceKeys {
    if (!this.identity) throw new Error(NOT_UNLOCKED);
    return this.identity;
  }

  /** The data key of `epoch` for a set this device holds a copy of. */
  private async dataKey(setId: string, epoch: number): Promise<Uint8Array> {
    const verified = this.verifiedCopy(setId);
    const header = verified.file.header;
    const held = this.dataKeys.get(setId)?.[epoch];
    if (held && header.epoch !== epoch) return held;
    if (header.epoch !== epoch) throw new Error(`This device doesn't hold key ${epoch} of that set.`);
    const key = held ?? openEnvDataKey(header, this.requireIdentity());
    this.checkWraps(setId, verified, key);
    if (!held) await this.keepDataKey(setId, epoch, key);
    return key;
  }

  /**
   * verifyEnvFile can't check wraps (that needs the key): every member's and the recovery
   * identity's wrap must rebuild from the key this device opened, once per header. Otherwise the
   * owner could give one member a different key; such a set is refused and releases nothing.
   */
  private checkWraps(setId: string, verified: EnvVerifiedSet, key: Uint8Array): void {
    const checked = `${setId}:${verified.headerHash}`;
    if (this.wrapsChecked.has(checked)) return;
    const bad = findBadEnvWraps(verified.file.header, key);
    if (bad.length > 0) {
      this.badWraps.set(setId, bad);
      this.changed();
      throw new Error(badWrapsSentence(verified.file.header.name));
    }
    this.badWraps.delete(setId);
    this.wrapsChecked.add(checked);
  }

  private async keepDataKey(setId: string, epoch: number, key: Uint8Array): Promise<void> {
    const keys = { ...(this.dataKeys.get(setId) ?? {}), [epoch]: key };
    this.dataKeys.set(setId, keys);
    await this.host.store.saveDataKeys(setId, keys);
  }

  private async ownerKeys(setId: string, file: EnvSetFile): Promise<Record<number, Uint8Array>> {
    await this.dataKey(setId, file.header.epoch);
    return { ...this.dataKeys.get(setId)! };
  }

  // --- Copies -------------------------------------------------------------------------------

  private copy(setId: string): StoredEnvSet {
    const copy = this.copies.get(setId);
    if (!copy) throw new Error(UNKNOWN_SET);
    return copy;
  }

  /** This device's copy, checked against its own trust (which also catches a copy changed on disk). */
  private verifiedCopy(setId: string): EnvVerifiedSet {
    const cached = this.verified.get(setId);
    if (cached) return cached;
    const copy = this.copy(setId);
    const result = verifyEnvFile(copy.text, copy.trust);
    if (!result.ok) throw new Error(`This device's copy of ${copy.name} is damaged. ${refusal(result.problem, copy.name).message}`);
    this.verified.set(setId, result.set);
    return result.set;
  }

  private roleIn(setId: string): EnvSetView['role'] {
    const copy = this.copies.get(setId);
    if (!copy) return 'outside';
    if (copy.removed) return 'removed';
    return this.verifiedCopy(setId).file.header.members.find((m) => m.id === this.memberId)?.role ?? 'outside';
  }

  /** A set this device is a member of (not removed), for reading values and changing them. */
  private memberCopy(setId: string): StoredEnvSet {
    const copy = this.copy(setId);
    if (copy.removed) throw new Error(REMOVED_READ_ONLY);
    if (this.roleIn(setId) === 'outside') throw new Error(NOT_A_MEMBER);
    return copy;
  }

  private async keep(copy: StoredEnvSet): Promise<void> {
    this.copies.set(copy.setId, copy);
    this.verified.delete(copy.setId);
    await this.host.store.saveSet(copy);
  }

  /** Takes a file this device made (signed) as its copy: it must pass against the copy's trust. */
  private async keepOwn(setId: string, text: string, pending: boolean, location?: EnvLocation): Promise<void> {
    const copy = this.copy(setId);
    const result = verifyEnvFile(text, copy.trust);
    if (!result.ok) throw refusal(result.problem, copy.name);
    await this.keep({ ...copy, text, trust: nextEnvTrust(copy.trust, result.set), pending, removed: null, location: location ?? copy.location, syncedAt: this.host.now() });
  }

  /** Starts a copy from a file this device just checked (a new set, a join, a take-over). */
  private async keepNew(verified: EnvVerifiedSet, text: string, location: EnvLocation | null, previous?: StoredEnvSet, pin: EnvTrust | null = null): Promise<void> {
    this.setAside.delete(verified.file.header.set);
    this.refusedTakes.delete(verified.file.header.set);
    await this.keep({
      setId: verified.file.header.set,
      name: verified.file.header.name,
      text,
      trust: nextEnvTrust(pin, verified),
      location,
      syncedAt: this.host.now(),
      lastReleasedAt: previous?.lastReleasedAt ?? null,
      removed: null,
      pending: false,
    });
  }

  private removedNote(verified: EnvVerifiedSet, commits: readonly (string | null)[] | undefined): string {
    const header = verified.file.header;
    const signer = header.members.find((m) => m.id === header.signer)?.label ?? "The owner's recovery phrase";
    const commit = commits?.[verified.parsed.headerLine - 1] ?? null;
    return `${signer} removed this device from ${header.name}${commit ? ` in commit ${commit}` : ''}.`;
  }

  /**
   * Compares a file from the computer with this device's copy and keeps what is newer: the rules
   * a release, a change and a sync all follow.
   */
  private async acceptFile(setId: string, text: string, location: EnvLocation, commits?: readonly (string | null)[]): Promise<Accepted> {
    const copy = this.copies.get(setId) ?? null;
    if (this.refusedTakes.get(setId)?.text !== text) this.refusedTakes.delete(setId);
    if (copy?.removed) return { kind: 'removed' };
    if (copy?.pending) return this.mergePending(copy, text, location);
    const result = verifyEnvFile(text, copy?.trust ?? null);
    if (!result.ok) return copy && isOlderProblem(result.problem) ? { kind: 'older' } : { kind: 'refused', problem: result.problem };
    const verified = result.set;
    if (verified.file.header.set !== setId) return { kind: 'refused', problem: { kind: 'header-chain', rev: verified.file.header.rev } };
    // A take-over or recovery change this device hasn't seen: it has no memory of the line the
    // change came from, so the history decides, as for a first take (ENV-24: a retired key's fork).
    if (copy && envCrossesAuthority(copy.trust, verified.file.header)) {
      const verdict = await this.historyVerdict(setId, location, text);
      if (verdict) return { kind: 'refused', ...verdict };
    }
    const listed = verified.file.header.members.some((m) => m.id === this.memberId);
    if (!copy) {
      if (!listed) return { kind: 'outside' };
      return this.adoptListed(setId, text, verified, location);
    }
    if (!listed) {
      await this.keep({ ...copy, removed: { note: this.removedNote(verified, commits) }, location, pending: false });
      return { kind: 'removed' };
    }
    if (text === copy.text) {
      await this.keep({ ...copy, location, syncedAt: this.host.now() });
      return { kind: 'same' };
    }
    await this.keep({ ...copy, text, trust: nextEnvTrust(copy.trust, verified), location, syncedAt: this.host.now() });
    return { kind: 'adopted' };
  }

  /**
   * A file that lists this device, with no copy here. Taken only as the set this device asked to
   * join (it follows the file the request was made against) or as a copy set aside (at or past
   * what its anchor vouched for). Anything else, say a set someone made with this device's public
   * keys, stays outside: a set is only ever entered by creating it, a check code, a join request
   * or the recovery phrase.
   */
  private async adoptListed(setId: string, text: string, verified: EnvVerifiedSet, location: EnvLocation): Promise<Accepted> {
    const asked = this.ownRequests.find((r) => r.setId === setId);
    // The owner's words not compared yet: whoever made the pinned file may not be the owner the person meant.
    if (asked && !asked.ownerConfirmed) return { kind: 'outside' };
    if (asked) {
      const pinned = verifyEnvFile(text, asked.pin);
      if (!pinned.ok) {
        this.refusedTakes.set(setId, { text, note: refusal(pinned.problem, asked.setName).message });
        return { kind: 'refused', problem: pinned.problem };
      }
      if (await this.refuseTake(setId, location, text, verified.file.header.name)) return { kind: 'outside' };
      // Withdrawn while the history was read: the set is no longer one this device asked for.
      if (!this.stillAsked(asked)) return { kind: 'outside' };
      await this.keepNew(pinned.set, text, location, undefined, asked.pin);
      return { kind: 'adopted' };
    }
    const aside = this.setAside.get(setId);
    if (aside) {
      const { rev } = verified.file.header;
      const sameHead = rev === aside.rev && verified.headerHash === aside.headerHash;
      if (!sameHead && !(rev > aside.rev && verified.owner.id === aside.ownerId)) {
        const problem: EnvFileProblem = { kind: 'header-chain', rev };
        this.refusedTakes.set(setId, { text, note: refusal(problem, verified.file.header.name).message });
        return { kind: 'refused', problem };
      }
      if (await this.refuseTake(setId, location, text, verified.file.header.name)) return { kind: 'outside' };
      await this.keepNew(verified, text, location);
      return { kind: 'adopted' };
    }
    return { kind: 'outside' };
  }

  /** The own request is still there, confirmed, and the one the adoption started from (same pin). */
  private stillAsked(asked: StoredOwnRequest): boolean {
    const now = this.ownRequests.find((r) => r.setId === asked.setId);
    return !!now && now.ownerConfirmed && now.madeAt === asked.madeAt && now.pin.head.headerHash === asked.pin.head.headerHash;
  }

  /**
   * With no trust in a set yet, the file must stand on its git history, read to the end: at or
   * above what the history signed (ENV-08: a repo writer could otherwise swap a deleted variable's
   * tombstone back for its older value line), and the only set there under its id (ENV-14). Returns
   * why not, as a sentence; null when it stands. Fails closed when the history can't be read whole.
   */
  /** historyRefusal, remembered for the outside view: true when the take is refused. */
  private async refuseTake(setId: string, location: EnvLocation, text: string, setName: string): Promise<boolean> {
    const note = await this.historyRefusal(setId, location, text, setName);
    if (note) this.refusedTakes.set(setId, { text, note });
    else this.refusedTakes.delete(setId);
    return note !== null;
  }

  private async historyRefusal(setId: string, location: EnvLocation, text: string, setName: string): Promise<string | null> {
    const verdict = await this.historyVerdict(setId, location, text);
    return verdict && refusedError(verdict, setName).message;
  }

  private async historyVerdict(setId: string, location: EnvLocation, text: string): Promise<HistoryVerdict | null> {
    let floor: EnvHistoryFloor | null;
    try {
      floor = await this.readHistoryFloor(setId, location, createEnvFloorBuilder(text));
    } catch (err) {
      // The agent couldn't serve the history whole (a shallow or partial clone, a history that
      // changed mid-read, …) and says why, in a sentence for the person.
      if (err instanceof RequestError && err.fromComputer && err.code === 'failed') return { problem: null, note: err.message };
      if (err instanceof EnvFileRefused) return { problem: err.problem };
      throw err;
    }
    if (!floor) return { problem: null, note: historyTooLong(setNameOf(text)) };
    const below = checkEnvFloor(text, floor);
    return below ? { problem: below } : null;
  }

  /**
   * Reads the set file's history to its end, folding each version into `builder` as it arrives;
   * null when it ran past the history budget (UTF-8 bytes, as the agent sends it).
   */
  private async readHistoryFloor(setId: string, location: EnvLocation, builder: EnvFloorBuilder): Promise<EnvHistoryFloor | null> {
    const params = { path: location.path, setId };
    let before: string | undefined;
    let read = 0;
    for (;;) {
      const page = await this.host.link.request('env.history.read', before ? { ...params, before } : params, FILE_TIMEOUT_MS);
      for (const commit of page.commits) {
        // Every commit costs its metadata too, so pages of deleted files still use up the budget.
        read += utf8Bytes(commit.commit) + utf8Bytes(commit.author) + utf8Bytes(commit.subject) + (commit.file === null ? 0 : utf8Bytes(commit.file));
        if (read > this.historyBudgetBytes) return null;
        if (commit.file !== null) builder.add({ commit: commit.commit, text: commit.file });
      }
      const last = page.commits[page.commits.length - 1];
      if (!page.more || !last) return builder.floor();
      before = last.commit;
    }
  }

  /** A copy with changes made offline meets the computer's newer file: the merge driver's rules join them. */
  private async mergePending(copy: StoredEnvSet, theirs: string, location: EnvLocation): Promise<Accepted> {
    // The computer's file is behind this copy (it lacks the offline change), so the sides are
    // merged on their own checks and the result is held to this copy's trust instead.
    const outcome = mergeEnvFiles({ base: null, ours: copy.text, theirs, trust: null });
    if (outcome.kind === 'refused') return { kind: 'refused', problem: outcome.problem };
    if (outcome.kind === 'two-headers') return { kind: 'refused', problem: { kind: 'header-chain', rev: outcome.rev } };
    const merged = verifyEnvFile(outcome.file, copy.trust);
    if (!merged.ok) return { kind: 'refused', problem: merged.problem };
    if (envCrossesAuthority(copy.trust, merged.set.file.header)) {
      const verdict = await this.historyVerdict(copy.setId, location, theirs);
      if (verdict) return { kind: 'refused', ...verdict };
    }
    if (!merged.set.file.header.members.some((m) => m.id === this.memberId)) {
      await this.keep({ ...copy, removed: { note: this.removedNote(merged.set, undefined) }, location, pending: false });
      return { kind: 'removed' };
    }
    await this.keep({ ...copy, text: outcome.file, trust: nextEnvTrust(copy.trust, merged.set), location, pending: outcome.file !== theirs });
    return { kind: 'merged' };
  }

  // --- The computer -------------------------------------------------------------------------

  private forgetComputer(): void {
    this.outside.clear();
    this.remote.clear();
    this.teammates.clear();
    this.grants = [];
    for (const id of [...this.incoming.keys()]) this.dropIncoming(id, false);
    this.joins.dispose();
  }

  private isOnline(location: EnvLocation | null): boolean {
    return Boolean(location && this.computer?.hasEnv && this.computer.agentId === location.agentId);
  }

  private locationFor(summary: { path: string; repoRoot: string; remote: string | null }): EnvLocation {
    const computer = this.computer!;
    return { agentId: computer.agentId, computerName: computer.name, path: summary.path, repoRoot: summary.repoRoot, remote: summary.remote };
  }

  /** Watches for requests and reads every set on the computer. Calls made while one runs fold into one more. */
  sync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.syncAgain = false;
        await this.exclusive(() => this.syncOnce());
      } while (this.syncAgain);
    })().finally(() => {
      this.syncing = null;
      this.changed();
    });
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const computer = this.computer;
    if (!computer?.hasEnv) return;
    const watch = await this.host.link.request('env.watch', { members: this.memberId ? [this.memberId] : [] });
    if (this.computer !== computer) return;
    this.grants = watch.grants;
    for (const request of watch.requests) if (!this.incoming.has(request.requestId)) this.addIncoming(request);
    const { sets } = await this.host.link.request('env.sets.list', {});
    if (this.computer !== computer) return;
    this.outside.clear();
    for (const summary of sets) {
      try {
        await this.readSet(summary);
      } catch (err) {
        console.warn('Env sets: reading a set failed:', (err as Error).message);
      }
    }
    await this.syncRecovery();
    this.changed();
  }

  private async readSet(summary: EnvSetSummary): Promise<void> {
    const copy = this.copies.get(summary.setId);
    const location = this.locationFor(summary);
    if (copy?.removed) return;
    const upToDate = copy && !copy.pending && summary.fileHash === this.verifiedCopy(summary.setId).fileHash;
    if (upToDate && summary.joinRequests === 0) {
      this.remote.set(summary.setId, { fileHash: summary.fileHash, problem: null, older: false });
      this.teammates.delete(summary.setId);
      await this.keep({ ...copy, location, syncedAt: this.host.now() });
      return;
    }
    const read = await this.host.link.request('env.file.read', { path: summary.path, setId: summary.setId }, FILE_TIMEOUT_MS);
    const accepted = await this.acceptFile(summary.setId, read.file, location, read.commits);
    if (accepted.kind === 'outside' || (accepted.kind === 'refused' && !this.copies.has(summary.setId))) {
      this.outside.set(summary.setId, { summary, location });
      return;
    }
    const refused = accepted.kind === 'refused' ? accepted : null;
    const problem = refused?.problem ? this.computerProblem(summary.setId, refused.problem, read.file, read.commits) : null;
    this.remote.set(summary.setId, { fileHash: read.fileHash, problem, note: refused?.note ?? null, older: accepted.kind === 'older' });
    this.teammates.set(summary.setId, this.teammateRequests(summary.setId, read.requests));
    // An older file stays as it is (a checkout of an older commit is the person's own business);
    // releases use this device's copy. Only changes made here offline are written.
    if (accepted.kind !== 'older' && this.copies.get(summary.setId)?.pending) await this.writeCopy(summary.setId, read.fileHash);
    this.dropOwnRequest(summary.setId);
  }

  /**
   * What the set shows for a refused computer file. Lines under an old key are listed by name for
   * the owner's review (fixOldKeyLines); a file that fails anything else shows that instead.
   */
  private computerProblem(setId: string, problem: EnvFileProblem, text: string, commits: readonly (string | null)[]): NonNullable<RemoteState['problem']> {
    if (problem.kind !== 'wrong-epoch') return { problem, commit: commitOf(problem, commits) };
    const checked = verifyEnvFileForRekey(text, this.copy(setId).trust);
    if (!checked.ok) return { problem: checked.problem, commit: commitOf(checked.problem, commits) };
    return { problem, commit: commitOf(problem, commits), names: checked.oldEpoch };
  }

  /** Sends changes made here offline (already merged with the computer's file). Left pending on a conflict: the next read merges again. */
  private async writeCopy(setId: string, baseHash: string): Promise<void> {
    const copy = this.copy(setId);
    if (!copy.location || !this.isOnline(copy.location)) return;
    try {
      const { fileHash } = await this.host.link.request('env.file.write', { path: copy.location.path, setId, baseHash, file: copy.text }, FILE_TIMEOUT_MS);
      await this.keep({ ...copy, pending: false });
      this.remote.set(setId, { fileHash, problem: null, older: false });
    } catch (err) {
      if (!isConflict(err)) throw err;
    }
  }

  private teammateRequests(setId: string, entries: readonly EnvJoinRequestEntry[]): TeammateRequest[] {
    if (this.roleIn(setId) !== 'owner') return [];
    const members = new Set(this.verifiedCopy(setId).file.header.members.map((m) => m.id));
    const out: TeammateRequest[] = [];
    for (const entry of entries) {
      const read = readEnvJoinRequest(entry.text, { set: setId, path: entry.path });
      if (!read.ok || members.has(read.request.member)) continue;
      out.push({ id: `${setId}:${entry.path}`, setId, path: entry.path, request: read.request, member: read.member, keyWords: read.keyWords, commit: entry.commit });
    }
    return out;
  }

  private dropOwnRequest(setId: string): void {
    if (this.roleIn(setId) === 'outside' || !this.ownRequests.some((r) => r.setId === setId)) return;
    this.ownRequests = this.ownRequests.filter((r) => r.setId !== setId);
    void this.savePrefs();
  }

  private savePrefs(): Promise<void> {
    return this.host.store.savePrefs({ memberId: this.memberId, ownRequests: this.ownRequests, personName: this.personName });
  }

  // --- Requests from the computer -----------------------------------------------------------

  private addIncoming(request: EnvComputerRequest): void {
    const computer = this.computer;
    if (!computer || request.expiresAt <= this.host.now()) return;
    const item: Incoming = { request, computerName: computer.name, agentId: computer.agentId, olderOnComputer: false, problem: null, changes: null };
    this.checkIncoming(item);
    this.incoming.set(request.requestId, item);
    this.clearTimer(request.requestId);
    this.timers.set(
      request.requestId,
      setTimeout(() => this.endIncoming(request.requestId, 'expired', null), Math.max(0, request.expiresAt - this.host.now())),
    );
    void this.planPush(item).finally(() => this.changed());
  }

  /** What the sheet warns about: the computer's file against this device's copy. Public checks only, so it runs while locked. */
  private checkIncoming(item: Incoming): void {
    const { request } = item;
    if (request.kind === 'create') return;
    const copy = this.copies.get(request.setId);
    const result = verifyEnvFile(request.file, copy?.trust ?? null);
    item.olderOnComputer = false;
    item.problem = null;
    if (!result.ok) {
      if (copy && isOlderProblem(result.problem)) item.olderOnComputer = true;
      else item.problem = problemView(result.problem, request.setName, null);
      return;
    }
    const listed = result.set.file.header.members.some((m) => m.id === this.memberId);
    if (this.badWraps.has(request.setId)) {
      item.problem = problemViewForBadWraps(request.setName);
      return;
    }
    if (request.kind !== 'join-keys' && (!listed || copy?.removed)) {
      item.problem = { id: 'not-a-member', kind: 'file', severity: 'error', title: 'Not a member', text: NOT_A_MEMBER };
    }
  }

  private refreshIncoming(): void {
    for (const item of this.incoming.values()) {
      this.checkIncoming(item);
      void this.planPush(item).finally(() => this.changed());
    }
  }

  /** push: what the change does by name, from the values only this device can open. */
  private async planPush(item: Incoming): Promise<void> {
    if (item.request.kind !== 'push' || !this.identity || item.problem) return;
    const request = item.request;
    try {
      item.changes = (await this.exclusive(() => this.pushPlan(request))).view;
    } catch (err) {
      item.problem = { id: 'push', kind: 'file', severity: 'error', title: "The change can't be made", text: (err as Error).message };
    }
  }

  /**
   * A push planned against the base it will be signed on: the computer's file is taken first when
   * it is newer and passes, so the sheet and the signature compare with the same values.
   */
  private async pushPlan(request: EnvPushRequest): Promise<{ base: EnvVerifiedSet; dataKey: Uint8Array; changes: EnvValueChanges; view: EnvChangeView[] }> {
    const accepted = await this.acceptFile(request.setId, request.file, this.locationFor(request));
    if (accepted.kind === 'refused') throw refusedError(accepted, request.setName);
    this.memberCopy(request.setId);
    const base = this.verifiedCopy(request.setId);
    const dataKey = await this.dataKey(request.setId, base.file.header.epoch);
    const current = openEnvValues(base.file, dataKey);
    const changes = planEnvPush(current, request.values, request.prune);
    const view = [
      ...changes.upsert.map((v) => changeView(v.name, current.some((c) => c.name === v.name) ? 'change' : 'add')),
      ...changes.remove.map((name) => changeView(name, 'remove')),
    ];
    return { base, dataKey, changes, view };
  }

  /** The newest valid file for a request: the computer's when it is newer and passes, else this device's copy. */
  private releaseBase(request: EnvReleaseRequest | EnvPushRequest): EnvVerifiedSet {
    const copy = this.copies.get(request.setId);
    const fromComputer = verifyEnvFile(request.file, copy?.trust ?? null);
    if (fromComputer.ok && !copy) return fromComputer.set;
    return this.verifiedCopy(request.setId);
  }

  /** A request left without this device's answer: kept in `ended` for a minute, so an open sheet can say why. */
  private endIncoming(requestId: string, reason: EnvEndedRequestView['reason'], by: string | null): void {
    this.dropIncoming(requestId, false);
    this.ended = [{ id: requestId, reason, by, endedAt: this.host.now() }, ...this.ended.filter((e) => e.id !== requestId)];
    const key = `ended:${requestId}`;
    this.clearTimer(key);
    this.timers.set(
      key,
      setTimeout(() => this.dismissEnded(requestId), ENDED_KEEP_MS),
    );
    this.changed();
  }

  dismissEnded(requestId: string): void {
    this.clearTimer(`ended:${requestId}`);
    const before = this.ended.length;
    this.ended = this.ended.filter((e) => e.id !== requestId);
    if (this.ended.length !== before) this.changed();
  }

  private dropIncoming(requestId: string, publish = true): void {
    this.clearTimer(requestId);
    if (this.incoming.delete(requestId) && publish) this.changed();
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer) clearTimeout(timer);
    this.timers.delete(requestId);
  }

  async answer(requestId: string, answer: EnvRequestAnswer): Promise<EnvAnswerResult> {
    const item = this.incoming.get(requestId);
    if (!item) throw new Error(REQUEST_ENDED);
    if (answer === 'deny') {
      this.dropIncoming(requestId);
      await this.send(requestId, { kind: 'deny' }).catch((err) => {
        if (!(err instanceof Error && err.message === REQUEST_ENDED)) throw err;
      });
      return { changes: null };
    }
    await this.host.vault.confirm(confirmReason(item.request));
    await this.vaultChanged();
    this.requireIdentity();
    if (!this.incoming.has(requestId)) throw new Error(REQUEST_ENDED);
    return this.exclusive(async () => {
      const { reply, after } = await this.buildAnswer(item, answer);
      await this.send(requestId, reply);
      this.dropIncoming(requestId);
      await after();
      return { changes: reply.kind === 'signed' ? signedChanges(reply) : null };
    });
  }

  private async send(requestId: string, answer: EnvAnswer): Promise<void> {
    try {
      await this.host.link.request('env.request.answer', { requestId, answer }, ANSWER_TIMEOUT_MS);
    } catch (err) {
      if (!isGone(err)) throw err;
      this.dropIncoming(requestId);
      throw new Error(REQUEST_ENDED);
    }
  }

  /** The answer for an approved request, and what to keep once the agent took it. */
  private async buildAnswer(item: Incoming, answer: EnvRequestAnswer): Promise<{ reply: EnvAnswer; after: () => Promise<void> }> {
    const { request } = item;
    const location = this.locationFor(request);
    switch (request.kind) {
      case 'run':
      case 'pull': {
        if (answer !== 'grant' && answer !== 'once') throw new Error(WRONG_ANSWER);
        const reply = await this.release(request, location, answer === 'grant' ? 'grant' : 'once');
        return { reply, after: () => this.keep({ ...this.copy(request.setId), lastReleasedAt: this.host.now() }) };
      }
      case 'push': {
        if (answer !== 'approve') throw new Error(WRONG_ANSWER);
        const { reply, text } = await this.signPush(item, request);
        return { reply, after: () => this.keepOwn(request.setId, text, false, location) };
      }
      case 'create': {
        if (answer !== 'approve') throw new Error(WRONG_ANSWER);
        return this.createSet(request.setName, request.values, location);
      }
      case 'join-keys': {
        if (answer !== 'approve') throw new Error(WRONG_ANSWER);
        return this.joinKeys(request, item.computerName);
      }
    }
  }

  /** Answers run or pull from the newest valid copy: the computer's file when it is newer and passes, else this device's. */
  private async release(request: EnvReleaseRequest, location: EnvLocation, scope: 'once' | 'grant'): Promise<EnvAnswer> {
    const accepted = await this.acceptFile(request.setId, request.file, location);
    if (accepted.kind === 'refused') throw refusedError(accepted, request.setName);
    this.memberCopy(request.setId);
    const source = this.verifiedCopy(request.setId);
    const values = openEnvValues(source.file, await this.dataKey(request.setId, source.file.header.epoch));
    const recipient = fromBase64Url(scope === 'once' ? request.oneTimeKey : request.grantKey, 'The release key');
    const sealed = sealEnvValues(values, { set: request.setId, request: request.requestId }, recipient, this.host.random);
    return { kind: 'release', scope, values: sealed, source: { rev: source.file.header.rev, fileHash: source.fileHash } };
  }

  /** Signs the push only when it changes exactly what the sheet showed; otherwise the sheet shows the new plan. */
  private async signPush(item: Incoming, request: EnvPushRequest): Promise<{ reply: EnvAnswer; text: string }> {
    const { base, dataKey, changes, view } = await this.pushPlan(request);
    if (!item.changes || planKey(view) !== planKey(item.changes)) {
      item.changes = view;
      this.changed();
      throw new Error(PLAN_CHANGED);
    }
    const result = changeEnvValues({ file: base.file, author: this.requireIdentity(), dataKey, changes, time: this.host.now(), random: this.host.random });
    const text = writeFile(result.file);
    return { reply: { kind: 'signed', file: text, added: result.added, changed: result.changed, removed: result.removed }, text };
  }

  private async createSet(name: string, values: EnvPushRequest['values'], location: EnvLocation): Promise<{ reply: EnvAnswer; after: () => Promise<void> }> {
    const identity = this.requireIdentity();
    // The set's recovery identity is the vault's: the vault's phrase can then take the set over.
    const recovery = await this.currentVaultRecovery();
    const created = createEnvSet({
      name,
      owner: identity,
      ownerLabel: this.memberLabel(),
      ownerForm: this.host.device.form,
      recovery,
      values,
      time: this.host.now(),
      random: this.host.random,
    });
    const checked = verifyEnvFile(created.text, null);
    if (!checked.ok) throw refusal(checked.problem, name);
    // The id is the hash of the set's signed birth line.
    const setId = created.file.header.set;
    return {
      reply: { kind: 'created', file: created.text },
      after: async () => {
        await this.keepNew(checked.set, created.text, location);
        await this.keepDataKey(setId, created.file.header.epoch, created.dataKey);
      },
    };
  }

  private joinKeys(request: EnvJoinKeysRequest, computerName: string): { reply: EnvAnswer; after: () => Promise<void> } {
    const { setId, setName } = request;
    const identity = this.requireIdentity();
    // The set as the computer showed it now: what the owner's later file must follow.
    const seen = verifyEnvFile(request.file, null);
    if (!seen.ok) throw refusal(seen.problem, setName);
    if (seen.set.file.header.set !== setId) throw refusal({ kind: 'header-chain', rev: seen.set.file.header.rev }, setName);
    const pin = nextEnvTrust(null, seen.set);
    const owner = seen.set.owner;
    const joinRequest = createEnvJoinRequest({ set: setId, device: identity, label: this.memberLabel(), form: this.host.device.form, time: this.host.now() });
    const keyWords = envKeyWords(identity.edPublic, identity.xPublic);
    const ownerKeyWords = memberKeyWords(owner);
    return {
      reply: { kind: 'join-keys', request: joinRequest },
      after: async () => {
        // A confirmation holds only for the owner key it was given for: a pin to another owner asks again.
        const before = this.ownRequests.find((r) => r.setId === setId);
        const ownerConfirmed = before?.ownerConfirmed === true && pinOwnerEd(before.pin) === owner.ed;
        const own: StoredOwnRequest = { setId, setName, computerName, keyWords, madeAt: this.host.now(), pin, ownerLabel: owner.label, ownerKeyWords, ownerConfirmed };
        this.ownRequests = [...this.ownRequests.filter((r) => r.setId !== setId), own];
        await this.savePrefs();
      },
    };
  }

  pushedValue(requestId: string, name: string): string | null {
    const request = this.incoming.get(requestId)?.request;
    if (request?.kind !== 'push') return null;
    return request.values.find((v) => v.name === name)?.value ?? null;
  }

  async endGrant(setId: string): Promise<void> {
    const grant = this.grants.find((g) => g.setId === setId);
    if (!grant) return;
    await this.host.link.request('env.grant.end', { grantId: grant.grantId });
    this.grants = this.grants.filter((g) => g.grantId !== grant.grantId);
    this.changed();
  }

  // --- Changes made on this device ----------------------------------------------------------

  /**
   * Reads the computer's file, builds the change on the newest valid copy, and writes it with the
   * file's hash as the base. A `conflict` (the file changed meanwhile) reads and builds again.
   * Offline, a change that allows it is kept here and sent with the next read.
   */
  private async commitChange(
    setId: string,
    build: (base: EnvVerifiedSet) => Promise<EnvSetFile>,
    options: { offline: boolean; removeRequests?: string[] } = { offline: false },
  ): Promise<void> {
    const copy = this.memberCopy(setId);
    const location = copy.location;
    if (!location || !this.isOnline(location)) {
      if (!options.offline) throw new Error(offlineSentence(location?.computerName ?? 'The computer'));
      await this.keepOwn(setId, writeFile(await build(this.verifiedCopy(setId))), true);
      this.changed();
      return;
    }
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const read = await this.host.link.request('env.file.read', { path: location.path, setId }, FILE_TIMEOUT_MS);
      const accepted = await this.acceptFile(setId, read.file, location, read.commits);
      if (accepted.kind === 'refused') throw refusedError(accepted, copy.name);
      if (accepted.kind === 'removed' || accepted.kind === 'outside') throw new Error(REMOVED_READ_ONLY);
      const text = writeFile(await build(this.verifiedCopy(setId)));
      try {
        const { fileHash } = await this.host.link.request(
          'env.file.write',
          { path: location.path, setId, baseHash: read.fileHash, file: text, ...(options.removeRequests ? { removeRequests: options.removeRequests } : {}) },
          FILE_TIMEOUT_MS,
        );
        await this.keepOwn(setId, text, false);
        this.remote.set(setId, { fileHash, problem: null, older: false });
        this.changed();
        return;
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }
    throw new Error(KEPT_CHANGING);
  }

  private changeValues(setId: string, changes: EnvValueChanges): Promise<void> {
    return this.exclusive(() =>
      this.commitChange(
        setId,
        async (base) =>
          changeEnvValues({
            file: base.file,
            author: this.requireIdentity(),
            dataKey: await this.dataKey(setId, base.file.header.epoch),
            changes,
            time: this.host.now(),
            random: this.host.random,
          }).file,
        { offline: true },
      ),
    );
  }

  async saveVariable(setId: string, variable: { name: string; value: string; previousName?: string }): Promise<void> {
    const problems = checkVariable(variable.name, variable.value);
    if (problems.length > 0) throw new Error(problems[0]);
    this.requireIdentity();
    const renamed = variable.previousName !== undefined && variable.previousName !== variable.name;
    await this.changeValues(setId, { upsert: [{ name: variable.name, value: variable.value }], remove: renamed ? [variable.previousName!] : [] });
  }

  async addVariables(setId: string, values: { name: string; value: string }[]): Promise<void> {
    for (const { name, value } of values) {
      const problems = checkVariable(name, value);
      if (problems.length > 0) throw new Error(problems[0]);
    }
    this.requireIdentity();
    await this.changeValues(setId, { upsert: values, remove: [] });
  }

  async deleteVariable(setId: string, name: string): Promise<void> {
    this.requireIdentity();
    await this.changeValues(setId, { upsert: [], remove: [name] });
  }

  private requireOwner(setId: string): void {
    this.requireIdentity();
    this.memberCopy(setId);
    if (this.roleIn(setId) !== 'owner') throw new Error(ONLY_OWNER);
  }

  private async addMember(setId: string, member: EnvNewMember, removeRequests?: string[]): Promise<void> {
    this.requireOwner(setId);
    await this.commitChange(
      setId,
      async (base) => addEnvMember({ file: base.file, owner: this.requireIdentity(), dataKeys: await this.ownerKeys(setId, base.file), time: this.host.now(), member }),
      { offline: false, ...(removeRequests ? { removeRequests } : {}) },
    );
  }

  /**
   * Owner, after reviewing the names under an old key: keep encrypts them again under a new key;
   * drop deletes them (tombstones, under the new key). Never done without this review: a line
   * copied from git history could otherwise bring back a deleted value.
   */
  async fixOldKeyLines(setId: string, keep: boolean, reviewedNames: string[]): Promise<{ rotate: string[] }> {
    this.requireOwner(setId);
    await this.confirm(`${keep ? 'Keep' : 'Drop'} old-key values in ${this.copy(setId).name}`);
    return this.exclusive(async () => {
      this.requireOwner(setId);
      const identity = this.requireIdentity();
      const copy = this.copy(setId);
      const location = copy.location;
      if (!location || !this.isOnline(location)) throw new Error(offlineSentence(location?.computerName ?? 'The computer'));
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
        const read = await this.host.link.request('env.file.read', { path: location.path, setId }, FILE_TIMEOUT_MS);
        const checked = verifyEnvFileForRekey(read.file, copy.trust);
        if (!checked.ok) throw refusal(checked.problem, copy.name);
        // The review binds the change, as the push sheet does: other names now means a new review.
        if (!sameNames(checked.oldEpoch, reviewedNames ?? [])) {
          const remote = this.remote.get(setId);
          if (remote?.problem) this.remote.set(setId, { ...remote, fileHash: read.fileHash, problem: { ...remote.problem, names: checked.oldEpoch } });
          this.changed();
          throw new Error(REVIEW_CHANGED);
        }
        if (checked.oldEpoch.length === 0) {
          await this.acceptFile(setId, read.file, location, read.commits);
          return { rotate: [] };
        }
        const file = checked.set.file;
        const held = await this.keysFor(setId, file, checked.set.live.map((line) => line.box!.epoch));
        const rekeyed = rekeyEnvSet({ file, owner: identity, dataKeys: held, time: this.host.now(), random: this.host.random });
        let result = rekeyed.file;
        if (!keep) {
          const changes = { upsert: [], remove: checked.oldEpoch };
          result = changeEnvValues({ file: result, author: identity, dataKey: rekeyed.dataKey, changes, time: this.host.now(), random: this.host.random }).file;
        }
        const text = writeFile(result);
        try {
          const { fileHash } = await this.host.link.request('env.file.write', { path: location.path, setId, baseHash: read.fileHash, file: text }, FILE_TIMEOUT_MS);
          await this.keepDataKey(setId, result.header.epoch, rekeyed.dataKey);
          await this.keepOwn(setId, text, false, location);
          this.remote.set(setId, { fileHash, problem: null, older: false });
          this.changed();
          // Whoever was removed with the old key can read every value boxed under it in the repo's
          // history, dropped ones included: a dropped value still in use elsewhere needs rotating too.
          return { rotate: checked.oldEpoch };
        } catch (err) {
          if (!isConflict(err)) throw err;
        }
      }
      throw new Error(KEPT_CHANGING);
    });
  }

  /** The data keys for these epochs: held ones, and the file's current key opened (wraps checked). */
  private async keysFor(setId: string, file: EnvSetFile, epochs: number[]): Promise<Record<number, Uint8Array>> {
    const held = { ...this.dataKeys.get(setId) };
    const current = file.header.epoch;
    if (!held[current]) {
      const key = openEnvDataKey(file.header, this.requireIdentity());
      if (findBadEnvWraps(file.header, key).length > 0) throw new Error(badWrapsSentence(file.header.name));
      held[current] = key;
      await this.keepDataKey(setId, current, key);
    }
    const missing = [...new Set(epochs)].filter((epoch) => !held[epoch]);
    if (missing.length > 0) throw new Error(`This device doesn't hold key ${missing.join(', ')} of ${file.header.name}, so it can't open those values. Ask the member who wrote them to save them again.`);
    return held;
  }

  async removeMember(setId: string, memberId: string): Promise<{ rotate: string[] }> {
    await this.confirm(`Remove a device from ${this.copy(setId).name}`);
    return this.exclusive(async () => {
      this.requireOwner(setId);
      let made: { rotate: string[]; epoch: number; dataKey: Uint8Array } | null = null;
      await this.commitChange(setId, async (base) => {
        const result = removeEnvMember({
          file: base.file,
          owner: this.requireIdentity(),
          dataKeys: await this.ownerKeys(setId, base.file),
          time: this.host.now(),
          memberId,
          random: this.host.random,
        });
        made = { rotate: result.rotate, epoch: result.file.header.epoch, dataKey: result.dataKey };
        return result.file;
      });
      const rekeyed = made as { rotate: string[]; epoch: number; dataKey: Uint8Array } | null;
      if (!rekeyed) throw new Error(KEPT_CHANGING);
      await this.keepDataKey(setId, rekeyed.epoch, rekeyed.dataKey);
      return { rotate: rekeyed.rotate };
    });
  }

  private teammateRequest(requestId: string): TeammateRequest | undefined {
    for (const list of this.teammates.values()) {
      const found = list.find((r) => r.id === requestId);
      if (found) return found;
    }
    return undefined;
  }

  async approveJoin(requestId: string): Promise<void> {
    const offered = this.joins.hasOffer(requestId);
    const request = offered ? undefined : this.teammateRequest(requestId);
    if (!offered && !request) throw new Error(JOIN_REQUEST_GONE);
    await this.confirm('Add a device to an env set');
    if (offered) return this.joins.approve(requestId);
    if (!request) throw new Error(JOIN_REQUEST_GONE);
    await this.exclusive(() => this.addMember(request.setId, request.member, [request.path]));
    this.teammates.set(request.setId, (this.teammates.get(request.setId) ?? []).filter((r) => r.id !== requestId));
    this.changed();
  }

  async declineJoin(requestId: string): Promise<void> {
    if (this.joins.hasOffer(requestId)) return this.joins.decline(requestId);
    const request = this.teammateRequest(requestId);
    if (!request) throw new Error(JOIN_REQUEST_GONE);
    await this.exclusive(() => this.removeRequestFile(request));
    this.teammates.set(request.setId, (this.teammates.get(request.setId) ?? []).filter((r) => r.id !== requestId));
    this.changed();
  }

  /** Declining a teammate: the request file goes, the set file stays as it is. */
  private async removeRequestFile(request: TeammateRequest): Promise<void> {
    this.requireOwner(request.setId);
    const location = this.copy(request.setId).location;
    if (!location || !this.isOnline(location)) throw new Error(offlineSentence(location?.computerName ?? 'The computer'));
    await this.deleteRequestFile(request.setId, location, request.path);
  }

  /** Removes one request file next to the set, leaving the set file as it is; a conflict reads again. */
  private async deleteRequestFile(setId: string, location: EnvLocation, path: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const read = await this.host.link.request('env.file.read', { path: location.path, setId }, FILE_TIMEOUT_MS);
      try {
        await this.host.link.request('env.file.write', { path: location.path, setId, baseHash: read.fileHash, removeRequests: [path] });
        return;
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }
    throw new Error(KEPT_CHANGING);
  }

  /**
   * Teammate: withdraws this device's request to join. It is dropped from memory at once, so an
   * adoption already waiting on the history finds it gone (stillAsked) and leaves the set outside;
   * saving that (pin and anchor with it) and removing the request file from the computer, when it
   * is reachable, run in the queue. Withdrawing is safe, so it needs no unlock and never fails over
   * the computer.
   */
  async cancelOwnRequest(setId: string): Promise<void> {
    if (!this.ownRequests.some((r) => r.setId === setId)) return;
    this.ownRequests = this.ownRequests.filter((r) => r.setId !== setId);
    this.refusedTakes.delete(setId);
    this.changed();
    await this.exclusive(async () => {
      await this.savePrefs();
      const location = this.outside.get(setId)?.location ?? null;
      if (!location || !this.isOnline(location) || !this.memberId) return;
      try {
        await this.deleteRequestFile(setId, location, envJoinRequestPath(this.memberId));
      } catch (err) {
        // Forgotten here either way; the owner sees a request this device will never act on.
        console.warn('Env sets: removing the join request file failed:', (err as Error).message);
      }
    });
  }

  async acceptOwnDeviceJoin(requestId: string): Promise<void> {
    if (!this.joins.hasOffer(requestId)) throw new Error(JOIN_REQUEST_GONE);
    await this.confirm('Answer a device asking to join');
    await this.joins.accept(requestId);
  }

  async requestJoin(setId: string): Promise<void> {
    this.requireIdentity();
    const name = this.outside.get(setId)?.summary.name ?? this.copies.get(setId)?.name;
    if (!name) throw new Error(UNKNOWN_SET);
    await this.joins.requestJoin(setId, name);
  }

  async confirmOwnerWords(setId: string, shownWords: string[]): Promise<void> {
    const asked = this.ownRequests.find((r) => r.setId === setId);
    if (!asked) throw new Error(JOIN_REQUEST_GONE);
    if (asked.ownerKeyWords.join(' ') !== shownWords.join(' ')) throw new Error(OWNER_WORDS_CHANGED);
    if (!asked.ownerConfirmed) {
      this.ownRequests = this.ownRequests.map((r) => (r === asked ? { ...r, ownerConfirmed: true } : r));
      await this.savePrefs();
      this.changed();
    }
    // The owner may already have added this device.
    if (this.computer?.hasEnv) await this.sync();
  }

  cancelJoin(): void {
    this.joins.cancel();
  }

  /** New device: the owner said it added this device. The set file must show it, added by the device it compared codes with. */
  private async adoptJoined(setId: string, device: DeviceKeys, challenge: JoinChallenge): Promise<void> {
    const location = this.outside.get(setId)?.location ?? this.copies.get(setId)?.location;
    if (!location || !this.isOnline(location)) throw new Error(offlineSentence(location?.computerName ?? 'The computer'));
    const read = await this.host.link.request('env.file.read', { path: location.path, setId }, FILE_TIMEOUT_MS);
    const previous = this.copies.get(setId);
    const result = verifyEnvFile(read.file, previous?.removed ? null : (previous?.trust ?? null));
    if (!result.ok) throw refusal(result.problem, challenge.vaultName);
    const check = checkEnvJoined(result.set.file, device, challenge);
    if (check.status === 'not-yet') throw new Error("The set file on the computer doesn't list this device yet. Try again once it does.");
    if (check.status === 'intercepted') throw new Error(`Something between the two devices changed the join: ${check.reason}. Start again.`);
    if (findBadEnvWraps(result.set.file.header, check.dataKey).length > 0) throw new Error(badWrapsSentence(challenge.vaultName));
    // A remembered copy across a take-over or recovery change it hasn't seen: the history decides, as in acceptFile.
    if (previous && !previous.removed && envCrossesAuthority(previous.trust, result.set.file.header)) {
      const verdict = await this.historyVerdict(setId, location, read.file);
      if (verdict) throw refusedError(verdict, challenge.vaultName);
    }
    if (!previous || previous.removed) {
      if (await this.refuseTake(setId, location, read.file, challenge.vaultName)) throw new Error(this.refusedTakes.get(setId)!.note);
    }
    await this.keepNew(result.set, read.file, location, previous);
    await this.keepDataKey(setId, result.set.file.header.epoch, check.dataKey);
    this.outside.delete(setId);
    this.changed();
  }

  /** Returns the members the take-over took out (to ask back) and every value to rotate. */
  async becomeOwner(setId: string, phrase: string[]): Promise<{ removed: string[]; rotate: string[] }> {
    await this.confirm('Become the owner of an env set');
    return this.exclusive(async () => {
      const identity = this.requireIdentity();
      const previous = this.copies.get(setId);
      const location = previous?.location ?? this.outside.get(setId)?.location ?? null;
      const name = previous?.name ?? this.outside.get(setId)?.summary.name ?? 'the set';
      if (!location || !this.isOnline(location)) throw new Error(offlineSentence(location?.computerName ?? 'The computer'));
      // A removed copy's trust is older than the file: the take-over chains to the file, which is checked as it stands.
      const trust = previous && !previous.removed ? previous.trust : null;
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
        const read = await this.host.link.request('env.file.read', { path: location.path, setId }, FILE_TIMEOUT_MS);
        const current = verifyEnvFile(read.file, trust);
        if (!current.ok) throw refusal(current.problem, name);
        const recoveryId = current.set.file.header.recovery?.id;
        if (!recoveryId) throw new Error(noRecovery(name));
        // The set's recovery identity is its owner's vault's: the phrase opens it only within that
        // vault, which a phone restored with the phrase has again.
        const vaultId = await this.host.vault.vaultId();
        const recovery = vaultId ? recoveryFrom(phrase, vaultId) : null;
        if (!recovery || recovery.deviceId !== recoveryId) throw new Error(notThePhrase(name));
        // The phrase replaces a lost device of this vault: a set owned by anyone else is someone
        // else's, even when it is wrapped to this vault's recovery keys (they are public).
        if (!(await this.host.vault.isVaultDevice(current.set.owner.id))) throw new Error(notOurOwner(name));
        // A restored phone has no memory of the set: git's history is the floor of what it signs.
        const refused = await this.historyRefusal(setId, location, read.file, name);
        if (refused) throw new Error(refused);
        const taken = takeOverEnvSet({ file: current.set.file, recovery, newOwner: identity, label: this.memberLabel(), form: this.host.device.form, time: this.host.now(), random: this.host.random });
        const text = writeFile(taken.file);
        try {
          await this.host.link.request('env.file.write', { path: location.path, setId, baseHash: read.fileHash, file: text }, FILE_TIMEOUT_MS);
        } catch (err) {
          if (isConflict(err)) continue;
          throw err;
        }
        const after = verifyEnvFile(text, trust);
        if (!after.ok) throw refusal(after.problem, name);
        if (trust && previous) await this.keep({ ...previous, text, trust: nextEnvTrust(trust, after.set), location, removed: null, pending: false, syncedAt: this.host.now() });
        else await this.keepNew(after.set, text, location, previous);
        await this.keepDataKey(setId, taken.file.header.epoch, taken.dataKey);
        this.outside.delete(setId);
        this.changed();
        return { removed: taken.removed.map((member) => member.label), rotate: taken.rotate };
      }
      throw new Error(KEPT_CHANGING);
    });
  }

  // --- The person and the vault's recovery phrase -------------------------------------------

  async setPersonName(name: string): Promise<void> {
    const cleaned = cleanJoinName(name);
    if (!cleaned) throw new Error('Type your name.');
    if (cleaned.length > MAX_PERSON_NAME) throw new Error(`Keep your name to ${MAX_PERSON_NAME} characters or fewer.`);
    this.personName = cleaned;
    await this.savePrefs();
    this.changed();
  }

  /** How this device is listed in a set: "Maya Rao · Pixel 8", or the device name until the person gives theirs. */
  private memberLabel(): string {
    return this.personName ? `${this.personName} · ${this.host.device.label}` : this.host.device.label;
  }

  /** The device's own unlock before a change that hands out or moves a key, as answer() does; it also opens a locked vault. */
  private async confirm(reason: string): Promise<void> {
    await this.host.vault.confirm(reason);
    await this.vaultChanged();
    this.requireIdentity();
  }

  private async currentVaultRecovery(): Promise<EnvRecoveryPublic | null> {
    if (this.vaultRecovery === undefined) this.vaultRecovery = await this.host.vault.recovery();
    return this.vaultRecovery;
  }

  /** The vault's recovery phrase was set or changed: every set this device owns follows it. */
  async vaultRecoveryChanged(): Promise<void> {
    if (!this.identity) {
      this.vaultRecovery = undefined;
      return;
    }
    this.vaultRecovery = await this.host.vault.recovery();
    this.changed();
    await this.exclusive(() => this.syncRecovery());
    this.changed();
  }

  /** A set this device owns whose recovery identity isn't the vault's current one. */
  private recoveryPending(setId: string, file: EnvSetFile): boolean {
    if (!this.vaultRecovery || this.copies.get(setId)?.removed) return false;
    if (!file.header.members.some((m) => m.id === this.memberId && m.role === 'owner')) return false;
    return file.header.recovery?.id !== this.vaultRecovery.deviceId;
  }

  /** Brings every owned set on the reachable computer to the vault's recovery identity (a new phrase re-keys). */
  private async syncRecovery(): Promise<void> {
    const recovery = this.identity ? this.vaultRecovery : undefined;
    if (!recovery) return;
    for (const copy of [...this.copies.values()]) {
      if (!this.isOnline(copy.location)) continue;
      let file: EnvSetFile;
      try {
        file = this.verifiedCopy(copy.setId).file;
      } catch {
        continue;
      }
      if (!this.recoveryPending(copy.setId, file)) continue;
      try {
        let made: { epoch: number; dataKey: Uint8Array } | null = null;
        await this.commitChange(copy.setId, async (base) => {
          const result = setEnvRecovery({
            file: base.file,
            owner: this.requireIdentity(),
            dataKeys: await this.ownerKeys(copy.setId, base.file),
            time: this.host.now(),
            recovery,
            random: this.host.random,
          });
          made = { epoch: result.file.header.epoch, dataKey: result.dataKey };
          return result.file;
        });
        const rekeyed = made as { epoch: number; dataKey: Uint8Array } | null;
        if (rekeyed) await this.keepDataKey(copy.setId, rekeyed.epoch, rekeyed.dataKey);
      } catch (err) {
        console.warn('Env sets: putting the recovery phrase on a set failed:', (err as Error).message);
      }
    }
  }

  async deleteRemovedSet(setId: string): Promise<void> {
    const copy = this.copy(setId);
    if (!copy.removed) throw new Error('Only a set this device was removed from can be deleted here.');
    await this.host.store.deleteSet(setId);
    this.copies.delete(setId);
    this.verified.delete(setId);
    const keys = this.dataKeys.get(setId);
    if (keys) wipe(keys);
    this.dataKeys.delete(setId);
    this.changed();
  }

  // --- Reading ------------------------------------------------------------------------------

  async reveal(setId: string, name: string): Promise<string> {
    this.requireIdentity();
    const line = this.verifiedCopy(setId).live.find((l) => l.name === name);
    if (!line?.box) throw new Error(`${name} is no longer in this set.`);
    const value = openEnvValue(await this.dataKey(setId, line.box.epoch), setId, line);
    if (value === null) throw new Error(`${name} is no longer in this set.`);
    return value;
  }

  checkVariable(name: string, value: string): string[] {
    return checkVariable(name, value);
  }

  parseDotenv(text: string): { values: { name: string; value: string }[]; problems: string[] } {
    return parseDotenv(text);
  }

  async history(setId: string, before?: string): Promise<{ items: EnvHistoryItemView[]; more: boolean }> {
    const location = this.copies.get(setId)?.location ?? this.outside.get(setId)?.location ?? null;
    if (!location || !this.isOnline(location)) throw new Error(offlineSentence(location?.computerName ?? 'The computer'));
    const params = { path: location.path, setId };
    const page = await this.host.link.request('env.history.read', before ? { ...params, before } : params, FILE_TIMEOUT_MS);
    const last = page.commits[page.commits.length - 1];
    // The oldest commit on a page is compared with the newest one on the next.
    const tail = page.more && last ? ((await this.host.link.request('env.history.read', { ...params, before: last.commit }, FILE_TIMEOUT_MS)).commits[0] ?? null) : null;
    const trusted = this.trustedHeader(setId);
    const items = page.commits.map((commit, i) => historyItem(setId, commit, page.commits[i + 1] ?? tail, trusted));
    return { items, more: page.more };
  }

  /**
   * The header history measures commits against: the newest this device trusts (its copy, or the
   * file it asked to join). Null when it trusts none, and then no commit shows as signed.
   */
  private trustedHeader(setId: string): EnvHeader | null {
    return (this.copies.get(setId)?.trust ?? this.ownRequests.find((r) => r.setId === setId)?.pin ?? null)?.header ?? null;
  }

  teammateSteps(setId: string): string {
    const copy = this.copy(setId);
    const repo = copy.location?.remote ?? 'the repo';
    const computer = copy.location?.computerName ?? 'my computer';
    return [
      `Join ${copy.name} on AuthDeck:`,
      `1. Clone ${repo} and run authdeck env init in it. Your phone makes its keys, and the command writes .authdeck/requests/<device>.json and shows six key words.`,
      '2. Commit that file and push, or open a pull request.',
      `3. Once ${computer} has the commit, we compare your name and six key words, then I approve.`,
    ].join('\n');
  }

  // --- What the screens see -----------------------------------------------------------------

  status(): EnvStatus {
    if (!this.loaded) return 'loading';
    const vault = this.host.vault.status();
    if (vault === 'loading' || (vault === 'open' && !this.identity)) return 'loading';
    return this.identity ? 'open' : 'locked';
  }

  snapshot(): EnvSnapshot {
    const sets: EnvSetView[] = [];
    for (const copy of this.copies.values()) {
      const view = this.copyView(copy);
      if (view) sets.push(view);
    }
    for (const [setId, { summary, location }] of this.outside) {
      if (!this.copies.has(setId)) sets.push(outsideSetView(summary, location.computerName, this.isOnline(location), this.refusedNote(setId)));
    }
    return {
      status: this.status(),
      sets,
      incoming: [...this.incoming.values()].sort((a, b) => a.request.askedAt - b.request.askedAt).map((item) => this.requestView(item)),
      ended: this.ended,
      joinRequests: this.joinRequestViews(),
      join: this.joins.joinView(),
      ownRequests: this.ownRequests
        .filter((r) => this.roleIn(r.setId) === 'outside')
        .map(({ setId, setName, computerName, keyWords, madeAt, ownerLabel, ownerKeyWords, ownerConfirmed }) => ({
          setId,
          setName,
          computerName,
          keyWords,
          madeAt,
          ownerLabel,
          ownerKeyWords,
          ownerConfirmed,
        })),
      agentTooOld: this.computer !== null && !this.computer.hasEnv,
      personName: this.personName,
    };
  }

  private refusedNote(setId: string): string | null {
    return this.refusedTakes.get(setId)?.note ?? null;
  }

  private copyView(copy: StoredEnvSet): EnvSetView | null {
    let file: EnvSetFile;
    try {
      file = this.verifiedCopy(copy.setId).file;
    } catch {
      return null;
    }
    const remote = this.remote.get(copy.setId);
    return setView(copy, file, {
      memberId: this.memberId,
      online: this.isOnline(copy.location),
      grant: this.grants.find((g) => g.setId === copy.setId) ?? null,
      joinRequestCount: (this.teammates.get(copy.setId)?.length ?? 0) + this.joins.countFor(copy.setId),
      computerProblem: remote?.problem ?? null,
      computerNote: remote?.note ?? null,
      olderOnComputer: remote?.older ?? false,
      badWraps: this.badWraps.has(copy.setId),
      recoveryPending: this.recoveryPending(copy.setId, file),
    });
  }

  detail(setId: string): EnvSetDetail | null {
    const copy = this.copies.get(setId);
    if (!copy) {
      const outside = this.outside.get(setId);
      return outside ? { set: outsideSetView(outside.summary, outside.location.computerName, this.isOnline(outside.location), this.refusedNote(setId)), variables: [], members: [] } : null;
    }
    const view = this.copyView(copy);
    if (!view) return null;
    const file = this.verifiedCopy(setId).file;
    return { set: view, variables: variableViews(file), members: memberViews(file, this.memberId) };
  }

  private requestView(item: Incoming): EnvRequestView {
    const { request } = item;
    const isRelease = request.kind === 'run' || request.kind === 'pull';
    return {
      id: request.requestId,
      kind: request.kind,
      computerName: item.computerName,
      setId: request.setId,
      setName: request.setName,
      askedAt: request.askedAt,
      expiresAt: request.expiresAt,
      needsUnlock: !this.identity,
      command: request.kind === 'run' && request.command ? commandLine(request.command) : request.invocation,
      folder: isRelease ? request.cwd : request.repoRoot,
      startedIn: isRelease ? request.startedIn : null,
      target: isRelease ? request.target : null,
      variableCount: this.requestVariableCount(request),
      changes: request.kind === 'push' ? item.changes : null,
      olderOnComputer: item.olderOnComputer,
      problem: item.problem,
      file: request.kind === 'create' ? null : setFilePath(request.setName),
    };
  }

  private requestVariableCount(request: EnvComputerRequest): number {
    if (request.kind === 'push' || request.kind === 'create') return request.values.length;
    if (request.kind === 'join-keys') return 0;
    try {
      return this.releaseBase(request).live.length;
    } catch {
      return 0;
    }
  }

  private joinRequestViews(): EnvJoinRequestView[] {
    const teammates: EnvJoinRequestView[] = [];
    for (const [setId, list] of this.teammates) {
      const setName = this.copies.get(setId)?.name ?? '';
      // This device's own words, as the set lists it: the owner reads them out, the teammate checks.
      let ownerKeyWords: string[] | null = null;
      try {
        const me = this.verifiedCopy(setId).file.header.members.find((m) => m.id === this.memberId);
        ownerKeyWords = me ? memberKeyWords(me) : null;
      } catch {
        ownerKeyWords = null;
      }
      for (const r of list) {
        teammates.push({
          id: r.id,
          via: 'teammate',
          setId,
          setName,
          label: r.request.label,
          form: r.request.form,
          keyWords: r.keyWords,
          commit: r.commit,
          code: null,
          expiresAt: null,
          ownerKeyWords,
          needsUnlock: !this.identity,
        });
      }
    }
    return [...teammates, ...this.joins.requestViews(!this.identity)];
  }
}

function changeView(name: string, change: EnvChangeView['change']): EnvChangeView {
  return { name, change, loadsCode: envLoadsCode(name) };
}

/** The changes as a comparable key: the same names, the same kinds. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join('\n') === [...b].sort().join('\n');
}

function planKey(changes: readonly EnvChangeView[]): string {
  return changes
    .map((c) => `${c.change}:${c.name}`)
    .sort()
    .join('\n');
}

function pinOwnerEd(pin: EnvTrust): string | undefined {
  return pin.header.members.find((m) => m.role === 'owner')?.ed;
}

function memberKeyWords(member: EnvMember): string[] {
  return envKeyWords(fromBase64Url(member.ed), fromBase64Url(member.x));
}

function badWrapsSentence(setName: string): string {
  return `The member list of ${setName} gives a device a key that doesn't match this device's, so AuthDeck won't use it. Ask the owner to open ${setName} on their phone and remove that device.`;
}

function writeFile(file: EnvSetFile): string {
  return writeEnvFile(file);
}

/** What the device's own unlock prompt says while a request waits. */
function confirmReason(request: EnvComputerRequest): string {
  switch (request.kind) {
    case 'run':
    case 'pull':
      return `Allow ${request.setName}`;
    case 'push':
      return `Sign the change to ${request.setName}`;
    case 'create':
      return `Make ${request.setName}`;
    case 'join-keys':
      return `Ask to join ${request.setName}`;
  }
}

function signedChanges(reply: Extract<EnvAnswer, { kind: 'signed' }>): EnvChangeView[] {
  return [
    ...reply.added.map((name) => changeView(name, 'add')),
    ...reply.changed.map((name) => changeView(name, 'change')),
    ...reply.removed.map((name) => changeView(name, 'remove')),
  ];
}

/** The set's recovery identity from the words typed, or null when they aren't a phrase at all. */
function recoveryFrom(phrase: readonly string[], vaultId: string): DeviceKeys | null {
  const words = phrase.map((w) => w.trim().toLowerCase()).filter(Boolean);
  try {
    return envRecoveryKeys(words.join(' '), vaultId);
  } catch {
    return null;
  }
}

/**
 * A commit is on the line this device trusts when its authority (birth, take-overs, recovery
 * changes) continues the trusted header's, or the trusted header's continues it (older commits,
 * across a take-over this device saw). A file under the same id from anyone else fails its own
 * checks, since the id is the hash of the set's signed birth line.
 */
function onTrustedLine(setId: string, header: EnvHeader, trusted: EnvHeader | null): boolean {
  if (!trusted || header.set !== setId) return false;
  return envAuthorityExtends(header, trusted) || envAuthorityExtends(trusted, header);
}

/** One commit, checked against its own signatures and this device's trusted keys, and compared with the commit before it. */
function historyItem(setId: string, commit: EnvCommit, previous: EnvCommit | null, trusted: EnvHeader | null): EnvHistoryItemView {
  const unsigned = (text: string): EnvHistoryItemView => ({ commit: commit.commit, time: commit.time, text, by: commit.author, signed: false });
  if (commit.file === null) return unsigned('Deleted the set file');
  const after = verifyEnvFile(commit.file, null);
  if (!after.ok) return unsigned(envFileProblemWords(after.problem, { file: '', set: '', where: 'phone' }).title);
  if (!onTrustedLine(setId, after.set.file.header, trusted)) return unsigned("Changed the set with keys this device doesn't trust");
  const before = previous?.file ? verifyEnvFile(previous.file, null) : null;
  const beforeFile = before?.ok ? before.set.file : null;
  const change = diffEnvFiles(beforeFile, after.set.file);
  const members = [...after.set.file.header.members, ...(beforeFile?.header.members ?? [])];
  const signerId = change.signers[0];
  const signer = signerId === undefined ? null : (members.find((m) => m.id === signerId)?.label ?? (after.set.file.header.recovery?.id === signerId ? "The owner's recovery phrase" : null));
  return {
    commit: commit.commit,
    time: commit.time,
    text: changeSentence(change, previous === null),
    by: signer ?? commit.author,
    signed: signer !== null,
  };
}
