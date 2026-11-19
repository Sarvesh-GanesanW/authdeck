/**
 * Signed head beacons (docs/authenticator.md, "Withheld changes"). Each device keeps one small
 * signed file, `heads/<deviceId>.json`, overwritten after each sync: the vault's epoch and the
 * head of every log as that device last saw them in the folder. A reader that finds a beacon
 * naming a newer epoch, or an entry its own copy lacks, knows the folder it reads is missing
 * something another device saw (a withheld `device.remove`, a rolled-back sync), and stops
 * writing secrets until it arrives.
 */
import { canonicalJson } from './canonical';
import { fromBase64Url, toBase64Url, utf8Encode } from './bytes';
import { sign, verifySignature, type DeviceKeys } from './crypto';
import { isEntryRef, isId, isPlainObject, MAX_IDENTITIES, type EntryRef } from './entry';
import type { VaultState } from './replay';

export const BEACON_VERSION = 2;
/** Room for a head per identity at the most a vault holds. */
export const MAX_BEACON_BYTES = 32 * 1024;
const SIGNING_DOMAIN = 'authdeck/beacon/v2\n';
const BEACON_FIELDS = ['device', 'epoch', 'heads', 'sig', 'time', 'v', 'vault'];
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

export interface Beacon {
  v: 2;
  vault: string;
  device: string;
  epoch: number;
  heads: Record<string, EntryRef>;
  /** The writer's clock; shown as "last heard from", never trusted for anything else. */
  time: number;
  sig: string;
}

function signedBytes(beacon: Omit<Beacon, 'sig'>): Uint8Array {
  const { v, vault, device, epoch, heads, time } = beacon;
  return utf8Encode(SIGNING_DOMAIN + canonicalJson({ v, vault, device, epoch, heads: heads as never, time }));
}

/**
 * True for an identity whose log no longer matters to anyone: a removed device, or one cut off
 * (removed, replaced as the recovery phrase, or proven to have signed two histories). Its owner
 * can delete or withhold its own lines at will, so beacons neither name nor check its head.
 */
export function outOfVault(state: VaultState, id: string): boolean {
  return Object.hasOwn(state.cutoffs, id) || (Object.hasOwn(state.members, id) && state.members[id]!.removed);
}

/** The identity is in this copy's vault in some way: a member (in or out) or an identity with a verified log. */
function knownHere(state: VaultState, id: string): boolean {
  return Object.hasOwn(state.members, id) || Object.hasOwn(state.chains, id) || state.recovery?.deviceId === id;
}

/** This device's beacon for what it last saw in the folder, leaving out logs of identities no longer in the vault. */
export function signBeacon(folderState: VaultState, device: Pick<DeviceKeys, 'deviceId' | 'edSecret'>, time: number): Beacon {
  const heads: Record<string, EntryRef> = {};
  for (const [deviceId, head] of Object.entries(folderState.heads)) {
    if (!outOfVault(folderState, deviceId)) heads[deviceId] = { seq: head.seq, hash: head.hash };
  }
  const unsigned = { v: BEACON_VERSION, vault: folderState.vaultId, device: device.deviceId, epoch: folderState.epoch, heads, time } as const;
  return { ...unsigned, sig: toBase64Url(sign(signedBytes(unsigned), device.edSecret)) };
}

/** The reason an unknown value is not a well-formed beacon, or null. */
export function beaconShapeProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'it is not a JSON object';
  if (Object.keys(value).sort().join(',') !== BEACON_FIELDS.join(',')) return 'it has missing or extra fields';
  if (value.v !== BEACON_VERSION) return `version ${String(value.v)} is not supported`;
  if (!isId(value.vault) || !isId(value.device)) return 'an id is malformed';
  if (!Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0) return 'the epoch is not a whole number';
  if (!Number.isSafeInteger(value.time) || (value.time as number) < 0) return 'the time is not a whole number';
  if (typeof value.sig !== 'string' || !SIGNATURE_PATTERN.test(value.sig)) return 'the signature is malformed';
  if (!isPlainObject(value.heads)) return 'the heads are not an object';
  const heads = Object.entries(value.heads);
  if (heads.length > MAX_IDENTITIES) return 'it names more logs than a vault can hold';
  for (const [deviceId, ref] of heads) if (!isId(deviceId) || !isEntryRef(ref)) return 'a head is malformed';
  return null;
}

