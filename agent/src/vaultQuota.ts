import type { VaultLogs } from './vault/chain';
import type { Member, VaultState } from './vault/replay';
import { DEFAULT_QUOTA_LIMITS, quotaPass, storedQuotaPass, type Allowance, type QuotaLimits } from './vault/quota';

export {
  ADMIN_QUOTA,
  DEFAULT_QUOTA_LIMITS,
  MAX_VAULT_BYTES,
  MAX_VAULT_ENTRIES,
  MEMBER_QUOTA,
  RESERVE_PER_IDENTITY,
  UNCAPPED_BOUND,
  VAULT_RESERVE,
  type Allowance,
  type QuotaLimits,
} from './vault/quota';

const MIB = 1024 * 1024;

/*
 * How much of a vault the computer takes. Only verified lines of identities the vault knows
 * count (`state.chains`): junk past a chain and logs nobody brought in count toward nothing.
 *
 * - Ordinary lines (account changes, renames, adds, phrases, key changes nobody needed, rejected
 *   placeholders) count toward their author's quota and toward the vault-wide cap. The vault-wide
 *   caps count only lines of identities still in, within their cutoff and within their share, so
 *   removing whoever filled the vault frees it. A member gets a
 *   tenth of the vault, far more than years of edits, so one member can't fill it; an admin, who
 *   also adds devices, gets more.
 * - Uncapped lines let honest devices take the vault back whatever else is in the folder: an
 *   active admin's removal of a device still in, and a restore by the recovery phrase (vault/quota.ts
 *   quotaPass). No quota or cap refuses them and they count toward none; they are bounded by
 *   identities (UNCAPPED_BOUND), and every byte field of a removal has an exact or tight size.
 * - Reserved lines (a key.rotate when the vault needed a fresh key, a device's hello) are taken
 *   past the author's quota and the vault cap, within the author's reserve and the vault-wide one.
 *   Past the author's reserve they count as ordinary.
 */

interface Tally {
  lines: number;
  bytes: number;
}

interface IdentityUsage {
  ordinary: Tally;
  reserved: Tally;
  /**
   * What counts toward the vault-wide caps: lines of an identity still in, within its cutoff,
   * and (ordinary ones) within its share. A removed or cut-off identity's lines, and anything past
   * a share, fill nothing for good (R6-B).
   */
  vaultOrdinary: Tally;
  vaultReserved: Tally;
  /** Lines of this append that landed in each bucket. */
  addedOrdinary: number;
  addedReserved: number;
}

const emptyTally = (): Tally => ({ lines: 0, bytes: 0 });

function fits(tally: Tally, line: number, allowance: Allowance): boolean {
  return tally.lines + 1 <= allowance.lines && tally.bytes + line <= allowance.bytes;
}

function add(tally: Tally, bytes: number): void {
  tally.lines += 1;
  tally.bytes += bytes;
}

/** Members are devices; a known identity that isn't one is a recovery identity (current or replaced). */
function quotaFor(member: Member | undefined, limits: QuotaLimits): Allowance {
  return member?.role === 'admin' ? limits.admin : limits.member;
}

/**
 * Each known identity's verified lines, sorted into its ordinary share and its reserve, oldest
 * first; uncapped lines count nowhere. Added lines are judged against `before` when it is known.
 */
