/**
 * The words for env rows in the Agent window's Activity list and the agent's log: what was asked,
 * and how it ended. Commands, paths and set names only; never a value.
 */
import type { EnvActivityEntry } from '../envSocketContract';
import type { EnvRequestKind } from '../protocol';

export type ActivityOutcome = EnvActivityEntry['outcome'];

/** How a request ended, for the outcome column. */
export type RequestEnd =
  | { kind: 'allowed-once'; by: string }
  | { kind: 'new-grant'; by: string }
  | { kind: 'inside-grant' }
  | { kind: 'signed'; by: string }
  | { kind: 'created'; by: string }
  | { kind: 'keys-made'; by: string }
  | { kind: 'denied'; by: string }
  | { kind: 'no-answer' }
  | { kind: 'cancelled' }
  | { kind: 'changed-meanwhile' }
  | { kind: 'file-refused' };

/** What the request was, in the words of the row. */
export interface ActivitySubject {
  kind: EnvRequestKind;
  setName: string;
  /** run: the command; pull: where .env goes; push: what changed; create: how many variables; join-keys: the request file. */
  detail: string;
  /** pull only: git would not leave .env out of a commit. */
  notIgnored?: boolean;
}

function succeeded(end: RequestEnd): boolean {
  return ['allowed-once', 'new-grant', 'inside-grant', 'signed', 'created', 'keys-made'].includes(end.kind);
}

export function activityTitle(subject: ActivitySubject, end: RequestEnd): string {
  const { setName } = subject;
  const ok = succeeded(end);
  switch (subject.kind) {
    case 'run':
      return ok ? `Ran with ${setName}` : `Asked for ${setName}`;
    case 'pull':
      return ok ? `Wrote .env for ${setName}` : `Asked for ${setName}`;
    case 'push':
      return ok ? `Changed ${setName}` : `Asked to change ${setName}`;
    case 'create':
      return ok ? `Made ${setName}` : `Asked to make ${setName}`;
    case 'join-keys':
      return `Asked to join ${setName}`;
  }
}

export function activityOutcome(subject: ActivitySubject, end: RequestEnd): ActivityOutcome {
  switch (end.kind) {
    case 'allowed-once':
      return { text: subject.notIgnored ? 'Allowed once · not ignored by git' : `Allowed once on ${end.by}`, tone: subject.notIgnored ? 'warn' : 'ok' };
    case 'new-grant':
      return { text: `Allowed for 15 min on ${end.by}`, tone: subject.notIgnored ? 'warn' : 'ok' };
    case 'inside-grant':
      return { text: 'Inside the 15-min grant', tone: 'ok' };
    case 'signed':
      return { text: `Signed by ${end.by}`, tone: 'ok' };
    case 'created':
      return { text: `Created on ${end.by}`, tone: 'ok' };
    case 'keys-made':
      return { text: `Keys made on ${end.by}`, tone: 'ok' };
    case 'denied':
      return { text: `Denied on ${end.by}`, tone: 'bad' };
    case 'no-answer':
      return { text: 'No device answered', tone: 'warn' };
    case 'cancelled':
      return { text: 'Stopped before an answer', tone: 'warn' };
    case 'changed-meanwhile':
      return { text: 'The file changed meanwhile', tone: 'warn' };
    case 'file-refused':
      return { text: 'Set file refused', tone: 'bad' };
  }
}

/** "1 added, 1 changed, 1 removed"; "No changes" when nothing did. */
export function changeWords(added: number, changed: number, removed: number): string {
  const parts = [added > 0 ? `${added} added` : '', changed > 0 ? `${changed} changed` : '', removed > 0 ? `${removed} removed` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'No changes';
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
