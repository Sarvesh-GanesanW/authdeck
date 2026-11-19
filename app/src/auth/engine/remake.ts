/**
 * This device's changes the rules now reject, because another device changed the vault at the
 * same time (a removal, a key change). Each is made again on the vault as it now stands, under
 * the current key (docs/authenticator.md, rule 2):
 *   - lines the folder never had are dropped and their seqs signed afresh;
 *   - lines that were sent stay where they are (signing a different entry at a seq the folder
 *     once held would look like two histories) and are made again as new entries after them.
 * A rejected key.rotate is never made again: another key took its place, and a fresh one is made
 * by itself when the vault still needs it. Pure apart from the random bytes it is given.
 */
import { fromBase64Url, utf8Decode, type RandomBytes } from '../../vault/bytes';
import type { AccountDeleteBody, AccountPutBody, DeviceAddBody, DeviceRemoveBody, DeviceRenameBody, RecoverySetBody, RotationFields } from '../../vault/bodies';
import { buildAccountDelete, buildAccountPut, buildDeviceAdd, buildDeviceRemove, buildDeviceRename, buildRecoverySet } from '../../vault/build';
import { decryptBox, deviceIdFor, openSealedKey, type Box, type DeviceKeys } from '../../vault/crypto';
import { serializeEntry, type SignedEntry } from '../../vault/entry';
import { boxContexts, openVault, validateAccountRecord } from '../../vault/open';
import { replayVault, type ReplayOptions, type VaultState } from '../../vault/replay';
import type { LocalLogs } from './sync';

export interface RemakeInput {
  logs: LocalLogs;
  /** The replayed state of `logs`. */
  state: VaultState;
  /** How many of this device's lines the folder holds or ever held (see ownSentLength). */
  sentLength: number;
  device: DeviceKeys;
  /** Epoch keys this device had open before the latest read, which may include a key that lost. */
  keys: Record<number, Uint8Array>;
  random: RandomBytes;
  time: number;
  /** The engine's verify cache and fork proofs, for every replay made here. */
  replay: ReplayOptions;
}

/** A change that could not be made again. `hash` is the rejected entry's, so it is told once. */
export interface LostChange {
  hash: string;
  kind: SignedEntry['kind'];
  text: string;
}

export interface Remade {
  logs: LocalLogs;
  state: VaultState;
  lost: LostChange[];
  /**
   * True when a new recovery phrase was made again or lost: either way the person should write
   * down a phrase again, so the app asks them to.
   */
  recoveryChanged: boolean;
}

type Rebuilt = { entry: SignedEntry; newKey?: Uint8Array } | null | 'lost';

const ROTATION_KINDS: readonly SignedEntry['kind'][] = ['device.remove', 'recovery.set', 'key.rotate'];

const LOST_SENTENCE: Partial<Record<SignedEntry['kind'], string>> = {
  'account.put': 'An account change made on this device could not be made again. Check the account.',
  'device.rename': 'A device name change could not be made again. Rename the device again.',
  'device.add': 'A device trusted on this device could not be added again. Approve it again.',
  'device.remove': 'A device removed on this device could not be removed again. Remove it again.',
  'recovery.set':
    'The new recovery phrase made on this device did not take effect, because another device changed the vault at the same time. Make a new recovery phrase.',
};
const LOST_FALLBACK = 'A change made on this device could not be made again.';
const PHRASE_RACE =
  'Another device made a new recovery phrase at the same time, and its phrase is the one that works. The phrase this device showed does not. Make a new one here if you do not have the other.';

function parse(line: string): SignedEntry {
  return JSON.parse(line) as SignedEntry;
}

/**
 * Every key this device could have used for a box at `epoch`: the ones it had open, then any
 * key sealed to it at that epoch, including by a rotation that lost to another.
 */
