/**
 * Released values on their way to a process (EnvSealedValues): a fresh 32-byte transfer key T,
 * sealed with vault/crypto sealKey to the recipient's sealing key, and one box under T holding the
 * UTF-8 canonical JSON of EnvPlainValue[] in file order.
 *
 *   key: sealKey(T, recipient, { vault: set, epoch: ENV_TRANSFER_EPOCH, to: ENV_TRANSFER_TO + request })
 *   box: encryptBox(T, json, { vault: set, epoch: ENV_TRANSFER_EPOCH, kind: ENV_TRANSFER_BOX_KIND, request })
 *
 * Binding the request id means a release answers exactly one request: the phone seals to the
 * CLI's one-time key (Allow once) or the agent's grant key (Allow for 15 minutes) under the
 * request it answers; the agent, inside a grant, opens with its grant key and seals again to each
 * later run's one-time key under that run's request id.
 */
import { takeRandom, utf8Decode, utf8Encode, type RandomBytes } from '../vault/bytes';
import { canonicalJson } from '../vault/canonical';
import { decryptBox, encryptBox, KEY_BYTES, openSealedKey, SealPoint, sealKey, sealScalar, type BoxContext, type DeviceKeys, type SealContext } from '../vault/crypto';
import { EnvFileRefused } from './errors';
import { checkEnvPlainValues } from './format';
import type { EnvPlainValue, EnvSealedValues, EnvSetId } from './types';

export const ENV_TRANSFER_EPOCH = 0;
export const ENV_TRANSFER_TO = 'env-release/';
export const ENV_TRANSFER_BOX_KIND = 'env-release';

/** Which release a sealed bundle belongs to. */
export interface EnvTransferScope {
  set: EnvSetId;
  /** The protocol request id (EnvRequestBase.requestId) being answered. */
  request: string;
}

/** A sealing key pair for one use: the CLI's one-time key, or the agent's grant key. Secrets stay in memory. */
export function newEnvTransferKey(random: RandomBytes): Pick<DeviceKeys, 'xSecret' | 'xPublic'> {
  const xSecret = takeRandom(random, KEY_BYTES);
  return { xSecret, xPublic: SealPoint.BASE.multiply(sealScalar(xSecret)).toBytes() };
}

/**
 * Seals plain values to `recipient` (a sealing public key, the protocol's oneTimeKey or grantKey
 * decoded). Throws EnvFileRefused when the values fail checkEnvPlainValues, a plain Error for an
 * unusable recipient key.
 */
export function sealEnvValues(values: readonly EnvPlainValue[], scope: EnvTransferScope, recipient: Uint8Array, random: RandomBytes): EnvSealedValues {
  const problem = checkEnvPlainValues(values);
  if (problem) throw new EnvFileRefused(problem);
  const transferKey = takeRandom(random, KEY_BYTES);
  const json = canonicalJson(values.map(({ name, value }) => ({ name, value })));
  return {
    key: sealKey(transferKey, recipient, sealContext(scope)),
    box: encryptBox(transferKey, utf8Encode(json), boxContext(scope), random),
  };
}

/**
 * Opens sealed values with the recipient's key pair and checks what comes out (shape, names, caps).
 * Throws a plain Error when the seal isn't to this key or this request, or the contents are malformed.
 */
export function openEnvSealedValues(sealed: EnvSealedValues, scope: EnvTransferScope, recipient: Pick<DeviceKeys, 'xSecret' | 'xPublic'>): EnvPlainValue[] {
  let parsed: unknown;
  try {
    const transferKey = openSealedKey(sealed.key, recipient, sealContext(scope));
    parsed = JSON.parse(utf8Decode(decryptBox(transferKey, sealed.box, boxContext(scope))));
  } catch (err) {
    throw new Error("These values weren't sealed to this key for this request, or they were changed.", { cause: err });
  }
  const values = plainValuesFrom(parsed);
  const problem = checkEnvPlainValues(values);
  if (problem) throw new Error(`The released values break a rule: ${problem.kind}.`);
  return values;
}

function sealContext(scope: EnvTransferScope): SealContext {
  return { vault: scope.set, epoch: ENV_TRANSFER_EPOCH, to: `${ENV_TRANSFER_TO}${scope.request}` };
}

function boxContext(scope: EnvTransferScope): BoxContext {
  return { vault: scope.set, epoch: ENV_TRANSFER_EPOCH, kind: ENV_TRANSFER_BOX_KIND, request: scope.request };
}

function plainValuesFrom(parsed: unknown): EnvPlainValue[] {
  const malformed = () => new Error('The released values are not a list of names and values.');
  if (!Array.isArray(parsed)) throw malformed();
  return parsed.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw malformed();
    const keys = Object.keys(item);
    const { name, value } = item as Record<string, unknown>;
    if (keys.length !== 2 || typeof name !== 'string' || typeof value !== 'string') throw malformed();
    return { name, value };
  });
}
