// @ts-nocheck PoC script, run as is by the round-5 tests
// T6 (S4, new shape): puppet admins first write a long chain of applied key.rotate entries (all
// membership lines, all within quotas and the reserve), then each writes 8 removals that pass the
// cheap prechecks but fail the full check (epoch 0). Each of those runs a full decideContext over
// a past of thousands of membership entries. Measures cold and warm replay.
// Usage: node --import tsx t6...ts [puppets] [rotationsEach]
import { addDevice, build, check, chain, dev, entry, found, now, open, random, st } from './lib';
const { replayVault, replayWork } = await import(new URL('../../../src/vault/replay.ts', import.meta.url).href);
const PUP = Number(process.argv[2] ?? 20), ROT = Number(process.argv[3] ?? 256);
const A = dev(), M = dev();
const v = found(A, 'team');
const id = v.vaultId;
addDevice(id, v.logs, A, M, 'admin');
const P = [M];
for (let i = 1; i < PUP; i++) { const p = dev(); addDevice(id, v.logs, M, p, 'admin'); P.push(p); }
const base = st(id, v.logs);
let key = open.openVault(base, M).currentKey;
let epoch = base.epoch;
const heads: Record<string, any> = { ...base.heads };
const applied: Record<string, any> = { ...base.appliedHeads };
const push = (author: any, e: any) => { const h = { seq: e.seq, hash: entry.entryHash(e), time: e.time }; heads[author.deviceId] = h; applied[author.deviceId] = h; v.logs[author.deviceId]!.push(entry.serializeEntry(e)); };
for (let r = 0; r < ROT; r++) for (const a of P) {
  const res = build.buildKeyRotate({ ...base, epoch, heads, appliedHeads: applied }, a, { currentKey: key, random, time: now() });
  push(a, res.entry); epoch++; key = res.newKey;
}
for (const a of P) for (let i = 0; i < 8; i++) {
  const res = build.buildDeviceRemove({ ...base, epoch, heads, appliedHeads: applied }, a, { device: A.deviceId, currentKey: key, random, time: now() });
  const { sig, ...u } = res.entry as any; u.body = { ...u.body, epoch: 0, prevKey: { ...u.body.prevKey, epoch: 0 } };
  push(a, entry.signEntry(u, a));
}
const lines = Object.values(v.logs).reduce((n, l) => n + l.length, 0);
const cache = new chain.VerifyCache();
const w0 = { ...replayWork };
let t = Date.now(); let s = replayVault(id, v.logs, { cache }); const cold = Date.now() - t;
const coldWork = { judgements: replayWork.fullJudgements - w0.fullJudgements, steps: replayWork.passSteps - w0.passSteps, signatures: cache.signatureChecks };
const w1 = { ...replayWork, signatures: cache.signatureChecks };
t = Date.now(); s = replayVault(id, v.logs, { cache }); const warm = Date.now() - t;
const warmWork = { judgements: replayWork.fullJudgements - w1.fullJudgements, steps: replayWork.passSteps - w1.passSteps, signatures: cache.signatureChecks - w1.signatures };
const rots = s.history.filter((h: any) => h.kind === 'key.rotate' && h.status === 'applied').length;
const rems = s.history.filter((h: any) => h.kind === 'device.remove').map((h: any) => h.reason);
console.log(`puppets ${PUP}, lines ${lines}, applied rotations ${rots}, removals ${rems.length} (e.g. "${rems[0]}"), epoch ${s.epoch}`);
console.log(`cold ${cold} ms, warm ${warm} ms`);
console.log(`cold work: ${coldWork.judgements} full judgements, ${coldWork.steps} pass steps, ${coldWork.signatures} signature checks`);
console.log(`warm work: ${warmWork.judgements} full judgements, ${warmWork.steps} pass steps, ${warmWork.signatures} signature checks`);
// Work, not time, so a busy machine can't fail it: each line's signature once, at most
// MAX_FAILED_JUDGEMENTS_PER_VAULT (64) full judgements, each a pass over at most every line, and
// the main passes; a warm replay checks no signature and judges nothing again.
check('cold replay checks a signature more than once', coldWork.signatures > lines, `${coldWork.signatures} for ${lines} lines`);
check('cold replay judges more than 64 removals in full', coldWork.judgements > 64, `${coldWork.judgements}`);
check('cold replay steps past 64 full passes plus the main ones', coldWork.steps > (64 + 8) * lines, `${coldWork.steps} steps for ${lines} lines`);
check('warm replay redoes signatures or judgements', warmWork.signatures > 0 || warmWork.judgements > 0, JSON.stringify(warmWork));
// A generous backstop only.
check('warm replay over 10 s', warm > 10_000, `${warm} ms`);
check('cold replay over 120 s', cold > 120_000, `${cold} ms`);
