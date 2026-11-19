/**
 * A stand-in for the file core, so the command can be tested on its own. Set files are JSON
 * describing what the real core would find; released values are "sealed" as base64 JSON bound to
 * the one-time key and request, so the tests still see a wrong key or request refused.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { EnvCliCore } from '../../../src/envcli/core';
import { ENV_LIMITS, type EnvFileProblem, type EnvPlainValue, type EnvSealedValues } from '../../../src/envcore/types';
import { toBase64Url } from '../../../src/vault/bytes';

export interface FakeSetFile {
  name: string;
  setId: string;
  rev: number;
  epoch: number;
  variables: number;
  owner: string;
  /** Set to make checkSetFile refuse the file. */
  problem?: EnvFileProblem;
}

export function fakeSetFile(name: string, overrides: Partial<FakeSetFile> = {}): string {
  return `${JSON.stringify({ name, setId: `s_${name}`, rev: 7, epoch: 3, variables: 12, owner: 'Maya Rao · Pixel 8', ...overrides })}\n`;
}

export const FAKE_KEY_WORDS = ['harbor', 'velvet', 'quarry', 'mosaic', 'lantern', 'ember'];

export function fakeSeal(values: EnvPlainValue[], oneTimeKey: string, scope: { set: string; request: string }): EnvSealedValues {
  return {
    key: { e: 'e', r: oneTimeKey, ct: `${scope.set}/${scope.request}` },
    box: { epoch: 0, n: 'n', ct: Buffer.from(JSON.stringify(values)).toString('base64'), c: 'c' },
  };
}

export const fakeCore: EnvCliCore = {
  checkSetFile(text) {
    const file = JSON.parse(text) as FakeSetFile;
    if (file.problem) return { ok: false, problem: file.problem };
    return { ok: true, summary: { name: file.name, setId: file.setId, rev: file.rev, epoch: file.epoch, variables: file.variables, ownerLabel: file.owner } };
  },
  fileHash: (text) => createHash('sha256').update(text).digest('base64url'),
  checkValues(values) {
    if (values.length > ENV_LIMITS.names) return { kind: 'too-large', limit: 'names' };
    const big = values.find((v) => Buffer.byteLength(v.value) > ENV_LIMITS.valueBytes);
    return big ? { kind: 'too-large', limit: 'value', name: big.name } : null;
  },
  newOneTimeKey: () => ({ xSecret: randomBytes(32), xPublic: randomBytes(32) }),
  openValues(sealed, scope, key) {
    if (sealed.key.r !== toBase64Url(key.xPublic)) throw new Error('sealed to another key');
    if (sealed.key.ct !== `${scope.set}/${scope.request}`) throw new Error('sealed for another request');
    return JSON.parse(Buffer.from(sealed.box.ct, 'base64').toString('utf8')) as EnvPlainValue[];
  },
  joinKeyWords: () => FAKE_KEY_WORDS,
  loadsCode: (name) => ['NODE_OPTIONS', 'LD_PRELOAD', 'BASH_ENV', 'PATH'].includes(name) || name.startsWith('DYLD_'),
  merge(base, ours, theirs) {
    if (ours.includes('TWO-HEADERS')) return { kind: 'two-headers', rev: 8 };
    if (theirs.includes('UNSIGNED')) return { kind: 'refused', problem: { kind: 'unsigned-line', line: 14, name: 'DATABASE_URL' } };
    return { kind: 'merged', file: `merged base=${base ?? 'none'}\n${ours}${theirs}` };
  },
};
