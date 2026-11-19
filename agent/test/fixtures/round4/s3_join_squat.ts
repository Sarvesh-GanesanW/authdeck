// @ts-nocheck PoC script, run as is by vaultRound4.test.ts
// S3: a malicious admin M (team vault) squats a pending join. It sees the joiner's ed in the join
// request the agent relays, and signs device.add(N, ed_N, x_M) with a low time, so it is N's FIRST
// approval. Then:
//  (a) the joiner's check (checkJoinedVault) reads members[N].x = first approval's x and reports
//      "intercepted" for the honest approver's add; N never writes hello. The app keeps N's keys
//      (keysForNewMembership), so every retry fails the same way.
//  (b) the honest admin can no longer remove M: the builder leaves pending N out (its addedBy is M,
//      the device being removed), but the rules count N as staying through the honest approval.
// PASS = the attack step worked.
import { agentAppend, build, check, dev, found, now, open, random, st, status, summary, addDevice, bytes } from './lib';
const approval = await import(new URL('../../../src/vault/approval.ts', import.meta.url).href);

const A = dev(); // honest founder admin
const M = dev(); // malicious admin
const N = dev(); // joiner
const names = { [A.deviceId]: 'A', [M.deviceId]: 'M', [N.deviceId]: 'N' };
const v = found(A, 'team');
const id = v.vaultId;
addDevice(id, v.logs, A, M, 'admin');

// M squats: device.add(N) with N's ed and M's own x, time backdated to sort first.
const s0 = st(id, v.logs);
const kM = open.openVault(s0, M).currentKey;
const squat = build.buildDeviceAdd(s0, M, { device: { deviceId: N.deviceId, edPublic: N.edPublic, xPublic: M.xPublic }, role: 'member', name: 'N', currentKey: kM, random, time: 1 });
agentAppend(id, v.logs, [squat]);

// Honest A approves N as normal (it saw M's add; nothing stops it).
const s1 = st(id, v.logs);
const kA = open.openVault(s1, A).currentKey;
const honest = build.buildDeviceAdd(s1, A, { device: { deviceId: N.deviceId, edPublic: N.edPublic, xPublic: N.xPublic }, role: 'member', name: 'N', currentKey: kA, random, time: now() });
agentAppend(id, v.logs, [honest]);
const s2 = st(id, v.logs);
console.log('state', summary(s2, names), 'N.x is M.x:', s2.members[N.deviceId]!.x === bytes.toBase64Url(M.xPublic));

const challenge = { ed: bytes.toBase64Url(A.edPublic), x: bytes.toBase64Url(A.xPublic), vault: id, vaultName: 'Home', name: 'Founder', nonce: 'x' };
const verdict = approval.checkJoinedVault(s2, N, challenge);
console.log('joiner verdict:', verdict);
check('(a) the joiner is told "intercepted" for the honest approval and never joins', verdict.status === 'intercepted');

// A approves again (retry): same keys, same outcome.
const s3 = st(id, v.logs);
const again = build.buildDeviceAdd(s3, A, { device: { deviceId: N.deviceId, edPublic: N.edPublic, xPublic: N.xPublic }, role: 'member', name: 'N', currentKey: open.openVault(s3, A).currentKey, random, time: now() });
agentAppend(id, v.logs, [again]);
const v2 = approval.checkJoinedVault(st(id, v.logs), N, challenge);
check('(a) a retry with the same keys is "intercepted" again', v2.status === 'intercepted');

// (b) A tries to remove M with the app's builder.
const s4 = st(id, v.logs);
const rem = build.buildDeviceRemove(s4, A, { device: M.deviceId, currentKey: open.openVault(s4, A).currentKey, random, time: now() });
let refused = '';
try { agentAppend(id, v.logs, [rem.entry]); } catch (e) { refused = (e as Error).message; }
// The app replays locally before sending (appendOwn) and throws if the entry is not applied.
const local = st(id, { ...v.logs, [A.deviceId]: [...v.logs[A.deviceId]!, (await import(new URL('../../../src/vault/entry.ts', import.meta.url).href)).serializeEntry(rem.entry)] });
console.log('removal of M, local replay:', status(local, rem.entry), '| agent:', refused || 'accepted');
check('(b) the honest admin cannot remove malicious M', status(local, rem.entry).startsWith('rejected'));
