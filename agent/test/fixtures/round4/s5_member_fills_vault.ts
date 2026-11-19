// @ts-nocheck PoC script, run as is by vaultRound4.test.ts
// S5: a plain team member fills the vault to the 20,000-entry cap through the honest agent
// (VaultStore, temp folder). Every later append, including the admin's removal of that member,
// is refused, so nobody can change the vault again and the member can't be removed.
// PASS = the attack step worked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDevice, build, check, dev, found, now, open, random, rec, st } from './lib';
const { VaultStore } = await import(new URL('../../../src/vaultStore.ts', import.meta.url).href);
const { splitLogText } = await import(new URL('../../../src/vault/logs.ts', import.meta.url).href);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-s5-'));
try {
  const store = new VaultStore({ personal: path.join(home, 'vault'), team: () => path.join(home, 'team') });
  fs.mkdirSync(path.join(home, 'team'));
  const A = dev();
  const Mb = dev();
  const v = found(A, 'team');
  const id = v.vaultId;
  addDevice(id, v.logs, A, Mb, 'member');
  // Seed the folder through the store.
  store.append(id, v.logs[A.deviceId]!.map((l) => JSON.parse(l)).slice(0, 1), false);
  store.append(id, v.logs[A.deviceId]!.map((l) => JSON.parse(l)).slice(1), false);
  store.append(id, v.logs[Mb.deviceId]!.map((l) => JSON.parse(l)), false);
  const readAll = () => {
    const logs: Record<string, string[]> = {};
    const dir = path.join(home, 'team', id, 'log');
    for (const f of fs.readdirSync(dir)) logs[f.replace('.jsonl', '')] = splitLogText(fs.readFileSync(path.join(dir, f), 'utf8'));
    return logs;
  };
  let s = st(id, readAll());
  const key = open.openVault(s, Mb).currentKey;
  const account = build.newAccountId(random);
  let t0 = Date.now();
  let total = Object.values(readAll()).reduce((n, l) => n + l.length, 0);
  let batches = 0;
  while (total < 20_000) {
    const n = Math.min(500, 20_000 - total);
    const entries: any[] = [];
    let draft = s;
    for (let i = 0; i < n; i++) {
      const e = build.buildAccountPut(draft, Mb, { account, record: rec('spam'), currentKey: key, random, time: now() });
      entries.push(e);
      draft = build.afterOwnEntry(draft, e);
    }
    try {
      store.append(id, entries, false);
    } catch (e) {
      console.log('member refused:', (e as Error).message.slice(0, 80));
      break;
    }
    batches++;
    total += n;
    s = draft;
  }
  console.log(`member wrote ${total} lines in ${batches} appends, ${Date.now() - t0} ms`);
  // Admin now removes the member.
  const sA = st(id, readAll());
  const rem = build.buildDeviceRemove(sA, A, { device: Mb.deviceId, currentKey: open.openVault(sA, A).currentKey, random, time: now() });
  let refused = '';
  try { store.append(id, [rem.entry], false); } catch (e) { refused = (e as Error).message; }
  console.log('admin removal:', refused || 'accepted');
  check('the member fills the vault', total >= 20_000);
  check('the admin\'s removal of the member is refused (vault full)', refused !== '');
  // A device's normal account change is refused too.
  const sB = st(id, readAll());
  const put = build.buildAccountPut(sB, A, { account: build.newAccountId(random), record: rec('real'), currentKey: open.openVault(sB, A).currentKey, random, time: now() });
  let refused2 = '';
  try { store.append(id, [put], false); } catch (e) { refused2 = (e as Error).message; }
  check('every other change is refused too', refused2 !== '');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
