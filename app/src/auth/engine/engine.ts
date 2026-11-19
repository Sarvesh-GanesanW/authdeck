/**
 * The vault engine on a phone or tablet: keys, lock, the local copy, sync with the paired
 * computer, and every action behind useVault(). Design: docs/authenticator.md.
 *
 * Secrets (device keys, opened vault keys, decrypted accounts) are held in memory only while
 * the vault is open; lock() drops and zeroes them. Everything else (the signed, encrypted logs)
 * is kept on the device so codes work without the computer.
 */
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { AppState, type AppStateStatus } from 'react-native';

import type { AccountView, CodeView, ImportPreview, NewAccount, VaultActions, VaultWarning } from '../contract';
import type { VaultEntry, VaultHead, VaultReadResult } from '../../protocol';
import { RequestError } from '../../net/client';
import { connection } from '../../net/connection';
import { useLive } from '../../state/live';
import { useStore } from '../../state/store';
import { fromBase64Url, toBase64Url, type RandomBytes } from '../../vault/bytes';
import { canonicalLine, VerifyCache, type ForkProof, type Rejection } from '../../vault/chain';
import { deviceIdFor, generateDeviceKeys, type DeviceKeys } from '../../vault/crypto';
import { entryHash, isId, isPlainObject, serializeEntry, type SignedEntry } from '../../vault/entry';
import { signRetire } from '../../vault/retire';
import { checkJoinedVault, type JoinChallenge } from '../../vault/approval';
import { checkBeacons, signBeacon, type BeaconCheck } from '../../vault/beacon';
import {
  afterOwnEntry,
  buildAccountDelete,
  buildAccountPut,
  buildDeviceAdd,
  buildDeviceHello,
  buildDeviceRemove,
  buildDeviceRename,
  buildKeyRotate,
  createVault,
  newAccountId,
  type DevicePublicKeys,
} from '../../vault/build';
import type { MigrationBatch } from '../../vault/migration';
import { openVault, type AccountRecord, type OpenVault } from '../../vault/open';
import { generateCode, secondsRemaining } from '../../vault/otp';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, recoveryKeysFromPhrase, restoreWithPhrase, unknownPhraseWords } from '../../vault/recovery';
import { replayVault, type ReplayOptions, type VaultState } from '../../vault/replay';
import { ownSealProofs, sealProofShapeProblem, type SealProof, type SealVerdicts } from '../../vault/sealProof';
import { checkRollback, findForks, type RememberedHeads } from '../../vault/rollback';
import { accountProblems, accountTitle, nextPosition, toAccountRecord, toAccountView } from './accounts';
import { listCaughtChanges, reapplyActions } from './caught';
import { scanQr } from './importer';
import { JoinController, JoinIntercepted, JoinNotApproved, type ApproverOffer } from './join';
import { keysUnlessRetired, renewDeviceKeys, type DeviceKeyStore, type KeysRetired } from './joinKeys';
import {
  DEFAULT_PREFS,
  forgetLogs,
  forgetPendingRestore,
  loadForks,
  loadSealProofs,
  loadHandledCaught,
  loadLogs,
  loadPendingRestore,
  loadPrefs,
  loadPhraseChangeRef,
  loadReplacement,
  saveForks,
  saveSealProofs,
  saveHandledCaught,
  saveLogs,
  savePendingRestore,
  savePendingPhraseChange,
  loadPendingPhraseChange,
  forgetPendingPhraseChange,
  forgetRecoveryRecords,
  pendingRestoreIds,
  keepRestoreAttempt,
  loadRestoreAttempts,
  forgetRestoreAttempts,
  savePrefs,
  savePhraseChangeRef,
  saveReplacement,
  type VaultPrefs,
} from './localCopy';
import { buildReplacement, finishReplacement, type ReplaceSteps, type VaultReplacement } from './replaceVault';
import { remakeRejected } from './remake';
import { heldRemoval, heldRemovalSentence, isRemoved, openRemovedVault, removedSentence, type HeldRemoval } from './removed';
import {
  confirmOwner,
  deviceAuth,
  forgetRestoreAttemptKeys,
  forgetVaultSecrets,
  keepRestoreAttemptKeys,
  loadDeviceKeys,
  loadRestoreAttemptKeys,
  loadHighestEpoch,
  loadOwnHead,
  loadRememberedHeads,
  saveDeviceKeys,
  saveEpochKeys,
  saveHighestEpoch,
  saveOwnHead,
  saveRememberedHeads,
} from './secrets';
import { reasonSentence, rollbackSentence } from './sentences';
import { badSealAtCurrentKey, buildSnapshot, knownBadSeals } from './snapshot';
import { useEngineVault } from './store';
import {
  appendBatches,
  headsAfterUpload,
  mergeLogs,
  ownHeadAfterUpload,
  ownHeadBeforeUpload,
  heldRemovalUploads,
  ownSentLength,
  pendingUploads,
  provenForks,
  FOLDER_TOO_LARGE,
  MAX_READ_BYTES,
  heldProblem,
  readWholeFolder,
  restoreStep,
  sendRestore,
  sendUpload,
  withOwnHead,
  withRestoreLines,
  type LocalLogs,
  type OwnHead,
  type PendingRestore,
  type Upload,
} from './sync';
import { OWN_LINES_READ_BACK, ownLineStatus, type OwnLineStatus } from './lostOwnLine';
import { appLockChange, canAuthenticate, replaceNeedsScreenLock, unlockGate, unlockRoute } from './appLock';
import { vaultFeatures } from '../../vault/features';
import { readRemovals, unpairSentence, type UnpairOutcomes } from './unpair';
import { pausedRefusal, trackWaiting, vaultWarnings } from './warnings';

const BACKGROUND_LOCK_MS = 60_000;
const READ_TIMEOUT_MS = 30_000;
const APPEND_TIMEOUT_MS = 30_000;
/** The computer allows a burst of 30 appends, then one per 500 ms; wait a little longer than that. */
const RATE_LIMIT_WAIT_MS = 1_000;
const RATE_LIMIT_RETRIES = 10;
/** A beacon is rewritten when the heads change, and at least this often so "last heard" stays fresh. */
const BEACON_REFRESH_MS = 60 * 60_000;
/** Sends of the same signed restore while the computer refuses it, before the person hears why. */
const RESTORE_ATTEMPTS = 3;
/** Waits before trying a failed sync again while the computer is online. */
const SYNC_RETRY_MS = [2_000, 5_000, 15_000, 60_000];
const DEFAULT_VAULT_NAME = 'My vault';
const UNLOCK_PROMPT = 'Unlock your codes';

const random: RandomBytes = (length) => Crypto.getRandomBytes(length);
const now = () => Date.now();
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Index of the first item that matches, or the length when none does. */
function firstIndex<T>(items: readonly T[], matches: (item: T) => boolean): number {
  const index = items.findIndex(matches);
  return index === -1 ? items.length : index;
}

function thisDeviceName(): string {
  return Device.deviceName ?? Device.modelName ?? 'This device';
}

function isRateLimited(err: unknown): boolean {
  return err instanceof RequestError && err.code === 'rate_limited';
}

function isRefused(err: unknown): boolean {
  return err instanceof RequestError && err.code === 'bad_request';
}

const REMOVED_READ_ONLY = "This device was removed from the vault, so it can only show its codes. It can't change the vault or use counter-based codes.";
const RECOVERY_REMADE =
  'Another device changed the vault while this device made a new recovery phrase, so AuthDeck set the phrase again. The phrase you wrote down still works; if you did not finish writing it down, make a new one.';
const UNNAMED_DEVICE = 'Unnamed device';
const NOT_CURRENT_PHRASE = "Those words are not this vault's current recovery phrase. Type the 12 words from your paper.";
const STALE_FLOW = 'This phrase screen is out of date. Close it and start again.';
const NOTHING_TO_CHECK = "There's no new phrase to check. Close this and make a new phrase.";
export const PHRASE_CHANGE_PENDING =
  "Your last phrase change hasn't reached the computer yet. Keep the words you wrote down for it. AuthDeck finishes it when the computer is reachable.";
const PHRASE_CHANGE_LOST_OLD_WORKS =
  "Your new phrase didn't reach the vault, so your previous phrase still works. Throw away the paper with the new words, then make a new phrase again.";
const PHRASE_CHANGE_LOST =
  "Your new phrase didn't reach the vault: another phrase change made with the same words counts instead. This is not the current recovery phrase of this vault. If you made a newer phrase, use that one.";
/** At most this many vaults are read when looking for the one a phrase restores. */
const MAX_RESTORE_SEARCH = 64;

type FlowState =
  | { kind: 'plain' }
  | { kind: 'solo-phrase'; vaultId: string; change: PendingRestore | null; stored: boolean }
  | { kind: 'replace'; vaultId: string; newVaultId: string; lines: string[] | null; record: VaultReplacement | null };
type RecoveryFlow = FlowState & { token: string };
/** Kinds a device may write while it can't open the current key: each builds a new key on the newest one it holds. */
const READ_ONLY_KINDS: ReadonlySet<string> = new Set(['device.remove', 'key.rotate', 'recovery.set']);
const READ_ONLY_REFUSED =
  "This device can't open the vault's current key, so it can only show codes, remove a device or make a new recovery phrase. The warning on the vault screen says why.";

/** An open vault: the only place decrypted secrets live. */
interface Session {
  device: DeviceKeys;
  vault: OpenVault;
}

/** Builds one entry from the state as it stands after the entries before it. */
type EntryStep = (state: VaultState, session: Session) => SignedEntry;

interface CommitOptions {
  /** Only an HOTP counter moves: allowed while new secrets are paused. */
  counterOnly?: boolean;
}

/**
 * Lines of a recovery identity (not a member device) this copy applied and the folder lacks: a
 * phrase change this device acked, whose stored record is gone. Sent before the ack that names them.
 */
function unsentRecoveryLines(logs: LocalLogs, local: VaultState, remote: VaultState): SignedEntry[] {
  const out: SignedEntry[] = [];
  for (const id of Object.keys(logs)) {
    if (Object.hasOwn(local.members, id) || !Object.hasOwn(local.chains, id)) continue;
    const have = remote.chains[id]?.length ?? 0;
    const lines = logs[id]!.slice(have, local.chains[id]!.length);
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as SignedEntry);
      } catch {
        return [];
      }
    }
  }
  return out;
}

/** Said instead of signing with the phrase on a folder behind this device's copy (Q1, Q2). */
const OLDER_COPY = 'This computer is showing an older copy of your vault. Try again once it has caught up.';

/** A restore whose seq kept going to another version, RESTORE_ATTEMPTS times (Q2, Q7). */
const KEEPS_OLDER_COPY = 'This computer keeps showing an older copy of your vault. Your phrase still works; try again later.';
/** A restore the folder doesn't show yet: this phone has the vault, the computer hasn't taken it. */
const RESTORE_NOT_SEEN =
  "This computer is showing an older copy of your vault, without this restore. Your codes are on this phone, and AuthDeck sends the restore again each time it syncs. Until the computer shows it, the phone you lost may still be in the vault on this computer.";

/** This phone's restore lost to an earlier one the computer had hidden (Q7, the accepted limit with a thief). */
const LOST_TO_EARLIER_RESTORE =
  'This computer now shows an earlier restore with your recovery phrase counting in place of the one on this phone, so this phone can no longer change the vault, and the phone that earlier restore went to may be in it. Delete the vault from this phone, then restore it again with your phrase: the new restore is made on top of the earlier one and takes that phone out. If the computer keeps showing an older copy of your vault, your phrase still works; try again later.';

/** This phone's restore lost to a phrase change signed with another copy of the phrase (L3). */
const LOST_TO_OTHER_PHRASE =
  "Your recovery phrase was changed from another copy of your phrase: someone who has the words you used to restore this phone made a new phrase, and this computer counts that change in place of this phone's restore. This phone can no longer change the vault. If you didn't do this, someone else has those words. Restore with your newest phrase through a computer you trust; if that phrase doesn't work there, the vault can't be taken back with it.";

const RESTORE_CANCELLED = 'The restore was stopped.';

const PHRASE_CHANGE_UNREADABLE = "Your last phrase change couldn't be read back. Make a new phrase.";

/** The recovery identity a stored phrase change sets, or null when its record doesn't hold one. */
function phraseChangeRecoveryId(pending: PendingRestore): string | null {
  try {
    const entry = JSON.parse(pending.lines[0]!) as SignedEntry;
    if (!entry || entry.kind !== 'recovery.set' || !isPlainObject(entry.body) || typeof entry.body.ed !== 'string') return null;
    return deviceIdFor(fromBase64Url(entry.body.ed));
  } catch {
    return null;
  }
}

