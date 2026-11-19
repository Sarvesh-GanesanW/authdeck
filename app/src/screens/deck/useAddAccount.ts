/**
 * Opens the authenticator's "Add account" sheet and reports the accounts it added once it closes,
 * so the caller can put them where the user asked (an empty spot, the key being edited). This is
 * the vault screen's own sheet, so every add takes one path: the removed and paused checks and the
 * "hasn't been heard from" confirm (AddAccountSheet) come before any step can write a secret.
 */
import { useCallback, useEffect, useRef } from 'react';

import type { AccountView } from '../../auth/contract';
import { useAuthUi } from '../../auth/ui';
import { useVault } from '../../auth/useVault';

export function useAddAccount(onAdded: (added: AccountView[]) => void): () => void {
  const vault = useVault();
  const surface = useAuthUi((s) => s.surface);
  /** Account ids before the sheet opened; null when not waiting on the sheet. */
  const known = useRef<Set<string> | null>(null);
  const report = useRef(onAdded);
  report.current = onAdded;

  useEffect(() => {
    if (!known.current || surface !== null) return;
    const before = known.current;
    known.current = null;
    const added = vault.accounts.filter((a) => !before.has(a.id));
    if (added.length > 0) report.current(added);
  }, [surface, vault.accounts]);

  const { accounts, status } = vault;
  return useCallback(() => {
    // Without a vault there is nowhere to add an account yet: set one up first.
    if (status === 'none') {
      useAuthUi.getState().open('intro');
      return;
    }
    // While locked the list is empty, so every account would look new after the sheet closes.
    known.current = status === 'open' ? new Set(accounts.map((a) => a.id)) : null;
    useAuthUi.getState().open('add-account');
  }, [accounts, status]);
}
