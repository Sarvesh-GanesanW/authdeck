/**
 * Open "Allow for 15 minutes" grants. They live only in this process: an agent restart ends them
 * all without a word, because nothing is left to end.
 *
 * A grant covers one set file (path and set id) on this computer; a second clone needs its own.
 * The values stay sealed as the device sent them, to a grant key whose secret is only in memory.
 * Each run inside the grant opens them and seals them again to that run's one-time key, under
 * that run's request id (envcore transfer.ts), so a sealed bundle answers one request only.
 */
import crypto from 'node:crypto';

import { openEnvSealedValues, sealEnvValues } from '../envcore';
import type { EnvSealedValues } from '../envcore/types';
import { ENV_GRANT_MS, type EnvGrant, type EnvGrantEndReason } from '../protocol';
import type { RandomBytes } from '../vault/bytes';
import type { DeviceKeys } from '../vault/crypto';

/** The commands a grant lists, newest first. */
export const MAX_GRANT_USES = 8;
const MAX_USE_CHARS = 120;
/**
 * The wall clock and the process's own clock may differ by this much between two checks before
 * the agent decides the computer slept (or its clock was set) and ends every grant. Well above a
 * long garbage-collection pause, well below a lid closed for a coffee.
 */
export const CLOCK_JUMP_MS = 20_000;
/** How often grants are checked for expiry, a clock jump and a changed set file. */
export const GRANT_CHECK_MS = 5_000;

export type TransferKey = Pick<DeviceKeys, 'xSecret' | 'xPublic'>;

/** The clocks a grant is measured by: the wall clock, and one that doesn't move while the computer sleeps. */
export interface GrantClock {
  now(): number;
  monotonic(): number;
}

export interface GrantEnded {
  grantId: string;
  setId: string;
  reason: EnvGrantEndReason;
}

interface OpenGrant {
  grant: EnvGrant;
  /** The paired device that allowed it. */
  deviceId: string;
  /** The computer's file when the grant opened; a different file ends it. */
  fileHash: string;
  source: { rev: number; fileHash: string };
  key: TransferKey;
  sealed: EnvSealedValues;
  /** The request the device sealed the values under. */
  sealedFor: string;
  startedMonotonic: number;
}

export interface NewGrant {
  setId: string;
  setName: string;
  path: string;
  by: string;
  deviceId: string;
  fileHash: string;
  source: { rev: number; fileHash: string };
  key: TransferKey;
  sealed: EnvSealedValues;
  requestId: string;
}

export interface GrantStoreDeps {
  clock: GrantClock;
  random: RandomBytes;
  /** Told after every change: the full list, and the grant that ended, if one did. */
  onChange(grants: EnvGrant[], ended?: GrantEnded): void;
}

export class GrantStore {
  private readonly open = new Map<string, OpenGrant>();
  private lastWall: number;
  private lastMonotonic: number;
  /** The process clock at the last periodic check. */
  private lastTick: number | null = null;

  constructor(private readonly deps: GrantStoreDeps) {
    this.lastWall = deps.clock.now();
    this.lastMonotonic = deps.clock.monotonic();
  }

  list(): EnvGrant[] {
    return [...this.open.values()].map((open) => structuredClone(open.grant));
  }

  /** The open grant for this set file, if any (an expired one is ended first). */
  find(filePath: string, setId: string): (EnvGrant & { fileHash: string; source: { rev: number; fileHash: string } }) | null {
    this.check();
    for (const open of this.open.values()) {
      if (open.grant.path === filePath && open.grant.setId === setId) return { ...structuredClone(open.grant), fileHash: open.fileHash, source: open.source };
    }
    return null;
  }

