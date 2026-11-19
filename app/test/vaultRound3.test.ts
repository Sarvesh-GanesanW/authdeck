/**
 * Round 3 of the vault security review, app side: restore retries never re-sign a recovery seq
 * (R4), a refused repair of a removed author's lines never blocks this device (R5), and a bogus
 * `seen` names its writer, not the device it names (R6).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RESTORE_FOLDER_BEHIND,
  RESTORE_TAKEN,
  isActiveAuthor,
  sendRestore,
  sendUpload,
  withRestoreLines,
  type LocalLogs,
  type PendingRestore,
  type RestoreIo,
  type Upload,
} from '../src/auth/engine/sync';
import { vaultWarnings, type WarningInput } from '../src/auth/engine/warnings';
import type { VaultEntry } from '../src/protocol';
import { buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, newAccountId } from '../src/vault/build';
import type { DeviceKeys } from '../src/vault/crypto';
import { entryHash, serializeEntry, signEntry, type SignedEntry } from '../src/vault/entry';
import { openVault } from '../src/vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, restoreWithPhrase } from '../src/vault/recovery';
import { replayVault, type VaultState } from '../src/vault/replay';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers';

const random = seededRandom('vault-round3-tests');
const REFUSED = new Error('refused');
const asEntry = (e: SignedEntry) => e as unknown as VaultEntry;

/** A personal vault with a recovery phrase; the founder phone is then lost. */
function vaultWithPhrase() {
  const vault = new MemoryVault(device(random), random);
  const phrase = generateRecoveryPhrase(random);
  vault.write(buildRecoverySetFromPhrase(vault.state(), vault.founder, { phrase, currentKey: vault.key, random, time: vault.now() }).entry);
  return { vault, phrase };
}

/** What the engine signs for a restore: device.add as the recovery identity, then the new device's hello. */
function signRestore(vaultId: string, phrase: string, newDevice: DeviceKeys, logs: LocalLogs, state: VaultState, time: number): PendingRestore {
  const restored = restoreWithPhrase(state, { phrase, device: newDevice, name: 'New phone', random, time });
  const add = serializeEntry(restored.entry);
  const withAdd = { ...logs, [restored.entry.author]: [...(logs[restored.entry.author] ?? []), add] };
  const hello = buildDeviceHello(replayVault(vaultId, withAdd), newDevice, time + 1);
  return { recoveryId: restored.entry.author, deviceId: newDevice.deviceId, seq: restored.entry.seq, lines: [add, serializeEntry(hello)], superseded: false };
}

/**
 * The PoC's computer: it keeps every append it gets but answers "refused", and keeps serving
 * `served`. Records every recovery line it was sent, and every signing.
 */
function hostileComputer(vault: MemoryVault, phrase: string, served: LocalLogs, newDevice: DeviceKeys) {
  const received: string[][] = [];
  const signed: PendingRestore[] = [];
  let stored: PendingRestore | null = null;
  const io: RestoreIo = {
    readFolder: async () => ({ logs: served, state: replayVault(vault.vaultId, served) }),
    sign: async ({ logs, state }) => {
      const pending = signRestore(vault.vaultId, phrase, newDevice, logs, state, vault.now());
      signed.push(pending);
      return pending;
    },
    save: async (pending) => {
      stored = pending;
    },
    append: async (entries) => {
      received.push(entries.map((e) => serializeEntry(e as unknown as SignedEntry)));
      throw REFUSED;
    },
    isRefused: (err) => err === REFUSED,
  };
  return { io, received, signed, stored: () => stored };
}

