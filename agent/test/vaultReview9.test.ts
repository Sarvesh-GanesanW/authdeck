/**
 * Review 9, Q3: what a restore offers back is chosen by log order, never by the removed device's
 * clock. Every account delete by a removed device is marked (`restoreReview`), however old, and
 * of its edits only those among its last RESTORE_REVIEW_LINES account lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountDelete, buildAccountPut, newAccountId } from '../src/vault/build';
import { entryHash } from '../src/vault/entry';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase } from '../src/vault/recovery';
import { RESTORE_REVIEW_LINES } from '../src/vault/replay';
import { MULTI_DEVICE_VAULTS, vaultFeatures } from '../src/vault/features';
import { device, MemoryVault, seededRandom, soloRestoreLines, totpRecord } from './helpers/vault';

vaultFeatures.multiDevice = MULTI_DEVICE_VAULTS;
const random = seededRandom('review-9');
const DAY = 24 * 60 * 60 * 1000;

for (const clock of ['honest', 'moved on 31 days'] as const) {
  test(`Q3 (${clock}): every delete by the removed phone is marked, edits only among its last ${RESTORE_REVIEW_LINES} account lines`, () => {
    const phone = device(random);
    const v = MemoryVault.found(phone, random, 'solo');
    const phrase = generateRecoveryPhrase(random);
    const set = buildRecoverySetFromPhrase(v.state(), phone, { phrase, currentKey: v.key, random, time: v.now() });
    v.write(set.entry);
    v.key = set.newKey;
    const put = (account: string, time = v.now()) => v.write(buildAccountPut(v.state(), phone, { account, record: totpRecord(), currentKey: v.key, random, time }));
    const old = newAccountId(random);
    const edited = newAccountId(random);
    put(old);
    put(edited);
    const oldEdit = put(edited);
    const oldDelete = v.write(buildAccountDelete(v.state(), phone, { account: old, time: v.now() }));
    // Many later lines, with the phone's clock as the thief set it.
    const shift = clock === 'honest' ? 0 : 31 * DAY;
    for (let i = 0; i < RESTORE_REVIEW_LINES + 5; i++) put(newAccountId(random), v.now() + shift);
    const lastEdit = put(newAccountId(random), v.now() + shift);
    for (const entry of soloRestoreLines(v.vaultId, v.logs, phrase, device(random), random, v.now() + shift)) v.write(entry);
    const history = v.state().history;
    const flag = (hash: string) => history.find((h) => h.hash === hash)?.restoreReview === true;
    assert.equal(flag(entryHash(oldDelete)), true, 'an old delete is still offered');
    assert.equal(flag(entryHash(oldEdit)), false, 'an edit before the last lines is not');
    assert.equal(flag(entryHash(lastEdit)), true, 'a recent edit is');
  });
}
