// @ts-nocheck PoC script, run as is by the round-6 tests
// Round-2 PoC helpers. Imports the vault core read-only from the repo (agent copy; app copy is byte-identical).
import { randomBytes } from 'node:crypto';
const SRC = new URL('../../../src/vault', import.meta.url).href;
export const build = await import(`${SRC}/build.ts`);
export const crypto = await import(`${SRC}/crypto.ts`);
export const entry = await import(`${SRC}/entry.ts`);
export const replay = await import(`${SRC}/replay.ts`);
export const open = await import(`${SRC}/open.ts`);
export const logs = await import(`${SRC}/logs.ts`);
export const approval = await import(`${SRC}/approval.ts`);
export const recovery = await import(`${SRC}/recovery.ts`);
export const rollback = await import(`${SRC}/rollback.ts`);
export const beacon = await import(`${SRC}/beacon.ts`);
export const bytes = await import(`${SRC}/bytes.ts`);
export const chain = await import(`${SRC}/chain.ts`);
export const order = await import(`${SRC}/order.ts`);

export const random = (n: number) => new Uint8Array(randomBytes(n));
export const dev = () => crypto.generateDeviceKeys(random);
// Throwaway test-only TOTP secret (RFC example style), never a real one.
export const rec = (issuer = 'Example', secret = 'JBSWY3DPEHPK3PXPJBSWY3DP') => ({ issuer, label: 'poc', secret, type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, counter: 0 });

let clock = 1_700_000_000_000;
export const now = () => (clock += 1000);

export type Logs = Record<string, string[]>;
export const ser = (e: any) => entry.serializeEntry(e);
export const clone = (l: Logs): Logs => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, [...v]]));
export const st = (vaultId: string, l: Logs) => replay.replayVault(vaultId, l);
export const put = (l: Logs, e: any) => ((l[e.author] ??= []).push(ser(e)), e);

/** Honest-agent append: refuses unless planAppend passes; mutates logs on success. */
export function agentAppend(vaultId: string, l: Logs, entries: any[], opts: any = {}) {
  const plan = logs.planAppend(vaultId, l, entries, opts);
  for (const id of plan.changed) l[id] = [...plan.logs[id]];
  return plan;
}

export function found(founder: any, kind: 'personal' | 'team' = 'personal') {
  const c = build.createVault({ founder, kind, name: 'Home', deviceName: 'Founder', random, time: now() });
  const l: Logs = {};
  put(l, c.entry);
  return { vaultId: c.vaultId as string, key: c.key as Uint8Array, logs: l };
}

/** admin adds device `d` (role) and d writes hello. Returns nothing; mutates logs. */
export function addDevice(vaultId: string, l: Logs, admin: any, d: any, role: 'admin' | 'member' = 'admin', name = 'dev') {
  const s = st(vaultId, l);
  const key = open.openVault(s, admin).currentKey;
  put(l, build.buildDeviceAdd(s, admin, { device: d, role, name, currentKey: key, random, time: now() }));
  put(l, build.buildDeviceHello(st(vaultId, l), d, now()));
}

export function status(s: any, e: any) {
  const h = s.history.find((x: any) => x.hash === entry.entryHash(e));
  return h ? `${h.status}${h.reason ? ` (${h.reason})` : ''}` : 'absent';
}

export function summary(s: any, names: Record<string, string>) {
  const n = (id: string) => names[id] ?? id.slice(0, 6);
  return {
    epoch: s.epoch,
    members: Object.values(s.members).map((m: any) => `${n(m.deviceId)}:${m.role}${m.removed ? ':REMOVED' : ''}`).join(', '),
    cutoffs: Object.fromEntries(Object.entries(s.cutoffs).map(([k, v]) => [n(k), v])),
    accounts: Object.keys(s.accounts).length,
  };
}

export function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
}
