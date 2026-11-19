/**
 * One clock for every 2FA key on screen. It ticks on the second boundary, so all codes and
 * countdowns change together, and it runs only while something on screen subscribes to it:
 * a deck with no visible 2FA keys (or a locked vault) has no timer at all.
 */
import { useCallback, useSyncExternalStore } from 'react';

import type { CodeView } from '../../auth/contract';
import { useVault } from '../../auth/useVault';

const listeners = new Set<() => void>();
let second = currentSecond();
let timer: ReturnType<typeof setTimeout> | null = null;

function currentSecond(): number {
  return Math.floor(Date.now() / 1000);
}

function scheduleTick(): void {
  // A few ms past the boundary, so the new second has surely begun when the tick reads it.
  timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
}

function tick(): void {
  second = currentSecond();
  listeners.forEach((notify) => notify());
  if (listeners.size > 0) scheduleTick();
  else timer = null;
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  if (!timer) {
    // The clock may have been idle: catch up before the first scheduled tick.
    second = currentSecond();
    scheduleTick();
  }
  return () => {
    listeners.delete(notify);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

const noSubscription = () => () => {};
const getSecond = () => second;

/** The current second (Unix time), re-rendering on each new second while `running`. */
export function useSecond(running: boolean): number {
  const subscribeIfRunning = useCallback((notify: () => void) => (running ? subscribe(notify) : noSubscription()), [running]);
  const ticked = useSyncExternalStore(subscribeIfRunning, getSecond, getSecond);
  // Stopped, the shared value may be stale from the last time the clock ran.
  return running ? ticked : currentSecond();
}

/**
 * An account's live code for a key face. `ticking` is false for keys nobody can see (pages
 * waiting off screen); they keep the code they last showed until they come into view.
 * HOTP codes never tick: they stay until used.
 */
export function useKeyCode(accountId: string, ticking: boolean): CodeView | null {
  const vault = useVault();
  const counts = vault.accounts.find((a) => a.id === accountId)?.type !== 'hotp';
  const at = useSecond(ticking && counts && vault.status === 'open');
  return vault.status === 'open' ? vault.code(accountId, at * 1000) : null;
}
