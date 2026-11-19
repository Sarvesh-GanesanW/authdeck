/**
 * A device the vault removed (docs/authenticator.md, rule 5). Nothing is deleted on its own:
 * a removal can be a mistake or an attack (two devices removing each other), so the device keeps
 * its copy, shows its codes read-only as of the last key it held, and says who removed it. The
 * person deletes the copy when they are sure. Pure.
 */
import type { DeviceKeys } from '../../vault/crypto';
import { openVault, type OpenVault } from '../../vault/open';
import type { VaultState } from '../../vault/replay';

const SOMEONE = 'Another device';

export function isRemoved(state: VaultState | null, deviceId: string | null): boolean {
  return !!deviceId && state?.members[deviceId]?.removed === true;
}

/**
 * The vault as this removed device last could read it: opened at the newest epoch whose key was
 * given to it. Accounts written under later keys stay unreadable, as they should.
 */
export function openRemovedVault(state: VaultState, device: DeviceKeys): OpenVault {
  const held = Object.keys(state.sealedKeys)
    .map(Number)
    .filter((epoch) => epoch <= state.epoch && state.sealedKeys[epoch]?.[device.deviceId])
    .sort((a, b) => b - a)[0];
  if (held === undefined) throw new Error('This device was removed from the vault and holds no key to read it.');
  return openVault({ ...state, epoch: held }, device);
}

function listNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? SOMEONE) : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Removals this device signed in true symmetry with its own removal (state.counterRemovals) that
 * the folder doesn't hold yet: the person removed a device here before that device's removal of
 * this one arrived. The computer still takes them, so they are kept and sent after pairing again.
 */
export interface HeldRemoval {
  /** The devices this device removed. */
  targets: string[];
  /** The highest seq among them: this device sends its own lines up to here. */
  lastSeq: number;
}

/**
 * This removed device's held counter-removals, or null when there are none. `folderSeq` is the
 * highest of its own seqs the folder is known to hold (-1 for none): lines past it are unsent.
 */
export function heldRemoval(state: VaultState, self: string, folderSeq: number): HeldRemoval | null {
  if (!isRemoved(state, self)) return null;
  const counters = new Set(state.counterRemovals);
  const held = state.history.filter((h) => h.author === self && h.kind === 'device.remove' && h.seq > folderSeq && counters.has(h.hash));
  if (held.length === 0) return null;
  return { targets: [...new Set(held.map((h) => h.subject).filter((id): id is string => id !== undefined))], lastSeq: Math.max(...held.map((h) => h.seq)) };
}

const READ_ONLY = 'Its codes still show here, read-only. Delete them from this device once you no longer need them.';

/** What the removed screen says while a counter-removal waits on this device for the computer. */
export function heldRemovalSentence(held: HeldRemoval, deviceName: (id: string) => string | null, computerName: string | null): string {
  const names = listNames(held.targets.map((id) => deviceName(id) ?? SOMEONE));
  return `${names} removed this phone. You removed ${names} on this phone before that. To send your removal, pair this phone with ${computerName ?? 'your computer'} again. ${READ_ONLY}`;
}

/**
 * Who removed this device, in a sentence: a removal made at the same time as one of its remover
 * (each took the other out) says so and points to the recovery phrase, which can take the vault
 * back. Null when this device is still in the vault.
 */
export function removedSentence(state: VaultState, self: string, deviceName: (id: string) => string | null): string | null {
  const me = state.members[self];
  if (!me?.removed) return null;
  if (me.removedBy.length === 0) {
    return `This device was cut off from the vault: two different versions of its history were signed with its key, so its key may have been copied. Use your recovery phrase on a device you trust to take the vault back. ${READ_ONLY}`;
  }
  const names = listNames(me.removedBy.map((id) => deviceName(id) ?? SOMEONE));
  const mutual = me.removedBy.some((id) => state.members[id]?.removedBy.includes(self));
  if (mutual) {
    return `${names} removed this device at the same time it was removed itself, so neither is in the vault now. If you didn't mean to do that, use your recovery phrase to take the vault back. ${READ_ONLY}`;
  }
  return `${names} removed this device from the vault. ${READ_ONLY}`;
}
