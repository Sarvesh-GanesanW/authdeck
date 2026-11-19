/** Round 8, P2: nothing the computer sends can make the vault prefs too large to load again. */
import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_PREFS, loadPrefs, MAX_PREFS_CHARS, savePendingRestore, savePrefs } from '../src/auth/engine/localCopy';
import { MAX_LINE_BYTES, type PendingRestore } from '../src/auth/engine/sync';
import { isMethodResult, LIMITS } from '../src/net/messages';

const PREFS_KEY = 'authdeck-vault-prefs-v2';
const ID = 'A'.repeat(22);
const OTHER_ID = 'B'.repeat(22);
const summary = (path: string) => ({ vaultId: ID, path, kind: 'solo', location: 'personal', lengths: {} });

describe('vault prefs stay small enough to load (P2)', () => {
  it('vault.list is refused when a vault path is longer than any folder path', () => {
    assert.equal(isMethodResult('vault.list', { vaults: [summary('/Users/me/vault')], teamFolder: null }), true);
    assert.equal(isMethodResult('vault.list', { vaults: [summary('x'.repeat(LIMITS.fsPath))], teamFolder: null }), true);
    assert.equal(isMethodResult('vault.list', { vaults: [summary(`/Users/me/${'x'.repeat(2_500_000)}`)], teamFolder: null }), false);
  });

  it('refuses to save a folder path over the cap, and writes nothing', async () => {
    await AsyncStorage.removeItem(PREFS_KEY);
    await assert.rejects(savePrefs({ ...DEFAULT_PREFS, vaultId: ID, folderPath: 'x'.repeat(LIMITS.fsPath + 1) }), /did not save the vault settings/);
    assert.equal(await AsyncStorage.getItem(PREFS_KEY), null);
    await savePrefs({ ...DEFAULT_PREFS, vaultId: ID, folderPath: 'x'.repeat(LIMITS.fsPath) });
    assert.equal((await loadPrefs()).folderPath?.length, LIMITS.fsPath);
  });

  it('refuses any malformed setting before writing', async () => {
    await assert.rejects(savePrefs({ ...DEFAULT_PREFS, vaultId: '__proto__' }), /vaultId/);
    await assert.rejects(savePrefs({ ...DEFAULT_PREFS, autoLockMs: -1 }), /autoLockMs/);
  });

  it('keeps the whole prefs value under the cap, far below what Android can read back', async () => {
    const worst = JSON.stringify({ ...DEFAULT_PREFS, vaultId: ID, deviceId: OTHER_ID, recoverySavedAt: Number.MAX_SAFE_INTEGER, location: 'personal', folderPath: '\u0000'.repeat(LIMITS.fsPath) });
    assert.ok(worst.length <= MAX_PREFS_CHARS, `a path of control characters escapes to ${worst.length} characters`);
    assert.ok(MAX_PREFS_CHARS * 3 < 2 * 1024 * 1024);
  });

  it('forgets an oversized path saved before the cap instead of calling the prefs damaged', async () => {
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify({ vaultId: ID, deviceId: OTHER_ID, folderPath: 'x'.repeat(LIMITS.fsPath + 1) }));
    const prefs = await loadPrefs();
    assert.equal(prefs.vaultId, ID);
    assert.equal(prefs.folderPath, null);
  });

  it('refuses a pending restore with a line longer than any vault line, and writes nothing', async () => {
    const pending: PendingRestore = { recoveryId: OTHER_ID, deviceId: ID, seq: 0, lines: ['x'.repeat(MAX_LINE_BYTES + 1)], superseded: false };
    await assert.rejects(savePendingRestore(ID, pending), /did not save the restore/);
    assert.equal(await AsyncStorage.getItem(`authdeck-vault-restore-v1:${ID}:${OTHER_ID}`), null);
    await assert.rejects(savePendingRestore(ID, { ...pending, lines: ['a', 'b', 'c', 'd'] }), /did not save the restore/);
  });
});
