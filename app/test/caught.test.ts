/**
 * Account changes caught in a symmetric conflict (two devices removed each other at once): listed
 * for review, never applied by themselves, re-applied only as new entries, and hidden once dismissed.
 * Secrets are never printed.
 */
import './native';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { listCaughtChanges, madeAfterRemoval, reapplyActions, type CaughtInput } from '../src/auth/engine/caught';
import { caughtDetail, initialCaughtSelection } from '../src/screens/vault/caughtReview';
import { loadHandledCaught, saveHandledCaught } from '../src/auth/engine/localCopy';
import { fromBase64Url } from '../src/vault/bytes';
import { afterOwnEntry, buildAccountDelete, buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, buildKeyRotate, newAccountId } from '../src/vault/build';
import { keyWords, type DeviceKeys } from '../src/vault/crypto';
import { entryHash } from '../src/vault/entry';
import { openVault } from '../src/vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, restoreWithPhrase } from '../src/vault/recovery';
import { replayVault, type VaultState } from '../src/vault/replay';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileSystemRoot = (require('expo-file-system') as { root: string }).root;

const random = seededRandom('caught-changes-tests');

function addDevice(vault: MemoryVault, who: DeviceKeys, name: string): void {
  vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: who, role: 'admin', name, currentKey: vault.key, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), who, vault.now()));
}

/**
 * The founder (Phone) and Tablet remove each other at once; before it saw the Phone's removal,
 * the Tablet added Bank and deleted GitHub. Both are out; those two changes are caught. With
 * `loner`, the Laptop (`third`) also removes it while it adds an account: a one-sided removal by
 * a device that stays, so that account change is rejected but not caught.
 */
function mutualRemoval(options: { phrase?: string; third?: DeviceKeys; loner?: DeviceKeys } = {}) {
  const vault = new MemoryVault(device(random), random);
  const key = () => openVault(vault.state(), vault.founder).currentKey;
  if (options.phrase) vault.write(buildRecoverySetFromPhrase(vault.state(), vault.founder, { phrase: options.phrase, currentKey: key(), random, time: vault.now() }).entry);
  const tablet = device(random);
  addDevice(vault, tablet, 'Tablet');
  if (options.third) addDevice(vault, options.third, 'Laptop');
  if (options.loner) addDevice(vault, options.loner, 'Old phone');
  const github = newAccountId(random);
  vault.write(buildAccountPut(vault.state(), vault.founder, { account: github, record: totpRecord({ issuer: 'GitHub' }), currentKey: key(), random, time: vault.now() }));
  const shared = vault.state();
  const sharedKey = key();
  vault.write(buildDeviceRemove(shared, vault.founder, { device: tablet.deviceId, currentKey: sharedKey, random, time: vault.now() }).entry);
  if (options.loner && options.third) {
    vault.write(buildDeviceRemove(shared, options.third, { device: options.loner.deviceId, currentKey: sharedKey, random, time: vault.now() }).entry);
    vault.write(buildAccountPut(shared, options.loner, { account: newAccountId(random), record: totpRecord({ issuer: 'Shop' }), currentKey: sharedKey, random, time: vault.now() }));
  }
  const bank = newAccountId(random);
  const put = buildAccountPut(shared, tablet, { account: bank, record: totpRecord({ issuer: 'Bank', label: 'ada' }), currentKey: sharedKey, random, time: vault.now() });
  const del = buildAccountDelete(afterOwnEntry(shared, put), tablet, { account: github, time: vault.now() });
  const counter = buildDeviceRemove(afterOwnEntry(afterOwnEntry(shared, put), del), tablet, { device: vault.founder.deviceId, currentKey: sharedKey, random, time: vault.now() });
  for (const entry of [put, del, counter.entry]) vault.write(entry);
  return { vault, tablet, github, bank, put, del };
}

function caughtInput(state: VaultState, logs: Record<string, string[]>, reader: DeviceKeys, handled: ReadonlySet<string> = new Set()): CaughtInput {
  const open = openVault(state, reader);
  return { state, logs, keys: open.keys, deviceNames: open.deviceNames, accounts: open.accounts, handled };
}

