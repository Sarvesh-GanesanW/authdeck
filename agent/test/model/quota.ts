/**
 * The agent's caps at model scale (invariant 18). vaultStore runs `quotaProblem` (src/vaultQuota.ts)
 * after planAppend with DEFAULT_QUOTA_LIMITS, sized for real vaults (20,000 lines, 32 MB), far past
 * what a model scenario writes. The model runs the same function with MODEL_LIMITS. Bytes are left
 * unlimited: at model scale only line counts can run out.
 */
import type { VaultState } from '../../src/vault/index';
import { quotaProblem, type QuotaLimits } from '../../src/vaultQuota';

const UNLIMITED = Number.MAX_SAFE_INTEGER;

/**
 * Small limits with the real shape: a member gets less than an admin; each identity's reserve
 * covers a few key changes; the vault reserve is above what the honest side of a deep scenario
 * writes (at most 4 hellos and 5 membership changes), so honest work alone never fills it.
 */
export const MODEL_LIMITS: QuotaLimits = {
  member: { lines: 8, bytes: UNLIMITED },
  admin: { lines: 16, bytes: UNLIMITED },
  vault: { lines: 60, bytes: UNLIMITED },
  reservePerIdentity: { lines: 4, bytes: UNLIMITED },
  vaultReserve: { lines: 10, bytes: UNLIMITED },
};

/** Marks a refusal as the cap's, not planAppend's. */
export const QUOTA_REFUSAL = 'quota: ';

/** What the agent's cap says to an append planAppend took, at model scale. */
export function modelQuotaProblem(after: VaultState, logs: Readonly<Record<string, readonly string[]>>, added: ReadonlySet<string>, before?: VaultState): string | null {
  return quotaProblem(after, logs as Record<string, string[]>, added, MODEL_LIMITS, before);
}
