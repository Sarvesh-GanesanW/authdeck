/**
 * Shared plumbing for the vault model checker: deterministic identities, the replay function
 * under test (injectable, so a deliberately broken rule can be checked too) and a replay memo.
 *
 * Only the public core API is used: builders, replayVault, openVault and the types.
 */
import type { SealProof } from '../../src/vault/sealProof';
import { existsSync } from 'node:fs';
import { modelQuotaProblem, QUOTA_REFUSAL } from './quota';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  AppendRefused,
  entryHash,
  checkJoinedVault,
  generateDeviceKeys,
  generateRecoveryPhrase,
  keyCheck,
  planAppend,
  openVault,
  recoveryKeysFromPhrase,
  replayVault,
  VerifyCache,
  type DeviceKeys,
  type ForkProof,
  type RandomBytes,
  toBase64Url,
  type SignedEntry,
  type VaultState,
  type VerifiedEntry,
} from '../../src/vault/index';

/**
 * Decides the vault state from a folder's logs and fork proofs: `replayVault`, or a toy rule in
 * tests. A rule set loaded from another folder brings that folder's planAppend too, so the honest
 * agent runs the same rules.
 */
export type ReplayFn = ((vaultId: string, logs: Record<string, string[]>, cache: VerifyCache, forks?: readonly ForkProof[], seals?: readonly SealProof[]) => VaultState) & { planAppend?: typeof planAppend; checkJoinedVault?: typeof checkJoinedVault };

export const realReplay: ReplayFn = (vaultId, logs, cache, forks, seals) => replayVault(vaultId, logs, { cache, ...(forks && forks.length > 0 ? { forks } : {}), ...(seals && seals.length > 0 ? { sealProofs: seals } : {}) } as Parameters<typeof replayVault>[2]);

/** What an honest agent's planAppend said to a batch: admitted (with the placeholders it kept), or the refusal. */
export type AppendResult = { ok: true; placeholders: string[]; logs: Record<string, string[]> } | { ok: false; reason: string };

/** Deterministic random stream: SHA-256(seed ‖ counter). Test-only. */
export function seededRandom(seed: string): RandomBytes {
  let counter = 0;
  return (length) => {
    const out = new Uint8Array(length);
    for (let filled = 0; filled < length; filled += 32) {
      const block = sha256(new TextEncoder().encode(`${seed}/${counter++}`));
      out.set(block.subarray(0, Math.min(32, length - filled)), filled);
    }
    return out;
  };
}

const MEMO_LIMIT = 50_000;

type CachedIdentity = Parameters<VerifyCache['prefix']>[1];

/**
 * A VerifyCache that remembers every verified line by content, not only each identity's last
 * chain, so the many sibling folders of a search share verified signatures. A line verified at
 * seq i for one identity is the same verified entry wherever it appears at seq i: its text fixes
 * its prev hash, seq, time and signature. It keeps the public prefix/remember contract.
 */
class ContentVerifyCache extends VerifyCache {
  private readonly verified = new Map<string, VerifiedEntry>();

  override prefix(vaultId: string, identity: CachedIdentity, lines: readonly string[]): VerifiedEntry[] {
    const id = identityKey(vaultId, identity);
    const out: VerifiedEntry[] = [];
    for (const line of lines) {
      const hit = this.verified.get(`${id}\n${line}`);
      if (!hit || hit.entry.seq !== out.length) break;
      out.push(hit);
    }
    return out;
  }

  override remember(vaultId: string, identity: CachedIdentity, lines: readonly string[], chain: VerifiedEntry[]): void {
    const id = identityKey(vaultId, identity);
    if (this.verified.size > MEMO_LIMIT * 4) this.verified.clear();
    chain.forEach((entry, i) => this.verified.set(`${id}\n${lines[i]}`, entry));
  }
}

function identityKey(vaultId: string, identity: CachedIdentity): string {
  return `${vaultId}/${identity.deviceId}/${identity.role}/${toBase64Url(identity.ed)}`;
}

/** The content cache while VerifyCache keeps its prefix/remember contract; a plain one otherwise. */
function newVerifyCache(): VerifyCache {
  const proto = VerifyCache.prototype as unknown as Record<string, unknown>;
  return typeof proto.prefix === 'function' && typeof proto.remember === 'function' ? new ContentVerifyCache() : new VerifyCache();
}

