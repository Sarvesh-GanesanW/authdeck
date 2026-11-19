import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approverCheckCode,
  checkJoinedVault,
  createJoinChallenge,
  createJoinRequest,
  createJoinReveal,
  newDeviceCheckCode,
  readJoinRequest,
  revealMatchesCommit,
  type JoinChallenge,
  type JoinRequest,
} from '../src/vault/approval';
import { toBase64Url } from '../src/vault/bytes';
import { buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, newAccountId } from '../src/vault/build';
import type { DeviceKeys } from '../src/vault/crypto';
import { signEntry } from '../src/vault/entry';
import { openVault } from '../src/vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, recoveryKeysFromPhrase, restoreWithPhrase, unknownPhraseWords } from '../src/vault/recovery';
import { replayVault } from '../src/vault/replay';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers/vault';

const random = seededRandom('vault-approval-tests');

/** A whole honest exchange: N asks, A answers for its vault, N reveals. */
function exchange(newcomer: DeviceKeys, approver: DeviceKeys, vault: MemoryVault) {
  const { request, nonce: newcomerNonce } = createJoinRequest(newcomer, 'Tablet', random);
  const { challenge } = createJoinChallenge(approver, { vaultId: vault.vaultId, vaultName: 'Home', deviceName: 'Phone' }, random);
  const reveal = createJoinReveal(newcomerNonce);
  return { request, challenge, reveal, newcomerNonce };
}

function approve(vault: MemoryVault, approver: DeviceKeys, request: JoinRequest) {
  return vault.write(buildDeviceAdd(vault.state(), approver, { device: readJoinRequest(request), role: 'admin', name: request.name, currentKey: vault.key, random, time: vault.now() }));
}

