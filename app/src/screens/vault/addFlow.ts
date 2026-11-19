/** Shared pieces of adding accounts: defaults, matching, and the success banner. */
import type { AccountView, NewAccount, OtpType, VaultWarning } from '../../auth/contract';
import { showDone } from './feedback';
import { accountName, plural } from './format';

/** What a site uses when its QR code doesn't say otherwise (RFC 6238 defaults). */
export const DEFAULT_ACCOUNT: NewAccount = { issuer: '', label: '', secret: '', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30 };

/** Steam Guard has one fixed shape: five characters, every 30 s, SHA-1. */
export const STEAM_SHAPE = { digits: 5, period: 30, algorithm: 'SHA1' } as const;

/** The shape each type starts from when picked in the form. */
export function shapeForType(type: OtpType): Pick<NewAccount, 'digits' | 'period' | 'algorithm'> {
  if (type === 'steam') return STEAM_SHAPE;
  return { digits: DEFAULT_ACCOUNT.digits, period: type === 'hotp' ? 0 : DEFAULT_ACCOUNT.period, algorithm: DEFAULT_ACCOUNT.algorithm };
}

/** Identity of an account for spotting the same one twice: site and account name, case-blind. */
export function accountKey(account: Pick<NewAccount, 'issuer' | 'label'>): string {
  return `${account.issuer.trim().toLowerCase()}\n${account.label.trim().toLowerCase()}`;
}

export function isInVault(account: NewAccount, existing: AccountView[]): boolean {
  const key = accountKey(account);
  return existing.some((a) => accountKey(a) === key);
}

/** "Added GitHub" or "Added 4 accounts". */
export function announceAdded(accounts: NewAccount[]) {
  showDone(accounts.length === 1 ? `Added ${accountName(accounts[0])}` : `Added ${plural(accounts.length, 'account')}`);
}

/**
 * Before a new secret is written: admin devices that haven't been heard from lately, as one
 * paragraph, or null. A removal one of them made could be held back by the computer, and the
 * removed device would then read the new secret, so the person is asked first.
 */
export function unheardNote(warnings: VaultWarning[]): string | null {
  const unheard = warnings.filter((w) => w.kind === 'unheard');
  return unheard.length === 0 ? null : unheard.map((w) => w.text).join(' ');
}

/** Why adding or changing accounts is paused: the pausing banner's own words. */
export function pausedNote(warnings: VaultWarning[]): string {
  const pausing = warnings.find((w) => w.kind === 'withheld' || w.kind === 'fresh-key');
  return (
    pausing?.text ??
    "Adding accounts is paused until this device gets changes another device has already seen, so a removed device can't read new keys. Your codes still work."
  );
}
