/**
 * The authenticator's contract: what the vault engine (src/auth) gives the screens that show it.
 * Screens import types from here and the hook from ./useVault; they never touch src/vault or the
 * agent connection directly. Design: docs/authenticator.md.
 *
 * Where each surface lives (AuthHost mounts them by these names):
 *   screens/vault/VaultScreen.tsx         export function VaultScreen(props: SurfaceProps)
 *   screens/vault/AddAccountSheet.tsx     export function AddAccountSheet(props: SurfaceProps)
 *   screens/authflows/RecoverySetup.tsx   export function RecoverySetup(props: SurfaceProps)
 *   screens/authflows/RestoreFlow.tsx     export function RestoreFlow(props: SurfaceProps)
 *   screens/authflows/JoinFlow.tsx        export function JoinFlow(props: SurfaceProps)
 *   screens/authflows/ApproveDialog.tsx   export function ApproveDialog(props: { request: JoinRequestView; onClose(): void })
 *   screens/authflows/VaultIntro.tsx      export function VaultIntro(props: SurfaceProps)
 */

export type OtpType = 'totp' | 'hotp' | 'steam';
export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

/** An account as screens see it. The secret never leaves the engine. */
export interface AccountView {
  id: string;
  /** "GitHub". May be empty when the site gave none. */
  issuer: string;
  /** "ada-lovelace" or an email address. */
  label: string;
  type: OtpType;
  algorithm: OtpAlgorithm;
  /** 6–8 for TOTP/HOTP; 5 for Steam Guard. */
  digits: number;
  /** Seconds per code for TOTP and Steam; 0 for HOTP. */
  period: number;
  /** Name of the team vault it is shared through, or null for your own vault. */
  team: string | null;
}

/** A live code. For HOTP, secondsLeft and period are 0 and the code stays until used. */
export interface CodeView {
  code: string;
  secondsLeft: number;
  period: number;
}

export interface DeviceView {
  id: string;
  name: string;
  /** Three words to compare by eye across devices, e.g. "amber orbit tulip". */
  keyWords: string;
  thisDevice: boolean;
  role: 'admin' | 'member';
  addedAt: number;
  /**
   * When this device last showed it was alive: its latest signed beacon or applied change, by
   * its own clock. Null when it never has. Shown as "Last heard from 2 days ago".
   */
  lastHeardAt: number | null;
  /** This device signed two different histories (proof kept). An admin should remove it. */
  signedTwoHistories: boolean;
}

/**
 * Something about the vault the person should see as a banner. Plain sentence; `deviceId`
 * names the device it is about, when there is one.
 */
export interface VaultWarning {
  id: string;
  /**
   * withheld: another device has seen changes this folder lacks (new secrets are paused);
   * fresh-key: key changes clashed or the key reached a device that left (new secrets are
   *   paused until an admin device makes a fresh key, which it does by itself; a solo vault has
   *   none, so only a new recovery phrase makes one);
   * fork: a device signed (or may have signed) two different histories; `deviceId` is that device;
   * implausible: a device signed a status note no real vault could produce (ignored);
   * unheard: another admin device hasn't been heard from in a day or more; ask before adding or
   *   changing an account (a removal it made could be held back);
   * joins: several join attempts were stopped in the last hour;
   * waiting: changes wait on entries a device hasn't synced yet;
   * key: an older vault key could not be opened, so some old accounts may be unreadable;
   * no-recovery: the vault has more than one device and no recovery phrase, so devices that
   *   remove each other leave nothing to take the vault back with. Stands until a phrase is set;
   * prev-key: a device's key change carries a copy of the previous key that doesn't open, so
   *   devices that join later can't read older accounts; `deviceId` is the device that wrote it;
   * bad-seal: a device's key change or approval gave someone (maybe this device or the recovery
   *   phrase) a copy of the vault key that does not open, found by a device holding the key or
   *   proven by the recipient; `deviceId` is the device that wrote it;
   * lost-own-line: this device signed a change that neither it nor the computer kept, so it can
   *   never write again (lostOwnLine.ts); writing stays paused until the vault is deleted here.
   */
  kind: 'withheld' | 'fresh-key' | 'fork' | 'implausible' | 'unheard' | 'joins' | 'waiting' | 'key' | 'no-recovery' | 'prev-key' | 'bad-seal' | 'lost-own-line';
  text: string;
  deviceId?: string;
}

