import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromBase64Url, toBase64Url } from '../src/vault/bytes';
import { canonicalJson } from '../src/vault/canonical';
import {
  buildAccountDelete,
  buildAccountPut,
  buildDeviceAdd,
  buildDeviceHello,
  buildDeviceRemove,
  buildDeviceRename,
  buildKeyRotate,
  newAccountId,
} from '../src/vault/build';
import { deviceIdFor, keyWords, type DeviceKeys } from '../src/vault/crypto';
import { entryHash, signEntry } from '../src/vault/entry';
import type { JsonValue } from '../src/vault/canonical';
import { openVault, sealAccountRecord } from '../src/vault/open';
import { replayVault, type VaultState } from '../src/vault/replay';
import { checkRollback, repairLines } from '../src/vault/rollback';
import { planAppend } from '../src/vault/logs';
import { MemoryVault, device, seededRandom, shuffled, totpRecord } from './helpers/vault';

const random = seededRandom('vault-log-tests');

/** A founder plus a second approved device. */
function twoDeviceVault(kind: 'personal' | 'team' = 'personal', role: 'admin' | 'member' = 'admin') {
  const founder = device(random);
  const vault = MemoryVault.found(founder, random, kind);
  const second = device(random);
  vault.write(buildDeviceAdd(vault.state(), founder, { device: second, role, name: 'Tablet', currentKey: vault.key, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), second, vault.now()));
  return { founder, second, vault };
}

function addAccount(vault: MemoryVault, author: DeviceKeys, record = totpRecord(), state: VaultState = vault.state()): string {
  const account = newAccountId(random);
  vault.write(buildAccountPut(state, author, { account, record, currentKey: vault.key, random, time: vault.now() }));
  return account;
}

/** Rewrites one line of a device's log through a JSON edit, keeping everything else. */
function editLine(vault: MemoryVault, deviceId: string, seq: number, edit: (entry: Record<string, unknown>) => void): void {
  const entry = JSON.parse(vault.logs[deviceId]![seq]!) as Record<string, unknown>;
  edit(entry);
  vault.logs[deviceId]![seq] = JSON.stringify(entry);
}

function flipChar(text: string, index: number): string {
  const replacement = text[index] === 'A' ? 'B' : 'A';
  return text.slice(0, index) + replacement + text.slice(index + 1);
}

function reasons(state: VaultState): string[] {
  return state.rejected.map((r) => r.reason);
}

describe('ids and key words', () => {
  it('derives a 16-byte device id and three stable BIP-39 words from the signing key', () => {
    const keys = device(random);
    assert.equal(fromBase64Url(keys.deviceId).length, 16);
    assert.equal(deviceIdFor(keys.edPublic), keys.deviceId);
    const words = keyWords(keys.edPublic);
    assert.equal(words.length, 3);
    assert.deepEqual(keyWords(keys.edPublic), words);
    assert.notDeepEqual(keyWords(device(random).edPublic), words);
  });
});

describe('canonical JSON', () => {
  it('sorts keys, drops whitespace, escapes everything outside printable ASCII and refuses floats', () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, 'é'] }), '{"a":[true,null,"\\u00e9"],"b":1}');
    // A lone surrogate is written the same way by every engine, and reads back unchanged.
    assert.equal(canonicalJson('\ud800"\\'), '"\\ud800\\"\\\\"');
    assert.equal(JSON.parse(canonicalJson('a\ud800😀\n')), 'a\ud800😀\n');
    assert.throws(() => canonicalJson({ a: 1.5 }), /safe integers/);
    assert.throws(() => canonicalJson({ a: 2 ** 60 }), /safe integers/);
    assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
  });

  it('round-trips bytes as unpadded base64url and refuses padded or non-canonical text', () => {
    const bytes = Uint8Array.from([251, 255, 0, 1]);
    assert.equal(toBase64Url(bytes), '-_8AAQ');
    assert.deepEqual(fromBase64Url('-_8AAQ'), bytes);
    assert.throws(() => fromBase64Url('-_8AAQ=='));
    assert.throws(() => fromBase64Url('-_8AAR'), /canonical/);
  });
});

