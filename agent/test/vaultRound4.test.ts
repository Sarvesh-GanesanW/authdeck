// Round 4 (security-review-4/findings4.md, PoCs S1-S6). The PoCs themselves run from
// test/fixtures/round4 (each prints PASS for an attack step that worked; only the benign lines
// listed below may say PASS). The rest pins the rules round 4 added: a cut-off identity changes
// nothing outside a true-symmetric conflict, voided membership changes are marked, a squatted
// join still completes, and unpairing never follows a rejected line.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkJoinedVault } from '../src/vault/approval';
import { buildDeviceAdd, buildDeviceHello, buildDeviceRemove } from '../src/vault/build';
import { toBase64Url } from '../src/vault/bytes';
import type { DeviceKeys } from '../src/vault/crypto';
import { entryHash, type SignedEntry } from '../src/vault/entry';
import { planAppend } from '../src/vault/logs';
import { openVault } from '../src/vault/open';
import { replayVault, type VaultState } from '../src/vault/replay';
import { identitiesTakenOut } from '../src/vaultStore';
import { MemoryVault, device, seededRandom } from './helpers/vault';

/** The fixtures cover the 0.4 multi-device code, so they run with it on (test/setup/multiDevice.ts). */
const MULTI_DEVICE_SETUP = new URL('./setup/multiDevice.ts', import.meta.url).href;

const random = seededRandom('vault-round4-tests');
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'round4');

/** Runs one PoC and returns its PASS lines (attack steps that worked). */
function attackSteps(file: string, ...args: string[]): { passed: string[]; out: string } {
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--import', MULTI_DEVICE_SETUP, path.join(FIXTURES, file), ...args], { encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { passed: out.split('\n').filter((l) => l.startsWith('PASS')).map((l) => l.slice(6).split('  --')[0]!.trim()), out };
}

function agentAppend(vault: MemoryVault, entries: SignedEntry[]): void {
  const plan = planAppend(vault.vaultId, vault.logs, entries);
  for (const id of plan.changed) vault.logs[id] = [...plan.logs[id]!];
}

function addDevice(vault: MemoryVault, by: DeviceKeys, who: DeviceKeys, role: 'admin' | 'member' = 'admin'): void {
  vault.write(buildDeviceAdd(vault.state(), by, { device: who, role, name: 'x', currentKey: openVault(vault.state(), by).currentKey, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), who, vault.now()));
}

function itemOf(state: VaultState, entry: SignedEntry) {
  return state.history.find((h) => h.hash === entryHash(entry));
}

describe('round-4 PoCs, each blocked', () => {
  it('S1: a line riding ahead of a counter-removal, a removal included, is taken only as a placeholder that changes nothing', () => {
    const { passed } = attackSteps('s1_counter_batch_rider.ts');
    // Round 6 ruling: the batch is taken (an honest counter-removal must never be blocked by its
    // own earlier unsent lines), but the riding "F removes A" is rejected and A stays in. A's put
    // made under B's key is rejected exactly as with the counter-removal alone (true symmetry
    // takes B's key off the chain), and the app makes it again.
    assert.deepEqual(passed, [
      'control: "F removes A" alone is refused by the agent',
      'agent accepts [F removes A, F removes B] in one batch',
      "A's account change after the removal is rejected",
      '...and NOT marked caught (no review offered)',
    ]);
  });

  it('S2: a removed admin writing straight into the folder removes nobody', () => {
    const { passed } = attackSteps('s2_removed_admin_direct_write.ts');
    assert.deepEqual(passed, ['none of them is offered for review (caught)', 'accounts left in the vault']);
  });

  it('S3: a squatted join neither blocks the joiner nor the squatter\'s removal', () => {
    assert.deepEqual(attackSteps('s3_join_squat.ts').passed, []);
  });

  it('S4: 19000 judged removals replay with bounded work: each signature once, no removal judged in full, nothing redone warm', () => {
    const { out } = attackSteps('s4_removal_judging_cost.ts', '19000');
    const lines = Number(/lines (\d+)/.exec(out)?.[1]);
    const work = (which: string) => {
      const m = new RegExp(`${which} work: (\\d+) full judgements, (\\d+) pass steps, (\\d+) signature checks`).exec(out);
      assert.ok(m, out);
      return { judgements: Number(m[1]), steps: Number(m[2]), signatures: Number(m[3]) };
    };
    const cold = work('cold');
    const warm = work('warm');
    // Counted, not timed, so a busy machine can't fail it.
    assert.ok(cold.signatures <= lines, `${cold.signatures} signature checks for ${lines} lines`);
    assert.ok(cold.judgements <= 64, `${cold.judgements} full judgements`);
    assert.ok(cold.steps <= (64 + 8) * lines, `${cold.steps} pass steps for ${lines} lines`);
    assert.deepEqual({ signatures: warm.signatures, judgements: warm.judgements }, { signatures: 0, judgements: 0 });
    // A generous wall-clock backstop only.
    const coldMs = Number(/cold replay (\d+) ms/.exec(out)?.[1]);
    const warmMs = Number(/warm replay (\d+) ms/.exec(out)?.[1]);
    assert.ok(coldMs < 120_000, `cold ${coldMs} ms`);
    assert.ok(warmMs < 10_000, `warm ${warmMs} ms`);
  });

  it('S5: a member cannot fill the vault, and its removal is still taken', () => {
    assert.deepEqual(attackSteps('s5_member_fills_vault.ts').passed, []);
  });

  it('S6: a removed device\'s self-fork takes back nothing others built on', () => {
    assert.deepEqual(attackSteps('s6_self_fork_collapse.ts').passed, ['the honest agent stores the self-fork proof of removed F']);
  });
});

