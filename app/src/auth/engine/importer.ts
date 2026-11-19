/**
 * Reading setup QR codes: single otpauth:// links, and Google Authenticator exports that span
 * several QR codes. Pure: the caller keeps the scanned batches between scans.
 */
import type { ImportPreview } from '../contract';
import { combineMigrationBatches, parseMigrationUri, type MigrationBatch } from '../../vault/migration';
import { parseOtpAuthUri } from '../../vault/otpauth';
import { fromOtpAccount, sentence } from './accounts';

const NOT_A_SETUP_CODE = "That QR code isn't a 2FA setup code. Look for the QR code on the site's two-factor setup page.";

export interface ScanResult {
  preview: ImportPreview;
  /** Export batches scanned so far; pass them to the next scan. */
  batches: MigrationBatch[];
}

function readMigration(text: string, previous: MigrationBatch[]): ScanResult {
  let batch: MigrationBatch;
  try {
    batch = parseMigrationUri(text);
  } catch (err) {
    return { preview: { accounts: [], problems: [sentence((err as Error).message)] }, batches: previous };
  }
  // A code from a different export starts over: people rescan after a failed import.
  const sameExport = previous.filter((b) => b.batch.id === batch.batch.id && b.batch.size === batch.batch.size);
  const batches = [...sameExport, batch];
  const combined = combineMigrationBatches(batches);
  const problems = combined.skipped.map((s) => `${s.name || 'An account'}: ${sentence(s.reason)}`);
  const total = batch.batch.size;
  const preview: ImportPreview = { accounts: combined.accounts.map(fromOtpAccount), problems };
  if (total > 1) preview.batches = { scanned: total - combined.missingBatches.length, total };
  return { preview, batches };
}

/** Parses one scanned QR text. Never throws; problems come back as plain sentences. */
export function scanQr(text: string, previous: MigrationBatch[]): ScanResult {
  const trimmed = text.trim();
  if (/^otpauth-migration:/i.test(trimmed)) return readMigration(trimmed, previous);
  if (!/^otpauth:/i.test(trimmed)) return { preview: { accounts: [], problems: [NOT_A_SETUP_CODE] }, batches: previous };
  try {
    return { preview: { accounts: [fromOtpAccount(parseOtpAuthUri(trimmed))], problems: [] }, batches: previous };
  } catch (err) {
    return { preview: { accounts: [], problems: [sentence((err as Error).message)] }, batches: previous };
  }
}