describe('vault life cycle', () => {
  it('a founder creates a vault that it alone can open', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const state = vault.state();
    assert.equal(state.created, true);
    assert.equal(state.founder, founder.deviceId);
    assert.equal(state.members[founder.deviceId]?.role, 'admin');
    const open = openVault(state, founder);
    assert.equal(open.name, 'Home');
    assert.equal(open.deviceNames[founder.deviceId], 'Phone');
    assert.throws(() => openVault(state, device(random)), /holds no key/);
  });

  it('an approved device reads accounts written before it joined', () => {
    const founder = device(random);
    const vault = MemoryVault.found(founder, random);
    const account = addAccount(vault, founder);
    const tablet = device(random);
    vault.write(buildDeviceAdd(vault.state(), founder, { device: tablet, role: 'admin', name: 'Tablet', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), tablet, vault.now()));
    const state = vault.state();
    assert.deepEqual(state.rejected, []);
    const open = openVault(state, tablet);
    assert.equal(open.accounts[account]?.record.issuer, 'GitHub');
    assert.equal(open.deviceNames[tablet.deviceId], 'Tablet');
  });

  it('applies renames and deletes', () => {
    const { founder, second, vault } = twoDeviceVault();
    const account = addAccount(vault, second);
    vault.write(buildDeviceRename(vault.state(), second, { device: second.deviceId, name: 'Kitchen tablet', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildAccountDelete(vault.state(), founder, { account, time: vault.now() }));
    const state = vault.state();
    assert.deepEqual(state.rejected, []);
    const open = openVault(state, founder);
    assert.equal(open.deviceNames[second.deviceId], 'Kitchen tablet');
    assert.equal(open.accounts[account], undefined);
  });

  it('rejects deleting an account that does not exist', () => {
    const { founder, vault } = twoDeviceVault();
    vault.write(buildAccountDelete(vault.state(), founder, { account: newAccountId(random), time: vault.now() }));
    assert.match(reasons(vault.state()).join(), /no such account/);
  });
});

describe('tampering with the folder', () => {
  it('a flipped byte in a body breaks the chain from that entry on', () => {
    const { founder, vault } = twoDeviceVault();
    addAccount(vault, founder);
    addAccount(vault, founder);
    editLine(vault, founder.deviceId, 2, (entry) => {
      const body = entry.body as { account: string };
      body.account = flipChar(body.account, 3);
    });
    const state = vault.state();
    assert.equal(state.chains[founder.deviceId]?.length, 2);
    assert.match(reasons(state).join(), /signature is not valid \(and the 1 entry after it\)/);
    assert.equal(Object.keys(state.accounts).length, 0);
  });

  it('a flipped byte in a signature is caught', () => {
    const { founder, vault } = twoDeviceVault();
    addAccount(vault, founder);
    editLine(vault, founder.deviceId, 2, (entry) => {
      entry.sig = flipChar(entry.sig as string, 10);
    });
    assert.match(reasons(vault.state()).join(), /signature is not valid/);
  });

  it('a changed prev is caught', () => {
    const { founder, vault } = twoDeviceVault();
    addAccount(vault, founder);
    editLine(vault, founder.deviceId, 2, (entry) => {
      entry.prev = flipChar(entry.prev as string, 5);
    });
    assert.match(reasons(vault.state()).join(), /prev does not match/);
  });

  it('a reordered or removed middle entry is caught', () => {
    const { founder, vault } = twoDeviceVault();
    addAccount(vault, founder);
    addAccount(vault, founder);
    const original = [...vault.logs[founder.deviceId]!];
    vault.logs[founder.deviceId] = [original[0]!, original[2]!, original[1]!, original[3]!];
    assert.match(reasons(vault.state()).join(), /expected seq 1 but found 2/);
    vault.logs[founder.deviceId] = [original[0]!, original[1]!, original[3]!];
    assert.match(reasons(vault.state()).join(), /expected seq 2 but found 3/);
  });

  it('a truncated log passes the chain checks but fails the rollback check', () => {
    const { founder, second, vault } = twoDeviceVault();
    addAccount(vault, founder);
    addAccount(vault, founder);
    const remembered = vault.state().heads;
    const full = vault.snapshot();
    vault.logs[founder.deviceId] = vault.logs[founder.deviceId]!.slice(0, 2);
    const truncated = vault.state();
    assert.deepEqual(truncated.rejected, []);
    const check = checkRollback(remembered, truncated);
    assert.deepEqual(check.problems.map((p) => [p.deviceId, p.kind]), [[founder.deviceId, 'rolled-back']]);
    assert.deepEqual(check.heads[founder.deviceId], remembered[founder.deviceId]);
    assert.deepEqual(check.heads[second.deviceId], remembered[second.deviceId]);
    const repair = repairLines(full, replayVault(vault.vaultId, full), truncated);
    assert.deepEqual(Object.keys(repair), [founder.deviceId]);
    assert.equal(repair[founder.deviceId]?.from, 2);
    const repaired = planAppend(vault.vaultId, vault.logs, repair[founder.deviceId]!.lines.map((line) => JSON.parse(line)));
    assert.deepEqual(repaired.logs[founder.deviceId], full[founder.deviceId]);
  });

  it('a changed entry at a remembered seq fails the rollback check', () => {
    const { founder, vault } = twoDeviceVault();
    addAccount(vault, founder);
    const remembered = vault.state().heads;
    vault.logs[founder.deviceId]!.pop();
    addAccount(vault, founder);
    const check = checkRollback(remembered, vault.state());
    assert.deepEqual(check.problems.map((p) => p.kind), ['changed']);
  });

  it('ignores a log from a device nobody added', () => {
    const { vault } = twoDeviceVault();
    const stranger = device(random);
    const state = vault.state();
    vault.write(buildAccountPut(state, stranger, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
    const after = vault.state();
    assert.match(reasons(after).join(), /no applied entry introduces this device/);
    assert.equal(Object.keys(after.accounts).length, 0);
    assert.equal(after.heads[stranger.deviceId], undefined);
  });

  it('a stranger cannot found the vault again under its own key', () => {
    const { vault } = twoDeviceVault();
    const stranger = device(random);
    const fake = MemoryVault.found(stranger, random);
    const createLine = JSON.parse(fake.logs[stranger.deviceId]![0]!) as Record<string, unknown>;
    createLine.vault = vault.vaultId;
    vault.logs[stranger.deviceId] = [JSON.stringify(createLine)];
    assert.match(reasons(vault.state()).join(), /no applied entry introduces/);
  });

  it('refuses an entry copied from another vault, even by the same device', () => {
    const founder = device(random);
    const home = MemoryVault.found(founder, random);
    const work = MemoryVault.found(founder, random);
    addAccount(work, founder);
    home.logs[founder.deviceId]!.push(work.logs[founder.deviceId]![1]!);
    assert.match(reasons(home.state()).join(), /belongs to another vault/);
  });

  it('refuses another vault\'s ciphertext re-signed into this vault, because the AAD names the vault', () => {
    const founder = device(random);
    const home = MemoryVault.found(founder, random);
    const work = MemoryVault.found(founder, random);
    const account = newAccountId(random);
    // Worst case: the same key in both vaults, so only the AAD tells the boxes apart.
    const foreignBox = sealAccountRecord({ vault: work.vaultId, epoch: 0, author: founder.deviceId }, home.key, account, totpRecord(), random);
    const genuine = buildAccountPut(home.state(), founder, { account, record: totpRecord(), currentKey: home.key, random, time: home.now() });
    const { sig: _sig, ...unsigned } = genuine;
    home.write(signEntry({ ...unsigned, body: { account, box: foreignBox as unknown as JsonValue } }, founder));
    const state = home.state();
    assert.deepEqual(state.rejected, [], 'the rules cannot look inside the box');
    const open = openVault(state, founder);
    assert.equal(open.accounts[account], undefined);
    assert.match(open.rejected[0]?.reason ?? '', /could not be read/);
  });
});

describe('membership rules', () => {
  it('a removed device\'s entries after its removal do not apply', () => {
    const { founder, second, vault } = twoDeviceVault();
    const { newKey } = (() => {
      const removal = buildDeviceRemove(vault.state(), founder, { device: second.deviceId, currentKey: vault.key, random, time: vault.now() });
      vault.write(removal.entry);
      return removal;
    })();
    vault.key = newKey;
    // The removed device still writes, having read the folder (so its entry comes after the removal).
    addAccount(vault, second);
    const state = vault.state();
    assert.equal(state.members[second.deviceId]?.removed, true);
    assert.match(reasons(state).join(), /removed from the vault before this entry/);
    assert.equal(Object.keys(state.accounts).length, 0);
    assert.throws(() => openVault(state, second), /current vault key/);
  });

  it('a member device of a team vault cannot add or remove devices', () => {
    const { founder, second: member, vault } = twoDeviceVault('team', 'member');
    vault.write(buildDeviceAdd(vault.state(), member, { device: device(random), role: 'admin', name: 'Sneaky', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceRemove(vault.state(), member, { device: founder.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    const state = vault.state();
    assert.deepEqual(reasons(state), ['only an admin device can do this', 'only an admin device can do this']);
    assert.equal(Object.keys(state.members).length, 2);
    // Members can still change accounts.
    addAccount(vault, member);
    assert.equal(vault.state().rejected.length, 2);
  });

  it('a personal vault refuses member roles; a device cannot remove itself, so a team always keeps an admin', () => {
    const founder = device(random);
    const personal = MemoryVault.found(founder, random);
    personal.write(buildDeviceAdd(personal.state(), founder, { device: device(random), role: 'member', name: 'X', currentKey: personal.key, random, time: personal.now() }));
    assert.match(reasons(personal.state()).join(), /every device in a personal vault is an admin/);

    const { founder: admin, vault: team } = twoDeviceVault('team', 'member');
    team.write(buildDeviceRemove(team.state(), admin, { device: admin.deviceId, currentKey: team.key, random, time: team.now() }).entry);
    assert.match(reasons(team.state()).join(), /can't remove itself/);
  });

  it('an account.put under the old key made at the same time as a removal still applies', () => {
    const { founder, second, vault } = twoDeviceVault();
    const third = device(random);
    vault.write(buildDeviceAdd(vault.state(), founder, { device: third, role: 'admin', name: 'Laptop', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), third, vault.now()));
    const beforeRotation = vault.state();
    const oldKey = vault.key;
    const removal = buildDeviceRemove(beforeRotation, founder, { device: third.deviceId, currentKey: vault.key, random, time: vault.now() });
    vault.write(removal.entry);
    // The second device hasn't seen the removal and writes under the old key. The line is in the
    // folder already, under a key the removed laptop held: refusing it would hide nothing.
    vault.key = oldKey;
    const early = addAccount(vault, second, totpRecord(), beforeRotation);
    vault.key = removal.newKey;
    const state = vault.state();
    assert.equal(state.epoch, 1);
    assert.equal(openVault(state, second).accounts[early]?.record.issuer, 'GitHub');
    // Written after seeing the removal it must use the new key.
    vault.key = oldKey;
    addAccount(vault, second, totpRecord(), { ...vault.state(), epoch: 0 });
    vault.key = removal.newKey;
    assert.match(reasons(vault.state()).join(), /encrypted under epoch 0, but the vault is at epoch 1/);
  });

  it('a device approved after a rotation still reads accounts from before it', () => {
    const { founder, second, vault } = twoDeviceVault();
    const early = addAccount(vault, founder);
    const removal = buildDeviceRemove(vault.state(), founder, { device: second.deviceId, currentKey: vault.key, random, time: vault.now() });
    vault.write(removal.entry);
    vault.key = removal.newKey;
    const late = device(random);
    vault.write(buildDeviceAdd(vault.state(), founder, { device: late, role: 'admin', name: 'New', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), late, vault.now()));
    const open = openVault(vault.state(), late);
    assert.deepEqual(Object.keys(open.keys).sort(), ['0', '1']);
    assert.equal(open.accounts[early]?.record.label, 'ada@example.com');
  });

  it('a removed device cannot be added back with the same keys', () => {
    const { founder, second, vault } = twoDeviceVault();
    const removal = buildDeviceRemove(vault.state(), founder, { device: second.deviceId, currentKey: vault.key, random, time: vault.now() });
    vault.write(removal.entry);
    vault.key = removal.newKey;
    vault.write(buildDeviceAdd(vault.state(), founder, { device: second, role: 'admin', name: 'Again', currentKey: vault.key, random, time: vault.now() }));
    assert.match(reasons(vault.state()).join(), /must make new keys/);
  });
});

describe('approval racing a rotation', () => {
  it('an approval made at the same time as an unrelated removal stays; a removal key that strands the newcomer is not the vault\'s', () => {
    const { founder, second, vault } = twoDeviceVault();
    const third = device(random);
    vault.write(buildDeviceAdd(vault.state(), founder, { device: third, role: 'admin', name: 'Laptop', currentKey: vault.key, random, time: vault.now() }));
    const shared = vault.state();
    const newcomer = device(random);
    // The second device approves a newcomer while the founder removes the laptop, neither seeing the other.
    const t = vault.now();
    vault.write(buildDeviceAdd(shared, second, { device: newcomer, role: 'admin', name: 'Watch', currentKey: vault.key, random, time: t - 500 }));
    const removal = buildDeviceRemove(shared, founder, { device: third.deviceId, currentKey: vault.key, random, time: t });
    vault.write(removal.entry);
    // The newcomer joins having seen both.
    vault.write(buildDeviceHello(vault.state(), newcomer, vault.now()));
    const state = vault.state();
    assert.equal(state.members[third.deviceId]?.removed, true);
    assert.equal(state.members[newcomer.deviceId]?.removed, false);
    assert.equal(state.members[newcomer.deviceId]?.joined, true);
    // The removal's key never reached the newcomer, which joined: it strands it, so the vault stays
    // on the key the laptop held and needs a fresh one; the founder writes it, to everyone in.
    assert.equal(state.epoch, 0);
    assert.equal(state.needsFreshKey, true);
    assert.deepEqual(state.unkeyedDevices, []);
    const fresh = buildKeyRotate(state, founder, { currentKey: vault.key, random, time: vault.now() });
    vault.write(fresh.entry);
    const rekeyed = vault.state();
    assert.equal(rekeyed.needsFreshKey, false);
    assert.equal(openVault(rekeyed, newcomer).epoch, rekeyed.epoch);
    // Approving it again is allowed (round 5): the key an approval gave may not open.
    const again = vault.write(buildDeviceAdd(rekeyed, founder, { device: newcomer, role: 'admin', name: 'Watch', currentKey: fresh.newKey, random, time: vault.now() }));
    assert.equal(vault.state().history.find((h) => h.hash === entryHash(again))?.status, 'applied');
  });

  it('a rotation must seal the new key to every device staying in the vault', () => {
    const { founder, second, vault } = twoDeviceVault();
    const third = device(random);
    vault.write(buildDeviceAdd(vault.state(), founder, { device: third, role: 'admin', name: 'Laptop', currentKey: vault.key, random, time: vault.now() }));
    const removal = buildDeviceRemove(vault.state(), founder, { device: third.deviceId, currentKey: vault.key, random, time: vault.now() });
    // An admin that seals the new key to itself only, leaving the second device out.
    const { sig: _sig, ...unsigned } = removal.entry;
    const body = removal.entry.body as { keys: Record<string, unknown> };
    const keys = { [founder.deviceId]: body.keys[founder.deviceId]! } as unknown as JsonValue;
    vault.write(signEntry({ ...unsigned, body: { ...removal.entry.body, keys } }, founder));
    const state = vault.state();
    assert.match(reasons(state).join(), /not sealed to every device staying/);
    assert.equal(state.members[third.deviceId]?.removed, false);
    assert.equal(openVault(state, second).epoch, 0);
  });
});

describe('concurrent edits', () => {
  it('two devices editing one HOTP account concurrently: later time wins, counter takes the max', () => {
    const { founder, second, vault } = twoDeviceVault();
    const account = addAccount(vault, founder, totpRecord({ type: 'hotp', counter: 5 }));
    const shared = vault.state();
    const t = vault.now();
    vault.write(buildAccountPut(shared, founder, { account, record: totpRecord({ type: 'hotp', counter: 9, label: 'from founder' }), currentKey: vault.key, random, time: t }));
    vault.write(buildAccountPut(shared, second, { account, record: totpRecord({ type: 'hotp', counter: 7, label: 'from second' }), currentKey: vault.key, random, time: t + 1 }));
    const record = openVault(vault.state(), founder).accounts[account]?.record;
    assert.equal(record?.label, 'from second');
    assert.equal(record?.counter, 9);
  });

  it('breaks a time tie by entry hash', () => {
    const { founder, second, vault } = twoDeviceVault();
    const account = addAccount(vault, founder);
    const shared = vault.state();
    const t = vault.now();
    const fromFounder = vault.write(buildAccountPut(shared, founder, { account, record: totpRecord({ label: 'founder' }), currentKey: vault.key, random, time: t }));
    const fromSecond = vault.write(buildAccountPut(shared, second, { account, record: totpRecord({ label: 'second' }), currentKey: vault.key, random, time: t }));
    const winner = entryHash(fromFounder) > entryHash(fromSecond) ? 'founder' : 'second';
    assert.equal(openVault(vault.state(), founder).accounts[account]?.record.label, winner);
  });

  it('a causally later edit wins even with an earlier clock', () => {
    const { founder, second, vault } = twoDeviceVault();
    const account = addAccount(vault, founder);
    const t = vault.now();
    vault.write(buildAccountPut(vault.state(), founder, { account, record: totpRecord({ label: 'first' }), currentKey: vault.key, random, time: t }));
    // The second device saw that edit but its clock is behind.
    vault.write(buildAccountPut(vault.state(), second, { account, record: totpRecord({ label: 'second, slow clock' }), currentKey: vault.key, random, time: t - 60_000 }));
    assert.equal(openVault(vault.state(), founder).accounts[account]?.record.label, 'second, slow clock');
  });

  it('holds back an entry that names an entry not in the folder yet', () => {
    const { founder, second, vault } = twoDeviceVault();
    addAccount(vault, founder);
    const withFounderEntry = vault.state();
    const missing = vault.logs[founder.deviceId]!.pop()!;
    addAccount(vault, second, totpRecord(), withFounderEntry);
    const state = vault.state();
    assert.deepEqual(state.history.filter((h) => h.status === 'waiting').map((h) => h.author), [second.deviceId]);
    vault.logs[founder.deviceId]!.push(missing);
    assert.equal(vault.state().history.filter((h) => h.status === 'waiting').length, 0);
  });
});

describe('determinism', () => {
  /** Three devices writing with partial views of each other, including a rotation and a rejected entry. */
  function busyVault(): { vault: MemoryVault; devices: DeviceKeys[] } {
    const { founder, second, vault } = twoDeviceVault();
    const third = device(random);
    vault.write(buildDeviceAdd(vault.state(), second, { device: third, role: 'admin', name: 'Laptop', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), third, vault.now()));
    const shared = vault.state();
    const accounts = [founder, second, third].map((author) => addAccount(vault, author, totpRecord({ type: 'hotp', counter: 1 }), shared));
    for (const [index, author] of [third, founder, second].entries()) {
      vault.write(buildAccountPut(shared, author, { account: accounts[0]!, record: totpRecord({ type: 'hotp', counter: 10 - index, label: `edit ${index}` }), currentKey: vault.key, random, time: 1_000_000 + 5_000 }));
    }
    const removal = buildDeviceRemove(vault.state(), founder, { device: third.deviceId, currentKey: vault.key, random, time: vault.now() });
    vault.write(removal.entry);
    addAccount(vault, third, totpRecord(), shared);
    vault.key = removal.newKey;
    addAccount(vault, second);
    return { vault, devices: [founder, second, third] };
  }

  it('every device computes the same state from the same logs in any read order', () => {
    const { vault, devices } = busyVault();
    const reference = vault.state();
    assert.ok(reference.rejected.length > 0, 'the scenario includes a rejected entry');
    const referenceOpen = canonicalJson(openVault(reference, devices[0]!).accounts as never);
    const shuffle = seededRandom('read-order');
    for (let round = 0; round < 25; round++) {
      const order = shuffled(Object.keys(vault.logs), shuffle);
      const logs = Object.fromEntries(order.map((id) => [id, vault.logs[id]!]));
      const state = replayVault(vault.vaultId, logs);
      assert.deepEqual(state.history, reference.history);
      assert.equal(canonicalJson(state as never), canonicalJson(reference as never));
      for (const reader of devices.slice(0, 2)) assert.equal(canonicalJson(openVault(state, reader).accounts as never), referenceOpen);
    }
  });
});
