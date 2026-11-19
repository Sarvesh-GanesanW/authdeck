/**
 * A signed request to retire a solo vault (`vault.retire`): a phone that made a new vault without
 * the old phrase asks the computer to set the old one aside. Only the old vault's active device
 * can sign one, for one computer (its agent id) and for a short time, so a paired device outside
 * the vault can't retire it and a request can't be replayed later or on another computer. The
 * computer keeps the old folder for RETIRED_KEEP_MS and tells its user (docs/authenticator.md).
 */
import { canonicalJson } from './canonical';
import { fromBase64Url, toBase64Url, utf8Encode } from './bytes';
import { sign, verifySignature, type DeviceKeys } from './crypto';
import { isId, isPlainObject } from './entry';
import type { VaultState } from './replay';

export const RETIRE_VERSION = 1;
/** How long a computer keeps a retired vault's folder before deleting it. */
export const RETIRED_KEEP_MS = 30 * 24 * 60 * 60_000;
/** How far a request's time may be from the computer's clock. */
export const RETIRE_WINDOW_MS = 5 * 60_000;
const SIGNING_DOMAIN = 'authdeck/retire/v1\n';
const FIELDS = ['agentId', 'device', 'newVault', 'sig', 'time', 'v', 'vault'];
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface VaultRetire {
  v: 1;
  /** The vault to retire. */
  vault: string;
  /** The vault that replaces it (shown to the computer's user). */
  newVault: string;
  /** The computer this request is for. */
  agentId: string;
  /** The device that signs: the vault's active device. */
  device: string;
  /** The signer's clock; the computer takes it only near its own. */
  time: number;
  sig: string;
}

function signedBytes(request: Omit<VaultRetire, 'sig'>): Uint8Array {
  const { v, vault, newVault, agentId, device, time } = request;
  return utf8Encode(SIGNING_DOMAIN + canonicalJson({ v, vault, newVault, agentId, device, time }));
}

export function signRetire(options: { vault: string; newVault: string; agentId: string; time: number }, device: Pick<DeviceKeys, 'deviceId' | 'edSecret'>): VaultRetire {
  const unsigned = { v: RETIRE_VERSION, vault: options.vault, newVault: options.newVault, agentId: options.agentId, device: device.deviceId, time: options.time } as const;
  return { ...unsigned, sig: toBase64Url(sign(signedBytes(unsigned), device.edSecret)) };
}

/** The reason an unknown value is not a well-formed request, or null. */
export function retireShapeProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'it is not a JSON object';
  if (Object.keys(value).sort().join(',') !== FIELDS.join(',')) return 'it has missing or extra fields';
  // Never String() an unknown value: a deeply nested one throws while being turned into text.
  if (value.v !== RETIRE_VERSION) return typeof value.v === 'number' ? `version ${value.v} is not supported` : 'its version is not a number';
  if (!isId(value.vault) || !isId(value.newVault) || !isId(value.device)) return 'an id is malformed';
  if (value.vault === value.newVault) return 'it names the same vault twice';
  if (typeof value.agentId !== 'string' || !AGENT_ID_PATTERN.test(value.agentId)) return 'the computer id is malformed';
  if (!Number.isSafeInteger(value.time) || (value.time as number) < 0) return 'the time is not a whole number';
  if (typeof value.sig !== 'string' || !SIGNATURE_PATTERN.test(value.sig)) return 'the signature is malformed';
  return null;
}

/**
 * Why the computer `agentId`, at `now`, must refuse `request` for the vault `state` (replayed from
 * its folder), or null to take it: a solo vault, signed by its one active device, for this
 * computer, and near this computer's clock.
 */
export function retireProblem(request: VaultRetire, state: VaultState, agentId: string, now: number): string | null {
  if (request.vault !== state.vaultId) return 'it is for another vault';
  if (!state.created || state.kind !== 'solo') return 'only a vault kept on one device (a solo vault) can be retired from a device';
  if (request.agentId !== agentId) return 'it is for another computer';
  if (Math.abs(now - request.time) > RETIRE_WINDOW_MS) return "its time is too far from this computer's clock; check the time on both";
  const member = Object.hasOwn(state.members, request.device) ? state.members[request.device]! : undefined;
  if (!member || member.removed || Object.hasOwn(state.cutoffs, request.device)) return 'it is not signed by the device in this vault';
  const { sig, ...unsigned } = request;
  try {
    if (verifySignature(fromBase64Url(sig), signedBytes(unsigned), fromBase64Url(member.ed))) return null;
  } catch {
    // A key or signature that doesn't decode signs nothing.
  }
  return 'its signature is not the vault device\'s';
}
