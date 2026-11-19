/**
 * `otpauth://` key URIs (the Google Authenticator key URI format) as shown in setup QR codes.
 * Parsed by hand because the app's runtime has no reliable URL global.
 */

import { base32Decode, base32Encode } from './base32';
import {
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  OTP_ALGORITHMS,
  STEAM_CODE_LENGTH,
  STEAM_PERIOD,
  validateOtpParams,
  type OtpAlgorithm,
  type OtpParams,
  type OtpType,
} from './otp';

export type OtpAccount = OtpParams & { issuer: string; label: string };

const OTPAUTH_PATTERN = /^otpauth:\/\/([^/?#]*)\/([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i;
const STEAM_ENCODER = 'steam';
const WHOLE_NUMBER = /^\d+$/;

function decodePart(text: string, what: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new Error(`The ${what} in this code has broken %-encoding. Scan the QR code again or copy the link again.`);
  }
}

/**
 * Parses a URI query into lower-case keys and decoded values. Values treat `+` as a space, as
 * HTML forms write them. The first of a repeated key wins.
 */
export function parseUriQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const equals = pair.indexOf('=');
    const rawKey = equals < 0 ? pair : pair.slice(0, equals);
    const rawValue = equals < 0 ? '' : pair.slice(equals + 1);
    const key = decodePart(rawKey.replace(/\+/g, ' '), 'link').toLowerCase();
    if (!params.has(key)) params.set(key, decodePart(rawValue.replace(/\+/g, ' '), `"${key}" value`));
  }
  return params;
}

function parseType(rawType: string, encoder: string | undefined): OtpType {
  const type = rawType.toLowerCase();
  if (type !== 'totp' && type !== 'hotp' && type !== 'steam') {
    throw new Error(`"${rawType}" codes are not supported. AuthDeck reads TOTP, HOTP and Steam codes.`);
  }
  if (type === 'totp' && encoder?.toLowerCase() === STEAM_ENCODER) return 'steam';
  return type;
}

/** Returns the secret in canonical form: upper-case base32, no padding or spaces. */
function parseSecret(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('This code has no secret. Scan the full QR code, or type the setup key by hand.');
  }
  const bytes = base32Decode(raw);
  if (bytes.length === 0) throw new Error('The secret is empty. Copy the full setup key from the website.');
  return base32Encode(bytes);
}

function parseAlgorithm(raw: string | undefined): OtpAlgorithm {
  if (raw === undefined) return 'SHA1';
  const name = raw.toUpperCase().replace('-', '');
  const algorithm = OTP_ALGORITHMS.find((candidate) => candidate === name);
  if (!algorithm) throw new Error(`The algorithm "${raw}" is not supported. AuthDeck supports SHA1, SHA256 and SHA512.`);
  return algorithm;
}

function parseWholeNumber(raw: string | undefined, fallback: number | undefined, what: string): number {
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`This code has no ${what}. Add one, or set the code up again on the website.`);
    return fallback;
  }
  const value = Number(raw);
  if (!WHOLE_NUMBER.test(raw) || !Number.isSafeInteger(value)) throw new Error(`The ${what} "${raw}" is not a whole number.`);
  return value;
}

function splitAtFirstColon(label: string): { prefix: string; account: string } | null {
  const colon = label.indexOf(':');
  return colon < 0 ? null : { prefix: label.slice(0, colon), account: label.slice(colon + 1) };
}

/**
 * Splits `Issuer:account`. An `issuer` parameter wins over the prefix. An empty `issuer`
 * parameter keeps the whole label, which is how a name containing a colon is written.
 */
function splitLabel(label: string, issuerParam: string | undefined): { issuer: string; label: string } {
  if (issuerParam === '') return { issuer: '', label: label.trim() };
  if (issuerParam !== undefined) {
    const issuerPrefix = `${issuerParam}:`;
    const account = label.startsWith(issuerPrefix) ? label.slice(issuerPrefix.length) : (splitAtFirstColon(label)?.account ?? label);
    return { issuer: issuerParam.trim(), label: account.trim() };
  }
  const parts = splitAtFirstColon(label);
  if (!parts) return { issuer: '', label: label.trim() };
  return { issuer: parts.prefix.trim(), label: parts.account.trim() };
}

/** Reads an `otpauth://totp|hotp|steam/...` link. Throws a message a person can act on. */
export function parseOtpAuthUri(uri: string): OtpAccount {
  const match = OTPAUTH_PATTERN.exec(uri.trim());
  if (!match) throw new Error('This is not an authenticator link. It should start with otpauth://totp/ or otpauth://hotp/.');
  const [, rawType = '', rawLabel = '', rawQuery = ''] = match;
  const query = parseUriQuery(rawQuery);
  const type = parseType(rawType, query.get('encoder'));
  const names = splitLabel(decodePart(rawLabel, 'account name'), query.get('issuer'));
  const isSteam = type === 'steam';
  const account: OtpAccount = {
    ...names,
    type,
    secret: parseSecret(query.get('secret')),
    algorithm: isSteam ? 'SHA1' : parseAlgorithm(query.get('algorithm')),
    digits: isSteam ? STEAM_CODE_LENGTH : parseWholeNumber(query.get('digits'), DEFAULT_DIGITS, 'digit count'),
    period: isSteam ? STEAM_PERIOD : parseWholeNumber(query.get('period'), DEFAULT_PERIOD, 'period'),
    counter: type === 'hotp' ? parseWholeNumber(query.get('counter'), undefined, 'counter') : 0,
  };
  validateOtpParams(account);
  return account;
}

/** Writes an `otpauth://` link that parseOtpAuthUri reads back to the same account. */
export function formatOtpAuthUri(account: OtpAccount): string {
  const label = account.issuer === '' ? account.label : `${account.issuer}:${account.label}`;
  const params: [string, string][] = [['secret', account.secret]];
  // An empty issuer is written only when needed to stop a colon in the name being read as one.
  if (account.issuer !== '' || account.label.includes(':')) params.push(['issuer', account.issuer]);
  if (account.type !== 'steam') {
    params.push(['algorithm', account.algorithm], ['digits', String(account.digits)]);
    params.push(account.type === 'hotp' ? ['counter', String(account.counter)] : ['period', String(account.period)]);
  }
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `otpauth://${account.type}/${encodeURIComponent(label)}?${query}`;
}
