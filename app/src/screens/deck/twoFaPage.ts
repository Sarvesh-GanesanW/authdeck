/**
 * The 2FA page every deck is given (state/store.ts withTwoFaPage): once the vault is open, each
 * account it has not been offered yet gets a key on it, the way "Make 2FA page" places them. These
 * keys are not the person's edits, so no edit unlock is asked for.
 */
import { useEffect } from 'react';

import type { AccountView, VaultStatus } from '../../auth/contract';
import type { Deck, Page } from '../../state/model';
import { useStore } from '../../state/store';
import { withAccountKeys } from '../../state/templates';

/**
 * The page with a key for each account not offered to it before, or null when nothing changes.
 * Every account is then counted as offered, also one that did not fit, so a key the person
 * removed is never put back.
 */
export function withNewAccounts(page: Page, accounts: AccountView[]): Page | null {
  // A deck's own 2FA page only, and only while it is one: "Make it a normal page" stops the filling.
  if (!page.otp || !page.autoAccounts) return null;
  const offered = new Set(page.autoAccounts);
  const fresh = accounts.filter((a) => !offered.has(a.id));
  if (fresh.length === 0) return null;
  return { ...withAccountKeys(page, fresh).page, autoAccounts: [...page.autoAccounts, ...fresh.map((a) => a.id)] };
}

/** Keeps the deck's 2FA page up to date with the vault while it is open. */
export function useTwoFaPage(agentId: string, deck: Deck, status: VaultStatus, accounts: AccountView[]): void {
  useEffect(() => {
    if (status !== 'open') return;
    for (const page of deck.pages) {
      if (!withNewAccounts(page, accounts)) continue;
      // Worked out again on the stored page, in case it changed since this render.
      useStore.getState().updatePage(agentId, page.id, (p) => withNewAccounts(p, accounts) ?? p);
    }
  }, [agentId, deck, status, accounts]);
}

/** The fewest spots a 2FA page lays out, so one or two keys don't stretch across the plate. */
export const MIN_TWO_FA_CELLS = 6;

export interface PageCells {
  /** Slots the grid is sized for. */
  cells: number;
  /** Slots drawn, from the first: the rest of `cells` stays empty plate. */
  shown: number;
}

/**
 * How much of a page's grid is laid out. A normal page shows all its slots. A 2FA page shows its
 * keys up to the last one and the "Add account" spot after them (at least MIN_TWO_FA_CELLS), so
 * a few accounts get big keys; editing adds one empty spot to move a key into. The grid is sized
 * for the editing count in both modes, so keys keep their size and place when Edit starts.
 * The page's slots themselves don't change.
 */
export function pageCells(page: Page, editing: boolean): PageCells {
  const total = page.slots.length;
  if (!page.otp) return { cells: total, shown: total };
  let last = -1;
  page.slots.forEach((k, i) => {
    if (k) last = i;
  });
  const cells = Math.min(total, Math.max(MIN_TWO_FA_CELLS, last + 3));
  const shown = editing ? cells : Math.min(total, Math.max(MIN_TWO_FA_CELLS, last + 2));
  return { cells, shown };
}
