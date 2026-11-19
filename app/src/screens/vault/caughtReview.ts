/** What the caught-changes review shows for each change, and what starts ticked. Pure, no React. */
import type { CaughtChangeView } from '../../auth/contract';
import { historyTime } from './format';

/** Which caught changes start ticked for re-applying: none. Nothing is applied unless the person picks it. */
export function initialCaughtSelection(): ReadonlySet<string> {
  return new Set();
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The author with its key words, and the lines under a change: who and when, made after removal, and whether it can be read. */
export function caughtDetail(change: CaughtChangeView, now = Date.now()): { author: string; detail: string } {
  const author = change.byKeyWords ? `${change.by} (key words: ${change.byKeyWords})` : change.by;
  const lines = [`${author}, ${historyTime(change.time, now)}`, sentenceCase(change.madeAfter)];
  if (!change.canReapply) lines.push("This device can't read it, so it can only be dismissed.");
  return { author, detail: lines.join('\n') };
}
