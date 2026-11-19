// @ts-nocheck PoC script, run as is by the round-5 tests
// T1: unsigned junk lines chained by prev onto an honest log force one signature check each
// (verifyChain walks back from the newest line), on every replay, warm cache or not.
// Folder writer / hostile computer. PASS = the attack step worked (replay over budget).
import { build, chain, check, dev, entry, found, now, open, random, rec, st, addDevice } from './lib';
const N = Number(process.argv[2] ?? 20000);
const A = dev();
const B = dev();
const v = found(A, 'team');
addDevice(v.vaultId, v.logs, A, B, 'admin');
const s = st(v.vaultId, v.logs);
const key = open.openVault(s, A).currentKey;
// One real signed put to copy a body shape from.
const real = build.buildAccountPut(s, A, { account: build.newAccountId(random), record: rec(), currentKey: key, random, time: now() });
const lines = [...v.logs[A.deviceId]!];
let prev = entry.entryHash(JSON.parse(lines[lines.length - 1]!));
const badSig = 'A'.repeat(85) + 'A';
for (let i = 0; i < N; i++) {
  const e = { ...real, seq: lines.length, prev, sig: badSig, time: real.time + i };
  lines.push(entry.serializeEntry(e as any));
  prev = entry.entryHash(e as any);
}
const logs = { ...v.logs, [A.deviceId]: lines };
const cache = new chain.VerifyCache();
let t = Date.now();
let r = st(v.vaultId, logs);
const cold = Date.now() - t;
t = Date.now();
r = (await import(new URL('../../../src/vault/replay.ts', import.meta.url).href)).replayVault(v.vaultId, logs, { cache });
const warm1 = Date.now() - t;
t = Date.now();
r = (await import(new URL('../../../src/vault/replay.ts', import.meta.url).href)).replayVault(v.vaultId, logs, { cache });
const warm2 = Date.now() - t;
console.log(`junk=${N} cold=${cold}ms warm(1st with cache)=${warm1}ms warm(2nd)=${warm2}ms; A chain kept=${r.chains[A.deviceId]!.length}; rejection=${r.rejected[0]?.reason.slice(0, 80)}`);
check('a warm agent replay is over 1 s because of unsigned junk', warm2 > 1000, `${warm2} ms`);
