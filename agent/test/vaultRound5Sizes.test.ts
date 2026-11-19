// Round 5, N1 and the garbage prevKey (security-review-5/findings5.md). The PoC runs from
// test/fixtures/round5 (each PASS line is an attack step that worked). The rest pins the rules:
// every byte field has an exact or tight size, a key change is no larger than its recipients
// allow, removals and restores pass every cap, a key change is reserved only when the vault
// needed one, and a prevKey that doesn't open names its writer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_ACCOUNT_RECORD_BYTES, MAX_NAME_BYTES, parseBody, rotationEntryMaxBytes } from '../src/vault/bodies';
import { buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, buildDeviceRename, buildKeyRotate, newAccountId } from '../src/vault/build';
import { toBase64Url } from '../src/vault/bytes';
import type { VaultLogs } from '../src/vault/chain';
import { encryptBox, type DeviceKeys } from '../src/vault/crypto';
import { entryHash, serializeEntry, signEntry, type SignedEntry } from '../src/vault/entry';
import { boxContexts, openVault, sealAccountRecord, type AccountRecord } from '../src/vault/open';
import { prevKeyProblems } from '../src/vault/prevKeyCheck';
import { DEFAULT_QUOTA_LIMITS, quotaPass, type QuotaLimits } from '../src/vault/quota';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase, restoreWithPhrase } from '../src/vault/recovery';
import { replayVault, type VaultState } from '../src/vault/replay';
import { quotaProblem } from '../src/vaultQuota';
import { MemoryVault, device, seededRandom } from './helpers/vault';

/** The fixtures cover the 0.4 multi-device code, so they run with it on (test/setup/multiDevice.ts). */
const MULTI_DEVICE_SETUP = new URL('./setup/multiDevice.ts', import.meta.url).href;

const random = seededRandom('vault-round5-sizes');
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'round5');

/** Runs one PoC and returns its PASS lines (attack steps that worked). */
function attackSteps(file: string): string[] {
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--import', MULTI_DEVICE_SETUP, path.join(FIXTURES, file)], { encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\n').filter((l) => l.startsWith('PASS')).map((l) => l.slice(6).split('  --')[0]!.trim());
}

function addDevice(vault: MemoryVault, by: DeviceKeys, who: DeviceKeys, role: 'admin' | 'member' = 'admin'): void {
  vault.write(buildDeviceAdd(vault.state(), by, { device: who, role, name: 'x', currentKey: openVault(vault.state(), by).currentKey, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), who, vault.now()));
}

/** The entry with one body field replaced, signed again by its author. */
function withBody(entry: SignedEntry, author: DeviceKeys, body: Record<string, unknown>): SignedEntry {
  const { sig: _sig, ...unsigned } = entry;
  return signEntry({ ...unsigned, body: { ...entry.body, ...body } as SignedEntry['body'] }, author);
}

const bytesOf = (length: number) => toBase64Url(new Uint8Array(length));

function boxWithCiphertext(box: unknown, length: number): unknown {
  return { ...(box as Record<string, unknown>), ct: bytesOf(length) };
}

function parseProblem(entry: SignedEntry): string | null {
  const parsed = parseBody(entry);
  return parsed.ok ? null : parsed.reason;
}

/** Founder A (admin), admin B, member C; a team vault. */
function teamVault() {
  const a = device(random);
  const vault = MemoryVault.found(a, random, 'team');
  const [b, c] = [device(random), device(random)];
  addDevice(vault, a, b, 'admin');
  addDevice(vault, a, c, 'member');
  return { vault, a, b, c };
}

/** Limits a vault of a handful of lines has already used up: no share, no reserve, no room. */
const EXHAUSTED: QuotaLimits = {
  member: { lines: 0, bytes: 0 },
  admin: { lines: 0, bytes: 0 },
  vault: { lines: 0, bytes: 0 },
  reservePerIdentity: { lines: 0, bytes: 0 },
  vaultReserve: { lines: 0, bytes: 0 },
};

/** The logs with `entry` appended to its author's log. */
function withLine(logs: VaultLogs, entry: SignedEntry): VaultLogs {
  return { ...logs, [entry.author]: [...(logs[entry.author] ?? []), serializeEntry(entry)] };
}

/** quotaProblem for appending `entry` to `vault` (not written), judged against the vault before it. */
function problemOfAppend(vault: MemoryVault, entry: SignedEntry, limits: QuotaLimits = EXHAUSTED): string | null {
  const before = vault.state();
  const logs = withLine(vault.snapshot(), entry);
  const after = replayVault(vault.vaultId, logs);
  return quotaProblem(after, logs, new Set([entryHash(entry)]), limits, before);
}

