/**
 * Google Authenticator export (`otpauth-migration://offline?data=...`): base64 protobuf, split
 * across several QR codes for large exports. Read with a small bounds-checked protobuf reader
 * so the app needs no protobuf library.
 */

import { base32Encode } from './base32';
import { fromBase64, utf8Decode } from './bytes';
import { DEFAULT_DIGITS, DEFAULT_PERIOD, type OtpAlgorithm, type OtpType } from './otp';
import { parseUriQuery, type OtpAccount } from './otpauth';

export interface MigrationBatchInfo {
  /** Random per export; every QR code of one export shares it. */
  id: number;
  /** Zero-based position of this QR code in the export. */
  index: number;
  /** Number of QR codes in the export. */
  size: number;
}

export interface SkippedAccount {
  name: string;
  reason: string;
}

export interface MigrationBatch {
  batch: MigrationBatchInfo;
  accounts: OtpAccount[];
  skipped: SkippedAccount[];
}

export interface CombinedMigration {
  accounts: OtpAccount[];
  skipped: SkippedAccount[];
  /** Zero-based indices of QR codes of the export that were not scanned. */
  missingBatches: number[];
}

const MIGRATION_PATTERN = /^otpauth-migration:\/\/offline\?([^#]*)$/i;
const TRUNCATED = 'The export data is cut off or damaged. Scan the QR code again.';

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;
const MAX_VARINT_BYTES = 10;
const TWO_POW_32 = 0x1_0000_0000;
/** Largest high word of a 64-bit value that still fits a safe integer (2^53 - 1). */
const MAX_SAFE_HIGH_WORD = 0x1f_ffff;
/** Real exports hold ten accounts per code; this only stops a damaged size from driving a huge loop. */
const MAX_BATCH_SIZE = 1000;

const ALGORITHMS: Record<number, OtpAlgorithm | 'MD5'> = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
const DIGIT_COUNTS: Record<number, number> = { 0: DEFAULT_DIGITS, 1: 6, 2: 8 };
const OTP_TYPES: Record<number, OtpType> = { 0: 'totp', 1: 'hotp', 2: 'totp' };

/** A 64-bit varint as two unsigned 32-bit words. */
interface Varint {
  low: number;
  high: number;
}

/** Bounds-checked protobuf reader: every read fails loudly instead of running past the end. */
class ProtoReader {
  private position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get isDone(): boolean {
    return this.position >= this.bytes.length;
  }

  varint(): Varint {
    let low = 0;
    let high = 0;
    for (let i = 0; i < MAX_VARINT_BYTES; i++) {
      const byte = this.bytes[this.position++];
      if (byte === undefined) throw new Error(TRUNCATED);
      const payload = byte & 0x7f;
      const shift = 7 * i;
      if (shift < 32) {
        low = (low | (payload << shift)) >>> 0;
        if (shift + 7 > 32) high = (high | (payload >>> (32 - shift))) >>> 0;
      } else {
        high = (high | (payload << (shift - 32))) >>> 0;
      }
      if ((byte & 0x80) === 0) return { low, high };
    }
    throw new Error(TRUNCATED);
  }

  lengthDelimited(): Uint8Array {
    const { low: length, high } = this.varint();
    if (high !== 0 || length > this.bytes.length - this.position) throw new Error(TRUNCATED);
    const start = this.position;
    this.position += length;
    return this.bytes.subarray(start, this.position);
  }

  /** Reads a field key; field number 0 never occurs in valid data. */
  tag(): { field: number; wireType: number } {
    const { low, high } = this.varint();
    const field = low >>> 3;
    if (high !== 0 || field === 0) throw new Error(TRUNCATED);
    return { field, wireType: low & 7 };
  }

  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.advance(8);
        return;
      case WIRE_LENGTH_DELIMITED:
        this.lengthDelimited();
        return;
      case WIRE_FIXED32:
        this.advance(4);
        return;
      default:
        throw new Error(TRUNCATED);
    }
  }

  private advance(count: number): void {
    if (count > this.bytes.length - this.position) throw new Error(TRUNCATED);
    this.position += count;
  }
}

function int32(value: Varint): number {
  return value.low | 0;
}

function uint64(value: Varint): number {
  if (value.high > MAX_SAFE_HIGH_WORD) throw new Error('An HOTP counter in the export is too large to use.');
  return value.high * TWO_POW_32 + value.low;
}

/** Reads every field of a message, handing known ones to `onField` and skipping the rest. */
function readMessage(bytes: Uint8Array, onField: (field: number, wireType: number, reader: ProtoReader) => boolean): void {
  const reader = new ProtoReader(bytes);
  while (!reader.isDone) {
    const { field, wireType } = reader.tag();
    if (!onField(field, wireType, reader)) reader.skip(wireType);
  }
}

interface RawOtpParameters {
  secret: Uint8Array;
  name: string;
  issuer: string;
  algorithm: number;
  digits: number;
  type: number;
  counter: number;
}