export interface HistoryItem {
  id: string;
  time: number;
  /** Plain sentence: "Added Steam", "Trusted Pixel 8", "Removed iPad". */
  text: string;
  /** Device name that made the change, or "Recovery phrase". */
  by: string;
  /** The author's key words ("amber orbit tulip"), to tell devices apart when names match. Absent for the recovery phrase or an unknown device. */
  byKeyWords?: string;
  /** Set when more than one device of the vault uses the author's name: how many do. */
  byNameShared?: number;
  status: 'applied' | 'rejected' | 'waiting';
  /** Why it was rejected or is waiting, as a plain sentence. */
  reason?: string;
}

/**
 * An account change another device made while the devices disagreed (a symmetric conflict took
 * its author out), kept in the folder but not applied. Offered back for review; never applied by itself.
 */
export interface CaughtChangeView {
  id: string;
  /** When the author's clock says it was made. */
  time: number;
  /** What it does: "Add GitHub (ada@example.com)", "Delete GitHub (ada@example.com)". */
  text: string;
  /** The author's name, and its key words when they can be read. */
  by: string;
  byKeyWords?: string;
  /** "made after Tablet was removed": its author was already cut off in the conflict when it made this. */
  madeAfter: string;
  /** False for a change this device can't read (its key never reached it): it can only be dismissed. */
  canReapply: boolean;
  /**
   * `restore`: not a caught change but one a device a restore took out made before it was cut (a
   * delete or an edit of an account, in the 30 days before its last line), applied and offered back.
   * Re-applying it ("Bring back") writes the account as it was before that change.
   */
  origin?: 'restore';
}

/**
 * A membership change (a removal, approval, phrase or key change) voided because its author was
 * removed by a change it had not seen. Told to the person in neutral words; never redone.
 */
export interface VoidedChangeView {
  id: string;
  time: number;
  /** The author's name. */
  by: string;
  /** "Tablet, which was removed, also tried to remove Phone. Nothing changed." */
  text: string;
  /** What the person can do themselves, if they want that change: "If you want Phone removed, remove it from its page." */
  hint?: string;
}

export type VaultStatus = 'loading' | 'none' | 'locked' | 'open';

export interface VaultSnapshot {
  status: VaultStatus;
  name: string;
  /** Sorted the way the user arranged them; empty while locked. */
  accounts: AccountView[];
  devices: DeviceView[];
  history: HistoryItem[];
  /** Account changes caught in a symmetric conflict that were neither re-applied nor dismissed; empty while locked. */
  caughtChanges: CaughtChangeView[];
  /** Membership changes voided because their author was removed at the same time; empty while locked. */
  voidedChanges: VoidedChangeView[];
  /** Every device's log checked out (signatures, chains, no rollback). */
  chainOk: boolean;
  /** Set when a log went backwards or changed under us; a plain sentence for a banner. */
  rollbackWarning: string | null;
  /** `pending`: a new phrase is checked but the computer doesn't hold it yet. */
  /** `finishing`: a new vault from "I don't have my phrase" is made here and still being saved to the computer. */
  /** `neverSet`: a solo vault made here whose phrase was never checked; only "I don't have my phrase" can give it one. */
  recovery: { savedAt: number | null; pending?: boolean; finishing?: boolean; neverSet?: boolean };
  /**
   * Where the vault folder lives, the encrypted backup: the computer's name and path, when known,
   * and when this device last read it (null before the first read since the app started).
   */
  storage: { computerName: string | null; path: string | null; syncedAt: number | null };
  lastChangeAt: number | null;
  /** App lock with Face ID / fingerprint / passcode. */
  appLock: boolean;
  /**
   * Set while app lock is on and this device can no longer prompt (its screen lock was removed):
   * the sentence to show. The vault then opens with the recovery phrase (unlockWithPhrase).
   */
  appLockBlocked: string | null;
  /** Lock after this long with no use. */
  autoLockMs: number;
  /** When the open vault will lock, for "locks in 4 min". Null when locked or no vault. */
  locksAt: number | null;
  /** True when the paired computer is online, so codes can be typed and changes synced. */
  computerOnline: boolean;
  /** Banners, most serious first. Empty when all is well. */
  warnings: VaultWarning[];
  /**
   * True while a `withheld` or `fresh-key` warning stands, or this device was removed: adding or
   * changing accounts is refused, so a removed device can't read new secrets. Codes still work,
   * and using an HOTP code (which only moves its counter) still does too.
   */
  secretsPaused: boolean;
  /**
   * Set when this device was removed from the vault: a plain sentence naming who removed it and
   * what to do. Its codes stay readable here, read-only, until the person deletes them with
   * deleteRemovedVault(). Nothing is deleted without that.
   */
  removed: string | null;
  /**
   * True while this removed device holds a removal it signed of the device that removed it, made
   * before it saw its own removal. The computer still takes it, so `removed` says to pair this
   * device with the computer again; the next sync sends it and both devices are out.
   */
  heldRemoval: boolean;
}

