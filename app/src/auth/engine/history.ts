/**
 * Turns the replayed log into the History list: one plain sentence per change ("Added GitHub",
 * "Trusted Pixel 8"), who made it, and why a change was rejected or is waiting. Pure.
 */
import type { HistoryItem } from '../contract';
import { fromBase64Url, utf8Decode } from '../../vault/bytes';
import type { Rejection } from '../../vault/chain';
import { decryptBox, keyWords, type Box } from '../../vault/crypto';
import { readingSkeleton } from '../../net/unicodeNames';
import { boxContexts, validateAccountRecord, type AccountRecord } from '../../vault/open';
import type { HistoryItem as CoreHistoryItem, VaultState } from '../../vault/replay';
import { accountTitle } from './accounts';
import { isUnknownDeviceRejection, reasonSentence } from './sentences';

export const RECOVERY_AUTHOR = 'Recovery phrase';
const UNKNOWN_DEVICE = 'Unknown device';

export interface HistoryInput {
  state: VaultState;
  /** Epoch keys this device holds (OpenVault.keys). */
  keys: Record<number, Uint8Array>;
  deviceNames: Record<string, string | null>;
  /** Rejections of whole lines from the last read of the folder; they never enter the local copy. */
  folderRejections: Rejection[];
  /** Account changes the rules applied but this device could not decrypt (OpenVault.rejected). */
  unreadable: Rejection[];
  /** When the folder was last read, the time shown for those. */
  readAt: number;
}

/** What an applied account.put changed, from the decrypted records before and after. */
interface AccountChangeNames {
  title: string;
  previous: AccountRecord | null;
  record: AccountRecord;
}

export function openRecord(state: VaultState, keys: Record<number, Uint8Array>, change: { account: string; box: Box; author: string }): AccountRecord | null {
  const { account, box, author } = change;
  const key = keys[box.epoch];
  if (!key) return null;
  try {
    const plain = decryptBox(key, box, boxContexts.account({ vault: state.vaultId, epoch: box.epoch, author }, account));
    return validateAccountRecord(JSON.parse(utf8Decode(plain)));
  } catch {
    return null;
  }
}

/** Decrypts every applied account change once, so each history line can name its account. */
function accountNames(state: VaultState, keys: Record<number, Uint8Array>): { puts: Map<string, AccountChangeNames>; deletes: Map<string, string> } {
  const latest = new Map<string, AccountRecord>();
  const puts = new Map<string, AccountChangeNames>();
  const deletes = new Map<string, string>();
  for (const change of state.accountChanges) {
    const previous = latest.get(change.account) ?? null;
    if (change.kind === 'account.delete') {
      deletes.set(change.hash, previous ? accountTitle(previous) : 'an account');
      latest.delete(change.account);
      continue;
    }
    const record = openRecord(state, keys, change);
    if (!record) continue;
    puts.set(change.hash, { title: accountTitle(record), previous, record });
    latest.set(change.account, record);
  }
  return { puts, deletes };
}

function putSentence(change: AccountChangeNames | undefined): string {
  if (!change) return 'Changed an account';
  const { previous, record, title } = change;
  if (!previous) return `Added ${title}`;
  const before = accountTitle(previous);
  if (previous.issuer !== record.issuer || previous.label !== record.label)
    return before === title ? `Renamed ${title} account` : `Renamed ${before} to ${title}`;
  if (record.type === 'hotp' && record.counter > previous.counter) return `Used a code for ${title}`;
  if (previous.position !== record.position) return `Moved ${title}`;
  return `Changed ${title}`;
}

/** Ids of every recovery identity the vault has had, so their entries read "Recovery phrase". */
export function recoveryIds(history: CoreHistoryItem[]): Set<string> {
  return new Set(history.filter((h) => h.kind === 'recovery.set' && h.status === 'applied' && h.subject).map((h) => h.subject!));
}

/** Who signed a line: a name, plus key words and a count when the name alone can't tell devices apart. */
export type Byline = Pick<HistoryItem, 'by' | 'byKeyWords' | 'byNameShared'>;

/** A value keyed by an author id, own properties only: an id like "constructor" finds nothing. */
function own<T>(record: Record<string, T>, id: string | undefined): T | undefined {
  return id !== undefined && Object.hasOwn(record, id) ? record[id] : undefined;
}

/**
 * How many devices of the vault use each name, counted by how the name reads (the UTS #39
 * skeleton), so "Pixel 8" with a Cyrillic "е" counts as the same name as "Pixel 8".
 */