  /**
   * Opens a grant with values the device sealed to `key` under `requestId`, and seals them for
   * the run that asked, under the same request id. Throws (plain Error) when they don't open, so a
   * bad answer never becomes a grant. Replaces an open grant for the same set file.
   */
  start(input: NewGrant, run: { recipient: Uint8Array; use: string }): { grant: EnvGrant; sealed: EnvSealedValues } {
    const values = openEnvSealedValues(input.sealed, { set: input.setId, request: input.requestId }, input.key);
    const sealed = sealEnvValues(values, { set: input.setId, request: input.requestId }, run.recipient, this.deps.random);
    for (const [grantId, open] of this.open) {
      if (open.grant.path === input.path && open.grant.setId === input.setId) this.drop(grantId);
    }
    const startedAt = this.deps.clock.now();
    const grant: EnvGrant = {
      grantId: crypto.randomUUID(),
      setId: input.setId,
      setName: input.setName,
      path: input.path,
      startedAt,
      endsAt: startedAt + ENV_GRANT_MS,
      by: input.by,
      uses: [useWords(run.use)],
    };
    this.open.set(grant.grantId, {
      grant,
      deviceId: input.deviceId,
      fileHash: input.fileHash,
      source: input.source,
      key: input.key,
      sealed: input.sealed,
      sealedFor: input.requestId,
      startedMonotonic: this.deps.clock.monotonic(),
    });
    this.deps.onChange(this.list());
    return { grant: structuredClone(grant), sealed };
  }

  /** Seals the grant's values to one run's key, under that run's request id, and notes the use. Null when the grant has ended. */
  release(grantId: string, run: { requestId: string; recipient: Uint8Array; use: string }): EnvSealedValues | null {
    this.check();
    const open = this.open.get(grantId);
    if (!open) return null;
    const values = openEnvSealedValues(open.sealed, { set: open.grant.setId, request: open.sealedFor }, open.key);
    const sealed = sealEnvValues(values, { set: open.grant.setId, request: run.requestId }, run.recipient, this.deps.random);
    open.grant.uses = [useWords(run.use), ...open.grant.uses].slice(0, MAX_GRANT_USES);
    this.deps.onChange(this.list());
    return sealed;
  }

  /** Ends one grant. False when no such grant is open. */
  end(grantId: string, reason: EnvGrantEndReason): boolean {
    const open = this.open.get(grantId);
    if (!open) return false;
    this.drop(grantId);
    this.deps.onChange(this.list(), { grantId, setId: open.grant.setId, reason });
    return true;
  }

  endAll(reason: EnvGrantEndReason): void {
    for (const grantId of [...this.open.keys()]) this.end(grantId, reason);
  }

  /** The device that allowed them was unpaired. */
  endFromDevice(deviceId: string): void {
    for (const [grantId, open] of [...this.open]) if (open.deviceId === deviceId) this.end(grantId, 'unpaired');
  }

  /** The set file now has `fileHash` (or is gone: null): grants opened on another file end. */
  fileChanged(filePath: string, fileHash: string | null): void {
    for (const [grantId, open] of [...this.open]) if (open.grant.path === filePath && open.fileHash !== fileHash) this.end(grantId, 'set-changed');
  }

  /** Paths with an open grant, for the periodic file check. */
  grantedFiles(): { path: string; fileHash: string }[] {
    return [...this.open.values()].map((open) => ({ path: open.grant.path, fileHash: open.fileHash }));
  }

  /**
   * Ends every grant when the clocks disagree (the computer slept, or its clock was set), then the
   * grants whose 15 minutes are up by either clock.
   */
  check(): void {
    const wall = this.deps.clock.now();
    const monotonic = this.deps.clock.monotonic();
    const jumped = Math.abs(wall - this.lastWall - (monotonic - this.lastMonotonic)) > CLOCK_JUMP_MS;
    this.lastWall = wall;
    this.lastMonotonic = monotonic;
    if (jumped) this.endAll('clock-jumped');
    for (const [grantId, open] of [...this.open]) {
      if (wall >= open.grant.endsAt || monotonic - open.startedMonotonic >= ENV_GRANT_MS) this.end(grantId, 'expired');
    }
  }

  /**
   * The periodic check (every GRANT_CHECK_MS). Where the process clock keeps running in sleep
   * (Windows), the clocks agree after a sleep, but the check itself comes late: that ends every
   * grant too.
   */
  tick(): void {
    const monotonic = this.deps.clock.monotonic();
    const late = this.lastTick !== null && monotonic - this.lastTick > GRANT_CHECK_MS + CLOCK_JUMP_MS;
    this.lastTick = monotonic;
    if (late) this.endAll('clock-jumped');
    this.check();
  }

  private drop(grantId: string): void {
    const open = this.open.get(grantId);
    if (!open) return;
    // The key goes first: nothing can open the values after this.
    open.key.xSecret.fill(0);
    this.open.delete(grantId);
  }
}

function useWords(command: string): string {
  const flat = command.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  return flat.length > MAX_USE_CHARS ? `${flat.slice(0, MAX_USE_CHARS - 1)}…` : flat;
}
