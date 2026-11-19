import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AgentError } from '../src/errors';
import type { DeviceKeys } from '../src/vault/crypto';
import { afterOwnEntry, buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, buildKeyRotate, createVault, newAccountId } from '../src/vault/build';
import type { Role } from '../src/vault/bodies';
import type { EntryKind, SignedEntry } from '../src/vault/entry';
import { splitLogText } from '../src/vault/logs';
import { replayVault, type HistoryItem, type Member, type VaultState } from '../src/vault/replay';
import { ADMIN_QUOTA, DEFAULT_QUOTA_LIMITS, MAX_VAULT_BYTES, MAX_VAULT_ENTRIES, MEMBER_QUOTA, quotaProblem, RESERVE_PER_IDENTITY, type QuotaLimits } from '../src/vaultQuota';
import { MAX_LOG_FILES, VaultStore } from '../src/vaultStore';
import { device, seededRandom, totpRecord } from './helpers/vault';

const random = seededRandom('vault-quota-tests');
const MIB = 1024 * 1024;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-quota-'));
}

const isBadRequest = (pattern: RegExp) => (err: AgentError) => err.code === 'bad_request' && pattern.test(err.message);

/** A team vault in a temp team folder: an admin founder, plus helpers that read the folder's files directly. */
function teamVault() {
  const team = tempDir();
  const warnings: string[] = [];
  const store = new VaultStore({ personal: tempDir(), team: () => team }, (line) => warnings.push(line));
  const admin = device(random);
  const created = createVault({ founder: admin, kind: 'team', name: 'Team', deviceName: 'Admin', random, time: 1_000 });
  const vaultId = created.vaultId;
  const logDir = path.join(team, vaultId, 'log');
  store.append(vaultId, [created.entry], false);
  let clock = 2_000;
  const now = () => (clock += 1_000);
  /** The folder's logs as a device would hold them; files the test made unreadable or junk folders are left out. */
  const logs = () => {
    const read: Record<string, string[]> = {};
    for (const file of fs.readdirSync(logDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      try {
        read[file.name.slice(0, -'.jsonl'.length)] = splitLogText(fs.readFileSync(path.join(logDir, file.name), 'utf8'));
      } catch {
        // Unreadable on purpose.
      }
    }
    return read;
  };
  const state = () => replayVault(vaultId, logs());
  const join = (role: Role): DeviceKeys => {
    const joiner = device(random);
    store.append(vaultId, [buildDeviceAdd(state(), admin, { device: joiner, role, name: role, currentKey: created.key, random, time: now() })], false);
    store.append(vaultId, [buildDeviceHello(state(), joiner, now())], false);
    return joiner;
  };
  /** `count` account puts by `author`, each chained on the one before, without writing them. */
  const puts = (author: DeviceKeys, count: number, from = state()): SignedEntry[] => {
    const entries: SignedEntry[] = [];
    let draft = from;
    for (let i = 0; i < count; i++) {
      const entry = buildAccountPut(draft, author, { account: newAccountId(random), record: totpRecord(), currentKey: created.key, random, time: now() });
      entries.push(entry);
      draft = afterOwnEntry(draft, entry);
    }
    return entries;
  };
  /** Writes `count` puts by `author` in batches the store takes. */
  const fill = (author: DeviceKeys, count: number) => {
    const all = puts(author, count);
    for (let i = 0; i < all.length; i += 300) store.append(vaultId, all.slice(i, i + 300), false);
  };
  return { store, admin, created, vaultId, logDir, warnings, now, logs, state, join, puts, fill };
}

describe('S5: one member can\'t fill the vault and freeze it', () => {
  it('refuses a member past its quota, still takes other devices, and admits the admin\'s removal of it', () => {
    const v = teamVault();
    const member = v.join('member');
    const other = v.join('member');
    // Its device.hello is reserved, so the whole quota is left for changes.
    v.fill(member, MEMBER_QUOTA.lines);
    const [over] = v.puts(member, 1);
    assert.throws(() => v.store.append(v.vaultId, [over], false), isBadRequest(/used its share of the vault \(2000 entries or 4 MB\)/));

    v.store.append(v.vaultId, v.puts(other, 1), false);
    v.store.append(v.vaultId, v.puts(v.admin, 1), false);

    const removal = buildDeviceRemove(v.state(), v.admin, { device: member.deviceId, currentKey: v.created.key, random, time: v.now() });
    const { takenOut } = v.store.append(v.vaultId, [removal.entry], false);
    assert.deepEqual(takenOut, [member.deviceId]);
    assert.equal(v.state().members[member.deviceId]?.removed, true);
  });
});

type SyntheticLine = { kind: EntryKind; status?: HistoryItem['status']; bytes?: number; subject?: string };

/** A replay state and logs made by hand: only what quotaProblem reads (chains, history, members, needsFreshKey). */
function synthetic(identities: Record<string, { role?: Role; lines: SyntheticLine[] }>, limits: QuotaLimits = DEFAULT_QUOTA_LIMITS) {
  const chains: Record<string, string[]> = {};
  const history: HistoryItem[] = [];
  const members: Record<string, Member> = {};
  const logs: Record<string, string[]> = {};
  for (const [id, { role, lines }] of Object.entries(identities)) {
    if (role) members[id] = { deviceId: id, ed: '', x: '', role, name: null as never, addedBy: id, joined: true, removed: false, removedBy: [] };
    chains[id] = lines.map((_, seq) => `${id}/${seq}`);
    logs[id] = lines.map(({ bytes = 100 }) => 'x'.repeat(bytes - 1));
    lines.forEach(({ kind, status = 'applied', subject }, seq) => history.push({ hash: `${id}/${seq}`, author: id, seq, time: seq, kind, status, ...(subject ? { subject } : {}) }));
  }
  const state = { chains, history, members, needsFreshKey: false } as unknown as VaultState;
  /**
   * quotaProblem for the vault with one more line by `id`, judged against the vault before it
   * (`needsFreshKey` sets whether that vault needed a fresh key).
   */
  const adding = (id: string, kind: EntryKind, extra: { status?: HistoryItem['status']; bytes?: number; role?: Role; subject?: string; needsFreshKey?: boolean } = {}) => {
    const { role, needsFreshKey = false, ...line } = extra;
    const identity = identities[id] ?? { role, lines: [] };
    const before = { ...state, needsFreshKey } as VaultState;
    return synthetic({ ...identities, [id]: { ...identity, lines: [...identity.lines, { kind, ...line }] } }, limits).problemOfLast(id, before);
  };
  const problemOfLast = (id: string, before: VaultState) => quotaProblem(state, logs, new Set([`${id}/${chains[id]!.length - 1}`]), limits, before);
  return { state, logs, adding, problemOfLast };
}

const puts = (count: number, bytes = 100) => Array.from({ length: count }, () => ({ kind: 'account.put' as const, bytes }));

/** A vault exactly at MAX_VAULT_ENTRIES ordinary lines: an admin plus members within their quotas. */
function fullVault() {
  const identities: Parameters<typeof synthetic>[0] = { admin: { role: 'admin', lines: [{ kind: 'vault.create' }, ...puts(MEMBER_QUOTA.lines - 1)] } };
  for (let i = 0; i < MAX_VAULT_ENTRIES / MEMBER_QUOTA.lines - 1; i++) identities[`member${i}`] = { role: 'member', lines: [{ kind: 'device.hello' }, ...puts(MEMBER_QUOTA.lines)] };
  return identities;
}

describe('room for taking the vault back', () => {
  it('takes an admin\'s removal of a device still in, and a key change the vault needs, when the vault is at the cap, but no account change', () => {
    const vault = synthetic(fullVault());
    assert.equal(vault.adding('admin', 'device.remove', { subject: 'member0' }), null);
    assert.equal(vault.adding('admin', 'key.rotate', { needsFreshKey: true }), null);
    assert.match(vault.adding('admin', 'account.put') ?? '', /vault is full \(20000 entries or 32 MB\)/);
    assert.match(vault.adding('member0', 'account.put') ?? '', /used its share|vault is full/);
  });

  it('counts a key change nobody needed, and a new recovery phrase, as ordinary', () => {
    const vault = synthetic(fullVault());
    assert.match(vault.adding('admin', 'key.rotate', { needsFreshKey: false }) ?? '', /vault is full/);
    assert.match(vault.adding('admin', 'recovery.set') ?? '', /vault is full/);
  });

  it('admits a new device\'s hello and a recovery identity\'s restore when the vault is at the cap', () => {
    const vault = synthetic(fullVault());
    assert.equal(vault.adding('newcomer', 'device.hello', { role: 'member' }), null);
    assert.equal(vault.adding('recovery', 'device.add', { subject: 'newcomer' }), null);
  });

  it('gives a member no reserve: its removals and key changes, which the rules reject, count as ordinary', () => {
    const vault = synthetic(fullVault());
    assert.match(vault.adding('member0', 'device.remove', { status: 'rejected', subject: 'admin' }) ?? '', /used its share/);
    assert.match(vault.adding('member0', 'key.rotate', { status: 'rejected', needsFreshKey: true }) ?? '', /used its share/);
    // An admin's rejected line holds a seq only; it gets no pass either.
    assert.match(vault.adding('admin', 'device.remove', { status: 'rejected', subject: 'member0' }) ?? '', /vault is full/);
  });

  it('bounds each identity\'s reserve, and all reserves together', () => {
    const small: QuotaLimits = { ...DEFAULT_QUOTA_LIMITS, member: { lines: 2, bytes: 1000 }, admin: { lines: 2, bytes: 1000 }, reservePerIdentity: { lines: 1, bytes: 1000 }, vaultReserve: { lines: 2, bytes: 10_000 } };
    const full = { lines: [{ kind: 'device.hello' as const }, ...puts(2)] };
    // One reserved line fits an identity's reserve; past it a reserved line counts as ordinary.
    const own = synthetic({ admin: { role: 'admin', lines: puts(2) } }, small);
    assert.equal(own.adding('admin', 'key.rotate', { needsFreshKey: true }), null);
    const spent = synthetic({ admin: { role: 'admin', ...full } }, small);
    assert.match(spent.adding('admin', 'key.rotate', { needsFreshKey: true }) ?? '', /used its share/);
    // Two hellos fill the vault-wide reserve of 2 lines.
    const crowd = synthetic({ a: { role: 'admin', ...full }, b: { role: 'admin', ...full }, honest: { role: 'admin', lines: puts(1) } }, small);
    assert.match(crowd.adding('honest', 'key.rotate', { needsFreshKey: true }) ?? '', /room for key changes is used up/);
    // A removal of a device still in passes whatever the reserves hold.
    assert.equal(crowd.adding('honest', 'device.remove', { subject: 'a' }), null);
  });

  it('caps a reserve by bytes too', () => {
    const big = Math.ceil(RESERVE_PER_IDENTITY.bytes / 4);
    const identities = fullVault();
    identities.admin!.lines.push(...Array.from({ length: 4 }, () => ({ kind: 'device.hello' as const, bytes: big })));
    assert.match(synthetic(identities).adding('admin', 'key.rotate', { bytes: big, needsFreshKey: true }) ?? '', /vault is full/);
  });
});

describe('byte quotas', () => {
  const lineBytes = 64 * 1024;

  it('refuses a member past its byte share long before its line share', () => {
    const count = Math.floor(MEMBER_QUOTA.bytes / lineBytes);
    const vault = synthetic({ member: { role: 'member', lines: puts(count - 1, lineBytes) } });
    assert.equal(vault.adding('member', 'account.put', { bytes: lineBytes }), null);
    assert.match(synthetic({ member: { role: 'member', lines: puts(count, lineBytes) } }).adding('member', 'account.put', { bytes: lineBytes }) ?? '', /used its share/);
  });

  it('gives an admin a larger byte share, within the vault\'s byte cap', () => {
    const vault = synthetic({ admin: { role: 'admin', lines: puts(Math.floor(MEMBER_QUOTA.bytes / lineBytes) + 10, lineBytes) } });
    assert.equal(vault.adding('admin', 'account.put', { bytes: lineBytes }), null);
    assert.match(synthetic({ admin: { role: 'admin', lines: puts(ADMIN_QUOTA.bytes / lineBytes, lineBytes) } }).adding('admin', 'account.put', { bytes: lineBytes }) ?? '', /used its share of the vault \(8000 entries or 12 MB\)/);

    const admins: Parameters<typeof synthetic>[0] = {};
    const perAdmin = ADMIN_QUOTA.bytes / lineBytes - 1;
    for (let i = 0; i * perAdmin * lineBytes < MAX_VAULT_BYTES; i++) admins[`admin${i}`] = { role: 'admin', lines: puts(perAdmin, lineBytes) };
    admins.last = { role: 'admin', lines: [] };
    assert.match(synthetic(admins).adding('last', 'account.put') ?? '', /vault is full/);
  });

  it('judges only what an append adds: another device still writes when one is over', () => {
    const vault = synthetic({ hog: { role: 'member', lines: puts(MEMBER_QUOTA.lines + 50) }, other: { role: 'member', lines: puts(3) } });
    assert.equal(vault.adding('other', 'account.put'), null);
  });
});

describe('junk in the log folder', () => {
  it('counts no junk lines and no unknown logs, and reads around junk files with a warning', { skip: process.platform === 'win32' }, () => {
    const v = teamVault();
    const member = v.join('member');
    v.fill(member, MEMBER_QUOTA.lines - 1);
    const memberLog = path.join(v.logDir, `${member.deviceId}.jsonl`);
    const honest = fs.readFileSync(memberLog, 'utf8');
    // Junk past the member's verified chain, a nobody's log far over the vault cap, and stray files.
    fs.appendFileSync(memberLog, '{"junk":1}\n'.repeat(5_000));
    const nobody = newAccountId(random);
    fs.writeFileSync(path.join(v.logDir, `${nobody}.jsonl`), 'SECRET-LOOKING-JUNK\n'.repeat(MAX_VAULT_ENTRIES + 1));
    fs.writeFileSync(path.join(v.logDir, 'notes.txt'), 'hello\n');
    fs.writeFileSync(path.join(v.logDir, 'conflicted copy.jsonl'), 'hello\n');
    fs.mkdirSync(path.join(v.logDir, `${newAccountId(random)}.jsonl`));
    const unreadable = path.join(v.logDir, `${newAccountId(random)}.jsonl`);
    fs.writeFileSync(unreadable, 'x\n');
    fs.chmodSync(unreadable, 0o000);
    const oversized = newAccountId(random);
    fs.writeFileSync(path.join(v.logDir, `${oversized}.jsonl`), `${'y'.repeat(200 * 1024)}\n{"after":1}\n`);

    const read = v.store.read(v.vaultId, { [nobody]: MAX_VAULT_ENTRIES + 1 });
    assert.equal(read.lengths[member.deviceId], MEMBER_QUOTA.lines + 5_000, 'junk lines are served for devices to judge');
    assert.equal(read.lengths[oversized], 0, 'a line no entry could be ends its log');

    // The member's last line of quota replaces its junk tail; nothing junk counted against it.
    const [last] = v.puts(member, 1);
    v.store.append(v.vaultId, [last], false);
    assert.ok(fs.readFileSync(memberLog, 'utf8').startsWith(honest));
    assert.throws(() => v.store.append(v.vaultId, v.puts(member, 1), false), isBadRequest(/used its share/));
    v.store.append(v.vaultId, v.puts(v.admin, 1), false);

    const warned = v.warnings.join('\n');
    assert.match(warned, /not a device log was skipped/);
    if (process.getuid?.() !== 0) assert.match(warned, /could not be opened \(EACCES\)/);
    assert.match(warned, new RegExp(`end of the log ${oversized} was ignored: line 1 is larger than an entry may be`));
    assert.equal(warned.includes('SECRET-LOOKING-JUNK'), false, 'warnings never quote log contents');
    const before = v.warnings.length;
    v.store.read(v.vaultId, undefined);
    assert.equal(v.warnings.length, before, 'each junk file is reported once');
    fs.chmodSync(unreadable, 0o600);
  });

  it('reads the vault\'s own logs when junk logs crowd the folder, and keeps taking changes', () => {
    const v = teamVault();
    const member = v.join('member');
    for (let i = 0; i < MAX_LOG_FILES + 10; i++) fs.writeFileSync(path.join(v.logDir, `${newAccountId(random)}.jsonl`), `{"junk":${i}}\n`);
    const read = v.store.read(v.vaultId, undefined);
    assert.deepEqual(Object.keys(read.lengths).sort(), [v.admin.deviceId, member.deviceId].sort());
    v.store.append(v.vaultId, v.puts(member, 1), false);
    const late = v.join('member');
    assert.equal(v.store.read(v.vaultId, undefined).lengths[late.deviceId], 1);
    assert.match(v.warnings.join('\n'), /only the logs of the vault's own devices were read/);
  });

  it('reads past a junk log larger than the folder budget to the vault\'s own logs', () => {
    const v = teamVault();
    v.fill(v.admin, 3);
    const rotate = buildKeyRotate(v.state(), v.admin, { currentKey: v.created.key, random, time: v.now() });
    v.store.append(v.vaultId, [rotate.entry], false);
    // Four files, each just under the vault size, pass what one folder read holds.
    const line = `${'z'.repeat(100 * 1024)}\n`;
    const junk = line.repeat(Math.floor((MAX_VAULT_BYTES - MIB) / line.length));
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(v.logDir, `${newAccountId(random)}.jsonl`), junk);
    assert.deepEqual(v.store.read(v.vaultId, undefined).lengths, { [v.admin.deviceId]: 5 });
    v.store.append(v.vaultId, v.puts(v.admin, 1), false);
  });
});
