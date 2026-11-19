/**
 * What the env engine (./engine.ts) needs from the app around it: the link to the active computer,
 * the device's storage, the vault's lock, a clock and randomness. The app wires the real ones
 * (./app.ts); tests pass fakes. Design: docs/env.md.
 */
import type { EnvMethod, EnvMethods } from '../../protocol';
import type { EnvTrust } from '../../envcore';
import type { RandomBytes } from '../../vault/bytes';
import type { DeviceKeys } from '../../vault/crypto';

/** The active computer as the env engine sees it: online, with or without env sets. */
export interface EnvComputer {
  agentId: string;
  name: string;
  /** The agent lists ENV_FEATURE: env.* may be called. A 0.3 agent never gets one. */
  hasEnv: boolean;
}

/** env.* requests to the active computer's agent. Rejects with net/client RequestError. */
export interface EnvLink {
  request<M extends EnvMethod>(method: M, params: EnvMethods[M]['params'], timeoutMs?: number): Promise<EnvMethods[M]['result']>;
}

/** Where a set file sits on a computer, as the agent reported it. */
export interface EnvLocation {
  agentId: string;
  computerName: string;
  path: string;
  repoRoot: string;
  remote: string | null;
}

/**
 * This device's copy of one set. Holds no secret: values are boxes under the set's data key, and
 * the trust (the newest header and versions accepted) is public. Its integrity is anchored in
 * secure storage (EnvStore.trustAnchor), so a copy changed on disk is refused, not trusted.
 */
export interface StoredEnvSet {
  setId: string;
  name: string;
  /** The newest file this device accepted, as written: what releases and changes start from. */
  text: string;
  trust: EnvTrust;
  location: EnvLocation | null;
  syncedAt: number | null;
  lastReleasedAt: number | null;
  /** Set when a newer member list left this device out; the copy is the last one it was in. */
  removed: { note: string } | null;
  /** A change made here that the computer hasn't taken yet (made offline): merged in on the next read. */
  pending: boolean;
}

/** A join request this device made for a teammate's set (join-keys), still waiting for the owner. */
export interface StoredOwnRequest {
  setId: string;
  setName: string;
  computerName: string;
  keyWords: string[];
  madeAt: number;
  /**
   * The set as this device saw it when it asked (the file the request was made against, checked):
   * only a later file that follows it is taken as the set it asked to join, so someone who can
   * write to the repo can't swap in a set of their own under the same id.
   */
  pin: EnvTrust;
  /** That file's owner, and its six key words, for the person to compare when the owner reads theirs out. */
  ownerLabel: string;
  ownerKeyWords: string[];
  /** The person compared the owner's words and they matched (confirmOwnerWords): only then is the set taken. */
  ownerConfirmed: boolean;
}

/**
 * What the trust anchor of a copy set aside (it failed its anchor check) still vouches for: the
 * accepted rev, its header hash and its owner. The set is taken again only from a file at that
 * rev with that header, or above it with the same owner.
 */
export interface EnvSetAside {
  setId: string;
  rev: number;
  headerHash: string;
  ownerId: string;
}

/** Public settings: readable while locked, so requests are routed before the vault opens. */
export interface EnvPrefs {
  /** This device's member id in env sets (public), or null before its env identity exists. */
  memberId: string | null;
  ownRequests: StoredOwnRequest[];
  /** The person's name, for member labels ("Maya Rao · Pixel 8"); null until they give it. */
  personName: string | null;
}

/** A recovery identity's public half: what a set wraps its key to, so the phrase can take it over. */
export type EnvRecoveryPublic = Pick<DeviceKeys, 'edPublic' | 'xPublic' | 'deviceId'>;

export interface EnvStore {
  loadPrefs(): Promise<EnvPrefs>;
  savePrefs(prefs: EnvPrefs): Promise<void>;
  /**
   * Every stored copy; a copy no slot of which matches its anchor is set aside: reported with
   * what the anchor still vouches for (null when the anchor itself is unreadable), not returned.
   */
  loadSets(): Promise<{ sets: StoredEnvSet[]; damaged: { setId: string; floor: EnvSetAside | null }[] }>;
  /** Writes the copy, then its trust anchor in secure storage. */
  saveSet(set: StoredEnvSet): Promise<void>;
  /** Forgets the copy, its anchor and its data keys. */
  deleteSet(setId: string): Promise<void>;
  /** The env identity: secure storage, this device only, never in backups. Read only while the vault is open. */
  loadIdentity(): Promise<DeviceKeys | null>;
  saveIdentity(keys: DeviceKeys): Promise<void>;
  /** A set's data keys by epoch (secure storage). Read only while the vault is open. */
  loadDataKeys(setId: string): Promise<Record<number, Uint8Array>>;
  saveDataKeys(setId: string, keys: Record<number, Uint8Array>): Promise<void>;
}

/** The vault's lock, which env keys follow: they open with the vault and lock with it. */
export interface EnvVaultGate {
  status(): 'loading' | 'none' | 'locked' | 'open';
  /** The vault's device keys, read when the vault is open, the first time env sets need an identity. */
  deviceKeys(): Promise<DeviceKeys>;
  /**
   * Before a release or a signed change: opens a locked vault (its unlock), or, with app lock on,
   * asks for the device's own unlock (Face ID, fingerprint or device PIN) even while it is open.
   * Rejects with a plain sentence when the person cancels.
   */
  confirm(reason: string): Promise<void>;
  /** The vault's current recovery identity (public keys), or null when no phrase was ever set. */
  recovery(): Promise<EnvRecoveryPublic | null>;
  /** This device's vault id: a set's recovery identity is derived from its owner's phrase and vault id. */
  vaultId(): Promise<string | null>;
  /** The device was ever part of this vault (its founder, a member, or a device it removed). Read-only. */
  isVaultDevice(deviceId: string): Promise<boolean>;
}

export interface EnvHost {
  now(): number;
  random: RandomBytes;
  link: EnvLink;
  store: EnvStore;
  vault: EnvVaultGate;
  /** The device's own name ("Pixel 8") and form; member labels add the person's name before it. */
  device: { label: string; form: 'phone' | 'tablet' | null };
}