function itemOf(state: VaultState, entry: SignedEntry) {
  const item = state.history.find((h) => h.hash === entryHash(entry));
  assert.ok(item, 'the entry reached the rules');
  return item;
}

describe('round-5 PoC, blocked', () => {
  it('N1: padded key changes neither reach the reserve nor stop the honest admins', () => {
    assert.deepEqual(attackSteps('t2_reserve_exhaustion.ts'), []);
  });
});

describe('every byte field has an exact or tight size', () => {
  it('refuses a prevKey one byte longer or shorter than a sealed epoch key', () => {
    const { vault, a } = teamVault();
    const { entry } = buildKeyRotate(vault.state(), a, { currentKey: openVault(vault.state(), a).currentKey, random, time: vault.now() });
    assert.equal(parseProblem(entry), null);
    assert.match(parseProblem(withBody(entry, a, { prevKey: boxWithCiphertext(entry.body.prevKey, 49) })) ?? '', /previous key ciphertext is too long/);
    assert.match(parseProblem(withBody(entry, a, { prevKey: boxWithCiphertext(entry.body.prevKey, 47) })) ?? '', /previous key ciphertext is too short/);
    assert.match(parseProblem(withBody(entry, a, { prevKey: boxWithCiphertext(entry.body.prevKey, 120_000) })) ?? '', /too long/);
  });

  it('refuses a name past MAX_NAME_BYTES and an account record past MAX_ACCOUNT_RECORD_BYTES', () => {
    const { vault, a } = teamVault();
    const key = openVault(vault.state(), a).currentKey;
    const rename = buildDeviceRename(vault.state(), a, { device: a.deviceId, name: 'Phone', currentKey: key, random, time: vault.now() });
    assert.equal(parseProblem(rename), null);
    assert.match(parseProblem(withBody(rename, a, { name: boxWithCiphertext(rename.body.name, MAX_NAME_BYTES + 17) })) ?? '', /name ciphertext is too long/);
    assert.equal(parseProblem(withBody(rename, a, { name: boxWithCiphertext(rename.body.name, MAX_NAME_BYTES + 16) })), null);
    const put = buildAccountPut(vault.state(), a, { account: newAccountId(random), record: { issuer: 'Example', label: 'me', secret: 'JBSWY3DPEHPK3PXPJBSWY3DP', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, counter: 0 }, currentKey: key, random, time: vault.now() });
    assert.equal(parseProblem(put), null);
    assert.match(parseProblem(withBody(put, a, { box: boxWithCiphertext(put.body.box, MAX_ACCOUNT_RECORD_BYTES + 17) })) ?? '', /account record ciphertext is too long/);
  });

  it('fits the widest account record the record check takes', () => {
    // Every text field at 256 characters that each escape to six bytes, the longest secret, every number at its widest.
    const escaped = '\u0001'.repeat(256);
    const record: AccountRecord = { issuer: escaped, label: escaped, icon: escaped, secret: 'A'.repeat(205), type: 'hotp', algorithm: 'SHA512', digits: 8, period: 86_400, counter: Number.MAX_SAFE_INTEGER, position: 10_000 };
    const box = sealAccountRecord({ vault: 'v', epoch: 0, author: 'a' }, new Uint8Array(32), 'acct', record, random);
    const length = Buffer.from(box.ct, 'base64url').length;
    assert.ok(length <= MAX_ACCOUNT_RECORD_BYTES + 16, `widest record is ${length} bytes`);
  });

  it('refuses a key change larger than its recipients allow, and keeps every real one within it', () => {
    const { vault, a, c } = teamVault();
    const removal = buildDeviceRemove(vault.state(), a, { device: c.deviceId, currentKey: openVault(vault.state(), a).currentKey, random, time: vault.now() }).entry;
    const recipients = Object.keys(removal.body.keys as object).length;
    assert.ok(serializeEntry(removal).length <= rotationEntryMaxBytes('device.remove', recipients));
    assert.equal(parseProblem(removal), null);
    // An entry padded past what its two sealed keys allow (here outside the body, which is exact).
    const padded = { ...removal, pad: 'A'.repeat(rotationEntryMaxBytes('device.remove', recipients)) } as SignedEntry;
    assert.match(parseProblem(padded) ?? '', /larger than a key change sealed to 2 devices can be/);
    assert.ok(rotationEntryMaxBytes('device.remove', 256) < 128 * 1024, 'a removal sealed to every identity fits one entry');
  });
});