class VaultEngine {
  private loaded = false;
  private prefs: VaultPrefs = DEFAULT_PREFS;
  private logs: LocalLogs = {};
  private state: VaultState | null = null;
  private heads: RememberedHeads = {};
  private session: Session | null = null;
  private folderRejections: Rejection[] = [];
  private readAt = 0;
  private rollbackWarning: string | null = null;
  /** The highest epoch this device's own replay reached; a folder below it is missing a rotation. */
  private highestEpoch = 0;
  /** Other devices' beacons from the last sync. Claims, not facts: never stored. */
  private beacons: BeaconCheck | null = null;
  /** Valid proofs that a device signed two histories; every replay applies them. */
  private forks: ForkProof[] = [];
  /**
   * Proofs of bad seals (sealProof.ts): the folder's and this device's own. Every replay applies
   * them. Kept in memory and read from the folder on each sync.
   */
  private sealProofs: SealProof[] = [];
  /** Seals already judged by this device holding their key, and own seals already found fine. */
  private sealVerdicts: SealVerdicts = new Map();
  private ownSealsChecked = new Set<string>();
  /** Seal proofs the computer refused (it keeps one per author); not sent again. */
  private sealProofsRefused = new Set<string>();
  /**
   * The recovery flow whose phrase is on screen (RecoverySetup, VaultIntro): only its token
   * confirms it, and what it holds in memory (a solo phrase change, a new vault) is dropped when
   * it ends or another one starts.
   */
  private flow: RecoveryFlow | null = null;
  /** A solo phrase change is stored and not yet applied in the folder (Settings says so). */
  private phrasePending = false;
  /** App lock is on and the device can't prompt any more: the sentence to show, and the phrase opens the vault. */
  private lockBlocked: string | null = null;
  /** The highest own entry the folder accepted (secure storage): seqs up to it are never signed again. */
  private ownHead: OwnHead | null = null;
  /** This device's own verified log in the folder as last read; null until a read since the vault opened (lostOwnLine.ts). */
  private ownLineFolder: string[] | null = null;
  /** Device names from the last open vault, for sentences shown while locked or removed. */
  private knownNames: Record<string, string | null> = {};
  /** Notices already told (lost changes by entry hash, failures by text), so each is told once. */
  private toldOnce = new Set<string>();
  private toldRemoved = false;
  /** Devices a re-key could not seal to; told once, not retried every sync. */
  private rekeyFailed = new Set<string>();
  private waitingSince = new Map<string, number>();
  /** Problems found while syncing that the person should see once, like changes that could not be made again. */
  private notices: string[] = [];
  private lastBeacon: { key: string; at: number } | null = null;
  private lockAt: number | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundedAt: number | null = null;
  private scans: MigrationBatch[] = [];
  /** Caught changes (caught.ts) re-applied or dismissed here, kept per vault. */
  private handledCaught = new Set<string>();
  /** What the computer said about devices its appends took out of the vault (unpair.ts). */
  private unpairOutcomes: UnpairOutcomes = new Map();
  /** Local changes and syncs run one at a time, so entries never race for a seq. */
  private serialTail: Promise<unknown> = Promise.resolve();
  private syncRunning: Promise<void> | null = null;
  private syncQueued = false;
  private syncRetry: ReturnType<typeof setTimeout> | null = null;
  private syncFailures = 0;
  /** Verified prefixes of each log, so a replay after a sync checks signatures only on new lines. */
  private readonly verified = new VerifyCache();
  /** True while the restore loop forgets a copy that lost: its attempts and pending record stay (Q2). */
  private keepingAttempts = false;
  /** Set by cancelRestore: the restore search stops before the next vault (nothing signed). */
  private restoreCancelled = false;
  /** A new vault from "I don't have my phrase" is stored here but not finished (the record is kept). */
  private replacing = false;
  /** False until a sync found no restore record left to settle for the open vault (L1). */
  private restoreRecordsSettled = false;
  readonly joins = new JoinController({
    random,
    now,
    request: (method, params) => connection.request(method, params),
    keysForJoin: () => this.keysForNewMembership((deviceId) => this.removedFromAVault(deviceId)),
    renewJoinKeys: () => this.renewJoinKeys(),
    adoptVault: (device, challenge) => this.adoptJoinedVault(device, challenge),
    canApprove: () => this.isAdmin(),
    approverOffer: () => this.approverOffer(),
    addDevice: (device, name) => this.addDevice(device, name),
    publish: (view) => {
      useEngineVault.setState(view);
      // Stopped join attempts feed a warning.
      this.publish();
    },
  });

  private replayOptions(): ReplayOptions & { sealProofs: readonly SealProof[] } {
    return { cache: this.verified, forks: this.forks, sealProofs: this.sealProofs };
  }

  private replay(vaultId: string, logs: LocalLogs): VaultState {
    return replayVault(vaultId, logs, this.replayOptions());
  }

  // --- Lifecycle --------------------------------------------------------------------------

  start(): () => void {
    this.load().catch((err) => this.report(err));
    const offEvents = connection.onEvent((msg) => {
      if (msg.event === 'vault.changed') {
        if ((msg.data as { vaultId: string }).vaultId === this.prefs.vaultId) this.syncSoon();
      } else if (msg.event.startsWith('vault.join.')) this.joins.handleEvent(msg.event, msg.data);
    });
    let wasOnline = useLive.getState().status === 'online';
    const offLive = useLive.subscribe((live) => {
      const online = live.status === 'online';
      if (online && !wasOnline) this.syncSoon();
      wasOnline = online;
      this.publish();
    });
    const appState = AppState.addEventListener('change', (next) => this.onAppState(next));
    return () => {
      offEvents();
      offLive();
      appState.remove();
      this.joins.dispose();
      this.lock();
      if (this.syncRetry) clearTimeout(this.syncRetry);
    };
  }

  private async load(): Promise<void> {
    try {
      this.prefs = await loadPrefs();
      const vaultId = this.prefs.vaultId;
      if (vaultId) {
        this.forks = await loadForks(vaultId);
        this.sealProofs = await loadSealProofs(vaultId);
        this.logs = await loadLogs(vaultId);
        this.state = this.replay(vaultId, this.logs);
        this.heads = await loadRememberedHeads(vaultId);
        this.highestEpoch = await loadHighestEpoch(vaultId);
        this.ownHead = await loadOwnHead(vaultId);
        this.ownLineFolder = null;
        this.handledCaught = await loadHandledCaught(vaultId);
        this.phrasePending = (await loadPhraseChangeRef(vaultId)) !== null;
        this.replacing = (await loadReplacement().catch(() => null)) !== null;
        // A solo vault has no seal proofs: its bad seals can't be reached (only R and one device seal).
        if (this.state.kind === 'solo') this.sealProofs = [];
      }
    } finally {
      this.loaded = true;
      this.publish();
    }
    if (this.prefs.vaultId && !this.prefs.appLock) await this.openSession().catch((err) => this.report(err));
    if (this.prefs.vaultId) await this.checkLockRoute();
    this.syncSoon();
  }

  private deviceName(id: string): string | null {
    return (this.session?.vault.deviceNames ?? this.knownNames)[id] ?? null;
  }

  /** Whether this device still holds every line it signed (lostOwnLine.ts). */
  private ownLine(): OwnLineStatus {
    const id = this.prefs.deviceId;
    return ownLineStatus({
      ownHead: this.ownHead,
      localChain: (id && this.state?.chains[id]) || [],
      folderChain: this.ownLineFolder,
      folderHead: (id && this.heads[id]) || null,
    });
  }

  private warnings(): { warnings: VaultWarning[]; secretsPaused: boolean } {
    if (!this.state) return { warnings: [], secretsPaused: false };

    const found = vaultWarnings({
      state: this.state,
      self: this.prefs.deviceId,
      beacons: this.beacons,
      highestEpoch: this.highestEpoch,
      waitingSince: this.waitingSince,
      keyProblems: this.session?.vault.keyProblems ?? [],
      stoppedJoins: this.joins.stoppedAttempts(),
      now: now(),
      deviceName: (id) => this.deviceName(id) ?? 'A device',
    });
    // A line of its own lost for good: this device can never write again, so that comes first and stays.
    const own = this.ownLine();
    if (own.kind === 'lost') {
      const text = this.lostText(own.message);
      return { warnings: [{ id: `lost-own-line:${own.seq}`, kind: 'lost-own-line', text }, ...found.warnings], secretsPaused: true };
    }
    // A current key someone in the vault can't open must be replaced before new secrets go under it.
    return this.needsKeyForBadSeal() ? { ...found, secretsPaused: true } : found;
  }

  /**
   * True when a proven fork proof against a recovery identity holds the restore that added this
   * device: the computer showed this phone a copy without an earlier restore, and now counts that
   * one in this phone's place (Q7). Restoring again signs on top of it and takes the vault back.
   */
  private lostCause(): 'restore' | 'phrase' | null {
    const self = this.prefs.deviceId;
    if (!self) return null;
    const parse = (line: string): SignedEntry | null => {
      try {
        return JSON.parse(line) as SignedEntry;
      } catch {
        return null;
      }
    };
    for (const proof of this.forks) {
      if (this.state && Object.hasOwn(this.state.members, proof.deviceId)) continue;
      const entries = proof.lines.map(parse);
      if (!entries.some((entry) => entry?.kind === 'device.add' && entry.body.device === self)) continue;
      // L3: the line that counts there now says which: an earlier restore, or a phrase change.
      const counted = this.state?.chains[proof.deviceId]?.[proof.seq];
      const winner = entries.find((entry) => entry !== null && entryHash(entry) === counted);
      return winner?.kind === 'recovery.set' ? 'phrase' : 'restore';
    }
    return null;
  }

  /** What this device says once it lost a line of its own for good: the cause when it is known. */
  private lostText(fallback: string): string {
    const cause = this.lostCause();
    return cause === 'phrase' ? LOST_TO_OTHER_PHRASE : cause === 'restore' ? LOST_TO_EARLIER_RESTORE : fallback;
  }


  /** Bad seals this device knows of (snapshot.ts knownBadSeals), while the vault is open. */
  private knownBadSeals() {
    const session = this.session;
    if (!session || !this.state) return [];
    return knownBadSeals(this.state, session.vault, this.logs, this.sealProofs, this.sealVerdicts);
  }

  /** The change that made the current key gave someone a copy that doesn't open (rule 3 then applies). */
  private needsKeyForBadSeal(): boolean {
    return this.state !== null && badSealAtCurrentKey(this.state, this.knownBadSeals());
  }

  private removedText(): string | null {
    const deviceId = this.prefs.deviceId;
    if (!this.state || !deviceId) return null;
    const held = this.heldRemoval();
    if (held) return heldRemovalSentence(held, (id) => this.deviceName(id), this.computerName());
    return removedSentence(this.state, deviceId, (id) => this.deviceName(id));
  }

  /** This removed device's counter-removals the folder doesn't hold yet (removed.ts); sent after pairing again. */
  private heldRemoval(): HeldRemoval | null {
    const deviceId = this.prefs.deviceId;
    if (!this.state || !deviceId) return null;
    return heldRemoval(this.state, deviceId, this.heads[deviceId]?.seq ?? -1);
  }

  /** The connected computer's name, or the saved one's while it refuses this device (say, after unpairing it). */
  private computerName(): string | null {
    const live = useLive.getState().agent?.name;
    if (live) return live;
    const { computers, activeId } = useStore.getState();
    return computers.find((c) => c.agentId === activeId)?.name ?? null;
  }

  private isRemoved(): boolean {
    return isRemoved(this.state, this.prefs.deviceId);
  }

  private publish(): void {
    const live = useLive.getState();
    const { warnings, secretsPaused } = this.warnings();
    useEngineVault.setState(
      buildSnapshot({
        loaded: this.loaded,
        prefs: this.prefs,
        state: this.state,
        open: this.session?.vault ?? null,
        thisDevice: this.prefs.deviceId,
        folderRejections: this.folderRejections,
        readAt: this.readAt,
        phrasePending: this.phrasePending,
        replacing: this.replacing,
        rollbackWarning: this.rollbackWarning,
        lockAt: this.lockAt,
        computerName: live.agent?.name ?? null,
        computerOnline: live.status === 'online',
        heardAt: this.beacons?.heardAt ?? {},
        forked: new Set(Object.keys(this.state?.forked ?? {})),
        warnings,
        secretsPaused,
        removed: this.removedText(),
        appLockBlocked: this.lockBlocked,
        heldRemoval: this.heldRemoval() !== null,
        logs: this.logs,
        handledCaught: this.handledCaught,
        sealProofs: this.sealProofs,
        sealVerdicts: this.sealVerdicts,
      }),
    );
  }

  /** A background failure (sync, auto-open) the person should know about. */
  private report(err: unknown): void {
    const message = err instanceof Error ? err.message : 'Something went wrong with the vault.';
    useLive.getState().showToast({ tone: 'fail', title: message });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serialTail.then(work, work);
    this.serialTail = run.catch(() => undefined);
    return run;
  }

  // --- Lock -------------------------------------------------------------------------------

  async unlock(): Promise<void> {
    if (this.session) return this.touch();
    if (!this.prefs.vaultId) throw new Error('There is no vault on this device yet.');
    const route = unlockRoute(this.prefs.appLock, await deviceAuth());
    this.setLockBlocked(route.kind === 'phrase' ? route.message : null);
    if (route.kind === 'phrase') throw new Error(route.message);
    if (route.kind === 'device') await confirmOwner(UNLOCK_PROMPT);
    await this.openSession();
    // An interrupted "I don't have my phrase" needs the open vault: finish it now, not at the next change.
    this.syncSoon();
  }

  /**
   * App lock for a guarded change outside the vault (appLock.ts unlockGate): the device prompt
   * with `reason`, which opens the vault, so the auto-lock time also covers the next change.
   */
  async requireUnlock(reason: string): Promise<void> {
    const gate = unlockGate({ hasVault: this.prefs.vaultId !== null, appLock: this.prefs.appLock, open: this.session !== null, auth: await deviceAuth() });
    if (gate.kind === 'refuse') throw new Error(gate.message);
    if (gate.kind === 'prompt') {
      await confirmOwner(reason);
      await this.openSession();
      this.syncSoon();
    } else if (this.session) this.touch();
  }