/** A new account from a QR code, the manual form or an import. */
export interface NewAccount {
  issuer: string;
  label: string;
  /** Base32, as sites show it; spaces and lower case allowed. */
  secret: string;
  type: OtpType;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
  /** HOTP only. */
  counter?: number;
}

export interface ImportPreview {
  accounts: NewAccount[];
  /** Plain sentences about what could not be imported and why. Empty when all is well. */
  problems: string[];
  /**
   * Google Authenticator exports split into several QR codes; set when there is more than one.
   * `scanned` counts the export's codes read so far (a repeat scan counts once; a code from a
   * different export starts the count over), and `accounts` holds every account read so far.
   */
  batches?: { scanned: number; total: number };
}

/** A device asking to join, shown on a trusted device. */
export interface JoinRequestView {
  id: string;
  deviceName: string;
  /** Six digits once both sides have exchanged nonces; null before. */
  code: string | null;
  expiresAt: number;
  /** The new device's three key words, to compare with what it shows. */
  keyWords?: string;
}

/** Progress of a join, on either side. */
export interface JoinState {
  role: 'new' | 'approver';
  requestId: string | null;
  /** The other device's name: the approver's on the new device, the new device's on the approver. */
  peerName: string | null;
  /** The other device's three key words, once known; covered by the code like the names. */
  peerKeyWords?: string;
  /** New device: the name of the vault it is joining, once the approver answered. */
  vaultName?: string;
  code: string | null;
  stage: 'waiting' | 'compare' | 'done' | 'failed' | 'expired';
  /** Plain sentence when failed. */
  error?: string;
  /**
   * New device: the join is stuck and only cancelling ends it. 'intercepted': the vault lists this
   * device with keys it didn't send, or something between the devices changed the join.
   * 'unapproved': the other device said it approved, but the vault holds no approval this device
   * can use. Either way this device makes new keys for the next attempt.
   */
  stuck?: 'intercepted' | 'unapproved';
  expiresAt: number | null;
}

