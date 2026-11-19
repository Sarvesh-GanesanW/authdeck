/**
 * Where env sets live on the device (EnvStore).
 *
 * - Each set's copy (StoredEnvSet: the set file as written, values still AES-256-GCM boxes, and the
 *   public trust) is a file in the app's private document folder, `authdeck-env-v1/`. Nothing in it
 *   opens a value. Two slots per set (`<id>.a.json`, `<id>.b.json`), each with a generation and a
 *   checksum, so a write torn by a crash leaves the previous copy (expo-file-system can't rename
 *   atomically; see engine/localFiles.ts).
 * - What must not be changed or copied lives in secure storage (iOS Keychain, Android Keystore),
 *   "when unlocked, this device only", so never in backups: the env identity (the vault's device
 *   keys, copied once), each set's data keys by epoch, and each copy's trust anchor (a hash of its
 *   trust and file, plus the rev, header hash and owner it vouches for), so a copy rolled back or
 *   edited on disk is refused instead of trusted, and only a file at or past that point replaces it.
 * - Prefs (member id, own join requests with their pins, the person's name) are public and small:
 *   AsyncStorage. Each pin's check (set id, owner key, header hash) is in secure storage, so an
 *   edited pin is dropped instead of trusted.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

import { canonicalJson } from '../../vault/canonical';
import { fromBase64Url, toBase64Url, utf8Encode } from '../../vault/bytes';
import { keysFromSecrets, sha256Bytes, type DeviceKeys } from '../../vault/crypto';
import { isId, isPlainObject } from '../../vault/entry';
import { ENV_KEY_WORD_COUNT } from '../../envcore/types';
import type { EnvPrefs, EnvSetAside, EnvStore, StoredEnvSet, StoredOwnRequest } from './host';

const ROOT = 'authdeck-env-v1';
const SLOTS = ['a', 'b'] as const;
const PREFS_KEY = 'authdeck-env-prefs-v1';
const MAX_OWN_REQUESTS = 64;
/** A name typed once for member labels; checked on save (engine), and again on load. */
const MAX_PERSON_NAME = 40;
const STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const IDENTITY_KEY = 'authdeck_env_device_v1';
const keysName = (setId: string) => `authdeck_env_keys_${checkedId(setId)}`;
const anchorName = (setId: string) => `authdeck_env_trust_${checkedId(setId)}`;
const pinName = (setId: string) => `authdeck_env_pin_${checkedId(setId)}`;

const SECURE_FAILED =
  "AuthDeck couldn't use this device's secure storage for env sets. Unlock the device, close and reopen AuthDeck, then try again.";
const DAMAGED_IDENTITY = "This device's env set keys in secure storage are damaged. Ask the set's owner to add this device again.";

export const EMPTY_ENV_PREFS: EnvPrefs = { memberId: null, ownRequests: [], personName: null };

/** Storage names carry ids only, so nothing else (a path, "__proto__") ever names a key or file. */
function checkedId(id: string): string {
  if (!isId(id)) throw new Error('An env set id is malformed, so AuthDeck will not use it to find stored data.');
  return id;
}

async function secure<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    console.warn('env secure storage:', err instanceof Error ? err.message : String(err));
    throw new Error(SECURE_FAILED, { cause: err });
  }
}

/** The check in a copy's anchor: a hash of its trust and file, kept where the file can't be changed with it. */
export function copyAnchor(set: StoredEnvSet): string {
  return toBase64Url(sha256Bytes(utf8Encode(canonicalJson({ set: set.setId, text: set.text, trust: set.trust }))));
}

/** The anchor as stored: the check, and the accepted head it vouches for (public, small). */
function anchorRecord(set: StoredEnvSet): string {
  const owner = set.trust.header.members.find((m) => m.role === 'owner');
  return JSON.stringify({ check: copyAnchor(set), rev: set.trust.head.rev, headerHash: set.trust.head.headerHash, ownerId: owner?.id ?? '' });
}

function readAnchor(setId: string, raw: string | null): { check: string; floor: EnvSetAside | null } | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { check?: unknown; rev?: unknown; headerHash?: unknown; ownerId?: unknown };
    if (typeof parsed.check !== 'string') return null;
    const floor =
      Number.isSafeInteger(parsed.rev) && typeof parsed.headerHash === 'string' && isId(parsed.ownerId)
        ? { setId, rev: parsed.rev as number, headerHash: parsed.headerHash, ownerId: parsed.ownerId }
        : null;
    return { check: parsed.check, floor };
  } catch {
    return null;
  }
}

/**
 * The check of a join pin: its set, the owner key and header hash it holds the owner's later file
 * to, and the whole pin. Kept in secure storage, since the pin itself sits in public prefs.
 */
export function pinAnchor(request: StoredOwnRequest): string {
  const owner = request.pin.header.members.find((m) => m.role === 'owner');
  return toBase64Url(
    sha256Bytes(utf8Encode(canonicalJson({ set: request.setId, ownerEd: owner?.ed ?? '', headerHash: request.pin.head.headerHash, pin: request.pin, owner: [request.ownerLabel, ...request.ownerKeyWords], confirmed: request.ownerConfirmed }))),
  );
}