  /**
   * Opens the vault with the recovery phrase instead of the device prompt: for a device whose
   * screen lock was removed after app lock went on, so app lock never locks the person out.
   */
  async unlockWithPhrase(words: string[]): Promise<void> {
    if (this.session) return this.touch();
    if (!this.prefs.vaultId || !this.state) throw new Error('There is no vault on this device yet.');
    // The current phrase, or a new one whose change is still on its way (once it applies, only that one).
    const recovery = this.phraseKeys(words);
    // Locally the change may already count (its ack is placed), so the phrase it replaces works too until the folder has it.
    const stored = this.phrasePending ? await this.storedPhraseChange() : null;
    const accepted = [this.state.recovery?.deviceId, await this.pendingRecoveryId(), stored?.recoveryId];
    if (!accepted.includes(recovery.deviceId)) throw new Error(NOT_CURRENT_PHRASE);
    recovery.edSecret.fill(0);
    recovery.xSecret.fill(0);
    await this.openSession();
    this.setLockBlocked(null);
  }

  private setLockBlocked(text: string | null): void {
    if (this.lockBlocked === text) return;
    this.lockBlocked = text;
    this.publish();
  }

  /** Whether app lock can still prompt on this device; looked at when the vault is locked. */
  private async checkLockRoute(): Promise<void> {
    if (!this.prefs.appLock || this.session) return this.setLockBlocked(null);
    const route = unlockRoute(true, await deviceAuth());
    this.setLockBlocked(route.kind === 'phrase' ? route.message : null);
  }

  lock(): void {
    const session = this.session;
    this.session = null;
    this.lockAt = null;
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    if (session) {
      session.device.edSecret.fill(0);
      session.device.xSecret.fill(0);
      Object.values(session.vault.keys).forEach((key) => key.fill(0));
    }
    this.publish();
  }

  private async ensureOpen(): Promise<Session> {
    if (!this.session) await this.unlock();
    return this.requireOpen();
  }

  private requireOpen(): Session {
    if (!this.session) throw new Error('Unlock the vault first.');
    return this.session;
  }

  /** Reads the device keys from secure storage and opens the vault with them. */
  private async openSession(): Promise<void> {
    const vaultId = this.prefs.vaultId;
    if (!vaultId || !this.state) throw new Error('There is no vault on this device yet.');
    const device = await loadDeviceKeys();
    if (!device) throw new Error("This device's keys are missing from secure storage. Restore the vault with your recovery phrase.");
    if (this.state.members[device.deviceId]?.removed) {
      this.session = { device, vault: openRemovedVault(this.state, device) };
      this.knownNames = this.session.vault.deviceNames;
      this.touch();
      return;
    }
    let vault: OpenVault;
    try {
      vault = openVault(this.state, device);
    } catch (err) {
      // L2: a device that lost its place says why, not "approve it from a device in the vault".
      const own = this.ownLine();
      if (own.kind === 'lost') throw new Error(this.lostText(own.message), { cause: err });
      throw err;
    }
    this.session = { device, vault };
    this.knownNames = this.session.vault.deviceNames;
    await saveEpochKeys(vaultId, this.session.vault.keys);
    this.touch();
  }

  /**
   * Re-opens after the state changed: new accounts, names, or a new key after a rotation. A
   * removed device keeps showing what it last could read, read-only, and says who removed it.
   */
  private async reopen(): Promise<void> {
    const session = this.session;
    if (!session || !this.state || !this.prefs.vaultId) return;
    if (this.isRemoved()) {
      session.vault = openRemovedVault(this.state, session.device);
      this.tellRemoved();
      return;
    }
    const epochBefore = session.vault.epoch;
    session.vault = openVault(this.state, session.device);
    this.knownNames = session.vault.deviceNames;
    if (session.vault.epoch !== epochBefore) await saveEpochKeys(this.prefs.vaultId, session.vault.keys);
  }

  private tellRemoved(): void {
    const text = this.removedText();
    if (!text || this.toldRemoved) return;
    this.toldRemoved = true;
    this.notices.push(text);
  }

  /** The device prompt; when the device can't prompt any more, an open vault is proof enough (appLock.ts). */
  private async confirmOwnerOrOpen(promptMessage: string): Promise<void> {
    const change = appLockChange({ on: false, current: true, auth: await deviceAuth(), open: this.session !== null });
    if (change.kind === 'refuse') throw new Error(change.message);
    if (change.kind === 'prompt') await confirmOwner(promptMessage);
  }

  /** Deletes a removed device's copy and keys, once the person confirms. */
  async deleteRemovedVault(): Promise<void> {
    if (!this.isRemoved() && this.ownLine().kind !== 'lost')
      throw new Error('This device is still in the vault. Remove it from another device in the vault first.');
    if (this.prefs.appLock) await this.confirmOwnerOrOpen('Delete the vault from this device');
    await this.serial(() => this.forgetVault());
  }

  private async forgetVault(): Promise<void> {
    const vaultId = this.prefs.vaultId;
    this.lock();
    if (!vaultId) return;
    await Promise.all([forgetLogs(vaultId), forgetVaultSecrets(vaultId)]);
    // The restore and phrase-change records and kept attempt keys go with it (L1); the restore
    // redo loop keeps its attempts in `keepAttempts` while it forgets a copy that lost.
    if (!this.keepingAttempts) await Promise.all([forgetRecoveryRecords(vaultId), forgetRestoreAttemptKeys(vaultId)]);
    this.logs = {};
    this.state = null;
    this.heads = {};
    this.ownHead = null;
    this.ownLineFolder = null;
    this.flow = null;
    this.phrasePending = false;
    this.handledCaught = new Set();
    this.knownNames = {};
    this.rollbackWarning = null;
    this.folderRejections = [];
    this.resetSyncFindings();
    await this.setPrefs({ vaultId: null, deviceId: null, recoverySavedAt: null, location: null, folderPath: null });
  }

  private resetSyncFindings(): void {
    this.highestEpoch = 0;
    this.beacons = null;
    this.forks = [];
    this.sealProofs = [];
    this.sealVerdicts = new Map();
    this.ownSealsChecked = new Set();
    this.sealProofsRefused = new Set();
    this.waitingSince = new Map();
    this.lastBeacon = null;
    this.toldOnce = new Set();
    this.toldRemoved = false;
    this.rekeyFailed = new Set();
  }

  /** Any use of the vault pushes the auto-lock back. */
  private touch(): void {
    if (!this.session) return;
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockAt = now() + this.prefs.autoLockMs;
    this.lockTimer = setTimeout(() => this.lock(), this.prefs.autoLockMs);
    this.publish();
  }

  private onAppState(next: AppStateStatus): void {
    // Only 'background' counts: the Face ID prompt itself makes the app 'inactive'.
    if (next === 'background') {
      this.backgroundedAt = now();
      return;
    }
    if (next !== 'active' || this.backgroundedAt === null) return;
    const away = now() - this.backgroundedAt;
    this.backgroundedAt = null;
    // Timers don't run while suspended, so both limits are checked on return.
    if (away >= BACKGROUND_LOCK_MS || (this.lockAt !== null && now() >= this.lockAt)) this.lock();
    // The screen lock may have been removed meanwhile (in the device settings).
    void this.checkLockRoute().catch(() => undefined);
    this.syncSoon();
  }

  async setAppLock(on: boolean): Promise<void> {
    if (on === this.prefs.appLock) return;
    const change = appLockChange({ on, current: this.prefs.appLock, auth: await deviceAuth(), open: this.session !== null });
    if (change.kind === 'nothing') return;
    if (change.kind === 'refuse') throw new Error(change.message);
    if (change.kind === 'prompt') await confirmOwner(on ? 'Turn on app lock' : 'Turn off app lock');
    await this.setPrefs({ appLock: on });
    if (!on) this.setLockBlocked(null);
  }

  setAutoLock(ms: number): void {
    void this.setPrefs({ autoLockMs: ms }).then(() => this.touch());
  }

  private async setPrefs(patch: Partial<VaultPrefs>): Promise<void> {
    const next = { ...this.prefs, ...patch };
    // Saved first: a value the store refuses (over a cap) never becomes the one in memory.
    await savePrefs(next);
    this.prefs = next;
    this.publish();
  }

  // --- Local changes ----------------------------------------------------------------------

  /**
   * Signs entries one after another, checks they apply, keeps them in the local copy, then tries
   * to send them. Offline, they wait in the local copy until the computer is back.
   */
  private async commit(steps: EntryStep[], options: CommitOptions = {}): Promise<SignedEntry[]> {
    const entries = await this.serial(() => this.appendOwn(steps, options));
    this.syncSoon();
    return entries;
  }

  /** The body of commit, for callers already inside serial() (sync's own changes). */
  private async appendOwn(steps: EntryStep[], { counterOnly = false }: CommitOptions = {}): Promise<SignedEntry[]> {
    const session = this.requireOpen();
    const vaultId = this.prefs.vaultId!;
    if (this.isRemoved()) throw new Error(REMOVED_READ_ONLY);
    const nextSeq = (this.state!.heads[session.device.deviceId]?.seq ?? -1) + 1;
    // A seq the folder already accepted is never signed again (two entries at one seq read as two histories).
    if (this.ownHead && nextSeq <= this.ownHead.seq) {
      const status = this.ownLine();
      throw new Error(status.kind === 'held' ? OWN_LINES_READ_BACK : status.message);
    }
    let draft = this.state!;
    const built: SignedEntry[] = [];
    for (const step of steps) {
      const entry = step(draft, session);
      // Built on an older key than the current one, only a key change makes sense (open.ts readOnly).
      if (session.vault.readOnly !== null && !READ_ONLY_KINDS.has(entry.kind)) throw new Error(READ_ONLY_REFUSED);
      const refusal = pausedRefusal(entry.kind, counterOnly, this.warnings());
      if (refusal) throw new Error(refusal);
      built.push(entry);
      // The next entry chains on this one; only the author's head changes for building.
      draft = afterOwnEntry(draft, entry);
    }
    const logs = { ...this.logs };
    for (const entry of built) logs[entry.author] = [...(logs[entry.author] ?? []), serializeEntry(entry)];
    const state = this.replay(vaultId, logs);
    for (const entry of built) {
      const item = state.history.find((h) => h.hash === entryHash(entry));
      if (item?.status !== 'applied') throw new Error(item?.reason ? reasonSentence(item.reason) : 'That change could not be applied.');
    }
    this.logs = logs;
    this.state = state;
    await saveLogs(vaultId, logs);
    await this.reopen();
    this.touch();
    return built;
  }

  // --- Sync -------------------------------------------------------------------------------

  /** Syncs in the background; failures retry with backoff while the computer is online. */
  private syncSoon(): void {
    if (this.syncRetry) clearTimeout(this.syncRetry);
    this.syncRetry = null;
    this.sync().then(
      () => {
        this.syncFailures = 0;
      },
      () => {
        if (useLive.getState().status !== 'online') return;
        const delay = SYNC_RETRY_MS[Math.min(this.syncFailures, SYNC_RETRY_MS.length - 1)]!;
        this.syncFailures++;
        this.syncRetry = setTimeout(() => this.syncSoon(), delay);
      },
    );
  }

  /** Reads the folder, merges, sends what it lacks. Concurrent calls share one extra run. */
  private sync(): Promise<void> {
    if (this.syncRunning) {
      this.syncQueued = true;
      return this.syncRunning;
    }
    this.syncRunning = (async () => {
      try {
        do {
          this.syncQueued = false;
          await this.syncOnce();
        } while (this.syncQueued);
      } finally {
        this.syncRunning = null;
      }
    })();
    return this.syncRunning;
  }

  private async syncOnce(): Promise<void> {
    if (useLive.getState().status !== 'online') return;
    await this.resumeReplacement();
    const vaultId = this.prefs.vaultId;
    if (!vaultId) return;
    // Beacons first: one written after this read would name entries the read missed.
    const beaconFiles = await this.readBeacons(vaultId);
    const { forks: folderForks, sealProofs: folderSealProofs } = await this.readFolderProofs(vaultId);
    const folder = await this.readFolder(vaultId);
    await this.serial(async () => {
      if (this.prefs.vaultId !== vaultId) return;
      this.keepSealProofs(folderSealProofs);
      const remoteState = this.replay(vaultId, folder.logs);
      this.ownLineFolder = [...(remoteState.chains[this.prefs.deviceId ?? ''] ?? [])];
      const localState = this.replay(vaultId, this.logs);
      const merged = mergeLogs(this.logs, localState, folder.logs, remoteState);
      const check = checkRollback(this.heads, remoteState);
      if (check.problems.length > 0) {
        this.rollbackWarning = rollbackSentence(check.problems, (id) => this.deviceName(id) ?? 'a device', useLive.getState().agent?.name ?? null);
        // Shown at once: the rest of this sync may fail against the older copy.
        this.publish();
      }
      const found = merged.diverged.length > 0 ? findForks(this.logs, localState, folder.logs, remoteState, this.verified) : [];
      await this.keepForks(vaultId, provenForks(this.replay(vaultId, merged.logs), [...this.forks, ...found, ...folderForks], merged.logs, this.verified));
      await this.shareForks(vaultId, folderForks);
      // Solo: a proof about the recovery phrase only chooses which of its versions counts, so this
      // copy reads the same ones as the computer does (the folder's), never one only it holds.
      if (remoteState.kind === 'solo') this.forks = this.forks.filter((f) => Object.hasOwn(remoteState.members, f.deviceId) || folderForks.some((g) => g.deviceId === f.deviceId && g.seq === f.seq));
      this.logs = merged.logs;
      this.state = this.replay(vaultId, merged.logs);
      this.heads = check.heads;
      this.folderRejections = remoteState.rejected.filter((r) => !r.hash);
      if (!this.restoreRecordsSettled) this.restoreRecordsSettled = await this.settleHeldRestores(vaultId, remoteState);
      this.readAt = now();
      this.beacons = checkBeacons(this.state, beaconFiles, this.prefs.deviceId);
      await this.raiseHighestEpoch(vaultId, this.state.epoch);
      this.proveOwnBadSeals(vaultId);
      await this.settleOwnChanges(remoteState);
      await saveLogs(vaultId, this.logs);
      await saveRememberedHeads(vaultId, this.heads);
      await this.rememberFolder(vaultId, folder.location);
      this.waitingSince = trackWaiting(this.waitingSince, this.state, now());
      const removed = this.isRemoved();
      // A removed device sends nothing, except a removal it signed in true symmetry with its own.
      const held = this.heldRemoval();
      if (!removed && this.phrasePending) {
        const pending = await this.storedPhraseChange();
        if (pending) await this.ackPhraseChange(pending).catch((err) => this.report(err));
      }
      const uploaded = this.prefs.deviceId && (!removed || held) ? await this.uploadOutbox(vaultId, remoteState, held) : true;
      if (!removed) await this.resendPhraseChange();
      try {
        await this.reopen();
      } catch (err) {
        // L4: what this sync found is shown even when the vault no longer opens.
        this.publish();
        throw err;
      }
      await this.shareSealProofs(vaultId, folderSealProofs);
      if (uploaded && !removed) await this.writeBeacon(vaultId);
      this.publish();
      this.showNotices();
    });
  }

