// Round 5 (security-review-5/findings5.md, PoCs t3, t4, t6) and the model checker's r6/r7
// counterexamples. The PoCs run from test/fixtures/round5 (PASS lines are attack steps that
// worked); the checker's run from test/fixtures/checker and print VIOLATED while one still fails.
// Signatures (t1, t1b, t5) are in vaultRound5Chain.test.ts; sizes and the reserve (t2) in
// vaultRound5Sizes.test.ts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkJoinedVault } from '../src/vault/approval';
import { buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove } from '../src/vault/build';
import { toBase64Url } from '../src/vault/bytes';
import type { DeviceKeys } from '../src/vault/crypto';
import { entryHash, type SignedEntry } from '../src/vault/entry';
import { planAppend } from '../src/vault/logs';
import { openVault } from '../src/vault/open';
import { replayVault } from '../src/vault/replay';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers/vault';

/** The fixtures cover the 0.4 multi-device code, so they run with it on (test/setup/multiDevice.ts). */
const MULTI_DEVICE_SETUP = new URL('./setup/multiDevice.ts', import.meta.url).href;

const random = seededRandom('vault-round5-tests');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

function run(file: string, ...args: string[]): string {
  try {
    return execFileSync(process.execPath, ['--import', 'tsx', '--import', MULTI_DEVICE_SETUP, file, ...args], { encoding: 'utf8', timeout: 900_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // A counterexample exits 1 while it still fails; its output says so.
    const out = (err as { stdout?: string }).stdout;
    if (typeof out === 'string') return out;
    throw err;
  }
}

const passed = (out: string) => out.split('\n').filter((l) => l.startsWith('PASS')).map((l) => l.slice(6).split('  --')[0]!.trim());

function agentAppend(vault: MemoryVault, entries: SignedEntry[]): void {
  const plan = planAppend(vault.vaultId, vault.logs, entries);
  for (const id of plan.changed) vault.logs[id] = [...plan.logs[id]!];
}

function addDevice(vault: MemoryVault, by: DeviceKeys, who: DeviceKeys, role: 'admin' | 'member' = 'admin'): void {
  vault.write(buildDeviceAdd(vault.state(), by, { device: who, role, name: 'x', currentKey: openVault(vault.state(), by).currentKey, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), who, vault.now()));
}

describe('round-5 PoCs, each blocked', () => {
  it('N5: a removed device\'s voided lines never offer a one-tap removal of an honest device', () => {
    assert.deepEqual(passed(run(path.join(FIXTURES, 'round5', 't3_voided_redo_lure.ts'))), []);
  });

  it('N4: an admin\'s garbage key for a joining device can\'t lock it out', () => {
    assert.deepEqual(passed(run(path.join(FIXTURES, 'round5', 't4_join_garbage_key.ts'))), []);
  });

  it('N6: 7,680 rotations then failing removals replay with bounded work (signatures, full judgements, pass steps), nothing redone warm', () => {
    const out = run(path.join(FIXTURES, 'round5', 't6_cost_rotations_then_judged.ts'), '30', '256');
    assert.deepEqual(passed(out), [], out);
  });
});

describe('model checker counterexamples (r6, r7), each holding', () => {
  // r8 and later run from vaultRound6.test.ts.
  const dir = path.join(FIXTURES, 'checker');
  for (const file of fs.readdirSync(dir).filter((f) => /^r[67]-.*\.ts$/.test(f)).sort()) {
    it(file.replace(/\.ts$/, ''), () => {
      const out = run(path.join(dir, file));
      assert.doesNotMatch(out, /VIOLATED/, out.split('\n').filter((l) => /VIOLATED|expected|got/.test(l)).join('\n'));
      assert.match(out, /HOLDS/);
    });
  }
});

describe('round-5 rules', () => {
  it('an exact retry of stored lines is taken and changes nothing', () => {
    const f = device(random);
    const vault = MemoryVault.found(f, random);
    const put = buildAccountPut(vault.state(), f, { account: 'a'.repeat(22), record: totpRecord(), currentKey: vault.key, random, time: vault.now() });
    agentAppend(vault, [put]);
    const before = JSON.stringify(vault.logs);
    const plan = planAppend(vault.vaultId, vault.logs, [put]);
    assert.deepEqual(plan.changed, []);
    assert.equal(JSON.stringify(vault.logs), before);
  });

  it('the hello names the approval it checked; the vault seals to that one', () => {
    const a = device(random);
    const vault = MemoryVault.found(a, random, 'team');
    const m = device(random);
    const n = device(random);
    addDevice(vault, a, m);
    // m approves n with n's own keys but a key that doesn't open; a approves n properly.
    vault.write(buildDeviceAdd(vault.state(), m, { device: n, role: 'admin', name: 'n', currentKey: random(32), random, time: 1 }));
    const honest = vault.write(buildDeviceAdd(vault.state(), a, { device: n, role: 'member', name: 'n', currentKey: openVault(vault.state(), a).currentKey, random, time: vault.now() }));
    const challenge = { ed: toBase64Url(a.edPublic), x: toBase64Url(a.xPublic), vault: vault.vaultId, vaultName: 'Home', name: 'Phone', nonce: 'x' };
    const verdict = checkJoinedVault(vault.state(), n, challenge);
    assert.deepEqual(verdict, { status: 'ok', approval: entryHash(honest) });
    vault.write(buildDeviceHello(vault.state(), n, vault.now(), entryHash(honest)));
    const state = vault.state();
    assert.equal(state.members[n.deviceId]!.joined, true);
    assert.equal(state.members[n.deviceId]!.role, 'member', 'the role comes from the confirmed approval');
    assert.equal(state.members[n.deviceId]!.addedBy, a.deviceId);
    assert.ok(openVault(state, n).currentKey.length > 0);
  });

  it('a hello naming an approval it had not seen, or none of its own, is refused', () => {
    const a = device(random);
    const vault = MemoryVault.found(a, random, 'team');
    const n = device(random);
    vault.write(buildDeviceAdd(vault.state(), a, { device: n, role: 'member', name: 'n', currentKey: vault.key, random, time: vault.now() }));
    const hello = vault.write(buildDeviceHello(vault.state(), n, vault.now(), 'A'.repeat(43)));
    const item = vault.state().history.find((h) => h.hash === entryHash(hello))!;
    assert.match(item.status, /^rejected/);
    assert.equal(vault.state().members[n.deviceId]!.joined, false);
  });

  it('a removal by a device never really in (a puppet of a cut-off device) never applies', () => {
    const f = device(random);
    const vault = MemoryVault.found(f, random, 'team');
    const d1 = device(random);
    const d2 = device(random);
    addDevice(vault, f, d1);
    addDevice(vault, d1, d2);
    const d2View = vault.state();
    // f removes d1 having seen none of d1's lines; d2, which only d1's unseen lines brought in,
    // also removes d1 (not f: that would be true symmetry, where everyone goes out).
    const fView = replayVault(vault.vaultId, { [f.deviceId]: vault.logs[f.deviceId]! });
    vault.write(buildDeviceRemove(fView, f, { device: d1.deviceId, currentKey: vault.key, random, time: vault.now() }).entry);
    const puppet = vault.write(buildDeviceRemove(d2View, d2, { device: d1.deviceId, currentKey: openVault(d2View, d2).currentKey, random, time: vault.now() }).entry);
    const state = vault.state();
    assert.match(state.history.find((h) => h.hash === entryHash(puppet))!.status, /^rejected/);
    assert.equal(state.members[f.deviceId]!.removed, false);
    assert.equal(state.members[d2.deviceId]?.joined ?? false, false);
  });
});
