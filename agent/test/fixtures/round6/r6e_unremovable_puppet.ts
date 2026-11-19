// @ts-nocheck PoC script, run as is by vaultRound6.test.ts
// R6-E: removals are judged with the verdicts as they stand BEFORE settleCutOffRemovals voids
// removals by cut-off authors (replay.ts judgeRemoval precheck and decideContext on the past both
// read the shared pre-settle `verdicts`). A removal r1 that is later voided by rule 1 still counts as
// "already removed" for every removal whose past holds it. So once an honest device has built on r1,
// its target can never be removed again by anyone who saw that device's lines.
// Thief X approves puppet P, then (not yet seeing its own removal by A) "removes" P itself; B syncs
// and builds on that; A's removal of X lands; r1 is voided and P is back in; B's removal of P is
// refused forever. All lines go through the honest agent. PASS = the attack worked.
import { addDevice, agentAppend, build, check, dev, found, now, open, random, rec, st, status, summary } from './lib.ts';

const A = dev(), B = dev(), X = dev(), P = dev();
const v = found(A);
const { vaultId, logs } = v;
const names = { [A.deviceId]: 'A', [B.deviceId]: 'B', [X.deviceId]: 'X', [P.deviceId]: 'P' };
addDevice(vaultId, logs, A, B, 'admin', 'B');
addDevice(vaultId, logs, A, X, 'admin', 'X');
addDevice(vaultId, logs, X, P, 'admin', 'P'); // X (stolen) approves its puppet P
const acct = build.newAccountId(random);
{ const s0 = st(vaultId, logs); agentAppend(vaultId, logs, [build.buildAccountPut(s0, A, { account: acct, record: rec('Old'), currentKey: open.openVault(s0, A).currentKey, random, time: now() })]); }

// 1. A notices the theft and removes X while offline (kept unsent).
let s = st(vaultId, logs);
const q = build.buildDeviceRemove(s, A, { device: X.deviceId, currentKey: open.openVault(s, A).currentKey, random, time: now() }).entry;

// 2. The thief, still in at the computer, "removes" its own puppet P.
s = st(vaultId, logs);
const r1 = build.buildDeviceRemove(s, X, { device: P.deviceId, currentKey: open.openVault(s, X).currentKey, random, time: now() }).entry;
agentAppend(vaultId, logs, [r1]);

// 3. Honest B syncs (P looks removed) and writes an ordinary change, naming X's head (r1).
s = st(vaultId, logs);
const b1 = build.buildAccountDelete(s, B, { account: acct, time: now() }); // key-independent, so it stays applied
agentAppend(vaultId, logs, [b1]);

// 4. A comes online: its removal of X is taken; r1 is voided (rule 1), so P is back in.
agentAppend(vaultId, logs, [q]);
s = st(vaultId, logs);
console.log('after A\'s removal:', summary(s, names), '| r1:', status(s, r1));

// 5. B (or anyone who saw B's lines) removes P: refused.
if (s.needsFreshKey) {
  const k = build.buildKeyRotate(s, B, { currentKey: open.openVault(s, B).currentKey, random, time: now() }).entry;
  agentAppend(vaultId, logs, [k]);
  s = st(vaultId, logs);
}
const r3 = build.buildDeviceRemove(s, B, { device: P.deviceId, currentKey: open.openVault(s, B).currentKey, random, time: now() }).entry;
let refused = '';
try { agentAppend(vaultId, logs, [r3]); } catch (err) { refused = (err as Error).message; }
// Also a removal by A after it syncs (its past then holds B's lines and r1 through them).
s = st(vaultId, logs);
const r4 = build.buildDeviceRemove(s, A, { device: P.deviceId, currentKey: open.openVault(s, A).currentKey, random, time: now() }).entry;
let refusedA = '';
try { agentAppend(vaultId, logs, [r4]); } catch (err) { refusedA = (err as Error).message; }
s = st(vaultId, logs);
const p = s.members[P.deviceId]!;
check('r1 (X removing its own puppet) is voided by A\'s removal of X', status(s, r1).startsWith('rejected'));
check('P is back in the vault, active', p.joined && !p.removed);
check('B\'s removal of P is rejected', refused !== '' || status(s, r3).startsWith('rejected'), refused || status(s, r3));
check('A\'s removal of P (after syncing) is rejected too', refusedA !== '' || status(s, r4).startsWith('rejected'), refusedA || status(s, r4));
check('P stays in, unremovable, holding the vault key', !s.members[P.deviceId]!.removed && !!s.sealedKeys[s.epoch]?.[P.deviceId]);
console.log('P member:', JSON.stringify({ joined: p.joined, removed: p.removed, removedBy: p.removedBy }));
for (const h of s.history) console.log(names[h.author], h.seq, h.kind, h.subject ? names[h.subject] ?? '' : '', h.status, h.reason ?? '');