  /**
   * What this device writes by itself once a sync has settled, before sending (rules 2 to 4): a
   * fresh key when key changes clashed, its own rejected changes made again, and the current key
   * for devices left without it. Needs the open vault; never while a device has seen changes the
   * folder lacks, since the vault as this device sees it may not be the real one.
   */
  private async settleOwnChanges(remoteState: VaultState): Promise<void> {
    const session = this.session;
    if (!session || !this.state || !this.prefs.deviceId || this.isRemoved()) return;
    if (this.warnings().warnings.some((w) => w.kind === 'withheld')) return;
    // In a solo vault only the recovery phrase changes the key or approves a device (a restore).
    const solo = this.state.kind === 'solo';
    if (!solo) await this.makeFreshKey(session);
    // New secrets made again under a key that must be replaced would reach the wrong devices, and
    // a device that can't open the current key can't make them again at all.
    if (this.warnings().secretsPaused || session.vault.readOnly !== null) return;
    this.remakeOwnRejected(remoteState, session);
    if (!solo) await this.rekeyUnkeyed(session);
  }

  /**
   * Rule 3: an admin device that holds the current key replaces it when the vault needs a fresh
   * one, or when the change that made it gave someone a copy that doesn't open.
   */
  private async makeFreshKey(session: Session): Promise<void> {
    if (!this.state || !(this.state.needsFreshKey || this.needsKeyForBadSeal())) return;
    if (!this.isAdmin() || session.vault.epoch !== this.state.epoch || session.vault.readOnly !== null) return;
    let skipped: string[] = [];
    try {
      await this.appendOwn([
        (state, s) => {
          const rotation = buildKeyRotate(state, s.device, { currentKey: s.vault.currentKey, random, time: now() });
          rotation.newKey.fill(0);
          skipped = rotation.skipped;
          return rotation.entry;
        },
      ]);
    } catch (err) {
      // The sync goes on; the paused banner stays until a fresh key applies.
      this.noticeOnce(`AuthDeck could not make a fresh vault key on this device: ${(err as Error).message}`);
      return;
    }
    if (skipped.length > 0) this.notices.push(this.unsealableSentence(skipped));
  }

  /**
   * Rule 2: this device's changes the rules now reject are made again on the vault as it stands,
   * sent or not, without signing a sent seq twice. Uses the keys open before this read, which
   * may include a key that lost to another.
   */
  private remakeOwnRejected(remoteState: VaultState, session: Session): void {
    const deviceId = this.prefs.deviceId!;
    const remade = remakeRejected({
      logs: this.logs,
      state: this.state!,
      sentLength: ownSentLength(remoteState, deviceId, this.ownHead),
      device: session.device,
      keys: session.vault.keys,
      random,
      time: now(),
      replay: this.replayOptions(),
    });
    if (!remade) return;
    this.logs = remade.logs;
    this.state = remade.state;
    for (const lost of remade.lost) this.noticeOnce(lost.text, lost.hash);
    if (!remade.recoveryChanged) return;
    if (!remade.lost.some((lost) => lost.kind === 'recovery.set')) this.notices.push(RECOVERY_REMADE);
    void this.setPrefs({ recoverySavedAt: null });
  }

  /** Rule 4: an admin device gives the current key to every active device left without it. */
  private async rekeyUnkeyed(session: Session): Promise<void> {
    if (!this.isAdmin() || session.vault.epoch !== this.state!.epoch) return;
    const targets = this.state!.unkeyedDevices.filter((id) => id !== session.device.deviceId && !this.rekeyFailed.has(id));
    for (const id of targets) {
      const name = session.vault.deviceNames[id] ?? UNNAMED_DEVICE;
      try {
        await this.appendOwn([
          (state, s) => {
            const member = state.members[id]!;
            const device = { deviceId: id, edPublic: fromBase64Url(member.ed), xPublic: fromBase64Url(member.x) };
            return buildDeviceAdd(state, s.device, { device, role: member.role, name, currentKey: s.vault.currentKey, random, time: now() });
          },
        ]);
      } catch (err) {
        this.rekeyFailed.add(id);
        this.notices.push(`${name} could not be given the current vault key: ${(err as Error).message} Approve it again from this device, or remove it.`);
      }
    }
  }

  private unsealableSentence(deviceIds: string[]): string {
    const who = deviceIds.map((d) => this.deviceName(d) ?? 'a device').join(', ');
    return `The new vault key could not be given to ${who}, whose keys can't be used. Approve it again from this device, or remove it.`;
  }

  /** A notice told once per `key` (default: its text), however many syncs find it again. */
  private noticeOnce(text: string, key = text): void {
    if (this.toldOnce.has(key)) return;
    this.toldOnce.add(key);
    this.notices.push(text);
  }

  private showNotices(): void {
    for (const notice of this.notices.splice(0)) this.report(new Error(notice));
  }

  /** Keeps every valid proof of a device that signed two histories, once per device and seq. */
  private async keepForks(vaultId: string, proofs: ForkProof[]): Promise<void> {
    const known = new Set(this.forks.map((f) => `${f.deviceId}:${f.seq}`));
    const fresh = proofs.filter((f) => !known.has(`${f.deviceId}:${f.seq}`));
    if (fresh.length === 0) return;
    this.forks = [...this.forks, ...fresh];
    await saveForks(vaultId, this.forks);
  }

  /** Sends the folder the proofs it lacks, so the computer and every other device cut that device off too. */
  private async shareForks(vaultId: string, inFolder: readonly ForkProof[]): Promise<void> {
    for (const proof of this.forks) {
      if (inFolder.some((f) => f.deviceId === proof.deviceId && f.seq <= proof.seq)) continue;
      try {
        await this.withRateLimit(() => connection.request('vault.forks.write', { vaultId, proof }, APPEND_TIMEOUT_MS));
      } catch (err) {
        // The computer checks proofs itself; one it refuses is still applied here.
        if (!isRefused(err)) throw err;
      }
    }
  }

  /** The folder's fork proofs and seal proofs; seal proofs of the wrong shape are dropped (replays check the rest). */
  private async readFolderProofs(vaultId: string): Promise<{ forks: ForkProof[]; sealProofs: SealProof[] }> {
    try {
      const read = await connection.request('vault.forks.read', { vaultId }, READ_TIMEOUT_MS);
      // Under the same cap as a folder read: every byte the computer sends about this vault counts (A4).
      if (JSON.stringify(read).length > MAX_READ_BYTES) throw new Error(FOLDER_TOO_LARGE);
      const sealProofs = Array.isArray(read.sealProofs) ? read.sealProofs.filter((proof) => sealProofShapeProblem(proof) === null) : [];
      return { forks: read.forks, sealProofs };
    } catch (err) {
      if (err instanceof RequestError && err.code === 'not_found') return { forks: [], sealProofs: [] };
      throw err;
    }
  }

  /** Keeps seal proofs not kept yet, once per entry and recipient. */
  private keepSealProofs(proofs: readonly SealProof[]): void {
    if (this.state?.kind === 'solo') return;
    const known = new Set(this.sealProofs.map((p) => `${p.entry}:${p.to}`));
    const fresh = proofs.filter((p) => !known.has(`${p.entry}:${p.to}`));
    if (fresh.length === 0) return;
    this.sealProofs = [...this.sealProofs, ...fresh];
    // Kept on the device too, so a replay before the next sync still applies them.
    const vaultId = this.prefs.vaultId;
    if (vaultId) saveSealProofs(vaultId, this.sealProofs).catch((err) => this.report(err));
  }

  /**
   * The recipient's side of a bad seal: proves every seal this device was given that doesn't open
   * to its entry's key, and replays with the proofs, so every device and the computer can see it.
   */
  private proveOwnBadSeals(vaultId: string): void {
    const session = this.session;
    if (!session || !this.state || this.isRemoved()) return;
    const before = this.sealProofs.length;
    this.keepSealProofs(ownSealProofs(this.state, this.logs, session.device, this.ownSealsChecked));
    if (this.sealProofs.length !== before) this.state = this.replay(vaultId, this.logs);
  }

  /** Sends the folder the seal proofs it lacks; the computer checks each and refuses one that doesn't hold. */
  private async shareSealProofs(vaultId: string, inFolder: readonly SealProof[]): Promise<void> {
    const stored = new Set(inFolder.map((p) => `${p.entry}:${p.to}`));
    for (const sealProof of this.sealProofs) {
      const id = `${sealProof.entry}:${sealProof.to}`;
      if (stored.has(id) || this.sealProofsRefused.has(id)) continue;
      try {
        await this.withRateLimit(() => connection.request('vault.forks.write', { vaultId, sealProof }, APPEND_TIMEOUT_MS));
      } catch (err) {
        // The computer checks proofs itself; one it refuses is still applied here.
        if (!isRefused(err)) throw err;
        this.sealProofsRefused.add(id);
      }
    }
  }

  /** Only this device's own replay raises the remembered epoch; a beacon's claim never does. */
  private async raiseHighestEpoch(vaultId: string, epoch: number): Promise<void> {
    if (epoch <= this.highestEpoch) return;
    this.highestEpoch = epoch;
    await saveHighestEpoch(vaultId, epoch);
  }

  /** Where the folder lives, for Settings; asks the computer for its path once per change of place. */
  private async rememberFolder(vaultId: string, location: 'personal' | 'team' | null): Promise<void> {
    if (location === this.prefs.location && this.prefs.folderPath) return;
    const { vaults } = await connection.request('vault.list', {});
    const path = vaults.find((v) => v.vaultId === vaultId)?.path ?? null;
    await this.setPrefs({ location, folderPath: path });
  }

  /**
   * Sends what the folder lacks: lines it lost as a repair proven by the remembered heads (this
   * device's own up to the stored own head), then this device's new lines. Unsent lines that
   * wait on entries the folder lacks stay queued. True when everything went. With `held` (this
   * device was removed), only its own lines up to its held counter-removals go.
   */
  private async uploadOutbox(vaultId: string, remoteState: VaultState, held: HeldRemoval | null = null): Promise<boolean> {
    const state = this.state!;
    const deviceId = this.prefs.deviceId!;
    let outbox = pendingUploads(this.logs, state, remoteState, deviceId, withOwnHead(this.heads, deviceId, this.ownHead));
    // A pending phrase change goes first, in the batch with this device's lines (its ack names it).
    const phrase = this.phrasePending && !held ? await this.storedPhraseChange() : null;
    const phraseStep = phrase ? restoreStep(remoteState, phrase) : null;
    // Without a readable record, the recovery lines this copy already counts (a change it acked) still go first.
    const rLines = phraseStep?.kind === 'send' ? phraseStep.entries : held ? [] : unsentRecoveryLines(this.logs, state, remoteState);
    if (rLines.length > 0) {
      const fresh = outbox.find((u) => !u.repair);
      outbox = [...outbox.filter((u) => u !== fresh), { entries: [...rLines, ...(fresh?.entries ?? [])], repair: false }];
    }
    const uploads = held ? heldRemovalUploads(outbox, state, deviceId, held.lastSeq) : outbox;
    // heldRemovalUploads already checked every line it kept.
    const unsendable = new Set(held ? [] : state.history.filter((h) => h.status !== 'applied').map((h) => h.hash));
    let complete = true;
    for (const upload of uploads) {
      const sendable = upload.repair
        ? upload.entries
        : upload.entries.slice(
            0,
            firstIndex(upload.entries, (e) => unsendable.has(entryHash(e as SignedEntry))),
          );
      if (sendable.length < upload.entries.length) complete = false;
      if (sendable.length === 0) continue;
      const ready: Upload = { ...upload, entries: sendable };
      // Counted as sent before it goes: if the answer is lost, the next sync sends these same
      // bytes again (the computer keeps a line the rules now reject as a placeholder) and never
      // signs another entry at their seq.
      await this.rememberOwnHead(vaultId, ownHeadBeforeUpload(this.ownHead, deviceId, ready));
      const { sent, blocked } = await sendUpload(ready, state, deviceId, { send: (u) => this.upload(vaultId, u), isRefused });
      if (blocked) complete = false;
      if (!sent) continue;
      this.heads = headsAfterUpload(this.heads, state, sent);
      await saveRememberedHeads(vaultId, this.heads);
      await this.rememberOwnHead(vaultId, ownHeadAfterUpload(this.ownHead, state, deviceId, sent));
    }
    return complete;
  }

