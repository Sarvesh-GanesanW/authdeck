// @ts-nocheck PoC script, run as is by the round-5 tests
// T5: since only the newest line's signature is checked, a member X can put a line with a
// garbage signature at seq k and vouch for it by signing seq k+1 over its hash. X shows device D a
// validly signed e_k', and the folder e_k'' (bad sig) + e_k+1. Both chains verify, but no fork
// proof can be made (e_k'' is not signed), so X is never cut off; D keeps its own copy (local
// wins), and the honest removal of X built on the folder waits forever on D.
// PASS = the attack step worked.
import { addDevice, build, check, dev, entry, found, now, open, random, rec, st } from './lib';
const { mergeLogs, provenForks } = await import(new URL('../../../../app/src/auth/engine/sync.ts', import.meta.url).href);
const { findForks } = await import(new URL('../../../src/vault/rollback.ts', import.meta.url).href);
const A = dev(), D = dev(), X = dev();
const v = found(A, 'team');
const id = v.vaultId;
addDevice(id, v.logs, A, D, 'admin', 'D');
addDevice(id, v.logs, A, X, 'member', 'X');
const s0 = st(id, v.logs);
const kx = open.openVault(s0, X).currentKey;
const acct = build.newAccountId(random);
// Version 1 (shown to D): a valid put.
const e1 = build.buildAccountPut(s0, X, { account: acct, record: rec('Bank', 'JBSWY3DPEHPK3PXPJBSWY3DP'), currentKey: kx, random, time: now() });
const dLogs = { ...v.logs, [X.deviceId]: [...v.logs[X.deviceId]!, entry.serializeEntry(e1)] };
// Version 2 (folder): same seq, other content, signature garbage; then a signed line over it.
const e2u = build.buildAccountPut(s0, X, { account: acct, record: rec('Bank', 'GEZDGNBVGY3TQOJQGEZDGNBVGY'), currentKey: kx, random, time: now() });
const e2: any = { ...e2u, sig: 'A'.repeat(86) };
const e3 = build.buildAccountPut(build.afterOwnEntry(s0, e2), X, { account: build.newAccountId(random), record: rec('Mail'), currentKey: kx, random, time: now() });
const fLogs = { ...v.logs, [X.deviceId]: [...v.logs[X.deviceId]!, entry.serializeEntry(e2), entry.serializeEntry(e3)] };
const fs0 = st(id, fLogs);
const sigOk = entry.entrySignatureValid(e2, X.edPublic);
const statusE2 = fs0.history.find((h: any) => h.hash === entry.entryHash(e2))?.status;
console.log(`folder: e_k'' signature valid=${sigOk}, status=${statusE2}`);
check('a line with a garbage signature is applied (vouched for by the next line)', !sigOk && statusE2 === 'applied');
// A (on the folder) removes X.
const rem = build.buildDeviceRemove(fs0, A, { device: X.deviceId, currentKey: open.openVault(fs0, A).currentKey, random, time: now() });
fLogs[A.deviceId] = [...fLogs[A.deviceId]!, entry.serializeEntry(rem.entry)];
const fs1 = st(id, fLogs);
console.log('folder: X removed =', fs1.members[X.deviceId].removed);
// D syncs.
const dState = st(id, dLogs);
const merged = mergeLogs(dLogs, dState, fLogs, fs1);
const proofs = findForks(dLogs, dState, fLogs, fs1);
const valid = provenForks(st(id, merged.logs), proofs);
const after = st(id, merged.logs);
const remOnD = after.history.find((h: any) => h.hash === entry.entryHash(rem.entry));
console.log(`D: diverged=${merged.diverged.length}, fork proofs found=${proofs.length}, valid=${valid.length}; removal of X on D: ${remOnD?.status} (${remOnD?.reason ?? ''}); X removed on D=${after.members[X.deviceId].removed}`);
check('no valid fork proof can be made, so X is never cut off by a proof', proofs.length > 0 && valid.length === 0);
check('the honest removal of X waits forever on D (copies never converge)', remOnD?.status === 'waiting' && !after.members[X.deviceId].removed);