function tallyUsage(after: VaultState, logs: VaultLogs, added: ReadonlySet<string>, limits: QuotaLimits, before: VaultState | undefined): Map<string, IdentityUsage> {
  const history = new Map(after.history.map((item) => [item.hash, item]));
  const usage = new Map<string, IdentityUsage>();
  for (const [identity, hashes] of Object.entries(after.chains)) {
    const lines = logs[identity] ?? [];
    const tally: IdentityUsage = { ordinary: emptyTally(), reserved: emptyTally(), vaultOrdinary: emptyTally(), vaultReserved: emptyTally(), addedOrdinary: 0, addedReserved: 0 };
    const quota = quotaFor(Object.hasOwn(after.members, identity) ? after.members[identity] : undefined, limits);
    const cutoffs = after.cutoffs ?? {};
    const cutoff = Object.hasOwn(cutoffs, identity) ? cutoffs[identity]! : Number.MAX_SAFE_INTEGER;
    const stillIn = Object.hasOwn(after.members, identity) ? !after.members[identity]!.removed : after.recovery?.deviceId === identity;
    for (const [seq, hash] of hashes.entries()) {
      const item = history.get(hash);
      const isAdded = added.has(hash);
      const pass = !item ? 'ordinary' : isAdded && before ? quotaPass(before, item, after) : storedQuotaPass(item, after);
      if (pass === 'uncapped') continue;
      const bytes = Buffer.byteLength(lines[seq] ?? '', 'utf8') + 1;
      const isReserved = pass === 'reserved' && fits(tally.reserved, bytes, limits.reservePerIdentity);
      add(isReserved ? tally.reserved : tally.ordinary, bytes);
      if (stillIn && seq <= cutoff) {
        if (isReserved) add(tally.vaultReserved, bytes);
        else if (fits(tally.vaultOrdinary, bytes, quota)) add(tally.vaultOrdinary, bytes);
      }
      if (!isAdded) continue;
      if (isReserved) tally.addedReserved += 1;
      else tally.addedOrdinary += 1;
    }
    usage.set(identity, tally);
  }
  return usage;
}

function over(tally: Tally, allowance: Allowance): boolean {
  return tally.lines > allowance.lines || tally.bytes > allowance.bytes;
}

function describe(allowance: Allowance): string {
  return `${allowance.lines} entries or ${allowance.bytes / MIB} MB`;
}

/**
 * Why the folder can't take an append, or null when it can. `after` is the replay with the append,
 * `added` holds the hashes of the appended entries and `before` is the replay without them, which
 * decides which of them pass uncapped or reserved (vault/quota.ts quotaPass); without it they are
 * judged like stored lines. Only what the append adds is judged: a vault already over a cap still
 * takes uncapped and reserved lines, and other devices' lines within their own limits.
 */
export function quotaProblem(after: VaultState, logs: VaultLogs, added: ReadonlySet<string>, limits: QuotaLimits = DEFAULT_QUOTA_LIMITS, before?: VaultState): string | null {
  const usage = tallyUsage(after, logs, added, limits, before);
  const ordinaryTotal = emptyTally();
  const reservedTotal = emptyTally();
  let addsOrdinary = false;
  let addsReserved = false;
  for (const [identity, tally] of usage) {
    ordinaryTotal.lines += tally.vaultOrdinary.lines;
    ordinaryTotal.bytes += tally.vaultOrdinary.bytes;
    reservedTotal.lines += tally.vaultReserved.lines;
    reservedTotal.bytes += tally.vaultReserved.bytes;
    addsOrdinary ||= tally.addedOrdinary > 0;
    addsReserved ||= tally.addedReserved > 0;
    const quota = quotaFor(Object.hasOwn(after.members, identity) ? after.members[identity] : undefined, limits);
    if (tally.addedOrdinary > 0 && over(tally.ordinary, quota)) {
      return `This device has used its share of the vault (${describe(quota)}), so the vault takes no more changes from it. An admin device can remove it, and it can then join again as a new device.`;
    }
  }
  if (addsOrdinary && over(ordinaryTotal, limits.vault)) {
    return `This vault is full (${describe(limits.vault)}), so it takes no more account changes. An admin device can still remove devices, and make a fresh key when the vault needs one.`;
  }
  if (addsReserved && over(reservedTotal, limits.vaultReserve)) {
    return `This vault's room for key changes is used up (${describe(limits.vaultReserve)}). An admin device can still remove devices; check the vault for devices that keep changing its key.`;
  }
  return null;
}