  private async rememberOwnHead(vaultId: string, head: OwnHead | null): Promise<void> {
    if (!head || (this.ownHead && head.seq <= this.ownHead.seq)) return;
    this.ownHead = head;
    await saveOwnHead(vaultId, head);
  }

  private async readBeacons(vaultId: string): Promise<Record<string, string>> {
    try {
      return (await connection.request('vault.beacons.read', { vaultId }, READ_TIMEOUT_MS)).beacons;
    } catch (err) {
      if (err instanceof RequestError && err.code === 'not_found') return {};
      throw err;
    }
  }

  /**
   * Signs this device's beacon for the folder as it now stands (everything was sent), so other
   * devices notice if the folder later hides it from them. Needs the device keys, so only while open.
   */
  private async writeBeacon(vaultId: string): Promise<void> {
    const session = this.session;
    if (!session || !this.state) return;
    const key = JSON.stringify([this.state.epoch, this.heads]);
    if (this.lastBeacon?.key === key && now() - this.lastBeacon.at < BEACON_REFRESH_MS) return;
    const folderState = { ...this.state, heads: Object.fromEntries(Object.entries(this.heads).map(([id, h]) => [id, { ...h, time: 0 }])) };
    const beacon = signBeacon(folderState, session.device, now());
    await this.withRateLimit(() => connection.request('vault.beacons.write', { vaultId, beacon }, APPEND_TIMEOUT_MS));
    this.lastBeacon = { key, at: now() };
  }

  /** The whole folder, read page by page; a missing folder reads as empty (it is rebuilt). */
  private async readFolder(vaultId: string): Promise<{ logs: LocalLogs; location: 'personal' | 'team' | null }> {
    try {
      return await readWholeFolder((since) => connection.request('vault.read', { vaultId, since }, READ_TIMEOUT_MS));
    } catch (err) {
      if (err instanceof RequestError && err.code === 'not_found') return { logs: {}, location: null };
      throw err;
    }
  }

  /** Sends the outbox in batches the computer accepts, waiting out its rate limit. Nothing is dropped: a failure leaves the lines queued. */
  private async upload(vaultId: string, upload: Upload): Promise<void> {
    for (const entries of appendBatches(upload.entries)) await this.append(vaultId, entries, upload.repair ? (upload.proof ?? {}) : undefined);
  }

  /** One vault.append; `proof` makes it a repair. */
  private async append(vaultId: string, entries: VaultEntry[], proof?: Record<string, VaultHead>): Promise<void> {
    const params = proof ? { vaultId, entries, repair: true, proof } : { vaultId, entries };
    const result = await this.withRateLimit(() => connection.request('vault.append', params, APPEND_TIMEOUT_MS));
    for (const [device, unpairedFrom] of readRemovals(result)) this.unpairOutcomes.set(device, unpairedFrom);
  }

