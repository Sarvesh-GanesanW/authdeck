/**
 * Which request sheet AuthHost shows, one at a time. Pure, so the queue rules are tested alone.
 * A computer's requests show oldest first as they arrive. An own device's join request shows at
 * once too (it runs out in minutes); a teammate's waits in the list until the owner picks Review.
 */
import type { EnvJoinRequestView, EnvRequestView } from '../../auth/envContract';

/** The request to show next: the oldest one not closed here. */
export function nextRequest(incoming: EnvRequestView[], closed: ReadonlySet<string>): EnvRequestView | null {
  return incoming.find((r) => !closed.has(r.id)) ?? null;
}

/**
 * The request on screen. The sheet keeps the one it opened with until it closes, following the
 * engine's newer copy of it (unlocked, say) while there is one, and keeping the last copy once
 * the engine drops it, so the sheet can show the signed diff or why the request ended.
 */
export function shownRequest(held: EnvRequestView | null, incoming: EnvRequestView[], closed: ReadonlySet<string>): EnvRequestView | null {
  if (held) return incoming.find((r) => r.id === held.id) ?? held;
  return nextRequest(incoming, closed);
}

/** The join request to show: the one picked for review, else an own device's that wasn't closed. */
export function joinToShow(requests: EnvJoinRequestView[], reviewId: string | null, closed: ReadonlySet<string>): EnvJoinRequestView | null {
  const picked = reviewId ? requests.find((r) => r.id === reviewId) : undefined;
  if (picked) return picked;
  return requests.find((r) => r.via === 'own-device' && !closed.has(r.id)) ?? null;
}

/** Closed ids, forgetting the ones the engine no longer lists (so the set doesn't grow forever). */
export function withClosed(closed: ReadonlySet<string>, id: string, stillListed: string[]): ReadonlySet<string> {
  const listed = new Set(stillListed);
  return new Set([...closed, id].filter((c) => listed.has(c)));
}