function keysAt(input: RemakeInput, epoch: number): Uint8Array[] {
  const found: Uint8Array[] = [];
  const known = input.keys[epoch];
  if (known) found.push(known);
  const me = input.device.deviceId;
  const context = { vault: input.state.vaultId, epoch, to: me };
  for (const lines of Object.values(input.logs)) {
    for (const line of lines) {
      const entry = parse(line);
      const body = entry.body as Record<string, unknown>;
      const sealed =
        ROTATION_KINDS.includes(entry.kind) && (body as unknown as RotationFields).epoch === epoch
          ? (body as unknown as RotationFields).keys?.[me]
          : entry.kind === 'device.add' && (body as unknown as DeviceAddBody).device === me && (body as unknown as DeviceAddBody).epoch === epoch
            ? (body as unknown as DeviceAddBody).key
            : undefined;
      if (!sealed) continue;
      try {
        found.push(openSealedKey(sealed, input.device, context));
      } catch {
        // Not a key this device can open; another may be.
      }
    }
  }
  return found;
}

function openBox(input: RemakeInput, box: Box, context: Parameters<typeof decryptBox>[2]): Uint8Array | null {
  for (const key of keysAt(input, box.epoch)) {
    try {
      return decryptBox(key, box, context);
    } catch {
      // The wrong key for this box; try the next.
    }
  }
  return null;
}

/** What an entry is about: a later change of this device to the same thing makes it moot. */
function targetOf(entry: SignedEntry): string | null {
  const body = entry.body as Record<string, unknown>;
  switch (entry.kind) {
    case 'account.put':
    case 'account.delete':
      return `account:${String(body.account)}`;
    case 'device.add':
    case 'device.remove':
    case 'device.rename':
      return `device:${String(body.device)}`;
    case 'recovery.set':
      return 'recovery';
    default:
      return null;
  }
}

/** True when an applied recovery.set by another device was outside this entry's sight: that phrase counts. */
function lostPhraseRace(entry: SignedEntry, state: VaultState): boolean {
  return state.history.some(
    (h) => h.kind === 'recovery.set' && h.status === 'applied' && h.author !== entry.author && (entry.seen[h.author]?.seq ?? -1) < h.seq,
  );
}

/** The same change, built on `state`; null when it no longer makes sense (the account or device is gone). */
function rebuild(input: RemakeInput, entry: SignedEntry, state: VaultState, currentKey: Uint8Array): Rebuilt {
  const { device, random, time } = input;
  const vault = state.vaultId;
  switch (entry.kind) {
    case 'account.put': {
      const body = entry.body as unknown as AccountPutBody;
      if (state.accountChanges.some((c) => c.kind === 'account.delete' && c.account === body.account)) return null;
      const plain = openBox(input, body.box, boxContexts.account({ vault, epoch: body.box.epoch, author: entry.author }, body.account));
      if (!plain) return 'lost';
      const record = validateAccountRecord(JSON.parse(utf8Decode(plain)));
      return { entry: buildAccountPut(state, device, { account: body.account, record, currentKey, random, time }) };
    }
    case 'account.delete': {
      const { account } = entry.body as unknown as AccountDeleteBody;
      return state.accounts[account] ? { entry: buildAccountDelete(state, device, { account, time }) } : null;
    }
    case 'device.rename': {
      const body = entry.body as unknown as DeviceRenameBody;
      if (state.members[body.device]?.removed !== false) return null;
      const plain = openBox(input, body.name, boxContexts.deviceName(vault, body.name.epoch, body.device));
      if (!plain) return 'lost';
      return { entry: buildDeviceRename(state, device, { device: body.device, name: utf8Decode(plain), currentKey, random, time }) };
    }
    case 'device.add': {
      const body = entry.body as unknown as DeviceAddBody;
      if (state.members[body.device] || state.cutoffs[body.device] !== undefined) return null;
      const plain = openBox(input, body.name, boxContexts.deviceName(vault, body.name.epoch, body.device));
      if (!plain) return 'lost';
      const edPublic = fromBase64Url(body.ed);
      const added = { deviceId: deviceIdFor(edPublic), edPublic, xPublic: fromBase64Url(body.x) };
      return { entry: buildDeviceAdd(state, device, { device: added, role: body.role, name: utf8Decode(plain), currentKey, random, time }) };
    }
    case 'device.remove': {
      const body = entry.body as unknown as DeviceRemoveBody;
      if (state.members[body.device]?.removed !== false) return null;
      return buildDeviceRemove(state, device, { device: body.device, currentKey, random, time });
    }
    case 'recovery.set': {
      if (lostPhraseRace(entry, state)) return 'lost';
      // The same recovery keys, so a phrase the person already wrote down works.
      const body = entry.body as unknown as RecoverySetBody;
      const edPublic = fromBase64Url(body.ed);
      const recovery = { deviceId: deviceIdFor(edPublic), edPublic, xPublic: fromBase64Url(body.x) };
      return buildRecoverySet(state, device, { recovery, currentKey, random, time });
    }
    default:
      // key.rotate: another key took its place. A hello or create is never rejected in an honest vault.
      return null;
  }
}

