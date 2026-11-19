/**
 * The vault's size limits and the one rule for which lines the limits never refuse. Pure, so the
 * agent (vaultQuota.ts) and replay judge lines the same way.
 */
import { rotationEntryMaxBytes } from './bodies';
import { MAX_IDENTITIES } from './entry';
import type { HistoryItem, Member, VaultState } from './replay';

const MIB = 1024 * 1024;

export interface Allowance {
  lines: number;
  bytes: number;
}

/**
 * Every number the quota check uses, in one object, so a model checker can run the real check at
 * a small scale. `vault` caps ordinary lines vault-wide; `vaultReserve` caps reserved ones.
 */
export interface QuotaLimits {
  member: Allowance;
  admin: Allowance;
  vault: Allowance;
  reservePerIdentity: Allowance;
  vaultReserve: Allowance;
}

export const MAX_VAULT_ENTRIES = 20_000;
export const MAX_VAULT_BYTES = 32 * MIB;
export const MEMBER_QUOTA: Allowance = { lines: 2_000, bytes: 4 * MIB };
export const ADMIN_QUOTA: Allowance = { lines: 8_000, bytes: 12 * MIB };
/**
 * What one identity's reserve holds: what the core lets one author write anyway (256 key changes,
 * MAX_IDENTITIES removals and one hello; replay.ts MAX_KEY_CHANGES_PER_AUTHOR and
 * MAX_REMOVALS_PER_AUTHOR, written out here so this file imports nothing at run time from replay).
 */
export const RESERVE_PER_IDENTITY: Allowance = { lines: 256 + MAX_IDENTITIES + 1, bytes: 8 * MIB };
export const VAULT_RESERVE: Allowance = { lines: 10_000, bytes: 32 * MIB };

export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  member: MEMBER_QUOTA,
  admin: ADMIN_QUOTA,
  vault: { lines: MAX_VAULT_ENTRIES, bytes: MAX_VAULT_BYTES },
  reservePerIdentity: RESERVE_PER_IDENTITY,
  vaultReserve: VAULT_RESERVE,
};

/**
 * How far uncapped lines (below) can grow a vault: they are bounded by identities, not bytes. At
 * most MAX_IDENTITIES removals apply, each at most a rotation sealed to every identity, plus a
 * restore (an approval and a hello) per identity, each well under the same size.
 */
export const UNCAPPED_BOUND: Allowance = {
  lines: 3 * MAX_IDENTITIES,
  bytes: 3 * MAX_IDENTITIES * (rotationEntryMaxBytes('device.remove', MAX_IDENTITIES) + 1),
};

/**
 * Which of a line's limits apply:
 * - uncapped: no quota or cap refuses it, and it counts toward none;
 * - reserved: taken past its author's share and the vault cap, within the reserves;
 * - ordinary: counts toward its author's share and the vault cap.
 */
export type QuotaPass = 'uncapped' | 'reserved' | 'ordinary';

function memberOf(state: VaultState, id: string): Member | undefined {
  return Object.hasOwn(state.members, id) ? state.members[id] : undefined;
}

function isActiveAdmin(member: Member | undefined): boolean {
  return member?.role === 'admin' && member.joined && !member.removed;
}

function isStillIn(member: Member | undefined): boolean {
  return member !== undefined && !member.removed;
}

/** A device approved by an identity that is not a device: a recovery identity restoring the vault. */
function isRestoredDevice(state: VaultState, id: string): boolean {
  const member = memberOf(state, id);
  return member !== undefined && memberOf(state, member.addedBy) === undefined;
}

/**
 * The hashes of lines that may be uncapped: the first applied removal of each device and the first
 * applied restore approval of each device (in replay order). So at most one of each per identity:
 * further removals of a device already out, or approvals of it again, go through the quotas.
 */
const firstOfEachCache = new WeakMap<VaultState, ReadonlySet<string>>();

