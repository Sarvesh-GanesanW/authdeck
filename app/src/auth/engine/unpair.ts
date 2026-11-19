/**
 * After removing a device: whether the computer also unpaired it, from the `removals` a
 * vault.append answer carries (protocol.ts VaultRemoval), and the sentence the removal sheet shows.
 */
import { isId, isPlainObject } from '../../vault/entry';

/** Removed device id -> the computer that unpaired it, or null when that computer didn't know which paired device it is. */
export type UnpairOutcomes = Map<string, string | null>;

/**
 * The `removals` of a vault.append answer. The app's message check only covers `lengths`, so this
 * field is checked here; anything malformed reads as "not told", never as unpaired.
 */
export function readRemovals(result: unknown): UnpairOutcomes {
  const outcomes: UnpairOutcomes = new Map();
  if (!isPlainObject(result) || !Array.isArray(result.removals)) return outcomes;
  for (const removal of result.removals) {
    if (!isPlainObject(removal) || !isId(removal.device)) continue;
    const from = removal.unpairedFrom;
    outcomes.set(removal.device, typeof from === 'string' && from.trim() !== '' ? from : null);
  }
  return outcomes;
}

/**
 * "<name> is also unpaired from <computer>." when the computer said so; otherwise what to do,
 * because a removed phone that is still paired can go on pressing keys on that computer.
 */
export function unpairSentence(deviceName: string, unpairedFrom: string | null | undefined, computerName: string | null): string {
  if (unpairedFrom) return `${deviceName} is also unpaired from ${unpairedFrom}.`;
  return `To stop ${deviceName} controlling ${computerName ?? 'your computer'}, unpair it in AuthDeck Agent.`;
}
