import { sha256 } from '@noble/hashes/sha2.js';
import type { RandomBytes } from '../../src/vault/bytes';
import { generateDeviceKeys, type DeviceKeys } from '../../src/vault/crypto';
import { entryHash, serializeEntry, type SignedEntry } from '../../src/vault/entry';
import type { VaultLogs } from '../../src/vault/chain';
import { buildDeviceHello, buildKeyRotate, createVault, type CreatedVault } from '../../src/vault/build';
import { recoveryKeysFromPhrase, restoreWithPhrase } from '../../src/vault/recovery';
import { replayVault, type VaultState } from '../../src/vault/replay';
import type { AccountRecord } from '../../src/vault/open';

/** Deterministic random stream for tests: SHA-256(seed ‖ counter). Never use outside tests. */
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

/** A folder's logs in memory, with helpers to write entries the way the agent would. */
export class MemoryVault {
  readonly logs: Record<string, string[]> = {};
  readonly vaultId: string;
  key: Uint8Array;
  private clock = 1_000_000;

  constructor(created: CreatedVault) {
    this.vaultId = created.vaultId;
    this.key = created.key;
    this.write(created.entry);
  }

  static found(founder: DeviceKeys, random: RandomBytes, kind: 'personal' | 'team' | 'solo' = 'personal'): MemoryVault {
    return new MemoryVault(createVault({ founder, kind, name: 'Home', deviceName: 'Phone', random, time: 1_000_000 }));
  }

  /** A strictly increasing time, so tests don't depend on the real clock. */
  now(): number {
    this.clock += 1000;
    return this.clock;
  }

  write(entry: SignedEntry): SignedEntry {
    (this.logs[entry.author] ??= []).push(serializeEntry(entry));
    return entry;
  }

  state(): VaultState {
    return replayVault(this.vaultId, this.logs);
  }

  snapshot(): VaultLogs {
    return Object.fromEntries(Object.entries(this.logs).map(([id, lines]) => [id, [...lines]]));
  }
}

export function device(random: RandomBytes): DeviceKeys {
  return generateDeviceKeys(random);
}

export function totpRecord(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return { issuer: 'GitHub', label: 'ada@example.com', secret: 'JBSWY3DPEHPK3PXP', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, counter: 0, ...overrides };
}

/** Fisher–Yates with a seeded stream, for read-order property tests. */
export function shuffled<T>(items: readonly T[], random: RandomBytes): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const bytes = random(4);
    const j = (((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The three lines of a solo vault's restore, signed on `logs`: the recovery identity's add of
 * `newPhone`, its hello, and the recovery identity's key change.
 */
export function soloRestoreLines(vaultId: string, logs: VaultLogs, phrase: string, newPhone: DeviceKeys, random: RandomBytes, time: number): SignedEntry[] {
  const recovery = recoveryKeysFromPhrase(phrase, vaultId);
  const restored = restoreWithPhrase(replayVault(vaultId, logs), { phrase, device: newPhone, name: 'New phone', random, time });
  const withAdd = { ...logs, [recovery.deviceId]: [...(logs[recovery.deviceId] ?? []), serializeEntry(restored.entry)] };
  const hello = buildDeviceHello(replayVault(vaultId, withAdd), newPhone, time, entryHash(restored.entry));
  const withHello = { ...withAdd, [newPhone.deviceId]: [serializeEntry(hello)] };
  const rotate = buildKeyRotate(replayVault(vaultId, withHello), recovery, { currentKey: restored.key, random, time });
  return [restored.entry, hello, rotate.entry];
}
