// @ts-nocheck PoC script, run as is by the round-5 tests
// T4: a malicious admin M also approves a joining device N, with N's own signing and sealing keys
// (both public on the join relay) but a garbage sealed key, and orders first (lower time).
// N's checkJoinedVault accepts the honest approver A's approval and N says hello. The vault then
// holds M's garbage key for N: N can't open the vault, N is not "unkeyed" (so nobody re-approves
// it), and a re-approval at this epoch is refused by the rules.
// PASS = the attack step worked.
import { addDevice, approval, build, check, crypto, dev, entry, found, now, open, random, st } from './lib';
const A = dev(), M = dev(), N = dev();
const v = found(A, 'team');
const id = v.vaultId;
addDevice(id, v.logs, A, M, 'admin', 'M');
const s0 = st(id, v.logs);
const keyA = open.openVault(s0, A).currentKey;
const keyM = open.openVault(s0, M).currentKey;
const pubN = { deviceId: N.deviceId, edPublic: N.edPublic, xPublic: N.xPublic };
// A's honest approval (time t), M's squat with a garbage sealed key and a lower time.
const addA = build.buildDeviceAdd(s0, A, { device: pubN, role: 'member', name: 'N', currentKey: keyA, random, time: now() + 10_000 });
const garbage = random(32);
const addMraw = build.buildDeviceAdd(s0, M, { device: pubN, role: 'member', name: 'N', currentKey: garbage, random, time: 0 });
v.logs[A.deviceId]!.push(entry.serializeEntry(addA));
v.logs[M.deviceId]!.push(entry.serializeEntry(addMraw));
const s1 = st(id, v.logs);
// N's own check, as join.ts does it.
const challenge = { ed: (await import(new URL('../../../src/vault/bytes.ts', import.meta.url).href)).toBase64Url(A.edPublic), x: (await import(new URL('../../../src/vault/bytes.ts', import.meta.url).href)).toBase64Url(A.xPublic), vault: id, vaultName: 'Home', name: 'Founder', nonce: '' } as any;
let verdict: any;
try { verdict = approval.checkJoinedVault(s1, N, challenge); } catch (e) { verdict = (e as Error).message; }
console.log('N checkJoinedVault:', verdict);
v.logs[N.deviceId] = [entry.serializeEntry(build.buildDeviceHello(s1, N, now()))];
const s2 = st(id, v.logs);
console.log('N joined:', s2.members[N.deviceId].joined, 'unkeyed:', s2.unkeyedDevices.includes(N.deviceId));
let opened = 'opened';
try { open.openVault(s2, N); } catch (e) { opened = (e as Error).message; }
console.log('N opens the vault:', opened);
// A tries to approve N again at this epoch.
const again = build.buildDeviceAdd(s2, A, { device: pubN, role: 'member', name: 'N', currentKey: keyA, random, time: now() });
v.logs[A.deviceId]!.push(entry.serializeEntry(again));
const s3 = st(id, v.logs);
const h = s3.history.find((x: any) => x.hash === entry.entryHash(again));
console.log('re-approval:', h?.status, h?.reason);
check('the joined device N can\'t open the vault, and is not offered re-approval', opened !== 'opened' && !s2.unkeyedDevices.includes(N.deviceId));
