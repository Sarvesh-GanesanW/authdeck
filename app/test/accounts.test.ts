import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NewAccount } from '../src/auth/contract';
import { accountProblems, toAccountRecord } from '../src/auth/engine/accounts';

const manual: NewAccount = { issuer: 'GitHub', label: 'ada', secret: 'jbsw y3dp ehpk 3pxp', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30 };

describe('accounts', () => {
  it('accepts a key typed with spaces and lower case, and stores it canonically', () => {
    assert.deepEqual(accountProblems(manual), []);
    assert.equal(toAccountRecord(manual, 0).secret, 'JBSWY3DPEHPK3PXP');
  });

  it('explains a missing name, a short key and a mistyped character', () => {
    assert.match(accountProblems({ ...manual, issuer: '', label: ' ' })[0]!, /Give the account a name/);
    assert.match(accountProblems({ ...manual, secret: 'JBSWY3DP' })[0]!, /at least 16/);
    assert.match(accountProblems({ ...manual, secret: 'JBSWY3DPEHPK3PX0' })[0]!, /0, 1 or 8/);
    assert.match(accountProblems({ ...manual, digits: 9 })[0]!, /6 to 8 digits/);
  });

  it('fixes Steam accounts to five characters every 30 seconds', () => {
    const record = toAccountRecord({ ...manual, type: 'steam', digits: 6, period: 60 }, 3);
    assert.deepEqual([record.digits, record.period, record.position], [5, 30, 3]);
  });
});