describe('caught changes', () => {
  it('lists only the caught account changes, with the author\'s name, key words and time', () => {
    const laptop = device(random);
    const { vault, tablet, put, del } = mutualRemoval({ third: laptop, loner: device(random) });
    const state = vault.state();
    assert.equal(state.members[vault.founder.deviceId]?.removed, true);
    assert.equal(state.members[tablet.deviceId]?.removed, true);
    const caughtHashes = state.history.filter((h) => h.caught).map((h) => h.hash).sort();
    assert.deepEqual(caughtHashes, [entryHash(put), entryHash(del)].sort());
    assert.ok(state.history.some((h) => h.kind === 'account.put' && h.status === 'rejected' && !h.caught), 'a one-sided removal\'s rejected change is not caught');
    const listed = listCaughtChanges(caughtInput(state, vault.logs, laptop));
    assert.deepEqual(listed.map((c) => c.view.id).sort(), caughtHashes);
    const words = keyWords(fromBase64Url(state.members[tablet.deviceId]!.ed)).join(' ');
    assert.deepEqual(
      listed.map((c) => [c.view.text, c.view.by, c.view.byKeyWords, c.view.time, c.view.canReapply]),
      [
        ['Delete GitHub (ada@example.com)', 'Tablet', words, del.time, true],
        ['Add Bank (ada)', 'Tablet', words, put.time, true],
      ],
    );
  });

  it('labels each one as made after its author was removed, under the author\'s name', () => {
    const laptop = device(random);
    const { vault } = mutualRemoval({ third: laptop });
    const listed = listCaughtChanges(caughtInput(vault.state(), vault.logs, laptop));
    assert.ok(listed.length > 0);
    for (const { view } of listed) assert.equal(view.madeAfter, 'made after Tablet was removed');
    assert.equal(madeAfterRemoval('Pixel 8'), 'made after Pixel 8 was removed');
    const { detail } = caughtDetail(listed[0]!.view, listed[0]!.view.time);
    assert.match(detail, /^Tablet \(key words: [a-z]+ [a-z]+ [a-z]+\), .+\nMade after Tablet was removed$/);
  });

  it('starts with nothing ticked, so no caught change is re-applied unless the person picks it', () => {
    const laptop = device(random);
    const { vault } = mutualRemoval({ third: laptop });
    const state = vault.state();
    const listed = listCaughtChanges(caughtInput(state, vault.logs, laptop));
    const chosen = initialCaughtSelection();
    assert.equal(chosen.size, 0);
    assert.deepEqual(reapplyActions(listed, chosen, openVault(state, laptop).accounts), []);
    assert.notEqual(initialCaughtSelection(), chosen, 'each review starts from its own empty selection');
  });

  it('never applies them by itself: listing changes nothing and the accounts stay as the rules left them', () => {
    const laptop = device(random);
    const { vault, github, bank } = mutualRemoval({ third: laptop });
    const before = vault.copy();
    const state = vault.state();
    listCaughtChanges(caughtInput(state, vault.logs, laptop));
    assert.deepEqual(vault.logs, before);
    const accounts = openVault(vault.state(), laptop).accounts;
    assert.equal(accounts[bank], undefined);
    assert.equal(accounts[github]?.record.issuer, 'GitHub');
  });

  it('re-applies only the chosen ones, as new entries by this device under the current key', () => {
    const laptop = device(random);
    const { vault, bank, put } = mutualRemoval({ third: laptop });
    let state = vault.state();
    const listed = listCaughtChanges(caughtInput(state, vault.logs, laptop));
    const actions = reapplyActions(listed, new Set([entryHash(put)]), openVault(state, laptop).accounts);
    assert.deepEqual(actions.map((a) => [a.kind, a.account]), [['account.put', bank]]);
    // The mutual removal left the vault needing a fresh key; the engine makes one first, as here.
    const fresh = buildKeyRotate(state, laptop, { currentKey: openVault(state, laptop).currentKey, random, time: vault.now() });
    vault.write(fresh.entry);
    state = vault.state();
    const action = actions[0]!;
    assert.equal(action.kind, 'account.put');
    if (action.kind !== 'account.put') return;
    const again = vault.write(buildAccountPut(state, laptop, { account: action.account, record: action.record, currentKey: fresh.newKey, random, time: vault.now() }));
    const after = vault.state();
    assert.notEqual(entryHash(again), entryHash(put));
    assert.equal(after.history.find((h) => h.hash === entryHash(again))?.status, 'applied');
    const reopened = openVault(after, laptop).accounts[bank];
    assert.equal(reopened?.record.issuer, 'Bank');
    assert.equal(reopened?.author, laptop.deviceId);
    assert.equal(after.history.find((h) => h.hash === entryHash(put))?.caught, true, 'the caught line stays where it is');
  });

  it('writes nothing for a delete whose account is already gone, and never moves an HOTP counter back', () => {
    const laptop = device(random);
    const { vault, del } = mutualRemoval({ third: laptop });
    const state = vault.state();
    const listed = listCaughtChanges(caughtInput(state, vault.logs, laptop));
    assert.deepEqual(reapplyActions(listed, new Set([entryHash(del)]), {}), []);
    const hotp = { view: { id: 'h', time: 1, text: '', by: '', madeAfter: '', canReapply: true }, action: { kind: 'account.put' as const, account: 'acct', record: totpRecord({ type: 'hotp', counter: 3 }) } };
    const current = { acct: { id: 'acct', record: totpRecord({ type: 'hotp', counter: 9 }), author: 'x', time: 0 } };
    const [written] = reapplyActions([hotp], new Set(['h']), current);
    assert.equal(written?.kind === 'account.put' ? written.record.counter : null, 9);
  });

  it('lists a put this device has no key for as unreadable, which can only be dismissed', () => {
    const laptop = device(random);
    const { vault, put } = mutualRemoval({ third: laptop });
    const state = vault.state();
    const listed = listCaughtChanges({ ...caughtInput(state, vault.logs, laptop), keys: {} });
    const unreadable = listed.find((c) => c.view.id === entryHash(put))!;
    assert.equal(unreadable.view.canReapply, false);
    assert.equal(unreadable.action, null);
    assert.match(unreadable.view.text, /no key to read it/);
  });

  it('hides handled ones, and keeps the handled list per vault with only hashes in it', async () => {
    const laptop = device(random);
    const { vault, put, del } = mutualRemoval({ third: laptop });
    const state = vault.state();
    await saveHandledCaught(vault.vaultId, new Set([entryHash(put), '__proto__']));
    const handled = await loadHandledCaught(vault.vaultId);
    assert.deepEqual([...handled], [entryHash(put)]);
    assert.deepEqual(listCaughtChanges(caughtInput(state, vault.logs, laptop, handled)).map((c) => c.view.id), [entryHash(del)]);
    // The stored file, written over by hand: only hashes come back, and a damaged one is none.
    const folder = path.join(fileSystemRoot, 'document', 'authdeck-vault-v1', vault.vaultId);
    const caughtFile = path.join(folder, fs.readdirSync(folder).find((name) => name.startsWith('caught.'))!);
    fs.writeFileSync(caughtFile, JSON.stringify(['constructor', entryHash(del), 7]));
    assert.deepEqual([...(await loadHandledCaught(vault.vaultId))], [entryHash(del)]);
    fs.writeFileSync(caughtFile, '{damaged');
    assert.equal((await loadHandledCaught(vault.vaultId)).size, 0);
    await assert.rejects(loadHandledCaught('__proto__'), /malformed/);
  });

  it('shows them on a device restored with the recovery phrase after both were removed', () => {
    const phrase = generateRecoveryPhrase(random);
    const { vault, bank } = mutualRemoval({ phrase });
    const state = vault.state();
    const newPhone = device(random);
    const restored = restoreWithPhrase(state, { phrase, device: newPhone, name: 'New phone', random, time: vault.now() });
    vault.write(restored.entry);
    vault.write(buildDeviceHello(vault.state(), newPhone, vault.now()));
    const after = replayVault(vault.vaultId, vault.logs);
    const listed = listCaughtChanges(caughtInput(after, vault.logs, newPhone));
    const bankChange = listed.find((c) => c.action?.kind === 'account.put');
    assert.equal(bankChange?.view.canReapply, true);
    assert.equal(bankChange?.action?.account, bank);
    assert.equal(bankChange?.view.text, 'Add Bank (ada)');
  });
});