/** One checker run: seed-derived identities and memoised replays shared by every scenario. */
export class ModelContext {
  private readonly keys = new Map<string, DeviceKeys>();
  private readonly phrases = new Map<string, string>();
  private readonly labels = new Map<string, string>();
  private readonly replays = new Map<string, VaultState>();
  private readonly opens = new Map<string, Uint8Array | null>();
  private readonly builds = new Map<string, unknown>();
  private readonly cache = newVerifyCache();
  replayCount = 0;

  constructor(readonly seed: string, readonly replay: ReplayFn = realReplay) {}

  /** A device identity's keys, the same for one label across every scenario of this seed. */
  device(label: string): DeviceKeys {
    let keys = this.keys.get(label);
    if (!keys) {
      keys = generateDeviceKeys(seededRandom(`${this.seed}/device/${label}`));
      this.keys.set(label, keys);
      this.labels.set(keys.deviceId, label);
    }
    return keys;
  }

  /** A recovery identity's phrase (honest ones are restored with it) and its keys for `vaultId`. */
  recovery(label: string, vaultId: string): { phrase: string; keys: DeviceKeys } {
    let phrase = this.phrases.get(label);
    if (!phrase) {
      phrase = generateRecoveryPhrase(seededRandom(`${this.seed}/phrase/${label}`));
      this.phrases.set(label, phrase);
    }
    const cacheKey = `${label}@${vaultId}`;
    let keys = this.keys.get(cacheKey);
    if (!keys) {
      keys = recoveryKeysFromPhrase(phrase, vaultId);
      this.keys.set(cacheKey, keys);
      this.labels.set(keys.deviceId, label);
    }
    return { phrase, keys };
  }

  labelOf(deviceId: string): string {
    return this.labels.get(deviceId) ?? deviceId.slice(0, 6);
  }

  /**
   * Replays `logs`, memoised on content. `folderKey` must identify the content exactly (the
   * last line hash of each log does, since every line chains to the one before).
   */
  replayFolder(vaultId: string, logs: Record<string, string[]>, folderKey: string, forks: readonly ForkProof[] = [], seals: readonly SealProof[] = []): VaultState {
    const memoKey = `${vaultId}|${folderKey}`;
    const hit = this.replays.get(memoKey);
    if (hit) return hit;
    if (this.replays.size > MEMO_LIMIT) this.replays.clear();
    const state = this.replay(vaultId, logs, this.cache, forks, seals);
    this.replayCount++;
    this.replays.set(memoKey, state);
    return state;
  }

  /** Replays without the memo, for read-order checks that must run the rules again. */
  replayFresh(vaultId: string, logs: Record<string, string[]>, forks: readonly ForkProof[] = [], seals: readonly SealProof[] = []): VaultState {
    this.replayCount++;
    return this.replay(vaultId, logs, this.cache, forks, seals);
  }

  /**
   * Memoises a deterministic build: callers key it by everything it depends on (the view's
   * content, author, arguments, time and random seed), so sibling scenarios share signed entries.
   */
  memo<T>(key: string, build: () => T): T {
    if (this.builds.has(key)) return this.builds.get(key) as T;
    if (this.builds.size > MEMO_LIMIT) this.builds.clear();
    const value = build();
    this.builds.set(key, value);
    return value;
  }

  /** What an honest agent's planAppend (always the real one) says to `entries` sent as one batch. */
  append(vaultId: string, logs: Record<string, string[]>, entries: readonly SignedEntry[], forks: readonly ForkProof[] = [], quota = false, seals: readonly SealProof[] = []): AppendResult {
    try {
      const append = this.replay.planAppend ?? planAppend;
      const plan = append(vaultId, logs, entries, { cache: this.cache, ...(forks.length > 0 ? { forks } : {}), ...(seals.length > 0 ? { sealProofs: seals } : {}) } as Parameters<typeof append>[3]);
      // vaultStore runs the cap after planAppend; at model scale, with model limits.
      if (quota) {
        const problem = modelQuotaProblem(plan.state, plan.logs, new Set(entries.map((e) => entryHash(e))), (plan as { before?: VaultState }).before);
        if (problem) return { ok: false, reason: `${QUOTA_REFUSAL}${problem}` };
      }
      return { ok: true, placeholders: plan.placeholders, logs: plan.logs as Record<string, string[]> };
    } catch (err) {
      // Another rule set's AppendRefused is its own class: match it by name.
      if (err instanceof AppendRefused || (err instanceof Error && err.constructor.name === 'AppendRefused')) return { ok: false, reason: err.message };
      throw err;
    }
  }