describe('round-4 rules', () => {
  it('a membership change by a device cut off by a removal it had not seen is voided and marked, never redone', () => {
    const a = device(random);
    const vault = MemoryVault.found(a, random, 'team');
    const [b, x, c] = [device(random), device(random), device(random)];
    addDevice(vault, a, b);
    addDevice(vault, a, x);
    addDevice(vault, a, c, 'member');
    const stale = vault.state();
    agentAppend(vault, [buildDeviceRemove(vault.state(), b, { device: x.deviceId, currentKey: openVault(vault.state(), b).currentKey, random, time: vault.now() }).entry]);
    // x, on its old copy, removes c straight in the folder.
    const late = vault.write(buildDeviceRemove(stale, x, { device: c.deviceId, currentKey: openVault(stale, x).currentKey, random, time: vault.now() }).entry);
    const state = vault.state();
    assert.equal(state.members[c.deviceId]!.removed, false);
    const item = itemOf(state, late)!;
    assert.match(item.status, /^rejected/);
    assert.equal(item.voided, true);
    // Unpairing follows applied removals only: the rejected line takes nobody out.
    const before = replayVault(vault.vaultId, { ...vault.logs, [x.deviceId]: vault.logs[x.deviceId]!.slice(0, -1) });
    assert.deepEqual(identitiesTakenOut(before, state), []);
  });

  it('S3: the joiner completes through the approval of the device it compared codes with', () => {
    const a = device(random);
    const vault = MemoryVault.found(a, random, 'team');
    const m = device(random);
    const n = device(random);
    addDevice(vault, a, m);
    // m squats n's join with its own sealing key; a then approves n with n's real keys.
    vault.write(buildDeviceAdd(vault.state(), m, { device: { ...n, xPublic: m.xPublic }, role: 'member', name: 'n', currentKey: openVault(vault.state(), m).currentKey, random, time: 1 }));
    vault.write(buildDeviceAdd(vault.state(), a, { device: n, role: 'member', name: 'n', currentKey: openVault(vault.state(), a).currentKey, random, time: vault.now() }));
    const challenge = { ed: toBase64Url(a.edPublic), x: toBase64Url(a.xPublic), vault: vault.vaultId, vaultName: 'Home', name: 'Phone', nonce: 'x' };
    assert.equal(checkJoinedVault(vault.state(), n, challenge).status, 'ok');
    // The squatter's approval names other keys, so a challenge from m is still "intercepted".
    const fromM = { ...challenge, ed: toBase64Url(m.edPublic), x: toBase64Url(m.xPublic) };
    assert.equal(checkJoinedVault(vault.state(), n, fromM).status, 'intercepted');
    // n joins; its hello confirms a's approval, so the vault seals to n's own key, and a can remove m.
    vault.write(buildDeviceHello(vault.state(), n, vault.now()));
    assert.equal(vault.state().members[n.deviceId]!.x, toBase64Url(n.xPublic));
    assert.equal(openVault(vault.state(), n).currentKey.length > 0, true);
    const removal = buildDeviceRemove(vault.state(), a, { device: m.deviceId, currentKey: openVault(vault.state(), a).currentKey, random, time: vault.now() }).entry;
    agentAppend(vault, [removal]);
    assert.equal(vault.state().members[m.deviceId]!.removed, true);
    assert.equal(openVault(vault.state(), n).currentKey.length > 0, true);
  });

  it('a removed device is told to make new keys, not to wait', () => {
    const a = device(random);
    const vault = MemoryVault.found(a, random, 'team');
    const n = device(random);
    addDevice(vault, a, n, 'member');
    agentAppend(vault, [buildDeviceRemove(vault.state(), a, { device: n.deviceId, currentKey: openVault(vault.state(), a).currentKey, random, time: vault.now() }).entry]);
    const challenge = { ed: toBase64Url(a.edPublic), x: toBase64Url(a.xPublic), vault: vault.vaultId, vaultName: 'Home', name: 'Phone', nonce: 'x' };
    const verdict = checkJoinedVault(vault.state(), n, challenge);
    assert.equal(verdict.status, 'intercepted');
  });
});