function firstOfEach(after: VaultState): ReadonlySet<string> {
  const cached = firstOfEachCache.get(after);
  if (cached) return cached;
  const seen = new Set<string>();
  const first = new Set<string>();
  for (const item of after.history) {
    if (item.status !== 'applied' || item.subject === undefined) continue;
    const isRemoval = item.kind === 'device.remove';
    const isRestore = item.kind === 'device.add' && memberOf(after, item.author) === undefined;
    if (!isRemoval && !isRestore) continue;
    const key = `${item.kind}/${item.subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    first.add(item.hash);
  }
  firstOfEachCache.set(after, first);
  return first;
}

/**
 * A recovery identity's first approval of a device, or that device's hello: these restore the
 * vault. A recovery identity is the only author that is not a device.
 */
function restores(item: HistoryItem, after: VaultState): boolean {
  // A solo vault's key and phrase change only by the recovery identity (a restore's key change, a
  // new phrase): nothing a device wrote can fill the room they need.
  if (after.kind === 'solo' && (item.kind === 'key.rotate' || item.kind === 'recovery.set') && memberOf(after, item.author) === undefined) return true;
  if (item.kind === 'device.add') return memberOf(after, item.author) === undefined && firstOfEach(after).has(item.hash);
  if (item.kind === 'device.hello') return isRestoredDevice(after, item.author);
  return false;
}

/** The first applied removal of its device. */
function isFirstRemoval(item: HistoryItem, after: VaultState): boolean {
  return item.kind === 'device.remove' && firstOfEach(after).has(item.hash);
}

/**
 * The pass of a line, judged by the replay before it was added (`before`) and the replay with it
 * (`after`, where `item` comes from). Only an applied line gets more than ordinary.
 * - A removal by an admin active in `before`, of a device still in there, that applies in `after`:
 *   uncapped. A removal that wouldn't apply gets nothing. (Once stored, only the first applied
 *   removal of each device stays uncapped: storedQuotaPass.)
 * - A restore (a recovery identity's first device.add of a device, or that device's hello): uncapped.
 *   So is, in a solo vault, a key change or new phrase signed by the recovery identity.
 * - A key.rotate by an active admin when `before` needed a fresh key: reserved; a rotation nobody
 *   needed is ordinary.
 * - Any other device's hello: reserved (one per device).
 */
export function quotaPass(before: VaultState, item: HistoryItem, after: VaultState): QuotaPass {
  if (item.status !== 'applied') return 'ordinary';
  if (restores(item, after)) return 'uncapped';
  const author = memberOf(before, item.author);
  if (item.kind === 'device.remove') return isActiveAdmin(author) && item.subject !== undefined && isStillIn(memberOf(before, item.subject)) ? 'uncapped' : 'ordinary';
  if (item.kind === 'key.rotate') return isActiveAdmin(author) && before.needsFreshKey ? 'reserved' : 'ordinary';
  if (item.kind === 'device.hello') return 'reserved';
  return 'ordinary';
}

/**
 * The pass of a line already in the folder, when the replay before it is no longer known. The
 * first applied removal of each device and restores are uncapped (an applied removal passed its
 * own view, so its author was an admin and its target in there). A key.rotate is ordinary: whether
 * a fresh key was needed before it can't be told afterwards, and a rotation counted as reserved
 * forever would let rotations nobody needed fill the vault-wide reserve.
 */
export function storedQuotaPass(item: HistoryItem, after: VaultState): QuotaPass {
  if (item.status !== 'applied') return 'ordinary';
  if (restores(item, after)) return 'uncapped';
  if (isFirstRemoval(item, after)) return 'uncapped';
  if (item.kind === 'device.hello') return 'reserved';
  return 'ordinary';
}

/** True when the line may go past its author's share and the vault cap (quotaPass is not ordinary). */
export function reservedPass(before: VaultState, item: HistoryItem, after: VaultState): boolean {
  return quotaPass(before, item, after) !== 'ordinary';
}
