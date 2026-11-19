/**
 * The most the app accepts in each answer (app/src/net/messages.ts LIMITS, same numbers): a reply
 * past any of them fails as a whole there, so the agent trims or leaves out what doesn't fit
 * instead of sending it. Lengths are JavaScript string lengths, as the app counts them.
 */
import type { AppEntry, FocusInfo, FsListResult, ProtocolError, VaultForkProof, VaultSealProof } from './protocol';

export const RESULT_LIMITS = {
  appId: 256,
  appName: 128,
  appDetail: 1024,
  apps: 2000,
  fsName: 1024,
  fsPath: 4096,
  fsEntries: 10_000,
  fsRoots: 64,
  focusName: 128,
  errorText: 1000,
  /** vault.forks.read: one proof of each kind per log at most, and a vault holds at most 256 logs. */
  vaultForkProofs: 256,
  vaultSealProofs: 256,
} as const;

/** Cuts `text` to `max`, never between the two halves of a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Apps the app can take: an id it could never match is left out, a long name or detail is cut. */
export function sendableApps(apps: readonly AppEntry[]): AppEntry[] {
  const kept: AppEntry[] = [];
  for (const app of apps) {
    if (kept.length >= RESULT_LIMITS.apps) break;
    if (app.id.length === 0 || app.id.length > RESULT_LIMITS.appId) continue;
    const entry: AppEntry = { ...app, name: clip(app.name, RESULT_LIMITS.appName) };
    if (entry.detail !== undefined) entry.detail = clip(entry.detail, RESULT_LIMITS.appDetail);
    kept.push(entry);
  }
  return kept;
}

/** A listing the app can take: entries with names or paths past the caps are left out, then the count is capped. */
export function sendableListing(listing: FsListResult): FsListResult {
  const fits = (e: { name: string; path: string }) => e.name.length <= RESULT_LIMITS.fsName && e.path.length <= RESULT_LIMITS.fsPath;
  return {
    ...listing,
    entries: listing.entries.filter(fits).slice(0, RESULT_LIMITS.fsEntries),
    roots: listing.roots.filter(fits).slice(0, RESULT_LIMITS.fsRoots),
  };
}

export function sendableFocus(info: FocusInfo): FocusInfo {
  return {
    ...info,
    appId: info.appId !== null && info.appId.length <= RESULT_LIMITS.appId ? info.appId : null,
    name: clip(info.name, RESULT_LIMITS.focusName),
  };
}

export function sendableError(error: ProtocolError): ProtocolError {
  // The code is one of the protocol's own short names; only the text can grow.
  const sent: ProtocolError = { code: error.code, message: clip(error.message, RESULT_LIMITS.errorText) };
  if (error.hint !== undefined) sent.hint = clip(error.hint, RESULT_LIMITS.errorText);
  return sent;
}

/** vault.forks.read within the app's caps. The store reads one proof per log, so this only guards a change there. */
export function sendableForks(result: { forks: VaultForkProof[]; sealProofs: VaultSealProof[] }): { forks: VaultForkProof[]; sealProofs: VaultSealProof[] } {
  return { forks: result.forks.slice(0, RESULT_LIMITS.vaultForkProofs), sealProofs: result.sealProofs.slice(0, RESULT_LIMITS.vaultSealProofs) };
}
