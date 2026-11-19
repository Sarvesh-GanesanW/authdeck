import { fromBase64Url, takeRandom, toBase64Url, utf8Encode, type RandomBytes } from './bytes';
import { MAX_NAME_BYTES, type Role, type VaultKind } from './bodies';
import { vaultIdFor } from './chain';
import { encryptBox, KEY_BYTES, keyCheck, sealKey, type DeviceKeys, type SealedKey } from './crypto';
import { ENTRY_VERSION, entryHash, signEntry, type EntryKind, type EntryRef, type SignedEntry } from './entry';
import type { JsonValue } from './canonical';
import { boxContexts, sealAccountRecord, type AccountRecord } from './open';
import type { Head, VaultState } from './replay';

const SALT_BYTES = 16;
const ACCOUNT_ID_BYTES = 16;

/** Public half of a device identity, as a join request carries it. */
export interface DevicePublicKeys {
  edPublic: Uint8Array;
  xPublic: Uint8Array;
  deviceId: string;
}

/**
 * Signs the next entry in `author`'s log. `seen` names every other identity's latest *applied*
 * entry, never a waiting one, so an entry stuck on something missing can't hold this one up.
 * `time` is raised to at least the author's previous entry and every entry named in `seen`.
 */
export function buildEntry(state: VaultState, author: Pick<DeviceKeys, 'deviceId' | 'edSecret'>, kind: EntryKind, body: Record<string, unknown>, time: number): SignedEntry {
  const head = state.heads[author.deviceId];
  const seen: Record<string, EntryRef> = {};
  let earliest = head?.time ?? 0;
  for (const [deviceId, other] of Object.entries(state.appliedHeads)) {
    if (deviceId === author.deviceId) continue;
    seen[deviceId] = { seq: other.seq, hash: other.hash };
    earliest = Math.max(earliest, other.time);
  }
  return signEntry(
    {
      v: ENTRY_VERSION,
      vault: state.vaultId,
      author: author.deviceId,
      seq: head ? head.seq + 1 : 0,
      prev: head ? head.hash : null,
      seen,
      time: Math.max(time, earliest),
      kind,
      body: body as { [key: string]: JsonValue },
    },
    author,
  );
}

/** The state to build an author's next entry on after `entry`, without replaying: only its own head moves. */
export function afterOwnEntry(state: VaultState, entry: SignedEntry): VaultState {
  const head: Head = { seq: entry.seq, hash: entryHash(entry), time: entry.time };
  return { ...state, heads: { ...state.heads, [entry.author]: head } };
}

export function newVaultKey(random: RandomBytes): Uint8Array {
  return takeRandom(random, KEY_BYTES);
}

export function newAccountId(random: RandomBytes): string {
  return toBase64Url(takeRandom(random, ACCOUNT_ID_BYTES));
}

function nameBox(key: Uint8Array, text: string, context: Parameters<typeof encryptBox>[2], random: RandomBytes) {
  const bytes = utf8Encode(text);
  if (bytes.length > MAX_NAME_BYTES) throw new Error(`A name can be at most ${MAX_NAME_BYTES} bytes.`);
  return encryptBox(key, bytes, context, random);
}

export interface CreatedVault {
  vaultId: string;
  /** The epoch 0 key. Keep it in secure storage. */
  key: Uint8Array;
  entry: SignedEntry;
}

/** Founds a vault: makes its id and epoch 0 key and signs `vault.create` as the founder's entry 0. */
export function createVault(options: { founder: DeviceKeys; kind: VaultKind; name: string; deviceName: string; random: RandomBytes; time: number }): CreatedVault {
  const { founder, random } = options;
  const salt = takeRandom(random, SALT_BYTES);
  const vaultId = vaultIdFor(founder.edPublic, salt);
  const key = newVaultKey(random);
  const entry = signEntry(
    {
      v: ENTRY_VERSION,
      vault: vaultId,
      author: founder.deviceId,
      seq: 0,
      prev: null,
      seen: {},
      time: options.time,
      kind: 'vault.create',
      body: {
        kind: options.kind,
        salt: toBase64Url(salt),
        ed: toBase64Url(founder.edPublic),
        x: toBase64Url(founder.xPublic),
        name: nameBox(key, options.name, boxContexts.vaultName(vaultId, 0), random) as unknown as JsonValue,
        deviceName: nameBox(key, options.deviceName, boxContexts.deviceName(vaultId, 0, founder.deviceId), random) as unknown as JsonValue,
        key: sealKey(key, founder.xPublic, { vault: vaultId, epoch: 0, to: founder.deviceId }) as unknown as JsonValue,
        keyCheck: keyCheck(key, vaultId, 0),
      },
    },
    founder,
  );
  return { vaultId, key, entry };
}

