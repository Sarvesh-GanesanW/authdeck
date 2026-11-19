import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildHistory } from '../src/auth/engine/history';
import { rollbackSentence, reasonSentence } from '../src/auth/engine/sentences';
import { buildAccountDelete, buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, buildKeyRotate, newAccountId } from '../src/vault/build';
import { fromBase64Url } from '../src/vault/bytes';
import { keyWords } from '../src/vault/crypto';
import { openVault } from '../src/vault/open';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers';

const random = seededRandom('history-tests');

function history(vault: MemoryVault, folderRejections = [] as Parameters<typeof buildHistory>[0]['folderRejections']) {
  const state = vault.state();
  const open = openVault(state, vault.founder);
  return buildHistory({ state, keys: open.keys, deviceNames: open.deviceNames, folderRejections, unreadable: open.rejected, readAt: 9_000_000 });
}

describe('buildHistory', () => {
  it('writes each change as a plain sentence, newest first', () => {
    const vault = new MemoryVault(device(random), random);
    const tablet = device(random);
    const put = (account: string, record = totpRecord()) => vault.write(buildAccountPut(vault.state(), vault.founder, { account, record, currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: tablet, role: 'admin', name: 'Pixel 8', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), tablet, vault.now()));
    const github = newAccountId(random);
    put(github);
    put(github, totpRecord({ issuer: 'GitHub Enterprise' }));
    const hotp = newAccountId(random);
    put(hotp, totpRecord({ issuer: 'VPN', type: 'hotp', counter: 1 }));
    put(hotp, totpRecord({ issuer: 'VPN', type: 'hotp', counter: 2 }));
    vault.write(buildAccountDelete(vault.state(), vault.founder, { account: github, time: vault.now() }));
    assert.deepEqual(
      history(vault).map((h) => [h.text, h.by, h.status]),
      [
        ['Deleted GitHub Enterprise', 'Phone', 'applied'],
        ['Used a code for VPN', 'Phone', 'applied'],
        ['Added VPN', 'Phone', 'applied'],
        ['Renamed GitHub to GitHub Enterprise', 'Phone', 'applied'],
        ['Added GitHub', 'Phone', 'applied'],
        ['Pixel 8 joined', 'Pixel 8', 'applied'],
        ['Trusted Pixel 8', 'Phone', 'applied'],
        ['Created the vault', 'Phone', 'applied'],
      ],
    );
  });

  it('marks a change by a removed device as rejected, with the reason in words', () => {
    const vault = new MemoryVault(device(random), random);
    const tablet = device(random);
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: tablet, role: 'admin', name: 'Tablet', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), tablet, vault.now()));
    const before = vault.state();
    vault.write(buildDeviceRemove(vault.state(), vault.founder, { device: tablet.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    vault.write(buildAccountPut(before, tablet, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
    const rejected = history(vault).find((h) => h.status === 'rejected');
    assert.equal(rejected?.text, 'Changed an account');
    assert.equal(rejected?.by, 'Tablet');
    assert.match(rejected!.reason!, /already been removed/);
  });

  it('lists a file no device vouches for as an unsigned change', () => {
    const vault = new MemoryVault(device(random), random);
    const items = history(vault, [{ deviceId: 'stranger', seq: 0, reason: 'no applied entry introduces this device, so its 1 entry is ignored' }]);
    assert.deepEqual(items[0], { id: 'folder:stranger:0', time: 9_000_000, text: 'Unsigned change', by: 'Unknown device', status: 'rejected', reason: 'None of your devices signed it, so it was ignored and nothing changed.' });
  });
});

describe('history bylines', () => {
  it('shows the signing key\'s words and flags a name two devices use (N9)', () => {
    const vault = new MemoryVault(device(random), random);
    const copycat = device(random);
    // A member names itself after the founder ("Phone").
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: copycat, role: 'admin', name: 'Phone', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), copycat, vault.now()));
    vault.write(buildAccountPut(vault.state(), copycat, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
    const [latest] = history(vault);
    const state = vault.state();
    assert.equal(latest?.by, 'Phone');
    assert.equal(latest?.byKeyWords, keyWords(fromBase64Url(state.members[copycat.deviceId]!.ed)).join(' '));
    assert.notEqual(latest?.byKeyWords, keyWords(vault.founder.edPublic).join(' '));
    assert.equal(latest?.byNameShared, 2);
  });

  it('leaves the flag off when a name is used once, and calls a fresh key what it is', () => {
    const vault = new MemoryVault(device(random), random);
    vault.write(buildKeyRotate(vault.state(), vault.founder, { currentKey: vault.key, random, time: vault.now() }).entry);
    const [latest] = history(vault);
    assert.equal(latest?.text, 'Made a fresh vault key');
    assert.equal(latest?.byNameShared, undefined);
    assert.equal(latest?.byKeyWords, keyWords(vault.founder.edPublic).join(' '));
  });
});

describe('sentences', () => {
  it('turns an unknown core reason into a sentence', () => {
    assert.equal(reasonSentence('something odd'), "It broke the vault's rules: Something odd.");
  });

  it('names the devices whose history went back', () => {
    const text = rollbackSentence(
      [
        { deviceId: 'a', kind: 'rolled-back', remembered: { seq: 3, hash: 'h' }, found: { seq: 1, hash: 'g' } },
        { deviceId: 'b', kind: 'changed', remembered: { seq: 1, hash: 'h' }, found: { seq: 1, hash: 'x' } },
      ],
      (id) => (id === 'a' ? 'Pixel 8' : 'iPad'),
      'MacBook',
    );
    assert.match(text!, /^The vault folder on MacBook went back in time: changes from Pixel 8 and iPad were replaced/);
    assert.equal(rollbackSentence([], () => '', null), null);
  });
});
