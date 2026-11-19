// @ts-nocheck PoC script, run as is by the round-5 tests
// T3: a removed thief X (team folder write access, or its stale copy pushed by a hostile computer)
// writes stale removals of every honest device straight into the folder. They are voided, and
// every honest admin's Vault screen then offers "Remove <honest device> again" for each.
// PASS = the attack step worked.
import { addDevice, build, check, dev, entry, found, now, open, random, st } from './lib';
const { listVoidedChanges } = await import(new URL('../../../../app/src/auth/engine/voided.ts', import.meta.url).href);
const A = dev(), B = dev(), C = dev(), X = dev();
const v = found(A, 'team');
const id = v.vaultId;
addDevice(id, v.logs, A, B, 'admin', 'B');
addDevice(id, v.logs, A, C, 'admin', 'C');
addDevice(id, v.logs, A, X, 'admin', 'X');
const stale = st(id, v.logs); // X's copy, before its removal
const s1 = st(id, v.logs);
v.logs[A.deviceId]!.push(entry.serializeEntry(build.buildDeviceRemove(s1, A, { device: X.deviceId, currentKey: open.openVault(s1, A).currentKey, random, time: now() }).entry));
// X, never having seen its removal, removes B, then (from a stale view including B) C.
const kx = open.openVault(stale, X).currentKey;
const r1 = build.buildDeviceRemove(stale, X, { device: B.deviceId, currentKey: kx, random, time: now() });
v.logs[X.deviceId]!.push(entry.serializeEntry(r1.entry));
const r2 = build.buildDeviceRemove(build.afterOwnEntry(stale, r1.entry), X, { device: C.deviceId, currentKey: kx, random, time: now() });
v.logs[X.deviceId]!.push(entry.serializeEntry(r2.entry));
const s = st(id, v.logs);
console.log('members:', Object.values(s.members).map((m: any) => `${m.deviceId === A.deviceId ? 'A' : m.deviceId === B.deviceId ? 'B' : m.deviceId === C.deviceId ? 'C' : 'X'}${m.removed ? ':out' : ''}`).join(' '));
const names = { [A.deviceId]: 'A', [B.deviceId]: 'Pixel B', [C.deviceId]: 'iPad C', [X.deviceId]: 'X' };
for (const me of [A, B, C]) {
  const list = listVoidedChanges({ state: s, logs: v.logs, deviceNames: names, me: me.deviceId, handled: new Set() });
  console.log(`on ${names[me.deviceId]}:`, list.map((l: any) => `${l.text} [${l.redo?.label ?? 'no button'}]`));
}
const onA = listVoidedChanges({ state: s, logs: v.logs, deviceNames: names, me: A.deviceId, handled: new Set() });
check('an honest admin is offered "Remove <honest device> again" by a thief\'s voided lines', onA.some((l: any) => l.redo?.device === B.deviceId) && onA.some((l: any) => l.redo?.device === C.deviceId));