/**
 * `device.add`, signed by an admin device or the recovery identity, with the current key sealed to
 * the new device. `epoch` gives an older epoch's key instead: a restore whose phrase can't open
 * the current key (a bad seal) adds the device on the newest key it can open (open.ts).
 */
export function buildDeviceAdd(
  state: VaultState,
  author: DeviceKeys,
  options: { device: DevicePublicKeys; role: Role; name: string; currentKey: Uint8Array; epoch?: number; random: RandomBytes; time: number },
): SignedEntry {
  const { device, random } = options;
  const epoch = options.epoch ?? state.epoch;
  return buildEntry(
    state,
    author,
    'device.add',
    {
      device: device.deviceId,
      ed: toBase64Url(device.edPublic),
      x: toBase64Url(device.xPublic),
      role: options.role,
      name: nameBox(options.currentKey, options.name, boxContexts.deviceName(state.vaultId, epoch, device.deviceId), random),
      epoch,
      key: sealKey(options.currentKey, device.xPublic, { vault: state.vaultId, epoch, to: device.deviceId }),
    },
    options.time,
  );
}

/**
 * The new device's entry 0, written once it has read its `device.add`. It names the device's own
 * sealing key: the device counts as joined only when that matches the key it was approved with.
 */
/**
 * The hello confirms one approval, by its hash (checkJoinedVault says which). Without one, the
 * newest applied approval carrying this device's own keys (else the newest, which the rules refuse).
 */
export function buildDeviceHello(state: VaultState, author: DeviceKeys, time: number, approval?: string): SignedEntry {
  const ed = toBase64Url(author.edPublic);
  const x = toBase64Url(author.xPublic);
  const member = Object.hasOwn(state.members, author.deviceId) ? state.members[author.deviceId] : undefined;
  const newest = [...(member?.approvals ?? [])].reverse();
  // Without one with its own keys, the newest at all: the rules then refuse the hello.
  const chosen = approval ?? (newest.find((a) => a.ed === ed && a.x === x) ?? newest[0])?.hash;
  if (!chosen) throw new Error('this device has no approval to confirm');
  return buildEntry(state, author, 'device.hello', { x, approval: chosen }, time);
}

/** A key rotation's body fields, and the recipients it could not seal to. */
interface Rotation {
  fields: { epoch: number; keys: Record<string, SealedKey>; prevKey: unknown; keyCheck: string };
  newKey: Uint8Array;
  skipped: string[];
}

/**
 * Makes the next epoch key, seals it to each recipient and keeps the old key readable under it.
 * A recipient whose sealing key can't be used is skipped and reported, not fatal: replay refuses
 * such keys, so this only happens with a damaged state, and a lost device must stay removable.
 *
 * `currentKey` may be an older epoch's key: a device whose seal for the current epoch is bad
 * (open.ts readOnly) rotates on the newest key it holds, and readers match the `prevKey` to the
 * epoch whose key check it passes.
 */
function rotate(state: VaultState, currentKey: Uint8Array, recipients: { id: string; x: string }[], random: RandomBytes): Rotation {
  const epoch = state.epoch + 1;
  const newKey = newVaultKey(random);
  const keys: Record<string, SealedKey> = {};
  const skipped: string[] = [];
  for (const { id, x } of recipients) {
    try {
      keys[id] = sealKey(newKey, fromBase64Url(x), { vault: state.vaultId, epoch, to: id });
    } catch {
      skipped.push(id);
    }
  }
  const prevKey = encryptBox(newKey, currentKey, boxContexts.prevKey(state.vaultId, epoch), random);
  return { fields: { epoch, keys, prevKey, keyCheck: keyCheck(newKey, state.vaultId, epoch) }, newKey, skipped };
}

function approverActive(state: VaultState, id: string): boolean {
  const approver = Object.hasOwn(state.members, id) ? state.members[id] : undefined;
  return !!approver && approver.joined && !approver.removed;
}

/**
 * Who a new key goes to (replay.ts stayingIn): joined devices with their confirmed sealing key,
 * and approved ones still waiting to join, through the approvals by active devices other than the
 * one being removed, when those all name the same sealing key.
 */
