/**
 * What the window and the tray show about env sets: Activity rows, the grant banner, the tray's
 * lines, and which grants ended and why. Pure: the clock and the time are passed in.
 */
import type { EnvActivityEntry } from '../../../agent/src/envSocketContract';
import type { EnvGrantEndReason } from '../../../agent/src/protocol';
import type { ActivityItem, EnvGrant } from './state';

/** Formats a time of day, "11:58". */
export type Clock = (at: number) => string;

const MS_PER_MINUTE = 60_000;
/** The tray menu names this many grants, then counts the rest. */
const TRAY_GRANT_LINES = 3;

/** Grants still open at `now`, soonest to end first. */
export function liveGrants(grants: readonly EnvGrant[], now: number): EnvGrant[] {
  return grants.filter((grant) => grant.endsAt > now).sort((a, b) => a.endsAt - b.endsAt);
}

/** "a", "a and b", "a, b and c". */
function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "Used by npm run dev and npm test.", newest first as the agent keeps them. */
export function usesSentence(uses: readonly string[]): string {
  return uses.length === 0 ? 'Not used yet.' : `Used by ${listWords(uses)}.`;
}

export function grantMinutes(grant: EnvGrant): number {
  return Math.round((grant.endsAt - grant.startedAt) / MS_PER_MINUTE);
}

export interface GrantRowView {
  grantId: string;
  /** "acme-api · until 11:58" */
  title: string;
  /** "Pixel 8 · Used by npm run dev." */
  detail: string;
  endsAt: number;
  /** For End now's accessible name. */
  setName: string;
}

/**
 * One grant: its sentence, as in the design ("acme-api is allowed here until 11:58" / "Pixel 8
 * allowed it for 15 minutes. Used by …"). Several: a count, then a row each with its own End now.
 */
export type GrantBannerView =
  | { kind: 'one'; grantId: string; setName: string; title: string; detail: string; endsAt: number }
  | { kind: 'several'; title: string; rows: GrantRowView[] };

export function grantBanner(grants: readonly EnvGrant[], now: number, clock: Clock): GrantBannerView | null {
  const live = liveGrants(grants, now);
  const [only] = live;
  if (!only) return null;
  if (live.length === 1) {
    return {
      kind: 'one',
      grantId: only.grantId,
      setName: only.setName,
      title: `${only.setName} is allowed here until ${clock(only.endsAt)}`,
      detail: `${only.by} allowed it for ${grantMinutes(only)} minutes. ${usesSentence(only.uses)}`,
      endsAt: only.endsAt,
    };
  }
  return {
    kind: 'several',
    title: `${live.length} sets are allowed here`,
    rows: live.map((grant) => ({
      grantId: grant.grantId,
      setName: grant.setName,
      title: `${grant.setName} · until ${clock(grant.endsAt)}`,
      detail: `${grant.by} · ${usesSentence(grant.uses)}`,
      endsAt: grant.endsAt,
    })),
  };
}

/** The tray's status lines while grants are open: "acme-api allowed until 11:58". */
export function grantTrayLines(grants: readonly EnvGrant[], now: number, clock: Clock): string[] {
  const live = liveGrants(grants, now);
  const named = live.slice(0, TRAY_GRANT_LINES).map((grant) => `${grant.setName} allowed until ${clock(grant.endsAt)}`);
  const more = live.length - named.length;
  return more > 0 ? [...named, `and ${more} more allowed`] : named;
}

/** The reasons the desktop app ends grants with: End now and End all, lock and sleep. */
export type DesktopEndReason = Extract<EnvGrantEndReason, 'ended-on-computer' | 'computer-locked' | 'computer-slept'>;

/** How an Activity row says why a grant ended; `minutes` is the grant's length. */
function endReasonWords(reason: EnvGrantEndReason, minutes: number): string {
  switch (reason) {
    case 'expired':
      return `Ran out after ${minutes} min`;
    case 'ended-on-device':
      return 'Ended on a device';
    case 'ended-on-computer':
      return 'Ended here';
    case 'computer-locked':
      return 'Ended when the computer locked';
    case 'computer-slept':
      return 'Ended when the computer slept';
    case 'clock-jumped':
      return "Ended when the computer's clock jumped";
    case 'set-changed':
      return 'Ended when the set changed';
    case 'unpaired':
      return 'Ended when a device was unpaired';
  }
}

/** Without the agent's reason, the row says only what the times show. */
function endWords(grant: EnvGrant, reason: EnvGrantEndReason | undefined, now: number): string {
  if (reason) return endReasonWords(reason, grantMinutes(grant));
  return grant.endsAt <= now ? endReasonWords('expired', grantMinutes(grant)) : 'Ended early';
}

export function grantEndedItem(grant: EnvGrant, reason: EnvGrantEndReason | undefined, now: number): ActivityItem {
  const used = grant.uses.length === 0 ? 'not used' : `used by ${grant.uses.join(', ')}`;
  return {
    kind: 'env',
    at: now,
    title: `Grant for ${grant.setName} ended`,
    detail: `Allowed on ${grant.by} · ${used}`,
    outcome: { text: endWords(grant, reason, now), tone: 'idle' },
  };
}

/** The agent writes the words ("Ran with acme-api", "npm test · 12 variables", "Inside the 15-min grant"). */
export function envActivityItem(entry: EnvActivityEntry): ActivityItem {
  return { kind: 'env', at: entry.at, title: entry.title, detail: entry.detail, outcome: entry.outcome };
}

/** The grants in `before` that `after` no longer has. */
export function endedGrants(before: readonly EnvGrant[], after: readonly EnvGrant[]): EnvGrant[] {
  const open = new Set(after.map((grant) => grant.grantId));
  return before.filter((grant) => !open.has(grant.grantId));
}

/** What env.grants.changed says about the grant that just ended. */
export interface GrantEnded {
  grantId: string;
  reason: EnvGrantEndReason;
}

/** The open grants as the agent last reported them. */
export class GrantTracker {
  private open: EnvGrant[] = [];

  get grants(): EnvGrant[] {
    return this.open;
  }

  /** Takes the agent's new list and returns a row for each grant that left it, with the agent's reason when given. */
  update(grants: readonly EnvGrant[], ended: GrantEnded | undefined, now: number): ActivityItem[] {
    const rows = endedGrants(this.open, grants).map((grant) => grantEndedItem(grant, grant.grantId === ended?.grantId ? ended.reason : undefined, now));
    this.open = [...grants];
    return rows;
  }

  /** The agent stopped: its grants went with it. */
  clear(): void {
    this.open = [];
  }
}
