// @ts-nocheck PoC script, run as is by vaultRound4.test.ts
// S4: replay cost of removals. judgeRemoval runs a full decideContext on each removal's causal
// past, for every device.remove (applied or not) up to 256 per author. A malicious team admin
// approves puppets; every identity writes 256 removals (of unknown ids, so they are all rejected
// but still judged), each naming everything before it. Cost ~ R^2/2 runPass steps.
// Usage: node --import tsx s4...ts [totalRemovals]
import { addDevice, build, dev, entry, found, now, open, random, st } from './lib';
const { VerifyCache } = await import(new URL('../../../src/vault/chain.ts', import.meta.url).href);
const { replayVault, replayWork } = await import(new URL('../../../src/vault/replay.ts', import.meta.url).href);

const TOTAL = Number(process.argv[2] ?? 4000);
const PER = 256;
const A = dev();
const v = found(A, 'team');
const id = v.vaultId;
const M = dev();
addDevice(id, v.logs, A, M, 'admin');
const ids = [M];
for (let i = 0; ids.length * PER < TOTAL; i++) {
  const p = dev();
  addDevice(id, v.logs, M, p, 'admin');
  ids.push(p);
}
const s0 = st(id, v.logs);
const tmpl = build.buildDeviceRemove(s0, M, { device: A.deviceId, currentKey: open.openVault(s0, M).currentKey, random, time: now() }).entry;
const heads: Record<string, { seq: number; hash: string; time: number }> = {};
for (const [d, h] of Object.entries(s0.heads)) heads[d] = { ...(h as any) };
let t = now();
let made = 0;
const keyById = new Map(ids.map((k) => [k.deviceId, k]));
outer: for (const k of ids) {
  for (let j = 0; j < PER; j++) {
    if (made >= TOTAL) break outer;
    const head = heads[k.deviceId]!;
    const seen: Record<string, { seq: number; hash: string }> = {};
    for (const [d, h] of Object.entries(heads)) if (d !== k.deviceId) seen[d] = { seq: h.seq, hash: h.hash };
    const fake = entry.entryHash(tmpl).slice(0, 22); // an id no device has
    const e = entry.signEntry({ v: 2, vault: id, author: k.deviceId, seq: head.seq + 1, prev: head.hash, seen, time: ++t, kind: 'device.remove', body: { ...tmpl.body, device: fake } }, k);
    (v.logs[k.deviceId] ??= []).push(entry.serializeEntry(e));
    heads[k.deviceId] = { seq: e.seq, hash: entry.entryHash(e), time: e.time };
    made++;
  }
}
const lines = Object.values(v.logs).reduce((n, l) => n + l.length, 0);
console.log(`identities ${ids.length + 1}, removals ${made}, lines ${lines}`);
const cache = new VerifyCache();
let t0 = Date.now();
const before = { ...replayWork };
let s = replayVault(id, v.logs, { cache });
console.log(`cold replay ${Date.now() - t0} ms (rejected ${s.rejected.length})`);
console.log(`cold work: ${replayWork.fullJudgements - before.fullJudgements} full judgements, ${replayWork.passSteps - before.passSteps} pass steps, ${cache.signatureChecks} signature checks`);
const warmFrom = { ...replayWork, signatureChecks: cache.signatureChecks };
t0 = Date.now();
s = replayVault(id, v.logs, { cache });
console.log(`warm replay ${Date.now() - t0} ms`);
console.log(`warm work: ${replayWork.fullJudgements - warmFrom.fullJudgements} full judgements, ${replayWork.passSteps - warmFrom.passSteps} pass steps, ${cache.signatureChecks - warmFrom.signatureChecks} signature checks`);