export interface VaultActions {
  /**
   * First run: makes the vault on this device and returns the recovery phrase to show once, with
   * the flow token that confirms it (confirmRecoverySaved) and ends it (endRecoveryFlow).
   */
  createVault(name?: string): Promise<{ phrase: string[]; flow: string }>;
  /**
   * After the user typed back three words of the flow's phrase. `saved` is false while the
   * computer doesn't hold the change yet (it is kept and sent again; Settings says so). Throws for
   * a flow that isn't the current one, or holds nothing to check.
   */
  confirmRecoverySaved(flow: string): Promise<{ saved: boolean }>;
  /** The phrase surface closed: drops what that flow holds in memory and never stored. */
  endRecoveryFlow(flow: string): void;
  /**
   * Makes a new recovery phrase; the old one stops working. A solo vault needs the current
   * phrase's words (`current`), and the change goes out once the new words are checked
   * (confirmRecoverySaved).
   */
  newRecoveryPhrase(current?: string[]): Promise<{ phrase: string[]; flow: string }>;
  /**
   * Solo vault, "I don't have my phrase": after the device's own prompt, makes a new vault holding
   * every account and returns its phrase. Once its words are checked (confirmRecoverySaved) the new
   * vault is saved to the computer, and only then is the old one forgotten here and set aside on
   * the computer, which keeps it 30 days (vault.retire).
   */
  replaceVaultWithoutPhrase(): Promise<{ phrase: string[]; flow: string }>;
  /** Face ID / fingerprint / passcode when app lock is on; resolves when open, rejects with a plain message. */
  unlock(): Promise<void>;
  /** Opens the vault with the current recovery phrase instead of the device prompt (app lock never locks the person out). */
  unlockWithPhrase(words: string[]): Promise<void>;
  /**
   * Before a guarded change outside the vault (editing deck keys and commands): resolves at once
   * without a vault or app lock, or while the vault is open (until it auto-locks); otherwise shows
   * the app-lock prompt with `reason` and resolves once it passes, opening the vault. Rejects with
   * a plain message when the person cancels, the prompt fails, or the device can no longer prompt
   * (then the vault must be opened with the recovery phrase first).
   */
  requireUnlock(reason: string): Promise<void>;
  lock(): void;
  setAppLock(on: boolean): Promise<void>;
  setAutoLock(ms: number): void;

  /** Current code for an account, or null when locked or unknown. Use useCode for a ticking view. */
  code(accountId: string, now?: number): CodeView | null;
  /** Parses an otpauth:// or otpauth-migration:// QR text. Never throws. */
  parseQr(text: string): ImportPreview;
  /** Checks a manual entry; returns plain-sentence problems, empty when valid. */
  checkAccount(account: NewAccount): string[];
  addAccounts(accounts: NewAccount[]): Promise<string[]>;
  renameAccount(id: string, issuer: string, label: string): Promise<void>;
  deleteAccount(id: string): Promise<void>;
  /** Computes the code and types only its digits on the paired computer (secret, never logged). */
  typeCode(accountId: string): Promise<void>;

  renameDevice(id: string, name: string): Promise<void>;
  /**
   * Removes a device and rotates the vault key; returns the accounts it could see, to reset at the
   * sites, and a sentence saying whether the device was also unpaired from the computer.
   */
  removeDevice(id: string): Promise<{ accountsToReset: AccountView[]; unpairNote: string }>;
  /** Writes the chosen caught changes again as new changes of this device. Nothing else ever applies them. */
  reapplyCaughtChanges(ids: string[]): Promise<void>;
  /** Hides caught changes on this device without applying them. */
  dismissCaughtChanges(ids: string[]): Promise<void>;
  /** Stops showing voided changes on this device. */
  dismissVoidedChanges(ids: string[]): Promise<void>;

  /** New device: asks a trusted device (through the paired computer) to let it in. */
  requestJoin(deviceName: string): Promise<void>;
  cancelJoin(): void;
  /** Trusted device: answers a request; the code then shows on both. */
  acceptJoinRequest(requestId: string): Promise<void>;
  /** Trusted device: the codes matched; writes the device.add. */
  approveJoin(requestId: string): Promise<void>;
  denyJoin(requestId: string): void;

  /** Restores the vault from the paired computer's folder with the 12 words. */
  /**
   * `replacedAt`: the vault restored was one a phone had replaced with a new one (kept by the computer for 30 days).
   * `warning`: the computer doesn't show the restore yet (an older copy); the codes are on this device, and it isn't confirmed.
   */
  restoreWithPhrase(words: string[]): Promise<{ replacedAt: number | null; warning: string | null }>;
  /** Stops a restore search between vaults (the restore screen closed); a restore already signing finishes. */
  cancelRestore(): void;

  /** Only after this device was removed (`removed` is set): deletes its copy of the vault and its keys. */
  deleteRemovedVault(): Promise<void>;
}

export type VaultApi = VaultSnapshot &
  VaultActions & {
    /** Join in progress on this device, either side. */
    join: JoinState | null;
    /** Requests waiting for this (trusted) device to answer. */
    incoming: JoinRequestView[];
  };

/** Props every full-screen or sheet surface takes. */
export interface SurfaceProps {
  onClose(): void;
}