function readOtpParameters(bytes: Uint8Array): RawOtpParameters {
  const raw: RawOtpParameters = { secret: new Uint8Array(0), name: '', issuer: '', algorithm: 0, digits: 0, type: 0, counter: 0 };
  readMessage(bytes, (field, wireType, reader) => {
    if (wireType === WIRE_LENGTH_DELIMITED) {
      if (field === 1) raw.secret = reader.lengthDelimited();
      else if (field === 2) raw.name = utf8Decode(reader.lengthDelimited(), 'An account name in the export');
      else if (field === 3) raw.issuer = utf8Decode(reader.lengthDelimited(), 'An issuer in the export');
      else return false;
      return true;
    }
    if (wireType === WIRE_VARINT) {
      if (field === 4) raw.algorithm = int32(reader.varint());
      else if (field === 5) raw.digits = int32(reader.varint());
      else if (field === 6) raw.type = int32(reader.varint());
      else if (field === 7) raw.counter = uint64(reader.varint());
      else return false;
      return true;
    }
    return false;
  });
  return raw;
}

function stripIssuerPrefix(name: string, issuer: string): string {
  const prefix = `${issuer}:`;
  return issuer !== '' && name.startsWith(prefix) ? name.slice(prefix.length).trim() : name.trim();
}

function displayName(issuer: string, label: string): string {
  if (issuer === '') return label;
  return label === '' ? issuer : `${issuer} (${label})`;
}

function toAccount(raw: RawOtpParameters): OtpAccount | SkippedAccount {
  const issuer = raw.issuer.trim();
  const label = stripIssuerPrefix(raw.name, issuer);
  const name = displayName(issuer, label);
  const algorithm = ALGORITHMS[raw.algorithm];
  const digits = DIGIT_COUNTS[raw.digits];
  const type = OTP_TYPES[raw.type];
  if (raw.secret.length === 0) return { name, reason: 'The export has no secret for this account.' };
  if (algorithm === 'MD5') return { name, reason: 'This account uses MD5, which AuthDeck does not support. Set it up again on the website.' };
  if (!algorithm) return { name, reason: 'This account uses an unknown algorithm. Set it up again on the website.' };
  if (!digits) return { name, reason: 'This account uses an unknown code length. Set it up again on the website.' };
  if (!type) return { name, reason: 'This account uses an unknown code type. Set it up again on the website.' };
  return {
    issuer,
    label,
    type,
    secret: base32Encode(raw.secret),
    algorithm,
    digits,
    period: DEFAULT_PERIOD,
    counter: type === 'hotp' ? raw.counter : 0,
  };
}

function isSkipped(entry: OtpAccount | SkippedAccount): entry is SkippedAccount {
  return 'reason' in entry;
}

function readPayload(payload: Uint8Array): MigrationBatch {
  const accounts: OtpAccount[] = [];
  const skipped: SkippedAccount[] = [];
  const batch: MigrationBatchInfo = { id: 0, index: 0, size: 1 };
  readMessage(payload, (field, wireType, reader) => {
    if (field === 1 && wireType === WIRE_LENGTH_DELIMITED) {
      const entry = toAccount(readOtpParameters(reader.lengthDelimited()));
      if (isSkipped(entry)) skipped.push(entry);
      else accounts.push(entry);
      return true;
    }
    if (wireType !== WIRE_VARINT) return false;
    if (field === 3) batch.size = int32(reader.varint());
    else if (field === 4) batch.index = int32(reader.varint());
    else if (field === 5) batch.id = int32(reader.varint());
    else return false;
    return true;
  });
  // Older single-code exports leave the batch fields unset.
  if (batch.size === 0) batch.size = 1;
  if (batch.size < 0 || batch.size > MAX_BATCH_SIZE || batch.index < 0 || batch.index >= batch.size) throw new Error(TRUNCATED);
  return { batch, accounts, skipped };
}

function extractData(uri: string): Uint8Array {
  const match = MIGRATION_PATTERN.exec(uri.trim());
  if (!match) throw new Error('This is not a Google Authenticator export. It should start with otpauth-migration://offline?data=.');
  const data = parseUriQuery(match[1] ?? '').get('data');
  if (data === undefined || data === '') throw new Error('This export link has no data. Scan the QR code again.');
  // Base64 never contains spaces, so a space here is a "+" that was not %-encoded.
  return fromBase64(data.replace(/ /g, '+'), 'The export data');
}

/** Reads one QR code of a Google Authenticator export. Unusable accounts are listed in `skipped`. */
export function parseMigrationUri(uri: string): MigrationBatch {
  return readPayload(extractData(uri));
}

/**
 * Joins the QR codes of one export in order. Repeated scans of the same code count once; codes
 * not scanned are listed in `missingBatches`. Throws when codes from different exports are mixed.
 */
export function combineMigrationBatches(batches: MigrationBatch[]): CombinedMigration {
  const first = batches[0];
  if (!first) return { accounts: [], skipped: [], missingBatches: [] };
  const byIndex = new Map<number, MigrationBatch>();
  for (const scanned of batches) {
    if (scanned.batch.id !== first.batch.id || scanned.batch.size !== first.batch.size) {
      throw new Error('These QR codes come from two different exports. Scan only the codes from one export, then try again.');
    }
    if (!byIndex.has(scanned.batch.index)) byIndex.set(scanned.batch.index, scanned);
  }
  const combined: CombinedMigration = { accounts: [], skipped: [], missingBatches: [] };
  for (let index = 0; index < first.batch.size; index++) {
    const scanned = byIndex.get(index);
    if (!scanned) {
      combined.missingBatches.push(index);
      continue;
    }
    combined.accounts.push(...scanned.accounts);
    combined.skipped.push(...scanned.skipped);
  }
  return combined;
}