function nameUses(deviceNames: Record<string, string | null>): Map<string, number> {
  const uses = new Map<string, number>();
  for (const name of Object.values(deviceNames)) {
    if (typeof name !== 'string' || !name) continue;
    const skeleton = readingSkeleton(name);
    uses.set(skeleton, (uses.get(skeleton) ?? 0) + 1);
  }
  return uses;
}

/** The key words of a member's signing key, or nothing when the stored key can't be read. */
function keyWordsOf(ed: unknown): string | undefined {
  if (typeof ed !== 'string') return undefined;
  try {
    return keyWords(fromBase64Url(ed)).join(' ');
  } catch {
    // A history line must still show; the byline then carries the name alone.
    return undefined;
  }
}

/**
 * Bylines for each author. A name is whatever a device calls itself, so any member can take
 * another's; the key words come from the key that signed the line and can't be copied.
 */
export function bylines(state: VaultState, deviceNames: Record<string, string | null>, recovery: Set<string>): (id: string) => Byline {
  const uses = nameUses(deviceNames);
  return (id) => {
    if (recovery.has(id)) return { by: RECOVERY_AUTHOR };
    const member = own(state.members, id);
    const name = own(deviceNames, id) || null;
    if (!member) return { by: name ?? UNKNOWN_DEVICE };
    const shared = name ? (uses.get(readingSkeleton(name)) ?? 0) : 0;
    const words = keyWordsOf(member.ed);
    return { by: name ?? UNKNOWN_DEVICE, ...(words ? { byKeyWords: words } : {}), ...(shared > 1 ? { byNameShared: shared } : {}) };
  };
}

export function buildHistory(input: HistoryInput): HistoryItem[] {
  const { state, deviceNames } = input;
  const recovery = recoveryIds(state.history);
  const names = accountNames(state, input.keys);
  const deviceName = (id: string | undefined) => own(deviceNames, id) || 'a device';
  const byline = bylines(state, deviceNames, recovery);
  const devicesAdded = new Set<string>();
  let recoverySets = 0;

  const textFor = (item: CoreHistoryItem): string => {
    const applied = item.status === 'applied';
    switch (item.kind) {
      case 'vault.create':
        return 'Created the vault';
      case 'device.add': {
        if (!applied) return 'Trusted a device';
        const again = devicesAdded.has(item.subject!);
        devicesAdded.add(item.subject!);
        if (again) return `Gave ${deviceName(item.subject)} the current vault key`;
        return recovery.has(item.author) ? `Restored the vault on ${deviceName(item.subject)}` : `Trusted ${deviceName(item.subject)}`;
      }
      case 'device.hello':
        return applied ? `${deviceName(item.author)} joined` : 'A device joined';
      case 'device.remove':
        return applied ? `Removed ${deviceName(item.subject)}` : 'Removed a device';
      case 'device.rename':
        return applied ? `Renamed ${item.subject === item.author ? 'device' : 'a device'} to ${deviceName(item.subject)}` : 'Renamed a device';
      case 'key.rotate':
        return 'Made a fresh vault key';
      case 'recovery.set':
        if (!applied) return 'Changed the recovery phrase';
        recoverySets++;
        return recoverySets === 1 ? 'Set up the recovery phrase' : 'Made a new recovery phrase';
      case 'account.put':
        return applied ? putSentence(names.puts.get(item.hash)) : 'Changed an account';
      case 'account.delete':
        return applied ? `Deleted ${names.deletes.get(item.hash) ?? 'an account'}` : 'Deleted an account';
    }
  };

  // Replay order, so "first add" and "first phrase" are decided the way they happened.
  const unreadable = new Map(input.unreadable.filter((r) => r.hash).map((r) => [r.hash!, r.reason]));
  const items: HistoryItem[] = state.history.map((item) => {
    const view: HistoryItem = { id: item.hash, time: item.time, text: textFor(item), ...byline(item.author), status: item.status };
    const reason = item.reason ?? unreadable.get(item.hash);
    if (unreadable.has(item.hash)) view.status = 'rejected';
    if (reason) view.reason = reasonSentence(reason);
    return view;
  });
  for (const rejection of input.folderRejections) {
    if (rejection.hash) continue;
    const unknown = isUnknownDeviceRejection(rejection.reason);
    items.push({
      id: `folder:${rejection.deviceId}:${rejection.seq}`,
      time: input.readAt,
      text: unknown ? 'Unsigned change' : 'Change that failed the checks',
      ...(unknown ? { by: UNKNOWN_DEVICE } : byline(rejection.deviceId)),
      status: 'rejected',
      reason: reasonSentence(rejection.reason),
    });
  }
  return items.sort((a, b) => b.time - a.time);
}