describe('restore retries (R4)', () => {
  it('resends the same signed bytes on every refusal and after a restart, never signing a second entry at the recovery seq', async () => {
    const { vault, phrase } = vaultWithPhrase();
    const computer = hostileComputer(vault, phrase, vault.copy(), device(random));

    await assert.rejects(sendRestore(computer.io, null, 3), REFUSED);
    assert.equal(computer.signed.length, 1, 'signed once');
    assert.equal(computer.received.length, 3, 'sent three times');
    assert.ok(computer.stored(), 'stored before it was sent');

    // The app stops and starts again: the stored restore goes out, nothing new is signed.
    await assert.rejects(sendRestore(computer.io, computer.stored(), 3), REFUSED);
    assert.equal(computer.signed.length, 1);
    const recoveryLines = new Set(computer.received.map((lines) => lines[0]));
    assert.equal(recoveryLines.size, 1, 'one recovery line at that seq, so no fork proof can be made');
    assert.deepEqual(computer.received.at(-1), computer.stored()!.lines);
  });

  it('sends only what the folder lacks once the computer holds the add', async () => {
    const { vault, phrase } = vaultWithPhrase();
    const newPhone = device(random);
    const served = vault.copy();
    const computer = hostileComputer(vault, phrase, served, newPhone);
    await assert.rejects(sendRestore(computer.io, null, 1), REFUSED);
    const pending = computer.stored()!;
    // The computer now serves the add it kept, but not the hello.
    (served[pending.recoveryId] ??= []).push(pending.lines[0]);
    const sent: string[][] = [];
    const io = {
      ...computer.io,
      append: async (entries: VaultEntry[]) => {
        const lines = entries.map((e) => serializeEntry(e as unknown as SignedEntry));
        sent.push(lines);
        // An honest computer from here: it keeps what it gets, and the next read shows it.
        for (const [i, e] of entries.entries()) (served[(e as unknown as SignedEntry).author] ??= []).push(lines[i]!);
      },
    };
    const result = await sendRestore(io, pending, 3);
    assert.deepEqual(sent, [[pending.lines[1]]]);
    assert.equal(computer.signed.length, 1);
    const logs = withRestoreLines(result.folder.logs, result.folder.state, result.pending);
    assert.equal(replayVault(vault.vaultId, logs).members[newPhone.deviceId]?.removed, false);
  });

  it('stops when the folder holds another entry at the seq, and a later restore signs past it', async () => {
    const { vault, phrase } = vaultWithPhrase();
    const served = vault.copy();
    const computer = hostileComputer(vault, phrase, served, device(random));
    await assert.rejects(sendRestore(computer.io, null, 1), REFUSED);
    const mine = computer.stored()!;
    // Another device restored with the phrase and took the seq.
    const other = signRestore(vault.vaultId, phrase, device(random), served, replayVault(vault.vaultId, served), vault.now());
    assert.equal(other.seq, mine.seq);
    const withOther = { ...served, [other.recoveryId]: [...(served[other.recoveryId] ?? []), other.lines[0]] };
    const io = { ...computer.io, readFolder: async () => ({ logs: withOther, state: replayVault(vault.vaultId, withOther) }) };

    await assert.rejects(sendRestore(io, mine, 3), { message: RESTORE_TAKEN });
    assert.equal(computer.signed.length, 1, 'did not sign again');
    assert.equal(computer.stored()!.superseded, true);

    await assert.rejects(sendRestore(io, computer.stored(), 1), REFUSED);
    assert.equal(computer.signed.length, 2);
    assert.equal(computer.signed[1]!.seq, mine.seq + 1, 'the new restore signs past the old seq');
  });

  it('refuses to sign again while the folder hides the entry that took the old seq', async () => {
    const { vault, phrase } = vaultWithPhrase();
    const computer = hostileComputer(vault, phrase, vault.copy(), device(random));
    await assert.rejects(sendRestore(computer.io, null, 1), REFUSED);
    const superseded = { ...computer.stored()!, superseded: true };
    await assert.rejects(sendRestore(computer.io, superseded, 3), { message: RESTORE_FOLDER_BEHIND });
    assert.equal(computer.signed.length, 1);
  });
});