describe('check-code approval', () => {
  it('both devices show the same code when nobody is in the middle, and the new device accepts the result', () => {
    const newcomer = device(random);
    const approver = device(random);
    const vault = MemoryVault.found(approver, random);
    const { request, challenge, reveal, newcomerNonce } = exchange(newcomer, approver, vault);
    assert.equal(readJoinRequest(request).deviceId, newcomer.deviceId);
    const onNewcomer = newDeviceCheckCode(request, newcomerNonce, challenge);
    const onApprover = approverCheckCode(request, challenge, reveal);
    assert.match(onNewcomer, /^\d{6}$/);
    assert.equal(onNewcomer, onApprover);

    assert.deepEqual(checkJoinedVault(vault.state(), newcomer, challenge), { status: 'not-yet' });
    approve(vault, approver, request);
    assert.equal(checkJoinedVault(vault.state(), newcomer, challenge).status, 'ok');
  });

  it('a relay that swaps in its own keys gets a different code on each side', () => {
    const newcomer = device(random);
    const approver = device(random);
    const relay = device(random);
    const vault = MemoryVault.found(approver, random);
    const { request: realRequest, challenge: realChallenge, newcomerNonce } = exchange(newcomer, approver, vault);
    // The relay forwards its own request to the approver and its own challenge to the newcomer.
    const { request: fakeRequest, nonce: relayNonce } = createJoinRequest(relay, 'Tablet', random);
    const { challenge: fakeChallenge } = createJoinChallenge(relay, { vaultId: vault.vaultId, vaultName: 'Home', deviceName: 'Phone' }, random);
    const onNewcomer = newDeviceCheckCode(realRequest, newcomerNonce, fakeChallenge);
    const onApprover = approverCheckCode(fakeRequest, realChallenge, createJoinReveal(relayNonce));
    assert.notEqual(onNewcomer, onApprover);
    assert.notEqual(readJoinRequest(fakeRequest).deviceId, readJoinRequest(realRequest).deviceId);
  });

  it('every field the code covers changes it: names, vault, approver keys', () => {
    const newcomer = device(random);
    const approver = device(random);
    const vault = MemoryVault.found(approver, random);
    const { request, challenge, newcomerNonce } = exchange(newcomer, approver, vault);
    const base = newDeviceCheckCode(request, newcomerNonce, challenge);
    const other = device(random);
    const changes: Partial<JoinChallenge>[] = [
      { vaultName: 'Work' },
      { name: 'Phone 2' },
      { vault: newAccountId(random) },
      { x: toBase64Url(other.xPublic) },
    ];
    for (const change of changes) assert.notEqual(newDeviceCheckCode(request, newcomerNonce, { ...challenge, ...change }), base, JSON.stringify(Object.keys(change)));
    assert.notEqual(newDeviceCheckCode({ ...request, name: 'Tablet 2' }, newcomerNonce, challenge), base);
  });

  it('refuses a reveal that does not match the commitment', () => {
    const newcomer = device(random);
    const approver = device(random);
    const vault = MemoryVault.found(approver, random);
    const { request, challenge } = exchange(newcomer, approver, vault);
    const forged = createJoinReveal(random(16));
    assert.equal(revealMatchesCommit(request, forged), false);
    assert.throws(() => approverCheckCode(request, challenge, forged), /different number than it committed to/);
    assert.equal(revealMatchesCommit(request, { nonce: 'not base64url!' }), false);
  });

  it('refuses malformed or unusable keys and uncleaned names in a request', () => {
    const { request } = createJoinRequest(device(random), 'Tablet', random);
    assert.throws(() => readJoinRequest({ ...request, ed: request.ed.slice(0, 20) }), /wrong length/);
    assert.throws(() => readJoinRequest({ ...request, x: toBase64Url(new Uint8Array(32)) }), /can't be used/);
    assert.throws(() => readJoinRequest({ ...request, name: ' Tablet\n' }), /not cleaned/);
  });
});

describe('recovery phrase', () => {
  it('makes 12 valid words that give one recovery identity per vault', () => {
    const phrase = generateRecoveryPhrase(random);
    assert.equal(phrase.split(' ').length, 12);
    const vaultId = newAccountId(random);
    const keys = recoveryKeysFromPhrase(phrase, vaultId);
    assert.equal(recoveryKeysFromPhrase(`  ${phrase.toUpperCase()}  `, vaultId).deviceId, keys.deviceId);
    assert.notEqual(recoveryKeysFromPhrase(generateRecoveryPhrase(random), vaultId).deviceId, keys.deviceId);
    assert.notEqual(recoveryKeysFromPhrase(phrase, newAccountId(random)).deviceId, keys.deviceId, 'a phrase reused for another vault is unrelated there');
  });

  it('refuses a phrase with a bad checksum or unknown words', () => {
    const words = generateRecoveryPhrase(random).split(' ');
    const swapped = [...words.slice(0, 11), words[11] === 'abandon' ? 'ability' : 'abandon'].join(' ');
    assert.throws(() => recoveryKeysFromPhrase(swapped, newAccountId(random)), /not a valid recovery phrase/);
    assert.deepEqual(unknownPhraseWords('abandon zzzz ability'), ['zzzz']);
  });

  it('round trip: found, add a device, remove a device, restore on a fresh device', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const phrase = generateRecoveryPhrase(random);
    const set = buildRecoverySetFromPhrase(vault.state(), founder, { phrase, currentKey: vault.key, random, time: vault.now() });
    vault.write(set.entry);
    vault.key = set.newKey;
    const account = newAccountId(random);
    vault.write(buildAccountPut(vault.state(), founder, { account, record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));

    const tablet = device(random);
    vault.write(buildDeviceAdd(vault.state(), founder, { device: tablet, role: 'admin', name: 'Tablet', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), tablet, vault.now()));
    const removal = buildDeviceRemove(vault.state(), founder, { device: tablet.deviceId, currentKey: vault.key, random, time: vault.now() });
    vault.write(removal.entry);
    vault.key = removal.newKey;
    const late = newAccountId(random);
    vault.write(buildAccountPut(vault.state(), founder, { account: late, record: totpRecord({ issuer: 'Bank' }), currentKey: vault.key, random, time: vault.now() }));

    // Every device is lost; a fresh phone has only the phrase and a copy of the folder.
    const fresh = device(random);
    const folder = vault.snapshot();
    const { entry, key } = restoreWithPhrase(replayVault(vault.vaultId, folder), { phrase, device: fresh, name: 'New phone', random, time: vault.now() });
    assert.deepEqual(key, vault.key);
    vault.write(entry);
    vault.write(buildDeviceHello(vault.state(), fresh, vault.now()));
    const state = vault.state();
    assert.deepEqual(state.rejected, []);
    assert.equal(state.members[fresh.deviceId]?.addedBy, recoveryKeysFromPhrase(phrase, vault.vaultId).deviceId);
    const open = openVault(state, fresh);
    assert.equal(open.accounts[account]?.record.issuer, 'GitHub');
    assert.equal(open.accounts[late]?.record.issuer, 'Bank');
    assert.equal(open.deviceNames[fresh.deviceId], 'New phone');
    assert.equal(open.deviceNames[tablet.deviceId], 'Tablet');
  });

  it('an old phrase stops working once a new one is set, even for a device.add signed while it was current', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const oldPhrase = generateRecoveryPhrase(random);
    const first = buildRecoverySetFromPhrase(vault.state(), founder, { phrase: oldPhrase, currentKey: vault.key, random, time: vault.now() });
    vault.write(first.entry);
    vault.key = first.newKey;
    const stale = vault.state();
    const second = buildRecoverySetFromPhrase(vault.state(), founder, { phrase: generateRecoveryPhrase(random), currentKey: vault.key, random, time: vault.now() });
    vault.write(second.entry);
    vault.key = second.newKey;
    assert.throws(() => restoreWithPhrase(vault.state(), { phrase: oldPhrase, device: device(random), name: 'X', random, time: vault.now() }), /not the current recovery phrase/);
    const { entry } = restoreWithPhrase(stale, { phrase: oldPhrase, device: device(random), name: 'X', random, time: 0 });
    vault.write(entry);
    assert.match(vault.state().rejected.map((r) => r.reason).join(), /removed or replaced/);
  });

  it('a removal that leaves the recovery identity out applies, and the vault needs a fresh key', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const tablet = device(random);
    vault.write(buildDeviceAdd(vault.state(), founder, { device: tablet, role: 'admin', name: 'Tablet', currentKey: vault.key, random, time: vault.now() }));
    const beforeRecovery = vault.state();
    const set = buildRecoverySetFromPhrase(vault.state(), founder, { phrase: generateRecoveryPhrase(random), currentKey: vault.key, random, time: vault.now() });
    vault.write(set.entry);
    vault.key = set.newKey;
    // Built from a view without the recovery key: it seals only to devices. Re-chained after the recovery.set.
    const removal = buildDeviceRemove({ ...beforeRecovery, epoch: 1 }, founder, { device: tablet.deviceId, currentKey: vault.key, random, time: vault.now() });
    const { sig: _sig, ...unsigned } = removal.entry;
    const state = vault.state();
    const head = state.heads[founder.deviceId]!;
    vault.write(signEntry({ ...unsigned, seq: head.seq + 1, prev: head.hash }, founder));
    // A removal always applies, but its key can't be the vault's: the vault needs a fresh one.
    const after = vault.state();
    assert.equal(after.members[tablet.deviceId]?.removed, true);
    assert.equal(after.needsFreshKey, true);
    assert.equal(after.epoch, 2);
  });
});
