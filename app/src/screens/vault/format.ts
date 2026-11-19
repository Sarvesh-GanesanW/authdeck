/** Plain-language wording for the vault screens: times, counts and account tags. Pure, no React. */
import type { AccountView, DeviceView, NewAccount, VaultSnapshot } from '../../auth/contract';
import type { GlyphName } from '../../ui/Icon';
import { vaultFeatures } from '../../vault/features';

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "18:22". */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "16 Nov". */
export function shortDate(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** History column: "18:22" today, "Yesterday", then "14 Nov". */
export function historyTime(at: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (at >= today) return clockTime(at);
  if (at >= today - DAY_MS) return 'Yesterday';
  return shortDate(at);
}

/** "18:22 today", "yesterday at 18:22", "14 Nov". */
export function whenPhrase(at: number, now: number): string {
  const today = startOfDay(now);
  if (at >= today) return `${clockTime(at)} today`;
  if (at >= today - DAY_MS) return `yesterday at ${clockTime(at)}`;
  return shortDate(at);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Past this, a date reads better than a count of days. */
const DAYS_BEFORE_DATE = 30;

/**
 * A device row's liveness line: "Last heard from 2 days ago", "Not heard from yet". The time is
 * by the device's own clock, so one running ahead reads as "moments ago" rather than the future.
 */
export function lastHeard(at: number | null, now = Date.now()): string {
  if (at === null) return 'Not heard from yet';
  const ago = Math.max(0, now - at);
  if (ago < MINUTE_MS) return 'Last heard from moments ago';
  if (ago < HOUR_MS) return `Last heard from ${plural(Math.floor(ago / MINUTE_MS), 'minute')} ago`;
  if (ago < DAY_MS) return `Last heard from ${plural(Math.floor(ago / HOUR_MS), 'hour')} ago`;
  const days = Math.floor(ago / DAY_MS);
  if (days < DAYS_BEFORE_DATE) return `Last heard from ${plural(days, 'day')} ago`;
  return `Last heard on ${shortDate(at)}`;
}

/** "9 accounts, 3 trusted devices, last change 18:22 today". */
export function vaultSummary(vault: Pick<VaultSnapshot, 'accounts' | 'devices' | 'lastChangeAt'>, now = Date.now()): string {
  const parts = vaultFeatures.multiDevice
    ? [plural(vault.accounts.length, 'account'), plural(vault.devices.length, 'trusted device')]
    : [plural(vault.accounts.length, 'account')];
  if (vault.lastChangeAt !== null) parts.push(`last change ${whenPhrase(vault.lastChangeAt, now)}`);
  return parts.join(', ');
}

/** What to call an account when one name is needed: the issuer, else the label. */
export function accountName(account: Pick<AccountView, 'issuer' | 'label'>): string {
  return account.issuer.trim() || account.label.trim() || 'Unnamed account';
}

/** The tag at the end of an account row: "6 digits, 30 s", "Steam Guard", "Team". */
export function accountTag(account: AccountView): string {
  if (account.team) return 'Team';
  if (account.type === 'steam') return 'Steam Guard';
  if (account.type === 'hotp') return `${account.digits} digits, counter`;
  return `${account.digits} digits, ${account.period} s`;
}

/** The second line of an account row. */
export function accountDetail(account: AccountView): string {
  return account.team ? `shared with ${account.team}` : account.label;
}

/** "6 digits, new code every 30 s", for a preview of an account about to be added. */
export function codeShape(account: Pick<NewAccount, 'type' | 'digits' | 'period'>): string {
  if (account.type === 'steam') return 'Steam Guard, new code every 30 s';
  if (account.type === 'hotp') return `${account.digits} digits, a new code each time you ask`;
  return `${account.digits} digits, new code every ${account.period} s`;
}

/** Splits a code in half for reading aloud: "123 456". Steam codes stay whole. */
export function spacedCode(code: string): string {
  if (code.length < 6 || !/^\d+$/.test(code)) return code;
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

const ISSUER_GLYPHS: [RegExp, GlyphName][] = [
  [/github|gitlab|bitbucket/i, 'git-branch'],
  [/aws|amazon|cloud|azure|digitalocean/i, 'cloud'],
  [/google|gmail|mail|outlook|proton/i, 'mail'],
  [/steam|epic|xbox|playstation|nintendo|battle/i, 'gamepad'],
];

/** The pixel icon in an account's tile, guessed from the issuer. */
export function accountGlyph(account: Pick<AccountView, 'issuer' | 'team'>): GlyphName {
  if (account.team) return 'users';
  return ISSUER_GLYPHS.find(([pattern]) => pattern.test(account.issuer))?.[1] ?? 'key';
}

/** The pixel icon in a device's tile, guessed from its name. */
export function deviceGlyph(device: Pick<DeviceView, 'name'>): GlyphName {
  return /pad|tab/i.test(device.name) ? 'tablet' : 'phone';
}

/** True when the account matches every word of a search. */
export function matchesSearch(account: AccountView, query: string): boolean {
  const haystack = `${account.issuer} ${account.label} ${account.team ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}