function slotChecksum(gen: number, body: string): string {
  return toBase64Url(sha256Bytes(utf8Encode(`${gen}\n${body}`)));
}

function isLocation(v: unknown): boolean {
  return v === null || (isPlainObject(v) && ['agentId', 'computerName', 'path', 'repoRoot'].every((k) => typeof v[k] === 'string') && (v.remote === null || typeof v.remote === 'string'));
}

const isTimeOrNull = (v: unknown) => v === null || (Number.isSafeInteger(v) && (v as number) >= 0);

function isStoredSet(v: unknown): v is StoredEnvSet {
  return (
    isPlainObject(v) &&
    isId(v.setId) &&
    typeof v.name === 'string' &&
    typeof v.text === 'string' &&
    isPlainObject(v.trust) &&
    isLocation(v.location) &&
    isTimeOrNull(v.syncedAt) &&
    isTimeOrNull(v.lastReleasedAt) &&
    (v.removed === null || (isPlainObject(v.removed) && typeof v.removed.note === 'string')) &&
    typeof v.pending === 'boolean'
  );
}

function isOwnRequest(v: unknown): v is StoredOwnRequest {
  return (
    isPlainObject(v) &&
    isId(v.setId) &&
    typeof v.setName === 'string' &&
    typeof v.computerName === 'string' &&
    Array.isArray(v.keyWords) &&
    v.keyWords.length === ENV_KEY_WORD_COUNT &&
    v.keyWords.every((w) => typeof w === 'string') &&
    isTimeOrNull(v.madeAt) &&
    isPlainObject(v.pin) &&
    isPlainObject(v.pin.head) &&
    isPlainObject(v.pin.header) &&
    typeof v.ownerLabel === 'string' &&
    typeof v.ownerConfirmed === 'boolean' &&
    Array.isArray(v.ownerKeyWords) &&
    v.ownerKeyWords.every((w) => typeof w === 'string')
  );
}

/** One slot's content: the copy, its generation and checksum; null when torn or damaged. */
function readSlot(text: string): { gen: number; set: StoredEnvSet } | null {
  try {
    const parsed = JSON.parse(text) as { gen?: unknown; body?: unknown; check?: unknown };
    if (!Number.isSafeInteger(parsed.gen) || typeof parsed.body !== 'string' || parsed.check !== slotChecksum(parsed.gen as number, parsed.body)) return null;
    const set = JSON.parse(parsed.body) as unknown;
    return isStoredSet(set) ? { gen: parsed.gen as number, set } : null;
  } catch {
    return null;
  }
}

export class DeviceEnvStore implements EnvStore {
  /** The generation last written per set, so the next save goes to the other slot. */
  private generations = new Map<string, number>();
  /** Sets with a pin anchor written or read, so a request that went also takes its anchor. */
  private pinIds = new Set<string>();

  constructor(private readonly root: () => Directory = () => new Directory(Paths.document, ROOT)) {}

  private folder(): Directory {
    const dir = this.root();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return dir;
  }

  async loadPrefs(): Promise<EnvPrefs> {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    if (raw === null) return EMPTY_ENV_PREFS;
    let stored: { memberId?: unknown; ownRequests?: unknown; personName?: unknown };
    try {
      stored = JSON.parse(raw) as typeof stored;
    } catch {
      // Prefs hold nothing that can't be learned again: the member id comes back with the vault.
      return EMPTY_ENV_PREFS;
    }
    const memberId = isId(stored.memberId) ? stored.memberId : null;
    const listed = Array.isArray(stored.ownRequests) ? stored.ownRequests.filter(isOwnRequest).slice(-MAX_OWN_REQUESTS) : [];
    // A pin its anchor doesn't vouch for (edited on disk) is dropped: that set stays outside
    // until the person asks to join again.
    const ownRequests: StoredOwnRequest[] = [];
    for (const request of listed) {
      const anchor = await secure(() => SecureStore.getItemAsync(pinName(request.setId), STORE_OPTIONS));
      if (anchor === pinAnchor(request)) ownRequests.push(request);
    }
    if (ownRequests.length < listed.length) console.warn(`Env sets: ${listed.length - ownRequests.length} join request(s) failed their check and were dropped.`);
    this.pinIds = new Set(listed.map((r) => r.setId));
    const personName = typeof stored.personName === 'string' && stored.personName.length <= MAX_PERSON_NAME ? stored.personName : null;
    return { memberId, ownRequests, personName };
  }

