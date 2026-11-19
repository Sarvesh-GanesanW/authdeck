import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { takeRandom, utf8Encode, type RandomBytes } from './bytes';
import { buildDeviceAdd, buildRecoverySet, type DevicePublicKeys, type RotationResult } from './build';
import { KEY_BYTES, keysFromSecrets, type DeviceKeys } from './crypto';
import type { SignedEntry } from './entry';
import { openVault } from './open';
import type { VaultState } from './replay';

const PHRASE_ENTROPY_BYTES = 16;
const PHRASE_WORDS = 12;
const RECOVERY_INFO = 'authdeck/recovery/v2/';

/** 12 BIP-39 English words (128 bits). Show once; never store. */
export function generateRecoveryPhrase(random: RandomBytes): string {
  return entropyToMnemonic(takeRandom(random, PHRASE_ENTROPY_BYTES), wordlist);
}

function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}

/** Words the user mistyped or that aren't BIP-39 words, so the screen can point at them. */
export function unknownPhraseWords(phrase: string): string[] {
  return normalizePhrase(phrase).split(' ').filter((word) => word !== '' && !wordlist.includes(word));
}

/**
 * The recovery identity for one vault: Ed25519 and sealing keys from HKDF-SHA-256 over the
 * phrase's 128-bit entropy, info "authdeck/recovery/v2/" ‖ vault id, 64 bytes (Ed25519 seed, then
 * sealing secret). The vault id is in the info so a phrase reused for two vaults gives two
 * unrelated identities.
 */
export function recoveryKeysFromPhrase(phrase: string, vaultId: string): DeviceKeys {
  const normalized = normalizePhrase(phrase);
  if (normalized.split(' ').length !== PHRASE_WORDS || !validateMnemonic(normalized, wordlist)) {
    throw new Error('That is not a valid recovery phrase. Check the 12 words and their order.');
  }
  const okm = hkdf(sha256, mnemonicToEntropy(normalized, wordlist), undefined, utf8Encode(`${RECOVERY_INFO}${vaultId}`), 2 * KEY_BYTES);
  return keysFromSecrets(okm.slice(0, KEY_BYTES), okm.slice(KEY_BYTES));
}

/** `recovery.set` for a phrase: makes it the recovery identity and rotates the vault key. */
export function buildRecoverySetFromPhrase(
  state: VaultState,
  author: DeviceKeys,
  options: { phrase: string; currentKey: Uint8Array; random: RandomBytes; time: number },
): RotationResult {
  const recovery = recoveryKeysFromPhrase(options.phrase, state.vaultId);
  return buildRecoverySet(state, author, { recovery, currentKey: options.currentKey, random: options.random, time: options.time });
}

/** True when `phrase` is the vault's current recovery phrase. */
export function isCurrentRecoveryPhrase(state: VaultState, phrase: string): boolean {
  return state.recovery?.deviceId === recoveryKeysFromPhrase(phrase, state.vaultId).deviceId;
}

/**
 * Restores access on a new device: checks the phrase is the vault's current recovery identity,
 * opens the vault key with it and signs `device.add` for the new device as that identity. Build
 * it from a fresh read of the folder: two restores signed from the same state give two entries
 * at one seq of the recovery identity's log, and the agent keeps only the first.
 *
 * When the phrase's seal for the current key is bad (open.ts readOnly), the device is added on the
 * newest key the phrase opens, so a bad seal can't make the phrase useless: the new device then
 * shows codes read-only and can remove the device that wrote the bad seal. `readOnly` says so;
 * `key` is that older key, and `epoch` its epoch.
 */
export function restoreWithPhrase(
  state: VaultState,
  options: { phrase: string; device: DevicePublicKeys; name: string; random: RandomBytes; time: number },
): { entry: SignedEntry; key: Uint8Array; epoch: number; readOnly: string | null } {
  const recovery = recoveryKeysFromPhrase(options.phrase, state.vaultId);
  if (state.recovery?.deviceId !== recovery.deviceId) {
    throw new Error('This phrase is not the current recovery phrase of this vault. If you made a newer phrase, use that one.');
  }
  const { currentKey, epoch, readOnly } = openVault(state, recovery);
  const entry = buildDeviceAdd(state, recovery, { device: options.device, role: 'admin', name: options.name, currentKey, epoch, random: options.random, time: options.time });
  return { entry, key: currentKey, epoch, readOnly };
}
