import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanQr } from '../src/auth/engine/importer';
import { migrationUri } from './helpers';

const github = { secret: 'hello-github-0001', name: 'GitHub:octocat', issuer: 'GitHub', algorithm: 1 };
const bank = { secret: 'bank-secret-0002', name: 'alice', issuer: 'Bank', algorithm: 1 };
const legacy = { secret: 'md5-secret-00003', name: 'Old:legacy', issuer: 'Old', algorithm: 4 };

describe('scanQr', () => {
  it('reads an otpauth link', () => {
    const { preview } = scanQr('otpauth://totp/GitHub:ada?secret=jbswy3dpehpk3pxp&issuer=GitHub', []);
    assert.deepEqual(preview.problems, []);
    assert.equal(preview.accounts[0]!.issuer, 'GitHub');
    assert.equal(preview.accounts[0]!.secret, 'JBSWY3DPEHPK3PXP');
  });

  it('explains a QR code that is not a setup code, and never throws', () => {
    assert.match(scanQr('https://example.com', []).preview.problems[0]!, /isn't a 2FA setup code/);
    assert.equal(scanQr('otpauth://totp/x', []).preview.accounts.length, 0);
    assert.equal(scanQr('otpauth-migration://offline?data=%%%', []).preview.accounts.length, 0);
  });

  it('combines the codes of one export across scans, counting repeats once', () => {
    const first = scanQr(migrationUri([github], { id: 9, index: 0, size: 2 }), []);
    assert.deepEqual(first.preview.batches, { scanned: 1, total: 2 });
    const again = scanQr(migrationUri([github], { id: 9, index: 0, size: 2 }), first.batches);
    assert.deepEqual(again.preview.batches, { scanned: 1, total: 2 });
    const both = scanQr(migrationUri([bank, legacy], { id: 9, index: 1, size: 2 }), again.batches);
    assert.deepEqual(both.preview.batches, { scanned: 2, total: 2 });
    assert.deepEqual(both.preview.accounts.map((a) => a.issuer), ['GitHub', 'Bank']);
    assert.equal(both.preview.problems.length, 1);
    assert.match(both.preview.problems[0]!, /^Old \(legacy\): .*MD5/);
  });

  it('starts over when a code from another export is scanned', () => {
    const first = scanQr(migrationUri([github], { id: 1, index: 0, size: 2 }), []);
    const other = scanQr(migrationUri([bank], { id: 2, index: 0, size: 1 }), first.batches);
    assert.deepEqual(other.preview.accounts.map((a) => a.issuer), ['Bank']);
    assert.equal(other.preview.batches, undefined);
  });
});
