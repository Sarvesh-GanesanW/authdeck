/** Shared env core test fixtures: deterministic devices, a set with an owner and a recovery phrase. */
import { toBase64Url } from '../../src/vault/bytes';
import { generateRecoveryPhrase, recoveryKeysFromPhrase } from '../../src/vault/recovery';
import { generateDeviceKeys, type DeviceKeys } from '../../src/vault/crypto';
import { createEnvSet, parseEnvFile, verifyEnvFile, type CreatedEnvSet, type EnvVerifiedSet } from '../../src/envcore';
import type { EnvPlainValue } from '../../src/envcore';
import { seededRandom } from '../helpers/vault';

export const T0 = 1_763_000_000_000;

export function device(seed: string): DeviceKeys {
  return generateDeviceKeys(seededRandom(`device/${seed}`));
}

export const VALUES: EnvPlainValue[] = [
  { name: 'DATABASE_URL', value: 'postgres://maya@db/acme' },
  { name: 'STRIPE_SECRET_KEY', value: 'sk_test_51Pq8eKz0' },
  { name: 'PEM', value: '-----BEGIN KEY-----\nline two\n-----END KEY-----' },
];

export interface TestSet extends CreatedEnvSet {
  owner: DeviceKeys;
  recovery: DeviceKeys;
  phrase: string;
  /** The owner's vault, whose recovery identity the set is wrapped to. */
  vaultId: string;
  /** The id createEnvSet derived from the set's birth certificate. */
  setId: string;
}

export function makeSet(seed = 'acme', values: EnvPlainValue[] = VALUES): TestSet {
  const random = seededRandom(`set/${seed}`);
  const owner = device(`${seed}/owner`);
  const phrase = generateRecoveryPhrase(seededRandom(`phrase/${seed}`));
  // The phone wraps a set to its vault's recovery identity, from public keys in vault state.
  const vaultId = toBase64Url(seededRandom(`vault/${seed}`)(16));
  const recovery = recoveryKeysFromPhrase(phrase, vaultId);
  const created = createEnvSet({ name: 'acme-api', owner, ownerLabel: 'Maya Rao · Pixel 8', ownerForm: 'phone', recovery, values, time: T0, random });
  return { ...created, owner, recovery, phrase, vaultId, setId: created.file.header.set };
}

/** verifyEnvFile that must pass. */
export function verified(text: string, ...rest: Parameters<typeof verifyEnvFile> extends [unknown, ...infer R] ? R : never): EnvVerifiedSet {
  const result = verifyEnvFile(text, ...rest);
  if (!result.ok) throw new Error(`expected the file to verify, got ${JSON.stringify(result.problem)}`);
  return result.set;
}

export function parsedOk(text: string) {
  const result = parseEnvFile(text);
  if (!result.ok) throw new Error(`expected the file to parse, got ${JSON.stringify(result.problem)}`);
  return result.parsed;
}

/** Replaces the first line for which `match` is true. */
export function editLine(text: string, match: (line: string) => boolean, edit: (line: string) => string): string {
  const lines = text.split('\n');
  const index = lines.findIndex(match);
  if (index < 0) throw new Error('no such line');
  lines[index] = edit(lines[index]!);
  return lines.join('\n');
}

export function lineNumber(text: string, match: (line: string) => boolean): number {
  return text.split('\n').findIndex(match) + 1;
}
