/// <reference types="node" />
/** Test-only vault fixtures: a seeded random stream and an in-memory folder. */
import { sha256 } from '@noble/hashes/sha2.js';
import { toBase64, utf8Encode, type RandomBytes } from '../src/vault/bytes';
import { createVault } from '../src/vault/build';
import { generateDeviceKeys, type DeviceKeys } from '../src/vault/crypto';
import { serializeEntry, type SignedEntry } from '../src/vault/entry';
import type { AccountRecord } from '../src/vault/open';
import { replayVault, type VaultState } from '../src/vault/replay';

/** Deterministic random stream: SHA-256(seed ‖ counter). Never use outside tests. */
export function seededRandom(seed: string): RandomBytes {
  let counter = 0;
  return (length) => {
    const out = new Uint8Array(length);
    for (let filled = 0; filled < length; filled += 32) {
      const block = sha256(utf8Encode(`${seed}/${counter++}`));
      out.set(block.subarray(0, Math.min(32, length - filled)), filled);
    }
    return out;
  };
}

export class MemoryVault {
  readonly logs: Record<string, string[]> = {};
  readonly vaultId: string;
  readonly key: Uint8Array;
  private clock = 1_000_000;

  constructor(readonly founder: DeviceKeys, random: RandomBytes) {
    const created = createVault({ founder, kind: 'personal', name: 'Home', deviceName: 'Phone', random, time: this.clock });
    this.vaultId = created.vaultId;
    this.key = created.key;
    this.write(created.entry);
  }

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

  copy(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.logs).map(([id, lines]) => [id, [...lines]]));
  }
}

export const device = (random: RandomBytes): DeviceKeys => generateDeviceKeys(random);

export function totpRecord(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return { issuer: 'GitHub', label: 'ada@example.com', secret: 'JBSWY3DPEHPK3PXP', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, counter: 0, ...overrides };
}

// Minimal protobuf writer for Google Authenticator export QR codes.
function varint(value: number | bigint): number[] {
  let rest = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  do {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    out.push(rest === 0n ? byte : byte | 0x80);
  } while (rest !== 0n);
  return out;
}
const varintField = (field: number, value: number | bigint) => [...varint(field << 3), ...varint(value)];
const bytesField = (field: number, bytes: Uint8Array | number[]) => [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];

export interface ExportedOtp {
  secret: string;
  name: string;
  issuer: string;
  /** 1 SHA1, 4 MD5 (unsupported). */
  algorithm: number;
}

/** One QR code of a Google Authenticator export holding TOTP accounts. */
export function migrationUri(otps: ExportedOtp[], batch: { id: number; index: number; size: number }): string {
  const payload = Uint8Array.from([
    ...otps.flatMap((otp) =>
      bytesField(1, [...bytesField(1, utf8Encode(otp.secret)), ...bytesField(2, utf8Encode(otp.name)), ...bytesField(3, utf8Encode(otp.issuer)), ...varintField(4, otp.algorithm), ...varintField(5, 1), ...varintField(6, 2)]),
    ),
    ...varintField(2, 1),
    ...varintField(3, batch.size),
    ...varintField(4, batch.index),
    ...varintField(5, batch.id),
  ]);
  return `otpauth-migration://offline?data=${encodeURIComponent(toBase64(payload))}`;
}