/** Founder, admin B and member X; the founder removes X, then X writes a line with its old view. */
function removedAuthorWrote() {
  const vault = new MemoryVault(device(random), random);
  const [b, x] = [device(random), device(random)];
  for (const [d, role] of [[b, 'admin'], [x, 'admin']] as const) {
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: d, role, name: d === b ? 'B' : 'X', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), d, vault.now()));
  }
  const stale = vault.state();
  vault.write(buildDeviceRemove(vault.state(), vault.founder, { device: x.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
  const junk = vault.write(buildAccountPut(stale, x, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
  return { vault, b, x, junk };
}

describe('a refused repair of a removed author (R5)', () => {
  it('counts a removed or cut-off identity as inactive', () => {
    const { vault, b, x } = removedAuthorWrote();
    const state = vault.state();
    assert.equal(isActiveAuthor(state, x.deviceId), false);
    assert.equal(isActiveAuthor(state, b.deviceId), true);
    assert.equal(isActiveAuthor(state, 'constructor'), true, 'an odd id is not mistaken for a removed one');
  });

  it("doesn't block the upload when only a removed author's lines are refused", async () => {
    const { vault, b, junk } = removedAuthorWrote();
    const repair: Upload = { entries: [asEntry(junk)], repair: true, proof: { [junk.author]: { seq: junk.seq, hash: entryHash(junk) } } };
    const outcome = await sendUpload(repair, vault.state(), b.deviceId, { send: async () => Promise.reject(REFUSED), isRefused: (err) => err === REFUSED });
    assert.deepEqual(outcome, { sent: null, blocked: false });
  });

  it("sends the active authors' lines again without the removed author's", async () => {
    const { vault, b, junk } = removedAuthorWrote();
    const own = vault.write(buildAccountPut(vault.state(), b, { account: newAccountId(random), record: totpRecord(), currentKey: openVault(vault.state(), b).currentKey, random, time: vault.now() }));
    const repair: Upload = {
      entries: [asEntry(own), asEntry(junk)],
      repair: true,
      proof: { [own.author]: { seq: own.seq, hash: entryHash(own) }, [junk.author]: { seq: junk.seq, hash: entryHash(junk) } },
    };
    const sends: Upload[] = [];
    const send = async (upload: Upload) => {
      sends.push(upload);
      if (upload.entries.some((e) => e.author === junk.author)) throw REFUSED;
    };
    const outcome = await sendUpload(repair, vault.state(), b.deviceId, { send, isRefused: (err) => err === REFUSED });
    assert.equal(outcome.blocked, false);
    assert.deepEqual(outcome.sent?.entries, [own]);
    assert.deepEqual(Object.keys(outcome.sent?.proof ?? {}), [b.deviceId]);
    assert.equal(sends.length, 2);
  });

  it("still blocks when this device's own repaired lines are refused", async () => {
    const { vault, b } = removedAuthorWrote();
    const own = vault.write(buildAccountPut(vault.state(), b, { account: newAccountId(random), record: totpRecord(), currentKey: openVault(vault.state(), b).currentKey, random, time: vault.now() }));
    const repair: Upload = { entries: [asEntry(own)], repair: true, proof: { [own.author]: { seq: own.seq, hash: entryHash(own) } } };
    const outcome = await sendUpload(repair, vault.state(), b.deviceId, { send: async () => Promise.reject(REFUSED), isRefused: (err) => err === REFUSED });
    assert.deepEqual(outcome, { sent: null, blocked: true });
  });

  it('a refused plain append is never swallowed', async () => {
    const { vault, b } = removedAuthorWrote();
    await assert.rejects(sendUpload({ entries: [], repair: false }, vault.state(), b.deviceId, { send: async () => Promise.reject(REFUSED), isRefused: () => true }), REFUSED);
  });

  it("a beacon naming a removed author's lost line doesn't pause secrets", () => {
    const { vault, b, x } = removedAuthorWrote();
    const state = vault.state();
    const input = (deviceId: string): WarningInput => ({
      ...warningBase(state),
      beacons: { problems: [{ device: b.deviceId, kind: 'missing-entry', entry: { deviceId, seq: 9 } }], heardAt: {}, claimedEpoch: state.epoch },
    });
    assert.equal(vaultWarnings(input(x.deviceId)).secretsPaused, false);
    assert.equal(vaultWarnings(input(vault.founder.deviceId)).secretsPaused, true, "an active device's lost line still pauses");
  });
});

function warningBase(state: VaultState): WarningInput {
  return { state, self: null, beacons: null, highestEpoch: state.epoch, waitingSince: new Map(), keyProblems: [], stoppedJoins: 0, now: 0, deviceName: (id) => names.get(id) ?? 'Unknown' };
}
const names = new Map<string, string>();

describe('a conflict without a fork proof (R6)', () => {
  it('names the writer of the bogus entry, not the device it names, and keeps proven forks on the forker', () => {
    const vault = new MemoryVault(device(random), random);
    const mallory = device(random);
    vault.write(buildDeviceAdd(vault.state(), vault.founder, { device: mallory, role: 'admin', name: 'Mallory', currentKey: vault.key, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), mallory, vault.now()));
    names.set(vault.founder.deviceId, 'Admin phone').set(mallory.deviceId, 'Mallory');
    const state = vault.state();
    const put = buildAccountPut(state, mallory, { account: newAccountId(random), record: totpRecord(), currentKey: openVault(state, mallory).currentKey, random, time: vault.now() });
    const { sig: _sig, ...unsigned } = put;
    const bogus = signEntry({ ...unsigned, seen: { ...put.seen, [vault.founder.deviceId]: { seq: state.heads[vault.founder.deviceId]!.seq, hash: 'A'.repeat(43) } } }, mallory);
    vault.write(bogus);
    const after = vault.state();
    assert.ok(after.conflicts.length > 0, 'the core records the conflict');

    const forks = vaultWarnings(warningBase(after)).warnings.filter((w) => w.kind === 'fork');
    assert.equal(forks.length, 1);
    assert.equal(forks[0]!.deviceId, mallory.deviceId);
    assert.match(forks[0]!.text, /^Mallory's change names a version of Admin phone's history/);
    assert.doesNotMatch(forks[0]!.text, /Admin phone may have signed|Remove that device/);

    const proven = vaultWarnings(warningBase({ ...after, forked: { [mallory.deviceId]: 3 } })).warnings.filter((w) => w.kind === 'fork');
    assert.deepEqual(proven.map((w) => w.deviceId), [mallory.deviceId]);
    assert.match(proven[0]!.text, /^Mallory signed two different versions/);
  });
});
