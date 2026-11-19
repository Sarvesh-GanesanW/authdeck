/**
 * The banners on the vault screen, from what sync found: changes held back from this device, a
 * vault key that must be replaced, devices that signed two histories, admin devices not heard
 * from, stopped join attempts, changes waiting on a device, old keys that won't open, no recovery
 * phrase. Pure.
 */
import type { VaultWarning } from '../contract';
import type { BeaconCheck, BeaconProblem } from '../../vault/beacon';
import type { EntryKind } from '../../vault/entry';
import type { VaultState } from '../../vault/replay';
import { isActiveAuthor } from './sync';

/** A change waiting this long on another device's entry gets a banner naming that device. */
export const WAIT_WARNING_MS = 10 * 60_000;
/** An admin device silent this long may have removed a device the computer is hiding. */
export const UNHEARD_WARNING_MS = 24 * 60 * 60_000;
/** This many join attempts stopped in the last hour (join.ts counts them) gets a banner. */
export const JOIN_ATTEMPT_LIMIT = 3;

export interface WarningInput {
  state: VaultState;
  /** This device's id, so its own beacon and role are left out. */
  self: string | null;
  /** The other devices' beacons from the last sync, or null before one. Never stored. */
  beacons: BeaconCheck | null;
  /** The highest epoch this device's own replay has reached (secure storage). */
  highestEpoch: number;
  /** Waiting entry hash -> when this device first saw it waiting. */
  waitingSince: ReadonlyMap<string, number>;
  /** Older epochs whose key would not open (OpenVault.keyProblems). */
  keyProblems: { epoch: number }[];
  /** Join attempts this device saw stopped (cancelled, failed, expired) in the last hour. */
  stoppedJoins: number;
  now: number;
  deviceName(id: string): string;
}

export interface VaultWarnings {
  warnings: VaultWarning[];
  /** New secrets wait while the folder lacks something another device saw, or the vault needs a fresh key. */
  secretsPaused: boolean;
}

/**
 * Beacon problems from devices still in the vault, about logs that still count. A removed
 * signer's claims count for nothing, and neither does a claim about a removed or cut-off
 * identity's log: it can delete its own lines, which would otherwise pause secrets for good.
 */
function activeProblems(input: WarningInput): BeaconProblem[] {
  const { state } = input;
  return (input.beacons?.problems ?? []).filter(
    (p) => Object.hasOwn(state.members, p.device) && state.members[p.device]!.removed === false && (!p.entry || isActiveAuthor(state, p.entry.deviceId)),
  );
}

function withheldWarning(input: WarningInput): VaultWarning | null {
  const { state, highestEpoch, deviceName } = input;
  const problems = activeProblems(input).filter((p) => p.kind !== 'implausible');
  const behindOwnEpoch = highestEpoch > state.epoch;
  if (problems.length === 0 && !behindOwnEpoch) return null;
  const first = problems[0];
  const who = first ? deviceName(first.device) : 'This device';
  const what = problems.some((p) => p.kind === 'newer-epoch') || behindOwnEpoch ? 'a newer vault key' : 'changes';
  return {
    id: 'withheld',
    kind: 'withheld',
    text: `${who} has seen ${what} that the vault folder on the computer doesn't have. Adding or changing accounts is paused until they arrive, so a removed device can't read new secrets. If the folder is still syncing this clears by itself; if it lasts, the computer or the folder may be holding them back.`,
    ...(first ? { deviceId: first.device } : {}),
  };
}

const FRESH_KEY_CAUSE = 'The vault key changed twice at the same time, or it reached a device that is no longer in the vault.';
const FRESH_KEY_BY_ADMIN = `${FRESH_KEY_CAUSE} Adding or changing accounts is paused until an admin device makes a fresh key, which it does by itself when its vault is open. Codes still work.`;
/**
 * A solo vault has no admin device: only its recovery phrase changes the key (engine
 * settleOwnChanges skips makeFreshKey for solo), through a new phrase or a restore.
 */
