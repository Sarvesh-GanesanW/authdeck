/**
 * Changing the deck is guarded like the vault: with app lock on, entering edit mode or creating a
 * key asks for the same unlock first (VaultActions.requireUnlock), so someone holding an unlocked
 * phone cannot point a key at a different command. Pressing existing keys is never gated.
 */
import type { VaultActions, VaultStatus } from '../../auth/contract';

/** The line the device prompt shows. */
export const EDIT_UNLOCK_REASON = 'Unlock to change your deck';

/**
 * Runs `change` once the person has unlocked (at once when app lock is off or the vault is open).
 * When the unlock is cancelled or fails, `change` never runs and `onRefused` gets its plain message.
 */
export async function afterEditUnlock(
  requireUnlock: VaultActions['requireUnlock'],
  change: () => void,
  onRefused: (message: string) => void,
): Promise<boolean> {
  try {
    await requireUnlock(EDIT_UNLOCK_REASON);
  } catch (e) {
    onRefused(e instanceof Error ? e.message : 'The deck stays as it is.');
    return false;
  }
  change();
  return true;
}

/**
 * For a change that starts by asking for something, like a backup file to import: the unlock comes
 * first, so the picker never opens for someone who can't pass it. Null when refused or nothing picked.
 */
export async function pickAfterEditUnlock<T>(
  requireUnlock: VaultActions['requireUnlock'],
  pick: () => Promise<T | null>,
  onRefused: (message: string) => void,
): Promise<T | null> {
  let allowed = false;
  await afterEditUnlock(requireUnlock, () => (allowed = true), onRefused);
  return allowed ? pick() : null;
}

/** Edit mode ends when the vault locks under it (auto-lock or Lock), so editing never outlives the unlock. */
export function mustLeaveEditing(editing: boolean, vault: { appLock: boolean; status: VaultStatus }): boolean {
  return editing && vault.appLock && vault.status === 'locked';
}
