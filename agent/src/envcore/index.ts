/**
 * AuthDeck env core: the public API the agent, the CLI and the app call for env sets. Pure
 * TypeScript with no Node or platform APIs; randomness comes in as a `RandomBytes` function and
 * clocks as `time` arguments. Crypto is the vault core's (../vault), imported by relative path, so
 * this folder is byte-identical in agent/src/envcore and app/src/envcore
 * (`node scripts/check-protocol.mjs` checks it).
 */
export * from './types';
export { EnvFileRefused } from './errors';
export { ENV_FILE_PREAMBLE, parseEnvFile, writeEnvFile, envFileHash, envSetFilePath, checkEnvPlainValues, type EnvParsedFile, type EnvParseResult } from './format';
export {
  ENV_HEADER_SIGNING_DOMAIN,
  ENV_VALUE_SIGNING_DOMAIN,
  ENV_JOIN_REQUEST_SIGNING_DOMAIN,
  envHeaderSignedBytes,
  envValueSignedBytes,
  envJoinRequestSignedBytes,
  envHeaderHash,
  envValueLineHash,
  signEnvHeader,
  signEnvValueLine,
  envHeaderSignatureValid,
  envValueSignatureValid,
  type EnvUnsignedHeader,
  type EnvUnsignedValueLine,
  type EnvLineScope,
} from './signing';
export {
  ENV_BIRTH_DOMAIN,
  ENV_TAKEOVER_DOMAIN,
  ENV_RECOVERY_CHANGE_DOMAIN,
  ENV_BIRTH_NONCE_BYTES,
  envBirthSignedBytes,
  envAuthorityChangeSignedBytes,
  envSetIdOf,
  newEnvBirth,
  envAuthorityHolders,
  envAuthorityEpoch,
  signEnvAuthorityChange,
  envAuthorityValid,
  envAuthorityExtends,
  envAuthorityFork,
  envCrossesAuthority,
  compareEnvHeaders,
  sameEnvKeys,
  type EnvUnsignedBirth,
  type EnvUnsignedAuthorityChange,
  type EnvAuthorityHolders,
  type EnvAuthorityFork,
} from './authority';
export {
  ENV_VALUE_BOX_KIND,
  ENV_RECOVERY_SCOPE,
  ENV_DATA_KEY_BYTES,
  envRecoveryKeys,
  createEnvSet,
  openEnvDataKey,
  findBadEnvWraps,
  sealEnvValue,
  openEnvValue,
  openEnvValues,
  type EnvNewMember,
  type EnvValueScope,
  type CreateEnvSetInput,
  type CreatedEnvSet,
} from './keys';
export { addEnvMember, removeEnvMember, rekeyEnvSet, settleEnvHeaders, setEnvRecovery, takeOverEnvSet, type EnvRekeyResult, type EnvOwnerContext, type EnvTakeOverResult } from './members';
export { planEnvPush, changeEnvValues, type EnvValueChanges, type EnvChangeResult } from './values';
export { ENV_TRANSFER_EPOCH, ENV_TRANSFER_TO, ENV_TRANSFER_BOX_KIND, newEnvTransferKey, sealEnvValues, openEnvSealedValues, type EnvTransferScope } from './transfer';
export { verifyEnvFile, verifyEnvFileForRekey, nextEnvTrust, type EnvTrust, type EnvVerifiedSet, type EnvVerifyResult, type EnvRekeyCheck } from './verify';
export { mergeEnvFiles, type EnvMergeInput } from './merge';
export {
  ENV_CHECK_DOMAIN,
  ENV_KEY_WORDS_DOMAIN,
  envCheckCode,
  envNewDeviceCheckCode,
  envApproverCheckCode,
  checkEnvJoined,
  envKeyWords,
  envJoinRequestPath,
  createEnvJoinRequest,
  writeEnvJoinRequest,
  readEnvJoinRequest,
  type EnvJoinedCheck,
  type EnvJoinRequestRead,
} from './join';
export { diffEnvFiles, type EnvFileChange } from './history';
export { envHistoryFloor, createEnvFloorBuilder, checkEnvFloor, type EnvHistoryFloor, type EnvHistoryFile, type EnvFloorBuilder } from './floor';
export { envLoadsCode, ENV_CODE_LOADING_NAMES, ENV_CODE_LOADING_PREFIXES } from './codeLoading';