const FRESH_KEY_SOLO = `${FRESH_KEY_CAUSE} Adding or changing accounts is paused until the vault has a fresh key, and in a vault kept on one device only the recovery phrase can make one: tap "Make a new phrase" under Backup on the vault screen and type your current words. Codes still work.`;

function freshKeyWarning(input: WarningInput): VaultWarning | null {
  if (!input.state.needsFreshKey) return null;
  return {
    id: 'fresh-key',
    kind: 'fresh-key',
    text: input.state.kind === 'solo' ? FRESH_KEY_SOLO : FRESH_KEY_BY_ADMIN,
  };
}

function implausibleWarnings(input: WarningInput): VaultWarning[] {
  const signers = new Set(
    activeProblems(input)
      .filter((p) => p.kind === 'implausible')
      .map((p) => p.device),
  );
  return [...signers].map((deviceId) => ({
    id: `implausible:${deviceId}`,
    kind: 'implausible' as const,
    text: `${input.deviceName(deviceId)} signed a status note that claims far more than this vault holds, so AuthDeck ignored it. That device may be damaged or misused; if you don't trust it, remove it.`,
    deviceId,
  }));
}

/**
 * Proven forks name the device that signed two histories. A conflict without a proof (an entry
 * whose `seen` names another device's entry the folder holds differently) proves nothing about
 * the device it names: anyone can write a made-up hash there. So it names the writer of that
 * entry, and never tells the person to remove the device it names.
 */
function forkWarnings(input: WarningInput): VaultWarning[] {
  const { state, deviceName } = input;
  // The recovery phrase is no device: it is never to be removed. In a solo vault its forks never
  // cut it (one version counts, replay.ts soloRecoveryVersions), so nothing is said about them.
  const device = (id: string) => Object.hasOwn(state.members, id);
  const proven = Object.keys(state.forked).map((deviceId) => ({
    id: `fork:${deviceId}`,
    kind: 'fork' as const,
    text: device(deviceId)
      ? `${deviceName(deviceId)} signed two different versions of its history. AuthDeck kept both as proof and no longer counts anything it signed from there. Remove that device from the vault.`
      : 'The recovery phrase signed two different versions of its history, so the vault no longer takes anything it signs. Make a new recovery phrase from a device in the vault.',
    deviceId,
  }));
  const explained = (id: string) => Object.hasOwn(state.forked, id);
  const named = state.conflicts
    // A verified log that is no device's is a recovery identity's: never named as a device.
    .filter((c) => !explained(c.names.deviceId) && !explained(c.author) && (device(c.names.deviceId) || !Object.hasOwn(state.chains, c.names.deviceId)))
    .map((c) => ({
      id: `conflict:${c.author}:${c.names.deviceId}`,
      kind: 'fork' as const,
      text: `${deviceName(c.author)}'s change names a version of ${deviceName(c.names.deviceId)}'s history that isn't in the vault folder. Either the folder is missing it or ${deviceName(c.author)} named a change that never existed. Open AuthDeck on both devices while they are connected, so the vault can tell which.`,
      deviceId: c.author,
    }));
  const unique = new Map(named.map((w) => [w.id, w]));
  return [...proven, ...unique.values()];
}