  /** Waits out the computer's rate limit a few times before giving up. */
  private async withRateLimit<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        if (!isRateLimited(err) || attempt >= RATE_LIMIT_RETRIES) throw err;
        await wait(RATE_LIMIT_WAIT_MS);
      }
    }
  }

  // --- Vault lifecycle --------------------------------------------------------------------

  private readonly deviceKeys: DeviceKeyStore = { load: loadDeviceKeys, save: saveDeviceKeys, make: () => generateDeviceKeys(random) };

  /** This device's keys for founding, joining or restoring, made on first use. Never ones `retired` says a vault already used up. */
  private async keysForNewMembership(retired: KeysRetired = () => false): Promise<DeviceKeys> {
    if (this.prefs.vaultId) throw new Error('This device is already in a vault.');
    return keysUnlessRetired(this.deviceKeys, retired);
  }

  /** New keys after a stuck join, so the next attempt never offers keys a vault already lists. */
  private async renewJoinKeys(): Promise<void> {
    if (this.prefs.vaultId) throw new Error('This device is already in a vault.');
    await renewDeviceKeys(this.deviceKeys);
  }

  /**
   * True when a vault on the computer lists `deviceId` as removed: it refuses those keys for good,
   * which happens when an iPhone is reinstalled (its keychain outlives the app).
   */
  private async removedFromAVault(deviceId: string): Promise<boolean> {
    const { vaults } = await connection.request('vault.list', {});
    for (const { vaultId } of vaults) {
      const folder = await this.readFolder(vaultId);
      if (isRemoved(this.replay(vaultId, folder.logs), deviceId)) return true;
    }
    return false;
  }

  /** Adopts a vault this device just joined, founded or restored: local copy, prefs, open session. */
  private async adopt(vaultId: string, device: DeviceKeys, logs: LocalLogs, folderHeads: RememberedHeads, recoverySavedAt: number | null, forks: ForkProof[] = []): Promise<void> {
    this.resetSyncFindings();
    // The folder's proofs a restore was read with (a solo vault's R versions depend on them).
    this.forks = forks;
    if (forks.length > 0) await saveForks(vaultId, forks);
    this.logs = logs;
    this.state = this.replay(vaultId, logs);
    this.heads = folderHeads;
    this.ownHead = folderHeads[device.deviceId] ?? null;
    this.ownLineFolder = null;
    this.rollbackWarning = null;
    this.folderRejections = [];
    this.restoreRecordsSettled = false;
    // A restore into a vault this device kept before brings back what it dismissed there.
    this.handledCaught = await loadHandledCaught(vaultId);
    this.highestEpoch = this.state.epoch;
    await saveHighestEpoch(vaultId, this.highestEpoch);
    await saveLogs(vaultId, logs);
    await saveRememberedHeads(vaultId, folderHeads);
    if (this.ownHead) await saveOwnHead(vaultId, this.ownHead);
    await this.setPrefs({ vaultId, deviceId: device.deviceId, recoverySavedAt });
    this.session = { device, vault: openVault(this.state, device) };
    this.knownNames = this.session.vault.deviceNames;
    await saveEpochKeys(vaultId, this.session.vault.keys);
    this.touch();
  }

  async createVault(name?: string): Promise<{ phrase: string[]; flow: string }> {
    const device = await this.keysForNewMembership();
    const time = now();
    const created = createVault({
      founder: device,
      kind: vaultFeatures.multiDevice ? 'personal' : 'solo',
      name: name?.trim() || DEFAULT_VAULT_NAME,
      deviceName: thisDeviceName(),
      random,
      time,
    });
    const founded = this.replay(created.vaultId, { [device.deviceId]: [serializeEntry(created.entry)] });
    const phrase = generateRecoveryPhrase(random);
    const recoverySet = buildRecoverySetFromPhrase(founded, device, { phrase, currentKey: created.key, random, time });
    created.key.fill(0);
    recoverySet.newKey.fill(0);
    await this.adopt(created.vaultId, device, { [device.deviceId]: [serializeEntry(created.entry), serializeEntry(recoverySet.entry)] }, {}, null);
    this.syncSoon();
    return { phrase: phrase.split(' '), flow: this.startFlow({ kind: 'plain' }) };
  }

  /** A new recovery flow; whatever an earlier one held in memory and never stored is dropped. */
  private startFlow(flow: FlowState): string {
    const token = toBase64Url(random(16));
    this.flow = { token, ...flow };
    return token;
  }

  /** The phrase surface closed: its unchecked phrase change or new vault is dropped (stored ones go on). */
  endRecoveryFlow(token: string): void {
    if (this.flow?.token === token) this.flow = null;
  }

  /**
   * The words of the flow `token` were checked. Saved (true) once the vault on the computer holds
   * what the flow made; false while the computer doesn't have it yet (it is kept and sent again,
   * and Settings says so). Throws for a flow that isn't the current one or holds nothing.
   */
  async confirmRecoverySaved(token: string): Promise<{ saved: boolean }> {
    const flow = this.flow;
    if (!flow || flow.token !== token) throw new Error(STALE_FLOW);
    if (flow.kind === 'plain') {
      this.flow = null;
      await this.setPrefs({ recoverySavedAt: now() });
      return { saved: true };
    }
    if (flow.kind === 'replace') return this.confirmReplacement(flow);
    // A solo vault's new phrase is stored and sent only now, once its words were checked: sent
    // earlier, a phrase nobody wrote down could replace the one on paper.
    const vaultId = this.prefs.vaultId;
    if (!vaultId || flow.vaultId !== vaultId) throw new Error(STALE_FLOW);
    if (flow.change) {
      await savePendingPhraseChange(vaultId, flow.change);
      await savePhraseChangeRef(vaultId, flow.change.recoveryId);
      flow.change = null;
      flow.stored = true;
      this.phrasePending = true;
    }
    if (!flow.stored) throw new Error(NOTHING_TO_CHECK);
    const outcome = await this.settlePhraseChange();
    if (outcome === 'applied' || outcome === 'none') this.flow = null;
    this.publish();
    return { saved: outcome === 'applied' };
  }

  /**
   * The stored phrase change, its ack and a sync, then its outcome on a fresh read of the folder:
   * 'applied' moves the saved date, 'lost' (another version counts at its seq once the folder's
   * replay weighed this one too, or the rules reject it) drops it and says which phrase works,
   * 'pending' keeps it for the next sync.
   */
  private async settlePhraseChange(): Promise<'applied' | 'lost' | 'pending' | 'none'> {
    const pending = await this.storedPhraseChange();
    if (!pending) return 'none';
    try {
      await this.serial(() => this.ackPhraseChange(pending));
      await this.sync();
    } catch {
      // Offline, refused or a read that failed: the change stays stored and goes on the next sync.
    }
    return this.judgePhraseChange(pending);
  }

  /**
   * The pending phrase change of this vault, or null. A reference whose record can't be read back
   * (damaged, or not this device's) is cleared and the person is told to make a new phrase: the
   * words they wrote down for it may not be the vault's.
   */
  private async storedPhraseChange(): Promise<PendingRestore | null> {
    const vaultId = this.prefs.vaultId;
    if (!vaultId) return null;
    const recoveryId = await loadPhraseChangeRef(vaultId);
    if (!recoveryId) {
      this.phrasePending = false;
      return null;
    }
    const pending = await loadPendingPhraseChange(vaultId, recoveryId).catch(() => null);
    if (!pending || pending.deviceId !== this.prefs.deviceId || phraseChangeRecoveryId(pending) === null) {
      await savePhraseChangeRef(vaultId, null);
      this.phrasePending = false;
      this.noticeOnce(PHRASE_CHANGE_UNREADABLE);
      this.showNotices();
      return null;
    }
    return pending;
  }

  /**
   * Rule A1.2 for the app: this device builds on its own phrase change at once. The recovery line
   * goes into the local copy and this device's next line (its own name again, sealed under the new
   * key) names it in `seen`. Once the folder holds the ack, a version someone else signs with the
   * old phrase at that seq can't count over it (a restore with it loses to a phrase change anyway).
   * Until then, against a second phrase change the lowest hash decides (docs: the edge rule A1.2
   * leaves); a repair writes the ack back and settles it. The ack is an ordinary own line: sent with
   * the recovery line (uploadOutbox), never signed twice. Inside serial(); does nothing once an own
   * line names the change.
   */
  private async ackPhraseChange(pending: PendingRestore): Promise<void> {
    const session = this.session;
    const vaultId = this.prefs.vaultId;
    if (!session || !vaultId || !this.state || this.isRemoved()) return;
    const line = pending.lines[0]!;
    const entry = JSON.parse(line) as SignedEntry;
    const hash = entryHash(entry);
    const own = this.logs[session.device.deviceId] ?? [];
    if (own.some((text) => (JSON.parse(text) as SignedEntry).seen[entry.author]?.hash === hash)) return;
    const chain = this.state.chains[entry.author] ?? [];
    if (chain[entry.seq] !== hash) {
      // Placed only on a copy that holds R's log up to it, the way it was signed.
      if (chain.length !== entry.seq) return;
      const logs = { ...this.logs, [entry.author]: [...(this.logs[entry.author] ?? []).slice(0, entry.seq), line] };
      const state = this.replay(vaultId, logs);
      if (state.chains[entry.author]?.[entry.seq] !== hash) return;
      this.logs = logs;
      this.state = state;
      await saveLogs(vaultId, logs);
      await this.reopen();
    }
    const name = this.session?.vault.deviceNames[session.device.deviceId] ?? thisDeviceName();
    await this.appendOwn([(state, s) => buildDeviceRename(state, s.device, { device: s.device.deviceId, name, currentKey: s.vault.currentKey, random, time: now() })]);
  }

  /** The phrase change's outcome on a fresh read of the folder (with the folder's proofs). */
  private async judgePhraseChange(pending: PendingRestore): Promise<'applied' | 'lost' | 'pending'> {
    const vaultId = this.prefs.vaultId!;
    let folderState: VaultState;
    let proofs: ForkProof[];
    try {
      const read = await this.readFolder(vaultId);
      proofs = (await this.readFolderProofs(vaultId)).forks;
      folderState = replayVault(vaultId, read.logs, { cache: this.verified, forks: proofs });
    } catch {
      return 'pending';
    }
    const step = restoreStep(folderState, pending);
    const problem = step.kind === 'held' ? heldProblem(folderState, pending) : null;
    if (step.kind === 'held' && problem === null) {
      await this.forgetPhraseChange(vaultId, pending.recoveryId);
      await this.setPrefs({ recoverySavedAt: now() });
      this.syncSoon();
      return 'applied';
    }
    // Another version holds the seq: lost only once the folder's replay weighed this one too (a proof carries it).
    const weighed = proofs.some((p) => p.deviceId === pending.recoveryId && p.lines.includes(pending.lines[0]!));
    if ((step.kind === 'taken' && weighed) || problem !== null) {
      await this.forgetPhraseChange(vaultId, pending.recoveryId);
      this.syncSoon();
      throw new Error(folderState.recovery?.deviceId === pending.recoveryId ? PHRASE_CHANGE_LOST_OLD_WORKS : PHRASE_CHANGE_LOST);
    }
    return 'pending';
  }

  private async forgetPhraseChange(vaultId: string, recoveryId: string): Promise<void> {
    await forgetPendingPhraseChange(vaultId, recoveryId);
    await savePhraseChangeRef(vaultId, null);
    this.phrasePending = false;
  }

  /** On every sync, after the upload: a stored phrase change is judged on the folder; told once if it lost. */
  private async resendPhraseChange(): Promise<void> {
    if (!this.phrasePending) return;
    try {
      const pending = await this.storedPhraseChange();
      if (pending) await this.judgePhraseChange(pending);
    } catch (err) {
      this.noticeOnce(err instanceof Error ? err.message : PHRASE_CHANGE_LOST);
    }
  }

  /**
   * Makes a new recovery phrase. In a solo vault only the current phrase can (`current`): the
   * recovery identity signs the change, which is stored and sent once the new words are checked
   * (confirmRecoverySaved). Elsewhere a device signs it.
   */
  async newRecoveryPhrase(current?: string[]): Promise<{ phrase: string[]; flow: string }> {
    await this.ensureOpen();
    if (this.state?.kind === 'solo') return this.newSoloPhrase(current ?? []);
    this.flow = null;
    const phrase = generateRecoveryPhrase(random);
    await this.commit([
      (state, s) => {
        const { entry, newKey } = buildRecoverySetFromPhrase(state, s.device, { phrase, currentKey: s.vault.currentKey, random, time: now() });
        newKey.fill(0);
        return entry;
      },
    ]);
    await this.setPrefs({ recoverySavedAt: null });
    return { phrase: phrase.split(' '), flow: this.startFlow({ kind: 'plain' }) };
  }

  /** Signs a solo vault's new phrase with the current one, on a fresh read of the folder; nothing is stored or sent yet. */
  private async newSoloPhrase(current: string[]): Promise<{ phrase: string[]; flow: string }> {
    const vaultId = this.prefs.vaultId!;
    // R never signs a second line while one is on its way: two at one seq would be a fork of the phrase.
    if (await loadPhraseChangeRef(vaultId)) throw new Error(PHRASE_CHANGE_PENDING);
    // Another flow starts: whatever the last one held unstored is dropped, even if this one fails.
    this.flow = null;
    const recovery = this.currentRecoveryKeys(current);
    const folder = await this.readFolder(vaultId);
    const state = this.replay(vaultId, folder.logs);
    // R never signs on a rewound copy: its next seq there may be one it already used (Q1).
    if (this.folderBehind(state, [recovery.deviceId])) throw new Error(OLDER_COPY);
    if (state.recovery?.deviceId !== recovery.deviceId) throw new Error(NOT_CURRENT_PHRASE);
    const phrase = generateRecoveryPhrase(random);
    const opened = openVault(state, recovery);
    if (opened.readOnly !== null) throw new Error(opened.readOnly);
    const { entry, newKey } = buildRecoverySetFromPhrase(state, recovery, { phrase, currentKey: opened.currentKey, random, time: now() });
    newKey.fill(0);
    Object.values(opened.keys).forEach((key) => key.fill(0));
    // Held in memory only: if the flow closes before the words are checked, nothing was stored or
    // sent and the old phrase stays. The old phrase works until the change applies, so the saved date stays.
    const change: PendingRestore = { recoveryId: recovery.deviceId, deviceId: this.prefs.deviceId!, seq: entry.seq, lines: [serializeEntry(entry)], superseded: false };
    return { phrase: phrase.split(' '), flow: this.startFlow({ kind: 'solo-phrase', vaultId, change, stored: false }) };
  }

  /**
   * "I don't have my phrase" (solo vaults, replaceVault.ts): after the device's own prompt, makes
   * a new solo vault holding every account and returns its phrase. Nothing is stored or sent, and
   * the old vault is untouched, until the new words are checked (confirmRecoverySaved).
   */
  async replaceVaultWithoutPhrase(): Promise<{ phrase: string[]; flow: string }> {
    await this.ensureOpen();
    if (this.state?.kind !== 'solo') throw new Error('Only a vault kept on one device can be replaced without its phrase.');
    if (this.isRemoved()) throw new Error(REMOVED_READ_ONLY);
    if (await loadReplacement()) throw new Error('A new vault made earlier is still being saved to the computer. Keep AuthDeck open while it is online, then try again.');
    if (this.prefs.vaultId && (await loadPhraseChangeRef(this.prefs.vaultId))) throw new Error(PHRASE_CHANGE_PENDING);
    this.flow = null;
    // The device's own prompt even when app lock is off: this hands every code to a new phrase.
    const auth = await deviceAuth();
    if (!canAuthenticate(auth)) throw new Error(replaceNeedsScreenLock(auth));
    await confirmOwner('Make a new recovery phrase');
    const session = this.requireOpen();
    const built = buildReplacement({
      device: session.device,
      name: session.vault.name ?? DEFAULT_VAULT_NAME,
      deviceName: session.vault.deviceNames[session.device.deviceId] ?? thisDeviceName(),
      accounts: Object.values(session.vault.accounts),
      random,
      time: now(),
      replay: (id, logs) => replayVault(id, logs, { cache: this.verified }),
    });
    return { phrase: built.phrase, flow: this.startFlow({ kind: 'replace', vaultId: this.prefs.vaultId!, newVaultId: built.vaultId, lines: built.lines, record: null }) };
  }

  /**
   * The checked words of a replacement: the new lines are stored, then the record (bound to this
   * computer), before anything is sent; then the run (replaceVault.ts). A retry of the same flow
   * carries on the stored record.
   */
  private async confirmReplacement(flow: Extract<RecoveryFlow, { kind: 'replace' }>): Promise<{ saved: boolean }> {
    if (!flow.record) {
      if (!flow.lines || this.prefs.vaultId !== flow.vaultId) throw new Error(STALE_FLOW);
      const agentId = useLive.getState().agent?.agentId;
      if (!agentId) throw new Error('Connect to the computer, then check the words again.');
      // The new lines first: a record never names a vault whose lines this device lacks.
      await saveLogs(flow.newVaultId, { [this.prefs.deviceId!]: flow.lines });
      const record = { oldVaultId: flow.vaultId, newVaultId: flow.newVaultId, agentId };
      await saveReplacement(record);
      this.replacing = true;
      this.publish();
      flow.lines = null;
      flow.record = record;
    }
    const outcome = await this.serial(() => finishReplacement(flow.record!, this.replaceSteps()));
    if (outcome === 'waiting') throw new Error('Unlock the vault on the computer it was made with, then check the words again.');
    this.replacing = (await loadReplacement()) !== null;
    this.flow = null;
    this.publish();
    this.syncSoon();
    return { saved: true };
  }

  /** Carries on a replacement a stop left unfinished (on start and every sync). Told once when it can't. */
  private async resumeReplacement(): Promise<void> {
    try {
      const record = await loadReplacement();
      this.replacing = record !== null;
      if (!record) return;
      this.publish();
      await this.serial(() => finishReplacement(record, this.replaceSteps()));
      this.replacing = (await loadReplacement()) !== null;
      this.publish();
    } catch (err) {
      this.noticeOnce(err instanceof Error ? err.message : 'The new vault could not be saved to the computer yet.');
    }
  }

  private replaceSteps(): ReplaceSteps {
    const deviceId = () => this.prefs.deviceId!;
    return {
      current: () => this.prefs.vaultId,
      agentId: () => (useLive.getState().status === 'online' ? (useLive.getState().agent?.agentId ?? null) : null),
      openOld: () => (this.session ? { device: this.session.device, accounts: Object.values(this.session.vault.accounts) } : null),
      loadLines: async (vaultId) => {
        const logs = await loadLogs(vaultId);
        return Object.hasOwn(logs, deviceId()) ? logs[deviceId()]! : [];
      },
      saveLines: (vaultId, lines) => saveLogs(vaultId, { [deviceId()]: lines }),
      send: (vaultId, lines) => this.upload(vaultId, { entries: lines.map((line) => JSON.parse(line) as VaultEntry), repair: false }),
      read: async (vaultId) => (await this.readFolder(vaultId)).logs,
      // Not this.replay: the old vault's fork and seal proofs say nothing about the new one.
      replay: (vaultId, logs) => replayVault(vaultId, logs, { cache: this.verified }),
      adopt: async (vaultId, logs, state) => {
        const device = this.requireOpen().device;
        await this.adopt(vaultId, device, logs, checkRollback({}, state).heads, now());
        await this.setPrefs({ location: 'personal', folderPath: null });
        await this.rememberFolder(vaultId, 'personal').catch(() => undefined);
      },
      retireOnComputer: (oldVaultId, newVaultId) => this.retireOnComputer(oldVaultId, newVaultId),
      forgetLocal: async (vaultId) => {
        await Promise.all([forgetLogs(vaultId), forgetVaultSecrets(vaultId, { keepDeviceKeys: true })]);
      },
      save: saveReplacement,
      random,
      now,
    };
  }

  /**
   * vault.retire, signed by this device (the old vault's device; the new vault has the same keys)
   * for the computer connected now. Anything but a well-formed success counts as not retired, and
   * the run resumes later; a folder already gone counts as retired.
   */
  private async retireOnComputer(oldVaultId: string, newVaultId: string): Promise<void> {
    const agentId = useLive.getState().agent?.agentId;
    const device = await loadDeviceKeys();
    if (!agentId || !device) throw new Error('The old vault can be set aside only while the computer is connected. AuthDeck tries again on the next sync.');
    const request = signRetire({ vault: oldVaultId, newVault: newVaultId, agentId, time: now() }, device);
    let result: unknown;
    try {
      result = await this.withRateLimit(() => connection.request('vault.retire', { vaultId: oldVaultId, request }, APPEND_TIMEOUT_MS));
    } catch (err) {
      if (err instanceof RequestError && err.code === 'not_found') return;
      throw err;
    }
    const keptUntil = isPlainObject(result) && Object.keys(result).length === 1 ? result.keptUntil : undefined;
    if (!Number.isSafeInteger(keptUntil) || (keptUntil as number) < 0) throw new Error('The computer did not confirm it set the old vault aside. AuthDeck tries again on the next sync.');
  }

  /** The recovery identity of the words typed, if they are the vault's current phrase. */
  private currentRecoveryKeys(words: string[]): DeviceKeys {
    const recovery = this.phraseKeys(words);
    if (this.state?.recovery?.deviceId !== recovery.deviceId) throw new Error(NOT_CURRENT_PHRASE);
    return recovery;
  }

  /**
   * True when `folder` is behind what this device has seen: the remembered heads, and this copy's
   * own heads of this device and of `identities` (a recovery identity about to sign), are missing
   * from it or differ. Before R signs anything, so it never signs at a seq it already used.
   */
  private folderBehind(folder: VaultState, identities: readonly string[]): boolean {
    const remembered: RememberedHeads = { ...this.heads };
    for (const id of [this.prefs.deviceId, ...identities]) {
      const head = id && this.state && Object.hasOwn(this.state.heads, id) ? this.state.heads[id]! : null;
      if (id && head && (!remembered[id] || remembered[id]!.seq < head.seq)) remembered[id] = head;
    }
    return checkRollback(remembered, folder).problems.length > 0;
  }

  /** The recovery identity the words give in this vault; throws for words not on the list. */
  private phraseKeys(words: string[]): DeviceKeys {
    const phrase = words.join(' ');
    const unknown = unknownPhraseWords(phrase);
    if (unknown.length > 0)
      throw new Error(
        `${unknown.map((w) => `"${w}"`).join(', ')} ${unknown.length === 1 ? "isn't a word" : "aren't words"} from the recovery word list. Check the spelling.`,
      );
    return recoveryKeysFromPhrase(phrase, this.prefs.vaultId!);
  }

  /** The recovery identity a stored, not yet applied phrase change sets, or null. */
  private async pendingRecoveryId(): Promise<string | null> {
    const pending = await this.storedPhraseChange();
    return pending ? phraseChangeRecoveryId(pending) : null;
  }

  async restoreWithPhrase(words: string[]): Promise<{ replacedAt: number | null; warning: string | null }> {
    const phrase = words.join(' ');
    const unknown = unknownPhraseWords(phrase);
    if (unknown.length > 0)
      throw new Error(
        `${unknown.map((w) => `"${w}"`).join(', ')} ${unknown.length === 1 ? "isn't a word" : "aren't words"} from the recovery word list. Check the spelling.`,
      );
    if (this.prefs.vaultId) throw new Error('This device is already in a vault.');
    this.restoreCancelled = false;
    const { vaults } = await connection.request('vault.list', {});
    // At most MAX_RESTORE_SEARCH vaults, one at a time (each read under the folder read cap), stopping at the match.
    for (const summary of vaults.slice(0, MAX_RESTORE_SEARCH)) {
      // Between candidates: the screen stays responsive, and closing it stops the search (nothing is signed yet).
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.restoreCancelled) throw new Error(RESTORE_CANCELLED);
      // The recovery identity depends on the vault, so each vault is checked with its own.
      const recoveryKeys = recoveryKeysFromPhrase(phrase, summary.vaultId);
      const recoveryId = recoveryKeys.deviceId;
      // R becomes a vault's phrase only through a recovery.set whose body carries its key, in the
      // folder's logs (canonical lines, so the text is exact) or a fork proof's lines: a vault
      // with neither is skipped before any replay.
      const keyText = `"ed":"${toBase64Url(recoveryKeys.edPublic)}"`;
      const replacedAt = summary.retired?.at ?? null;
      // What the last adopted copy held, but for R and the attempt that lost: a later read must not be behind it.
      let seen: RememberedHeads | null = null;
      let lost = 0;
      for (let round = 1; ; round++) {
        const proofs = await this.readFolderProofs(summary.vaultId);
        if (round === 1) {
          // The set may also be only in a fork proof (a version the folder's log doesn't hold).
          const proofLines = proofs.forks.flatMap((proof) => (isPlainObject(proof) && Array.isArray(proof.lines) ? proof.lines.filter((line): line is string => typeof line === 'string') : []));
          const carriesKey = (line: string) => line.includes(keyText) || canonicalLine(line).includes(keyText);
          if (!proofLines.some(carriesKey) && !(await this.folderCarries(summary.vaultId, keyText))) break;
          if (this.restoreCancelled) throw new Error(RESTORE_CANCELLED);
        }
        const folder = await this.readFolder(summary.vaultId);
        // The folder's fork proofs count from the first read: in a solo vault they choose which of R's versions counts (A1.2).
        // Checked with a cache of its own: what a vault that doesn't match leaves behind is freed (N2).
        const probe = new VerifyCache();
        const proven = provenForks(replayVault(summary.vaultId, folder.logs, { cache: probe }), proofs.forks, folder.logs, probe);
        const state = replayVault(summary.vaultId, folder.logs, { cache: probe, forks: proven });
        if (state.recovery?.deviceId !== recoveryId) break;
        this.forks = proven;
        if (seen && checkRollback(seen, state).problems.length > 0) throw new Error(KEEPS_OLDER_COPY);
        const pending = await this.restoreInto(summary.vaultId, summary.path, phrase, state.kind === 'solo');
        if (state.kind !== 'solo') {
          await this.settleRestore(summary.vaultId, recoveryId);
          return { replacedAt, warning: null };
        }
        // Solo: built on at once (rule A1.2 (3)), then judged on a fresh read.
        const ack = await this.ackRestore(summary.vaultId, pending);
        if (ack === 'held') {
          await this.settleRestore(summary.vaultId, recoveryId);
          return { replacedAt, warning: null };
        }
        // The folder lacks the restore (rewound, or held back): never signed again. The lines stay
        // stored and every sync sends the same bytes; the rollback warning stays up meanwhile.
        if (ack === 'missing' || ack === 'unknown') return { replacedAt, warning: RESTORE_NOT_SEEN };
        // Another version counts at the restore's seq: an earlier attempt of this phone's ('own',
        // adopted with its kept keys), or another device's ('lost', restored again on top of it).
        // After a loss, later reads must not be behind the copy that lost; an earlier attempt of
        // this phone's is adopted wherever the computer shows it.
        if (ack === 'lost') seen = Object.fromEntries(Object.entries(this.heads).filter(([id]) => id !== recoveryId && id !== pending.deviceId));
        this.keepingAttempts = true;
        try {
          await this.serial(() => this.forgetVault());
        } finally {
          this.keepingAttempts = false;
        }
        if (ack === 'lost') lost++;
        if (lost >= RESTORE_ATTEMPTS || round >= 2 * RESTORE_ATTEMPTS) throw new Error(KEEPS_OLDER_COPY);
      }
    }
    this.forks = [];
    const computer = useLive.getState().agent?.name ?? 'the computer';
    throw new Error(`No vault on ${computer} uses this recovery phrase. Check the words, and that the vault folder is synced to this computer.`);
  }

  /**
   * Signs device.add as the recovery identity and device.hello, stores both, then sends them.
   * A refusal or a restart sends the same stored bytes again: the recovery identity never signs
   * two entries at one seq, which would prove it forked and void the phrase. The restore counts
   * only once a folder read shows it applied. When another version took that seq, a solo restore
   * is signed again on top of it, with new device keys (this device's hello at seq 0 must not
   * come twice either); elsewhere the restore stops and the next try signs past it.
   */
  private async restoreInto(vaultId: string, path: string, phrase: string, solo: boolean): Promise<PendingRestore> {
    const recoveryId = recoveryKeysFromPhrase(phrase, vaultId).deviceId;
    let location: 'personal' | 'team' | null = null;
    const stored = await loadPendingRestore(vaultId, recoveryId);
    let signedBefore = stored !== null;
    const { folder, pending, sent } = await sendRestore(
      {
        readFolder: async () => {
          const read = await this.readFolder(vaultId);
          location = read.location;
          return { logs: read.logs, state: this.replay(vaultId, read.logs) };
        },
        sign: async (read) => {
          if (signedBefore) await this.renewJoinKeys();
          signedBefore = true;
          const signed = await this.signRestore(vaultId, phrase, read);
          // Kept before anything is sent, until one attempt settles: the computer may count this one later.
          const keys = await loadDeviceKeys();
          if (keys?.deviceId === signed.deviceId) await keepRestoreAttemptKeys(vaultId, keys);
          await keepRestoreAttempt(vaultId, signed);
          return signed;
        },
        earlier: (read) => this.earlierAttempt(vaultId, recoveryId, read.state),
        save: (record) => savePendingRestore(vaultId, record),
        append: (entries) => this.append(vaultId, entries),
        isRefused,
      },
      stored,
      RESTORE_ATTEMPTS,
      // Solo: a restore whose seq another version took is signed again on top of it (the phrase is at hand).
      { redo: solo },
    );
    let device = await loadDeviceKeys();
    // A record kept from an earlier try (its keys went with a forgotten copy): its kept keys.
    if (device?.deviceId !== pending.deviceId) {
      const kept = (await loadRestoreAttemptKeys(vaultId)).find((k) => k.deviceId === pending.deviceId);
      if (kept) {
        await saveDeviceKeys(kept);
        device = kept;
      }
    }
    if (device?.deviceId !== pending.deviceId) {
      throw new Error(
        "This device's keys changed after it signed the restore, so it can't finish it. Restore the vault from another device, or ask an admin device to add this one.",
      );
    }
    const logs = withRestoreLines(folder.logs, folder.state, pending);
    const heads = headsAfterUpload(checkRollback({}, folder.state).heads, this.replay(vaultId, logs), { entries: sent, repair: false });
    // The phrase was typed on this device; a new one keeps it from being the only way in.
    await this.adopt(vaultId, device, logs, heads, null, this.forks);
    // The phrase's own bad seals (a restore on an older key, recovery.ts): proven while the phrase is at hand.
    this.keepSealProofs(ownSealProofs(folder.state, folder.logs, recoveryKeysFromPhrase(phrase, vaultId)));
    await this.setPrefs({ location, folderPath: path });
    // The pending record stays until the restore settles (restoreWithPhrase): until then a folder
    // that lacks it gets the same bytes again, and RESTORE_FOLDER_BEHIND keeps R from signing anew.
    return pending;
  }

  /**
   * An earlier restore attempt of this phone's that `folder` counts (applied, its device a live
   * member), made this phone's keys again and stored as the pending restore; null when none.
   */
  private async earlierAttempt(vaultId: string, recoveryId: string, folder: VaultState): Promise<PendingRestore | null> {
    const keys = await loadRestoreAttemptKeys(vaultId);
    for (const attempt of (await loadRestoreAttempts(vaultId, recoveryId)).reverse()) {
      const member = Object.hasOwn(folder.members, attempt.deviceId) ? folder.members[attempt.deviceId]! : null;
      if (!member || member.removed === true) continue;
      if (restoreStep(folder, attempt).kind !== 'held' || heldProblem(folder, attempt) !== null) continue;
      const kept = keys.find((k) => k.deviceId === attempt.deviceId);
      if (!kept) continue;
      await saveDeviceKeys(kept);
      await savePendingRestore(vaultId, attempt);
      return attempt;
    }
    return null;
  }

  /**
   * L1: a restore that came back "Not confirmed yet" settles once a folder read shows this device
   * a member with that restore applied and a line of its own past its hello. True when no restore
   * record is left.
   */
  private async settleHeldRestores(vaultId: string, folder: VaultState): Promise<boolean> {
    const self = this.prefs.deviceId;
    if (!self || !Object.hasOwn(folder.members, self) || folder.members[self]!.removed === true) return false;
    // Settled means adopted and acked: a line of this device's past its hello is in the folder (A1.2 (3)).
    if ((folder.chains[self]?.length ?? 0) < 2) return false;
    let left = 0;
    for (const recoveryId of await pendingRestoreIds(vaultId)) {
      const pending = await loadPendingRestore(vaultId, recoveryId).catch(() => null);
      if (pending && pending.deviceId === self && restoreStep(folder, pending).kind === 'held' && heldProblem(folder, pending) === null) await this.settleRestore(vaultId, recoveryId);
      else left++;
    }
    return left === 0;
  }

  /**
   * The restore search's first look at a vault: pages through its logs for `keyText` (the
   * phrase's recovery key as a recovery.set body holds it), stopping at the first page that has
   * it. Nothing is kept, parsed or verified, so a vault this phrase can't restore costs only the
   * read. The computer serves canonical lines; one that re-encodes them only hides its own vault.
   */
  private async folderCarries(vaultId: string, keyText: string): Promise<boolean> {
    const since: Record<string, number> = {};
    let bytes = 0;
    for (;;) {
      let result: VaultReadResult;
      try {
        result = await connection.request('vault.read', { vaultId, since }, READ_TIMEOUT_MS);
      } catch (err) {
        if (err instanceof RequestError && err.code === 'not_found') return false;
        throw err;
      }
      let progressed = false;
      for (const [deviceId, part] of Object.entries(result.logs ?? {})) {
        if (!isId(deviceId) || !part || !Array.isArray(part.lines)) continue;
        for (const line of part.lines) {
          if (typeof line !== 'string') continue;
          if (line.includes(keyText)) return true;
          bytes += line.length;
        }
        if (part.lines.length > 0) progressed = true;
        since[deviceId] = (since[deviceId] ?? 0) + part.lines.length;
      }
      // Past what a whole read would take, the vault couldn't be restored anyway.
      if (bytes > MAX_READ_BYTES) return false;
      const complete = Object.entries(result.lengths ?? {}).every(([deviceId, length]) => !isId(deviceId) || (since[deviceId] ?? 0) >= length);
      if (complete || !progressed) return false;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** Closing the restore screen: the search stops between vaults; a restore already signing finishes. */
  cancelRestore(): void {
    this.restoreCancelled = true;
  }

  /** One attempt settled (adopted and acked): the pending record and every kept attempt go. */
  private async settleRestore(vaultId: string, recoveryId: string): Promise<void> {
    await forgetPendingRestore(vaultId, recoveryId);
    await forgetRestoreAttempts(vaultId, recoveryId);
    await forgetRestoreAttemptKeys(vaultId);
  }

  /**
   * Rule A1.2 (3) for the app: once a solo restore is adopted (a folder read showed it applied),
   * this device writes a line past its hello at once, its own name again. Between two restores the
   * one whose device signed more lines counts, so attempts the computer refused and kept (which
   * never get this line) can't tie with the adopted one. Not part of the restore append itself:
   * kept attempts would carry one too. Then a fresh read, with the folder's proofs, says: 'held'
   * (this device is in), 'missing' (the folder lacks the restore: rewound or held back), 'own' (an
   * earlier attempt of this phone's counts instead), 'lost' (another device's version counts) or
   * 'unknown' (no read).
   */
  private async ackRestore(vaultId: string, pending: PendingRestore): Promise<'held' | 'missing' | 'own' | 'lost' | 'unknown'> {
    const deviceId = this.prefs.deviceId;
    if (!deviceId || !this.session) return 'unknown';
    try {
      const name = this.session.vault.deviceNames[deviceId] ?? thisDeviceName();
      await this.appendOwn([(state, s) => buildDeviceRename(state, s.device, { device: s.device.deviceId, name, currentKey: s.vault.currentKey, random, time: now() })]);
    } catch {
      // Removed already (the fork flipped first): the read below says so.
    }
    try {
      await this.sync();
    } catch {
      // A sync that fails (a refused line, the restore lost) still leaves the read below to judge.
    }
    try {
      const folder = await this.readFolder(vaultId);
      const proofs = await this.readFolderProofs(vaultId);
      const plain = replayVault(vaultId, folder.logs, { cache: this.verified });
      const state = replayVault(vaultId, folder.logs, { cache: this.verified, forks: provenForks(plain, proofs.forks, folder.logs, this.verified) });
      const member = Object.hasOwn(state.members, deviceId) ? state.members[deviceId]! : null;
      if (member && member.removed !== true) return 'held';
      const attempts = await loadRestoreAttempts(vaultId, pending.recoveryId);
      const own = attempts.some((a) => a.deviceId !== deviceId && Object.hasOwn(state.members, a.deviceId) && state.members[a.deviceId]!.removed !== true && heldProblem(state, a) === null);
      if (own) return 'own';
      return state.chains[pending.recoveryId]?.[pending.seq] === undefined ? 'missing' : 'lost';
    } catch {
      return 'unknown';
    }
  }

  /** A new restore: device.add signed by the recovery identity on top of `folder`, and this device's hello after it. */
  private async signRestore(vaultId: string, phrase: string, folder: { logs: LocalLogs; state: VaultState }): Promise<PendingRestore> {
    const device = await this.keysForNewMembership((deviceId) => folder.state.members[deviceId] !== undefined);
    const restored = restoreWithPhrase(folder.state, { phrase, device, name: thisDeviceName(), random, time: now() });
    const add = serializeEntry(restored.entry);
    const withAdd = { ...folder.logs, [restored.entry.author]: [...(folder.logs[restored.entry.author] ?? []), add] };
    const hello = buildDeviceHello(this.replay(vaultId, withAdd), device, now(), entryHash(restored.entry));
    const lines = [add, serializeEntry(hello)];
    if (folder.state.kind === 'solo') {
      // A solo restore takes out every earlier device; its key change, sealed to this device and
      // the phrase only, keeps the old phone (maybe a thief's) from reading anything new.
      const withHello = { ...withAdd, [device.deviceId]: [serializeEntry(hello)] };
      const rotation = buildKeyRotate(this.replay(vaultId, withHello), recoveryKeysFromPhrase(phrase, vaultId), {
        currentKey: restored.key,
        random,
        time: now(),
      });
      rotation.newKey.fill(0);
      lines.push(serializeEntry(rotation.entry));
    }
    restored.key.fill(0);
    return { recoveryId: restored.entry.author, deviceId: device.deviceId, seq: restored.entry.seq, lines, superseded: false };
  }

  /**
   * New device, after the approver said it finished: the vault must be the one offered, hold this
   * device's own keys, added by the device it compared codes with, with a key that opens.
   */
  private async adoptJoinedVault(device: DeviceKeys, challenge: JoinChallenge): Promise<void> {
    const vaultId = challenge.vault;
    const folder = await this.readFolder(vaultId);
    const state = this.replay(vaultId, folder.logs);
    // Checked first: an approval from before the removal must not let this device back in.
    if (isRemoved(state, device.deviceId)) {
      throw new JoinNotApproved('This vault removed this device before, so it refuses the keys this device joined with.');
    }
    const verdict = checkJoinedVault(state, device, challenge);
    if (verdict.status === 'intercepted') {
      throw new JoinIntercepted(`Something between the two devices changed the join: ${verdict.reason}.`);
    }
    if (verdict.status === 'not-yet') {
      throw new JoinNotApproved("The other device said it approved this one, but the vault folder on the computer doesn't list this device.");
    }
    // The hello names the approval just checked, so keys, role, name and key all come from it.
    const hello = buildDeviceHello(state, device, now(), verdict.approval);
    await this.append(vaultId, [hello] as VaultEntry[]);
    const logs = { ...folder.logs, [device.deviceId]: [serializeEntry(hello)] };
    const sent: Upload = { entries: [hello] as VaultEntry[], repair: false };
    await this.adopt(vaultId, device, logs, headsAfterUpload(checkRollback({}, state).heads, this.replay(vaultId, logs), sent), state.recovery ? now() : null);
    await this.setPrefs({ location: folder.location });
    await this.rememberFolder(vaultId, folder.location).catch(() => undefined);
  }

  /** Approver: this device's keys, its vault and the names the new device will be shown. */
  private async approverOffer(): Promise<ApproverOffer> {
    const session = await this.ensureOpen();
    return {
      device: session.device,
      vaultId: this.prefs.vaultId!,
      vaultName: session.vault.name ?? DEFAULT_VAULT_NAME,
      deviceName: session.vault.deviceNames[session.device.deviceId] ?? thisDeviceName(),
    };
  }

  private isAdmin(): boolean {
    const me = this.prefs.deviceId ? this.state?.members[this.prefs.deviceId] : undefined;
    return me !== undefined && !me.removed && me.role === 'admin';
  }

  /** Approver: writes device.add and waits until the folder has it, since the new device reads it from there. */
  private async addDevice(device: DevicePublicKeys, name: string): Promise<string> {
    await this.ensureOpen();
    const [added] = await this.commit([
      (state, s) =>
        buildDeviceAdd(state, s.device, {
          device,
          role: state.kind === 'personal' ? 'admin' : 'member',
          name,
          currentKey: s.vault.currentKey,
          random,
          time: now(),
        }),
    ]);
    await this.sync();
    const inFolder = this.heads[added!.author];
    if (!inFolder || inFolder.seq < added!.seq) {
      throw new Error("The computer didn't store the approval, so the new device can't read it yet. Check the connection and approve again.");
    }
    return this.prefs.vaultId!;
  }

  // --- Accounts ---------------------------------------------------------------------------

  private requireAccount(id: string): AccountRecord {
    const account = this.requireOpen().vault.accounts[id];
    if (!account) throw new Error('That account is no longer in the vault.');
    return account.record;
  }

  private putStep(account: string, record: AccountRecord): EntryStep {
    return (state, s) => buildAccountPut(state, s.device, { account, record, currentKey: s.vault.currentKey, random, time: now() });
  }

  code(accountId: string, at = now()): CodeView | null {
    const account = this.session?.vault.accounts[accountId];
    if (!account) return null;
    const { record } = account;
    const code = generateCode(record, at);
    if (record.type === 'hotp') return { code, secondsLeft: 0, period: 0 };
    return { code, secondsLeft: secondsRemaining(record.period, at), period: record.period };
  }

  parseQr(text: string): ImportPreview {
    const { preview, batches } = scanQr(text, this.scans);
    this.scans = batches;
    return preview;
  }

  checkAccount(account: NewAccount): string[] {
    return accountProblems(account);
  }

  async addAccounts(accounts: NewAccount[]): Promise<string[]> {
    const session = await this.ensureOpen();
    const first = nextPosition(Object.values(session.vault.accounts));
    const records = accounts.map((account, i) => {
      try {
        return toAccountRecord(account, first + i);
      } catch (err) {
        throw new Error(`${accountTitle(account)}: ${(err as Error).message}`, { cause: err });
      }
    });
    const ids = records.map(() => newAccountId(random));
    await this.commit(records.map((record, i) => this.putStep(ids[i]!, record)));
    this.scans = [];
    return ids;
  }

  async renameAccount(id: string, issuer: string, label: string): Promise<void> {
    await this.ensureOpen();
    const record = this.requireAccount(id);
    await this.commit([this.putStep(id, { ...record, issuer: issuer.trim(), label: label.trim() })]);
  }

  async deleteAccount(id: string): Promise<void> {
    await this.ensureOpen();
    this.requireAccount(id);
    await this.commit([(state, s) => buildAccountDelete(state, s.device, { account: id, time: now() })]);
  }

  async typeCode(accountId: string): Promise<void> {
    await this.ensureOpen();
    const record = this.requireAccount(accountId);
    const code = generateCode(record, now());
    // Spend an HOTP counter before typing, so the same code is never typed twice.
    if (record.type === 'hotp') await this.commit([this.putStep(accountId, { ...record, counter: record.counter + 1 })], { counterOnly: true });
    await connection.run({ type: 'text', text: code, secret: true }, undefined, `Code for ${accountTitle(record)}`);
    this.touch();
  }

  // --- Devices ----------------------------------------------------------------------------

  async renameDevice(id: string, name: string): Promise<void> {
    await this.ensureOpen();
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Give the device a name.');
    await this.commit([(state, s) => buildDeviceRename(state, s.device, { device: id, name: trimmed, currentKey: s.vault.currentKey, random, time: now() })]);
  }

  async removeDevice(id: string): Promise<{ accountsToReset: AccountView[]; unpairNote: string }> {
    const session = await this.ensureOpen();
    if (id === session.device.deviceId) throw new Error('Remove this device from another device in the vault.');
    const name = this.deviceName(id) ?? UNNAMED_DEVICE;
    this.unpairOutcomes.delete(id);
    const team = this.state?.kind === 'team' ? session.vault.name : null;
    // It held the key to every account in the vault now, so all of them are at risk.
    const accountsToReset = Object.values(session.vault.accounts).map((a) => toAccountView(a, team));
    let skipped: string[] = [];
    await this.commit([
      (state, s) => {
        const removal = buildDeviceRemove(state, s.device, { device: id, currentKey: s.vault.currentKey, random, time: now() });
        removal.newKey.fill(0);
        skipped = removal.skipped;
        return removal.entry;
      },
    ]);
    if (skipped.length > 0) this.report(new Error(this.unsealableSentence(skipped)));
    // commit() started a sync; its answer from the computer says whether the device was unpaired.
    // Offline, the removal goes out later, maybe through another computer, so the sheet says what to do.
    await this.syncRunning?.catch(() => undefined);
    const unpairNote = unpairSentence(name, this.unpairOutcomes.get(id), useLive.getState().agent?.name ?? null);
    return { accountsToReset, unpairNote };
  }

  // --- Caught changes ---------------------------------------------------------------------

  /**
   * Writes the chosen caught changes again as this device's own new changes, under the current
   * key, through the normal write path. The only way a caught change is ever applied.
   */
  async reapplyCaughtChanges(ids: string[]): Promise<void> {
    const session = await this.ensureOpen();
    const vaultId = this.prefs.vaultId!;
    const chosen = new Set(ids);
    const caught = listCaughtChanges({
      state: this.state!,
      logs: this.logs,
      keys: session.vault.keys,
      deviceNames: session.vault.deviceNames,
      accounts: session.vault.accounts,
      handled: this.handledCaught,
    });
    const unreadable = caught.filter((c) => chosen.has(c.view.id) && c.action === null);
    if (unreadable.length > 0) throw new Error("This device can't read one of the chosen changes, so it can't make it again. Dismiss it instead.");
    const steps = reapplyActions(caught, chosen, session.vault.accounts).map((action): EntryStep =>
      action.kind === 'account.put'
        ? this.putStep(action.account, action.record)
        : (state, s) => buildAccountDelete(state, s.device, { account: action.account, time: now() }),
    );
    if (steps.length > 0) await this.commit(steps);
    await this.markCaughtHandled(
      vaultId,
      caught.filter((c) => chosen.has(c.view.id)).map((c) => c.view.id),
    );
  }

  async dismissCaughtChanges(ids: string[]): Promise<void> {
    const vaultId = this.prefs.vaultId;
    if (!vaultId) return;
    await this.markCaughtHandled(vaultId, ids);
  }

  async dismissVoidedChanges(ids: string[]): Promise<void> {
    const vaultId = this.prefs.vaultId;
    if (!vaultId) return;
    await this.markCaughtHandled(vaultId, ids);
  }

  private async markCaughtHandled(vaultId: string, ids: string[]): Promise<void> {
    this.handledCaught = new Set([...this.handledCaught, ...ids]);
    await saveHandledCaught(vaultId, this.handledCaught);
    this.publish();
  }
}

const engine = new VaultEngine();

/** Starts the engine (native only); returns the function that stops it. */
export function startVaultEngine(): () => void {
  return engine.start();
}

/** The actions behind useVault() on a phone or tablet. */
export const engineActions: VaultActions = {
  createVault: (name) => engine.createVault(name),
  confirmRecoverySaved: (flow) => engine.confirmRecoverySaved(flow),
  newRecoveryPhrase: (current) => engine.newRecoveryPhrase(current),
  replaceVaultWithoutPhrase: () => engine.replaceVaultWithoutPhrase(),
  endRecoveryFlow: (flow) => engine.endRecoveryFlow(flow),
  unlock: () => engine.unlock(),
  unlockWithPhrase: (words) => engine.unlockWithPhrase(words),
  requireUnlock: (reason) => engine.requireUnlock(reason),
  lock: () => engine.lock(),
  setAppLock: (on) => engine.setAppLock(on),
  setAutoLock: (ms) => engine.setAutoLock(ms),
  code: (accountId, at) => engine.code(accountId, at),
  parseQr: (text) => engine.parseQr(text),
  checkAccount: (account) => engine.checkAccount(account),
  addAccounts: (accounts) => engine.addAccounts(accounts),
  renameAccount: (id, issuer, label) => engine.renameAccount(id, issuer, label),
  deleteAccount: (id) => engine.deleteAccount(id),
  typeCode: (accountId) => engine.typeCode(accountId),
  renameDevice: (id, name) => engine.renameDevice(id, name),
  removeDevice: (id) => engine.removeDevice(id),
  reapplyCaughtChanges: (ids) => engine.reapplyCaughtChanges(ids),
  dismissVoidedChanges: (ids) => engine.dismissVoidedChanges(ids),
  dismissCaughtChanges: (ids) => engine.dismissCaughtChanges(ids),
  requestJoin: (deviceName) => engine.joins.requestJoin(deviceName),
  cancelJoin: () => engine.joins.cancel(),
  acceptJoinRequest: (requestId) => engine.joins.accept(requestId),
  approveJoin: (requestId) => engine.joins.approve(requestId),
  denyJoin: (requestId) => engine.joins.deny(requestId),
  restoreWithPhrase: (words) => engine.restoreWithPhrase(words),
  cancelRestore: () => engine.cancelRestore(),
  deleteRemovedVault: () => engine.deleteRemovedVault(),
};