/** Parses a beacon file's text; null when it isn't one. */
export function parseBeacon(text: string): Beacon | null {
  if (utf8Encode(text).length > MAX_BEACON_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return beaconShapeProblem(value) === null ? (value as Beacon) : null;
}

/** True when `beacon` is for this vault and signed by a device of it (removed devices included: the agent only checks authorship). */
export function beaconSignedByMember(beacon: Beacon, state: VaultState): boolean {
  const member = state.members[beacon.device];
  if (!member || beacon.vault !== state.vaultId) return false;
  const { sig, ...unsigned } = beacon;
  try {
    return verifySignature(fromBase64Url(sig), signedBytes(unsigned), fromBase64Url(member.ed));
  } catch {
    return false;
  }
}

export interface BeaconProblem {
  /** The device whose beacon shows it: banners name it. */
  device: string;
  /** implausible: the beacon claims more than a real vault could have (it is ignored otherwise). */
  kind: 'newer-epoch' | 'missing-entry' | 'different-entry' | 'implausible';
  /** For newer-epoch: the epoch the beacon names. */
  epoch?: number;
  /** For missing-entry and different-entry: the log entry the beacon names. */
  entry?: { deviceId: string; seq: number };
}

export interface BeaconCheck {
  problems: BeaconProblem[];
  /** Active device -> the time on its latest valid beacon. */
  heardAt: Record<string, number>;
  /**
   * The highest epoch an active device's beacon claims. A claim, not a fact: it lasts only while
   * that device stays active and keeps claiming it, and is never stored as this device's own.
   */
  claimedEpoch: number;
}

/** A beacon can't be further ahead than this: more epochs or entries than a vault could add between two reads. */
export const MAX_EPOCHS_AHEAD = 64;
export const MAX_ENTRIES_AHEAD = 20_000;

/**
 * Checks other active devices' beacons against this device's verified copy. Beacons from
 * removed devices, unsigned or malformed files are ignored: they prove nothing. So are the heads
 * they name for identities no longer in the vault (outOfVault). A claim far
 * beyond anything plausible is reported against its signer and otherwise ignored.
 */
export function checkBeacons(state: VaultState, files: Record<string, string>, self: string | null): BeaconCheck {
  const problems: BeaconProblem[] = [];
  const heardAt: Record<string, number> = {};
  let claimedEpoch = state.epoch;
  for (const [deviceId, text] of Object.entries(files)) {
    const beacon = parseBeacon(text);
    if (!isId(deviceId) || !beacon || beacon.device !== deviceId || beacon.device === self) continue;
    if (state.members[deviceId]?.removed !== false || !beaconSignedByMember(beacon, state)) continue;
    heardAt[deviceId] = beacon.time;
    const tooFar =
      beacon.epoch > state.epoch + MAX_EPOCHS_AHEAD ||
      Object.entries(beacon.heads).some(([logId, ref]) => ref.seq >= (state.chains[logId]?.length ?? 0) + MAX_ENTRIES_AHEAD);
    if (tooFar) {
      problems.push({ device: deviceId, kind: 'implausible' });
      continue;
    }
    const headProblems: BeaconProblem[] = [];
    for (const [logId, ref] of Object.entries(beacon.heads)) {
      // A removed or cut-off identity's lines can vanish without anyone hiding a change from us.
      // So can those of one this copy doesn't know at all (brought in only by a line the rules
      // voided): hiding its approval would show as a missing line of the approver's.
      if (outOfVault(state, logId) || !knownHere(state, logId)) continue;
      const chain = state.chains[logId] ?? [];
      if (chain.length <= ref.seq) headProblems.push({ device: deviceId, kind: 'missing-entry', entry: { deviceId: logId, seq: ref.seq } });
      else if (chain[ref.seq] !== ref.hash) headProblems.push({ device: deviceId, kind: 'different-entry', entry: { deviceId: logId, seq: ref.seq } });
    }
    // A newer epoch is news only while this copy lacks something the beacon's writer saw. With
    // every line it saw here too, the two copies differ only in what the rules made of them (a
    // fork proof the writer hadn't read yet, say), and its next beacon will agree.
    if (beacon.epoch > state.epoch && headProblems.length > 0) {
      claimedEpoch = Math.max(claimedEpoch, beacon.epoch);
      problems.push({ device: deviceId, kind: 'newer-epoch', epoch: beacon.epoch });
    }
    problems.push(...headProblems);
  }
  return { problems, heardAt, claimedEpoch };
}