  /** Every account `identity` can read in `state` (openVault, with whatever fallback the rules give). */
  readable(state: VaultState, folderKey: string, identity: DeviceKeys): Set<string> {
    const memoKey = `read|${state.vaultId}|${folderKey}|${identity.deviceId}`;
    const cached = this.builds.get(memoKey) as Set<string> | undefined;
    if (cached) return cached;
    let ids = new Set<string>();
    try {
      ids = new Set(Object.keys(openVault(state, identity).accounts));
    } catch {
      ids = new Set();
    }
    this.builds.set(memoKey, ids);
    return ids;
  }

  /** The current key `identity` opens in `state`, or null when it holds none. */
  /**
   * `readOnly`: also the key a device falls back to while the current one doesn't open for it (the
   * newest epoch it opens; openVault's readOnly), which serves to write a fresh key or a removal.
   */
  currentKey(state: VaultState, folderKey: string, identity: DeviceKeys, readOnly = false): Uint8Array | null {
    const memoKey = `${state.vaultId}|${folderKey}|${identity.deviceId}|${readOnly}`;
    if (this.opens.has(memoKey)) return this.opens.get(memoKey)!;
    let key: Uint8Array | null = null;
    try {
      const opened = openVault(state, identity) as { currentKey?: Uint8Array; epoch?: number; readOnly?: string | null };
      key = opened.currentKey ?? null;
      const epoch = opened.epoch ?? state.epoch;
      if (opened.readOnly && !readOnly) key = null;
      // Held only if it opens to that epoch's keyCheck, not merely because a sealed key exists.
      if (key && state.keyChecks[epoch] !== undefined && keyCheck(key, state.vaultId, epoch) !== state.keyChecks[epoch]) key = null;
    } catch {
      key = null;
    }
    if (this.opens.size > MEMO_LIMIT) this.opens.clear();
    this.opens.set(memoKey, key);
    return key;
  }
}

/**
 * A replay function from another module that exports `replayVault` with the same signature: a
 * candidate rule set, or a snapshot. When a `logs.ts` sits beside it, the honest agent uses that
 * planAppend too, and an `approval.ts` its checkJoinedVault. The model's builders still come from src/vault.
 */
export async function loadReplay(modulePath: string): Promise<ReplayFn> {
  const mod = (await import(modulePath)) as { replayVault?: (vaultId: string, logs: Record<string, string[]>, options: { cache: VerifyCache; forks?: readonly ForkProof[]; sealProofs?: readonly SealProof[] }) => VaultState };
  const replay = mod.replayVault;
  if (typeof replay !== 'function') throw new Error(`${modulePath} does not export replayVault. Point --replay-module at a file that does (for example src/vault/replay.ts).`);
  const fn: ReplayFn = (vaultId, logs, cache, forks, seals) => replay(vaultId, logs, { cache, ...(forks && forks.length > 0 ? { forks } : {}), ...(seals && seals.length > 0 ? { sealProofs: seals } : {}) });
  const logsPath = modulePath.replace(/replay\.ts$/, 'logs.ts');
  if (logsPath !== modulePath && existsSync(logsPath)) {
    const logs = (await import(logsPath)) as { planAppend?: typeof planAppend };
    if (typeof logs.planAppend === 'function') fn.planAppend = logs.planAppend;
  }
  // The joiner's check reads the state, so it must match the rules that built it.
  const approvalPath = modulePath.replace(/replay\.ts$/, 'approval.ts');
  if (approvalPath !== modulePath && existsSync(approvalPath)) {
    const approval = (await import(approvalPath)) as { checkJoinedVault?: typeof checkJoinedVault };
    if (typeof approval.checkJoinedVault === 'function') fn.checkJoinedVault = approval.checkJoinedVault;
  }
  return fn;
}
