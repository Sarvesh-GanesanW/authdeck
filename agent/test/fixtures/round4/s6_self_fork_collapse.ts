// @ts-nocheck PoC script, run as is by vaultRound4.test.ts
// S6: a thief forks its OWN log at a low seq on purpose. A valid fork proof cuts the forker off
// before the forked seq, so everything it signed from there is rejected retroactively, including
// its approvals of honest devices and its recovery.set. Every device it approved (and every device
// those approved) never joined; their changes are all rejected. Works after the thief was removed:
// the agent's writeFork takes a proof about any member, removed ones included.
// PASS = the attack step worked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDevice, build, check, clone, dev, entry, found, now, open, random, rec, st, status, summary, put, recovery } from './lib';
const { replayVault } = await import(new URL('../../../src/vault/replay.ts', import.meta.url).href);
const { VaultStore } = await import(new URL('../../../src/vaultStore.ts', import.meta.url).href);

const F = dev(); // founder phone, later stolen
const B = dev(); // tablet, approved by F
const C = dev(); // laptop-side phone, approved by B
const names = { [F.deviceId]: 'F', [B.deviceId]: 'B', [C.deviceId]: 'C' };

// Like the app: vault.create then recovery.set as F's seq 1.
const v = found(F, 'personal');
const id = v.vaultId;
const s0 = st(id, v.logs);
const phrase = recovery.generateRecoveryPhrase(random);
const rs = recovery.buildRecoverySetFromPhrase(s0, F, { phrase, currentKey: open.openVault(s0, F).currentKey, random, time: now() });
put(v.logs, rs.entry);
addDevice(id, v.logs, F, B);
addDevice(id, v.logs, B, C);
for (const who of [B, C]) {
  const s = st(id, v.logs);
  put(v.logs, build.buildAccountPut(s, who, { account: build.newAccountId(random), record: rec(`by-${names[who.deviceId]}`), currentKey: open.openVault(s, who).currentKey, random, time: now() }));
}
// B removes the stolen phone.
const s1 = st(id, v.logs);
put(v.logs, build.buildDeviceRemove(s1, B, { device: F.deviceId, currentKey: open.openVault(s1, B).currentKey, random, time: now() }).entry);
const before = st(id, v.logs);
console.log('before', summary(before, names), 'recovery set:', !!before.recovery);

// Thief signs a second, different entry at seq 1 (any kind), on the vault as of seq 0.
const s0b = st(id, { [F.deviceId]: [v.logs[F.deviceId]![0]!] });
const alt = build.buildEntry(s0b, F, 'account.delete', { account: build.newAccountId(random) }, now());
const proof = { deviceId: F.deviceId, seq: 1, lines: [v.logs[F.deviceId]![1]!, entry.serializeEntry(alt)] as [string, string] };

// The honest agent stores the proof (F is removed, but still "a device this vault knows").
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-s6-'));
let stored = false;
try {
  const store = new VaultStore({ personal: path.join(home, 'vault'), team: () => null });
  const dir = path.join(home, 'vault', id, 'log');
  fs.mkdirSync(dir, { recursive: true });
  for (const [d, lines] of Object.entries(v.logs)) fs.writeFileSync(path.join(dir, `${d}.jsonl`), lines.join('\n') + '\n');
  store.writeFork(id, proof);
  stored = store.readForks(id).forks.length === 1;
} catch (e) { console.log('writeFork refused:', (e as Error).message); }
finally { fs.rmSync(home, { recursive: true, force: true }); }

const after = replayVault(id, v.logs, { forks: [proof] });
console.log('after ', summary(after, names), 'recovery set:', !!after.recovery);
check('the honest agent stores the self-fork proof of removed F', stored);
check('B (approved by F before the theft) is no longer an active member', !after.members[B.deviceId] || after.members[B.deviceId]!.removed || !after.members[B.deviceId]!.joined);
check('C (approved by B) is gone too', !after.members[C.deviceId] || after.members[C.deviceId]!.removed || !after.members[C.deviceId]!.joined);
check('no active device is left', Object.values(after.members).every((m: any) => m.removed || !m.joined));
check('the recovery phrase no longer applies (vault unrecoverable)', !after.recovery);
check('all accounts gone, none caught for review', Object.keys(after.accounts).length === 0 && !after.history.some((h: any) => h.caught), `${Object.keys(before.accounts).length} -> ${Object.keys(after.accounts).length}`);
