/**
 * What the command needs from the file core (agent/src/envcore), in one place. Commands take an
 * EnvCliCore, so tests run them against a stand-in; `envCore` below binds the real one.
 */
import { randomBytes } from 'node:crypto';

import {
  checkEnvPlainValues,
  envFileHash,
  envKeyWords,
  envLoadsCode,
  mergeEnvFiles,
  newEnvTransferKey,
  openEnvSealedValues,
  verifyEnvFile,
  type EnvTransferScope,
} from '../envcore';
import type { EnvFileProblem, EnvJoinRequestFile, EnvMergeOutcome, EnvPlainValue, EnvSealedValues } from '../envcore/types';
import { fromBase64Url } from '../vault/bytes';
import type { DeviceKeys } from '../vault/crypto';

/** What the command shows of a set file it read and checked. */
export interface EnvSetFileSummary {
  name: string;
  setId: string;
  rev: number;
  epoch: number;
  /** Variables that hold a value (deletions not counted). */
  variables: number;
  /** "Maya Rao · Pixel 8". */
  ownerLabel: string;
}

export type EnvSetFileCheck = { ok: true; summary: EnvSetFileSummary } | { ok: false; problem: EnvFileProblem };

export type OneTimeKey = Pick<DeviceKeys, 'xSecret' | 'xPublic'>;

export interface EnvCliCore {
  /** Parses a set file and checks its format, caps and every signature. */
  checkSetFile(text: string): EnvSetFileCheck;
  /** The hash the agent and devices name a file by (EnvReleaseResult.source.fileHash). */
  fileHash(text: string): string;
  /** Names and caps of values read from a .env, before they are sent. Null when they pass. */
  checkValues(values: readonly EnvPlainValue[]): EnvFileProblem | null;
  /** The sealing key pair Allow once seals to; it lives only in this process. */
  newOneTimeKey(): OneTimeKey;
  /** Opens values released to the one-time key for one request. Throws when they don't open. */
  openValues(sealed: EnvSealedValues, scope: EnvTransferScope, key: OneTimeKey): EnvPlainValue[];
  /** The six words a teammate reads to the owner. */
  joinKeyWords(request: EnvJoinRequestFile): string[];
  /** True for a name that changes how programs start (NODE_OPTIONS, LD_PRELOAD…): run holds it back. */
  loadsCode(name: string): boolean;
  /** Git's three versions of a set file; `base` is null when the merge base had none. */
  merge(base: string | null, ours: string, theirs: string): EnvMergeOutcome;
}

/**
 * The real core. The command keeps no remembered heads of its own (the agent does), so files are
 * checked without trust: format, caps and every signature, but not rollback.
 */
export const envCore: EnvCliCore = {
  checkSetFile(text) {
    const verified = verifyEnvFile(text, null);
    if (!verified.ok) return verified;
    const { file, owner, live } = verified.set;
    return {
      ok: true,
      summary: { name: file.header.name, setId: file.header.set, rev: file.header.rev, epoch: file.header.epoch, variables: live.length, ownerLabel: owner.label },
    };
  },
  fileHash: envFileHash,
  checkValues: checkEnvPlainValues,
  newOneTimeKey: () => newEnvTransferKey((length) => new Uint8Array(randomBytes(length))),
  openValues: openEnvSealedValues,
  joinKeyWords: (request) => envKeyWords(fromBase64Url(request.ed), fromBase64Url(request.x)),
  loadsCode: envLoadsCode,
  merge: (base, ours, theirs) => mergeEnvFiles({ base, ours, theirs, trust: null }),
};