/** Lines of `own` after `seq` that are about the same thing. */
function supersededBy(lines: readonly string[], entry: SignedEntry): boolean {
  const target = targetOf(entry);
  return target !== null && lines.slice(entry.seq + 1).some((line) => targetOf(parse(line)) === target);
}

function lostChange(entry: SignedEntry, hash: string, state: VaultState): LostChange {
  const race = entry.kind === 'recovery.set' && lostPhraseRace(entry, state);
  return { hash, kind: entry.kind, text: race ? PHRASE_RACE : (LOST_SENTENCE[entry.kind] ?? LOST_FALLBACK) };
}

/**
 * Makes this device's rejected changes again on the vault as it stands. `sentLength` lines are
 * never re-signed; unsent ones from the first rejected one on are dropped and rebuilt. Null when
 * there is nothing to do, when this device was removed (nothing it signs counts) or when it
 * holds no current key yet (it is re-keyed first).
 */
export function remakeRejected(input: RemakeInput): Remade | null {
  const { state, sentLength } = input;
  const own = input.device.deviceId;
  if (state.members[own]?.removed !== false) return null;
  const lines = input.logs[own] ?? [];
  const rejected = state.history.filter((h) => h.author === own && h.status === 'rejected');
  const firstUnsent = rejected.find((h) => h.seq >= sentLength);
  const cut = firstUnsent ? firstUnsent.seq : lines.length;
  const sentToRemake = rejected.filter((h) => h.seq < sentLength && !supersededBy(lines, parse(lines[h.seq]!)));
  const pending = [
    ...sentToRemake.map((h) => ({ entry: parse(lines[h.seq]!), hash: h.hash })),
    ...lines.slice(cut).map((line, i) => {
      const seq = cut + i;
      const item = state.history.find((h) => h.author === own && h.seq === seq);
      return { entry: parse(line), hash: item?.hash ?? '' };
    }),
  ];
  if (cut === lines.length && !sentToRemake.some((h) => targetOf(parse(lines[h.seq]!)) !== null)) return null;

  let next: LocalLogs = { ...input.logs, [own]: lines.slice(0, cut) };
  let current = cut < lines.length ? replayVault(state.vaultId, next, input.replay) : state;
  let currentKey: Uint8Array;
  try {
    currentKey = openVault(current, input.device).currentKey;
  } catch {
    return null;
  }
  const lost: LostChange[] = [];
  let recoveryChanged = false;
  let changed = cut < lines.length;
  for (const { entry, hash } of pending) {
    const remade = rebuild(input, entry, current, currentKey);
    if (remade === null) continue;
    if (entry.kind === 'recovery.set') recoveryChanged = true;
    if (remade === 'lost') {
      lost.push(lostChange(entry, hash, current));
      continue;
    }
    const attempt = { ...next, [own]: [...(next[own] ?? []), serializeEntry(remade.entry)] };
    const attemptState = replayVault(state.vaultId, attempt, input.replay);
    if (attemptState.history.find((h) => h.author === own && h.seq === remade.entry.seq)?.status !== 'applied') {
      remade.newKey?.fill(0);
      lost.push(lostChange(entry, hash, current));
      continue;
    }
    next = attempt;
    current = attemptState;
    changed = true;
    if (remade.newKey) currentKey = remade.newKey;
  }
  if (!changed && lost.length === 0) return null;
  return { logs: next, state: current, lost, recoveryChanged };
}