describe('removals and restores pass every cap', () => {
  it('takes an active admin\'s removal of a device still in when every share, reserve and the vault are used up', () => {
    const { vault, a, c } = teamVault();
    const removal = buildDeviceRemove(vault.state(), a, { device: c.deviceId, currentKey: openVault(vault.state(), a).currentKey, random, time: vault.now() }).entry;
    assert.equal(problemOfAppend(vault, removal), null);
  });

  it('gives no pass to a removal that would not apply', () => {
    const { vault, a, b, c } = teamVault();
    // C is a member: its removal of B is rejected, so it counts as ordinary and the full vault refuses it.
    const byMember = buildDeviceRemove(vault.state(), c, { device: b.deviceId, currentKey: openVault(vault.state(), c).currentKey, random, time: vault.now() }).entry;
    assert.match(problemOfAppend(vault, byMember) ?? '', /used its share/);
    // A removal of a device already out gets no pass either.
    const stale = vault.state();
    vault.write(buildDeviceRemove(stale, a, { device: c.deviceId, currentKey: openVault(stale, a).currentKey, random, time: vault.now() }).entry);
    const again = buildDeviceRemove(stale, b, { device: c.deviceId, currentKey: openVault(stale, b).currentKey, random, time: vault.now() }).entry;
    const after = replayVault(vault.vaultId, withLine(vault.snapshot(), again));
    assert.equal(quotaPass(vault.state(), itemOf(after, again), after), 'ordinary');
  });

  it('takes a recovery restore (the approval and the hello) when every share, reserve and the vault are used up', () => {
    const { vault, a } = teamVault();
    const phrase = generateRecoveryPhrase(random);
    vault.write(buildRecoverySetFromPhrase(vault.state(), a, { phrase, currentKey: openVault(vault.state(), a).currentKey, random, time: vault.now() }).entry);
    const phone = device(random);
    const restore = restoreWithPhrase(vault.state(), { phrase, device: phone, name: 'New phone', random, time: vault.now() }).entry;
    assert.equal(problemOfAppend(vault, restore), null);
    vault.write(restore);
    assert.equal(problemOfAppend(vault, buildDeviceHello(vault.state(), phone, vault.now())), null);
  });
});

describe('a key change is reserved only when the vault needed one', () => {
  it('reserves a key.rotate when the vault before it needed a fresh key, and not otherwise', () => {
    const { vault, a } = teamVault();
    const before = vault.state();
    const rotate = buildKeyRotate(before, a, { currentKey: openVault(before, a).currentKey, random, time: vault.now() }).entry;
    const logs = withLine(vault.snapshot(), rotate);
    const after = replayVault(vault.vaultId, logs);
    const item = itemOf(after, rotate);
    assert.equal(item.status, 'applied');
    assert.equal(before.needsFreshKey, false);
    assert.equal(quotaPass(before, item, after), 'ordinary');
    assert.equal(quotaPass({ ...before, needsFreshKey: true }, item, after), 'reserved');
    // With room only in the reserve, the needed one is taken and the needless one refused.
    const reserveOnly: QuotaLimits = { ...EXHAUSTED, reservePerIdentity: DEFAULT_QUOTA_LIMITS.reservePerIdentity, vaultReserve: DEFAULT_QUOTA_LIMITS.vaultReserve };
    const added = new Set([item.hash]);
    assert.equal(quotaProblem(after, logs, added, reserveOnly, { ...before, needsFreshKey: true }), null);
    assert.match(quotaProblem(after, logs, added, reserveOnly, before) ?? '', /used its share/);
  });
});

describe('a prevKey that does not open', () => {
  it('names the device whose key change carries it, on a device that holds both keys', () => {
    const { vault, a, b } = teamVault();
    const state = vault.state();
    const result = buildKeyRotate(state, a, { currentKey: openVault(state, a).currentKey, random, time: vault.now() });
    const epoch = state.epoch + 1;
    const garbage = encryptBox(result.newKey, random(32), boxContexts.prevKey(vault.vaultId, epoch), random);
    vault.write(withBody(result.entry, a, { prevKey: garbage }));
    const after = vault.state();
    assert.equal(after.epoch, epoch, 'the rotation applied');
    const open = openVault(after, b);
    assert.deepEqual(prevKeyProblems(after, open.keys, vault.logs), [{ epoch, author: a.deviceId, hash: entryHash(withBody(result.entry, a, { prevKey: garbage })) }]);
  });

  it('finds nothing wrong with honest key changes', () => {
    const { vault, a, b } = teamVault();
    const state = vault.state();
    vault.write(buildKeyRotate(state, a, { currentKey: openVault(state, a).currentKey, random, time: vault.now() }).entry);
    const after = vault.state();
    assert.deepEqual(prevKeyProblems(after, openVault(after, b).keys, vault.logs), []);
  });
});
