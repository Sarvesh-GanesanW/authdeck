/**
 * AuthDeck vault core: the public API the app and the agent call. Pure TypeScript with no Node
 * or platform APIs; randomness comes in as a `RandomBytes` function. See docs/authenticator.md.
 */
export { toBase64Url, fromBase64Url, takeRandom, type RandomBytes } from './bytes';
export { canonicalJson, type JsonValue } from './canonical';
export { deviceIdFor, keyWords, generateDeviceKeys, keysFromSecrets, isUsableEd25519Key, isUsableSealingKey, keyCheck, type DeviceKeys, type SealedKey, type Box } from './crypto';
export { entryHash, signEntry, entrySignatureValid, serializeEntry, isId, ENTRY_KINDS, MAX_IDENTITIES, type SignedEntry, type UnsignedEntry, type EntryKind, type EntryRef } from './entry';
export { MEMBERSHIP_KINDS, type VaultKind, type Role } from './bodies';
export { verifyChain, findFounder, vaultIdFor, VerifyCache, type VaultLogs, type Rejection, type VerifiedEntry, type IdentityRole } from './chain';
export { orderEntries, follows, type SeenConflict, type Placed } from './order';
export { replayVault, type VaultState, type Member, type RecoveryIdentity, type HistoryItem, type AccountChange, type Head, type ReplayOptions } from './replay';
export { signRetire, retireProblem, retireShapeProblem, RETIRED_KEEP_MS, RETIRE_WINDOW_MS, type VaultRetire } from './retire';
export { openVault, validateAccountRecord, sealAccountRecord, type AccountRecord, type OpenVault, type OpenAccount } from './open';
export {
  createVault,
  buildEntry,
  afterOwnEntry,
  buildDeviceAdd,
  buildDeviceHello,
  buildDeviceRemove,
  buildDeviceRename,
  buildRecoverySet,
  buildAccountPut,
  buildAccountDelete,
  newAccountId,
  type CreatedVault,
  type DevicePublicKeys,
  type RotationResult,
} from './build';
export { checkRollback, repairLines, findForks, type RememberedHeads, type RollbackProblem, type RollbackCheck, type ForkProof } from './rollback';
export {
  cleanJoinName,
  createJoinRequest,
  readJoinRequest,
  readJoinChallenge,
  createJoinChallenge,
  createJoinReveal,
  revealMatchesCommit,
  checkCode,
  newDeviceCheckCode,
  approverCheckCode,
  checkJoinedVault,
  MAX_JOIN_NAME_LENGTH,
  type JoinRequest,
  type JoinChallenge,
  type JoinReveal,
  type JoinedVaultCheck,
} from './approval';
export { generateRecoveryPhrase, recoveryKeysFromPhrase, unknownPhraseWords, buildRecoverySetFromPhrase, isCurrentRecoveryPhrase, restoreWithPhrase } from './recovery';
export { splitLogText, joinLogLines, planAppend, AppendRefused, type AppendPlan, type AppendOptions } from './logs';
export { signBeacon, parseBeacon, beaconShapeProblem, beaconSignedByMember, checkBeacons, outOfVault, MAX_BEACON_BYTES, type Beacon, type BeaconCheck, type BeaconProblem } from './beacon';
export { base32Decode, base32Encode } from './base32';
export { hotp, totp, steamGuard, generateCode, secondsRemaining, validateOtpParams, type OtpParams, type OtpType, type OtpAlgorithm } from './otp';
export { parseOtpAuthUri, formatOtpAuthUri, type OtpAccount } from './otpauth';
export { parseMigrationUri, combineMigrationBatches, type MigrationBatch, type CombinedMigration, type SkippedAccount } from './migration';
export { MULTI_DEVICE_VAULTS, vaultFeatures } from './features';
