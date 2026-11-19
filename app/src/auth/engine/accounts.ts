/**
 * Converting between what screens send and show (NewAccount, AccountView) and the vault core's
 * account records. Pure, so node tests can run it.
 */
import type { AccountView, NewAccount } from '../contract';
import { base32Decode, base32Encode } from '../../vault/base32';
import type { AccountRecord, OpenAccount } from '../../vault/open';
import { validateAccountRecord } from '../../vault/open';
import { DEFAULT_PERIOD, STEAM_CODE_LENGTH, STEAM_PERIOD, validateOtpParams } from '../../vault/otp';
import type { OtpAccount } from '../../vault/otpauth';

/** 80 bits, the shortest key sites hand out; anything shorter typed by hand is almost surely a typo. */
const MIN_MANUAL_SECRET_CHARS = 16;

/** What a person calls an account: the issuer, else the label. */
export function accountTitle(account: { issuer: string; label: string }): string {
  return account.issuer.trim() || account.label.trim() || 'an account';
}

/** Turns a screen's account into a record the core can seal. Throws a plain sentence when it can't. */
export function toAccountRecord(account: NewAccount, position: number): AccountRecord {
  const isSteam = account.type === 'steam';
  const record: AccountRecord = {
    issuer: account.issuer.trim(),
    label: account.label.trim(),
    secret: base32Encode(base32Decode(account.secret)),
    type: account.type,
    algorithm: isSteam ? 'SHA1' : account.algorithm,
    digits: isSteam ? STEAM_CODE_LENGTH : account.digits,
    // HOTP has no period; the record still carries a valid one so every record checks the same way.
    period: isSteam ? STEAM_PERIOD : account.type === 'hotp' ? DEFAULT_PERIOD : account.period,
    counter: account.type === 'hotp' ? (account.counter ?? 0) : 0,
    position,
  };
  validateOtpParams(record);
  return validateAccountRecord(record);
}

/** Problems with an account typed by hand, as plain sentences; empty when it can be saved. */
export function accountProblems(account: NewAccount): string[] {
  const problems: string[] = [];
  if (!account.issuer.trim() && !account.label.trim()) problems.push('Give the account a name so you can tell it apart.');
  const compactSecret = account.secret.replace(/[\s=-]/g, '');
  if (!/^[A-Za-z2-7]*$/.test(compactSecret)) {
    problems.push('The key can only use the letters A–Z and the digits 2–7. Check for a 0, 1 or 8.');
  } else if (compactSecret.length < MIN_MANUAL_SECRET_CHARS) {
    problems.push(`The key should be at least ${MIN_MANUAL_SECRET_CHARS} characters. Copy the full setup key from the site.`);
  }
  if (problems.length > 0) return problems;
  try {
    toAccountRecord(account, 0);
  } catch (err) {
    problems.push(sentence((err as Error).message));
  }
  return problems;
}

/** A parsed otpauth link or export entry, as the add-account screen edits it. */
export function fromOtpAccount(account: OtpAccount): NewAccount {
  const added: NewAccount = {
    issuer: account.issuer,
    label: account.label,
    secret: account.secret,
    type: account.type,
    algorithm: account.algorithm,
    digits: account.digits,
    period: account.type === 'hotp' ? 0 : account.period,
  };
  if (account.type === 'hotp') added.counter = account.counter;
  return added;
}

export function toAccountView(account: OpenAccount, team: string | null): AccountView {
  const { record } = account;
  return {
    id: account.id,
    issuer: record.issuer,
    label: record.label,
    type: record.type,
    algorithm: record.algorithm,
    digits: record.digits,
    period: record.type === 'hotp' ? 0 : record.period,
    team,
  };
}

/** The user's order: deck position first, then name, so accounts without one sort predictably. */
export function sortAccounts(accounts: OpenAccount[]): OpenAccount[] {
  const position = (a: OpenAccount) => a.record.position ?? Number.MAX_SAFE_INTEGER;
  return [...accounts].sort((a, b) => position(a) - position(b) || accountTitle(a.record).localeCompare(accountTitle(b.record)) || a.id.localeCompare(b.id));
}

/** The position after every existing account. */
export function nextPosition(accounts: OpenAccount[]): number {
  return accounts.reduce((max, a) => Math.max(max, (a.record.position ?? -1) + 1), 0);
}

/** Core messages are lower-case fragments in places; screens get a full sentence. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return trimmed;
  const capitalized = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