function activeRecipients(state: VaultState, except?: string): { id: string; x: string }[] {
  const out: { id: string; x: string }[] = [];
  for (const m of Object.values(state.members)) {
    if (m.removed || m.deviceId === except) continue;
    if (m.joined) {
      out.push({ id: m.deviceId, x: m.x });
      continue;
    }
    const live = (m.approvals ?? []).filter((a) => a.by !== except && approverActive(state, a.by));
    if (live.length > 0 && live.every((a) => a.x === live[0]!.x)) out.push({ id: m.deviceId, x: live[0]!.x });
  }
  return out;
}

export interface RotationResult {
  entry: SignedEntry;
  /** The new epoch key. Keep it in secure storage. */
  newKey: Uint8Array;
  /** Devices the new key could not be sealed to; they show as unkeyed until approved again. */
  skipped: string[];
}

/**
 * Removes a device and rotates the vault key: the new key is sealed to every remaining device
 * and the recovery identity, and the old key is kept readable under the new one.
 */
export function buildDeviceRemove(state: VaultState, author: DeviceKeys, options: { device: string; currentKey: Uint8Array; random: RandomBytes; time: number }): RotationResult {
  const recipients = activeRecipients(state, options.device);
  if (state.recovery) recipients.push({ id: state.recovery.deviceId, x: state.recovery.x });
  const rotation = rotate(state, options.currentKey, recipients, options.random);
  const entry = buildEntry(state, author, 'device.remove', { device: options.device, ...rotation.fields }, options.time);
  return { entry, newKey: rotation.newKey, skipped: rotation.skipped };
}

/**
 * A fresh key for the devices in the vault now, changing nobody: written when key changes
 * clashed (`state.needsFreshKey`). Sealed to every active device and the recovery identity.
 */
export function buildKeyRotate(state: VaultState, author: DeviceKeys, options: { currentKey: Uint8Array; random: RandomBytes; time: number }): RotationResult {
  const recipients = activeRecipients(state);
  if (state.recovery) recipients.push({ id: state.recovery.deviceId, x: state.recovery.x });
  const rotation = rotate(state, options.currentKey, recipients, options.random);
  const entry = buildEntry(state, author, 'key.rotate', rotation.fields, options.time);
  return { entry, newKey: rotation.newKey, skipped: rotation.skipped };
}

export function buildDeviceRename(
  state: VaultState,
  author: DeviceKeys,
  options: { device: string; name: string; currentKey: Uint8Array; random: RandomBytes; time: number },
): SignedEntry {
  const name = nameBox(options.currentKey, options.name, boxContexts.deviceName(state.vaultId, state.epoch, options.device), options.random);
  return buildEntry(state, author, 'device.rename', { device: options.device, name }, options.time);
}

/**
 * Sets a new recovery identity and rotates the key like a removal: the new key is sealed to
 * every device and the new recovery identity, so the replaced phrase reads nothing written
 * afterwards (see recovery.ts for making one from a phrase).
 */
export function buildRecoverySet(state: VaultState, author: DeviceKeys, options: { recovery: DevicePublicKeys; currentKey: Uint8Array; random: RandomBytes; time: number }): RotationResult {
  const { recovery } = options;
  const recipients = [...activeRecipients(state), { id: recovery.deviceId, x: toBase64Url(recovery.xPublic) }];
  const rotation = rotate(state, options.currentKey, recipients, options.random);
  if (rotation.skipped.includes(recovery.deviceId)) throw new Error('The recovery phrase gave a key that can\'t be used. Make a new phrase.');
  const entry = buildEntry(state, author, 'recovery.set', { ed: toBase64Url(recovery.edPublic), x: toBase64Url(recovery.xPublic), ...rotation.fields }, options.time);
  return { entry, newKey: rotation.newKey, skipped: rotation.skipped };
}

export function buildAccountPut(
  state: VaultState,
  author: DeviceKeys,
  options: { account: string; record: AccountRecord; currentKey: Uint8Array; random: RandomBytes; time: number },
): SignedEntry {
  const box = sealAccountRecord({ vault: state.vaultId, epoch: state.epoch, author: author.deviceId }, options.currentKey, options.account, options.record, options.random);
  return buildEntry(state, author, 'account.put', { account: options.account, box }, options.time);
}

export function buildAccountDelete(state: VaultState, author: DeviceKeys, options: { account: string; time: number }): SignedEntry {
  return buildEntry(state, author, 'account.delete', { account: options.account }, options.time);
}