  async savePrefs(prefs: EnvPrefs): Promise<void> {
    const kept = prefs.ownRequests.slice(-MAX_OWN_REQUESTS);
    // The anchors first: a crash before the prefs are written leaves a pin without its request, never the reverse.
    for (const request of kept) await secure(() => SecureStore.setItemAsync(pinName(request.setId), pinAnchor(request), STORE_OPTIONS));
    const ids = new Set(kept.map((r) => r.setId));
    for (const setId of this.pinIds) if (!ids.has(setId)) await secure(() => SecureStore.deleteItemAsync(pinName(setId), STORE_OPTIONS));
    this.pinIds = ids;
    await AsyncStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ memberId: prefs.memberId, ownRequests: kept, personName: prefs.personName }),
    );
  }

  async loadSets(): Promise<{ sets: StoredEnvSet[]; damaged: { setId: string; floor: EnvSetAside | null }[] }> {
    const slots = new Map<string, { gen: number; set: StoredEnvSet }[]>();
    for (const entry of this.folder().list()) {
      if (!(entry instanceof File)) continue;
      const [setId, slot] = entry.name.split('.');
      if (!setId || !isId(setId) || !SLOTS.includes(slot as (typeof SLOTS)[number])) continue;
      // A slot that doesn't even read still names its set: the anchor decides what is set aside.
      const read = readSlot(await entry.text());
      slots.set(setId, [...(slots.get(setId) ?? []), ...(read && read.set.setId === setId ? [read] : [])]);
    }
    const sets: StoredEnvSet[] = [];
    const damaged: { setId: string; floor: EnvSetAside | null }[] = [];
    for (const [setId, found] of slots) {
      const anchor = readAnchor(setId, await secure(() => SecureStore.getItemAsync(anchorName(setId), STORE_OPTIONS)));
      // The newest slot the anchor vouches for: a slot written by a save that crashed before its
      // anchor, or edited on disk, is passed over.
      const kept = found.sort((a, b) => b.gen - a.gen).find((slot) => anchor?.check === copyAnchor(slot.set));
      this.generations.set(setId, Math.max(-1, ...found.map((slot) => slot.gen)));
      if (kept) sets.push(kept.set);
      else damaged.push({ setId, floor: anchor?.floor ?? null });
    }
    return { sets, damaged };
  }

  async saveSet(set: StoredEnvSet): Promise<void> {
    const gen = (this.generations.get(set.setId) ?? -1) + 1;
    const body = JSON.stringify(set);
    // The slot first, then the anchor that vouches for it: a crash between the two leaves the
    // previous slot, which the anchor still matches.
    await new File(this.folder(), `${checkedId(set.setId)}.${SLOTS[gen % 2]}.json`).write(JSON.stringify({ gen, body, check: slotChecksum(gen, body) }));
    this.generations.set(set.setId, gen);
    await secure(() => SecureStore.setItemAsync(anchorName(set.setId), anchorRecord(set), STORE_OPTIONS));
  }

  async deleteSet(setId: string): Promise<void> {
    const folder = this.folder();
    for (const slot of SLOTS) {
      const file = new File(folder, `${checkedId(setId)}.${slot}.json`);
      if (file.exists) file.delete();
    }
    this.generations.delete(setId);
    await secure(() => SecureStore.deleteItemAsync(anchorName(setId), STORE_OPTIONS));
    await secure(() => SecureStore.deleteItemAsync(keysName(setId), STORE_OPTIONS));
  }

  async loadIdentity(): Promise<DeviceKeys | null> {
    const raw = await secure(() => SecureStore.getItemAsync(IDENTITY_KEY, STORE_OPTIONS));
    if (raw === null) return null;
    try {
      const stored = JSON.parse(raw) as { ed?: unknown; x?: unknown };
      if (typeof stored.ed !== 'string' || typeof stored.x !== 'string') throw new Error('shape');
      return keysFromSecrets(fromBase64Url(stored.ed), fromBase64Url(stored.x));
    } catch (err) {
      throw new Error(DAMAGED_IDENTITY, { cause: err });
    }
  }

  saveIdentity(keys: DeviceKeys): Promise<void> {
    return secure(() => SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify({ ed: toBase64Url(keys.edSecret), x: toBase64Url(keys.xSecret) }), STORE_OPTIONS));
  }

  async loadDataKeys(setId: string): Promise<Record<number, Uint8Array>> {
    const raw = await secure(() => SecureStore.getItemAsync(keysName(setId), STORE_OPTIONS));
    if (raw === null) return {};
    const keys: Record<number, Uint8Array> = {};
    try {
      for (const [epoch, key] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        if (/^[1-9]\d{0,8}$/.test(epoch) && typeof key === 'string') keys[Number(epoch)] = fromBase64Url(key);
      }
    } catch {
      // A damaged item costs only old epochs: the current key opens again from the set file.
      return {};
    }
    return keys;
  }

  saveDataKeys(setId: string, keys: Record<number, Uint8Array>): Promise<void> {
    const encoded = Object.fromEntries(Object.entries(keys).map(([epoch, key]) => [epoch, toBase64Url(key)]));
    return secure(() => SecureStore.setItemAsync(keysName(setId), JSON.stringify(encoded), STORE_OPTIONS));
  }
}