function shortDate(time: number): string {
  return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Other admin devices whose beacon is missing or old: a removal they made could be held back. */
function unheardWarnings(input: WarningInput): VaultWarning[] {
  const { state, beacons, self, now, deviceName } = input;
  if (!beacons) return [];
  return Object.values(state.members)
    .filter((m) => !m.removed && m.role === 'admin' && m.deviceId !== self)
    .filter((m) => {
      const heard = beacons.heardAt[m.deviceId];
      return heard === undefined || now - heard >= UNHEARD_WARNING_MS;
    })
    .map((m) => {
      const heard = beacons.heardAt[m.deviceId];
      const since = heard === undefined ? "hasn't been heard from yet" : `hasn't been heard from since ${shortDate(heard)}`;
      return {
        id: `unheard:${m.deviceId}`,
        kind: 'unheard' as const,
        text: `${deviceName(m.deviceId)} ${since}. If it removed a device, this computer may be hiding that. Open AuthDeck on it while it is connected to check.`,
        deviceId: m.deviceId,
      };
    });
}

function joinsWarning(input: WarningInput): VaultWarning | null {
  if (input.stoppedJoins < JOIN_ATTEMPT_LIMIT) return null;
  return {
    id: 'joins',
    kind: 'joins',
    text: `Someone may be trying to join this vault: ${input.stoppedJoins} join attempts were stopped in the last hour. Only approve a device you are holding, after the codes match.`,
  };
}

function waitingWarnings(input: WarningInput): VaultWarning[] {
  const late = new Map<string, number>();
  for (const item of input.state.history) {
    if (item.status !== 'waiting' || !item.waitsFor) continue;
    const since = input.waitingSince.get(item.hash) ?? input.now;
    if (input.now - since < WAIT_WARNING_MS) continue;
    late.set(item.waitsFor.deviceId, (late.get(item.waitsFor.deviceId) ?? 0) + 1);
  }
  return [...late].map(([deviceId, count]) => ({
    id: `waiting:${deviceId}`,
    kind: 'waiting' as const,
    text: `${count === 1 ? 'A change waits' : `${count} changes wait`} on a change from ${input.deviceName(deviceId)} that hasn't reached the vault folder. Open AuthDeck on ${input.deviceName(deviceId)} while it is connected to the computer.`,
    deviceId,
  }));
}

function keyWarning(input: WarningInput): VaultWarning | null {
  if (input.keyProblems.length === 0) return null;
  return {
    id: 'key',
    kind: 'key',
    text: 'Some older vault keys could not be opened on this device, so accounts last changed long ago may not show. Ask another device in the vault to check them.',
  };
}

/**
 * More than one device and no recovery phrase: if two devices remove each other, both are out and
 * nothing can take the vault back. Not shown on a removed device, which can't set a phrase.
 */
function noRecoveryWarning(input: WarningInput): VaultWarning | null {
  const { state, self } = input;
  if (state.recovery !== null) return null;
  if (self !== null && state.members[self]?.removed !== false) return null;
  const devices = Object.values(state.members).filter((m) => !m.removed).length;
  if (devices <= 1) return null;
  return {
    id: 'no-recovery',
    kind: 'no-recovery',
    text: "No recovery phrase is set. If your devices ever remove each other, this vault can't be recovered. Set a recovery phrase.",
  };
}

/** Banners, most serious first. */
export function vaultWarnings(input: WarningInput): VaultWarnings {
  const withheld = withheldWarning(input);
  const freshKey = freshKeyWarning(input);
  const joins = joinsWarning(input);
  const key = keyWarning(input);
  const noRecovery = noRecoveryWarning(input);
  const warnings = [
    ...(withheld ? [withheld] : []),
    ...(freshKey ? [freshKey] : []),
    ...forkWarnings(input),
    ...implausibleWarnings(input),
    ...unheardWarnings(input),
    ...(joins ? [joins] : []),
    ...waitingWarnings(input),
    ...(key ? [key] : []),
    ...(noRecovery ? [noRecovery] : []),
  ];
  return { warnings, secretsPaused: withheld !== null || freshKey !== null };
}

const SECRETS_PAUSED = 'Adding or changing accounts is paused for now. Codes still work. The warning on the vault screen says why.';

/**
 * Why a change can't be written now, or null. While paused, no account record is written under
 * the current key, except one that only moves an HOTP counter: it reveals nothing new, and a
 * code that can't be used would lock the person out.
 */
export function pausedRefusal(kind: EntryKind, counterOnly: boolean, current: VaultWarnings): string | null {
  if (kind !== 'account.put' || counterOnly || !current.secretsPaused) return null;
  return SECRETS_PAUSED;
}

/** Keeps when each waiting entry was first seen waiting; forgets ones that applied or went. */
export function trackWaiting(previous: ReadonlyMap<string, number>, state: VaultState, now: number): Map<string, number> {
  const next = new Map<string, number>();
  for (const item of state.history) if (item.status === 'waiting') next.set(item.hash, previous.get(item.hash) ?? now);
  return next;
}
