// Round 6 (security-review-6/findings6.md, PoCs R6-A, R6-B, R6-E) and the model checker's r8
// counterexamples. The PoCs run from test/fixtures/round6 (PASS lines are attack steps that
// worked); the checker's run from test/fixtures/checker (r8-*) and print VIOLATED while one still
// fails. R6-D (seals) and R6-F (canonical lines) have their own test files.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkBeacons, signBeacon } from '../src/vault/beacon';
import { buildDeviceAdd, buildDeviceHello } from '../src/vault/build';
import type { DeviceKeys } from '../src/vault/crypto';
import { openVault } from '../src/vault/open';
import type { VaultState } from '../src/vault/replay';
import { MemoryVault, device, seededRandom } from './helpers/vault';

/** The fixtures cover the 0.4 multi-device code, so they run with it on (test/setup/multiDevice.ts). */
const MULTI_DEVICE_SETUP = new URL('./setup/multiDevice.ts', import.meta.url).href;

const random = seededRandom('vault-round6-tests');
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

describe('round-6 PoCs, each blocked', () => {
  it('R6-A: a puppet that is not standing at the end contests nothing; pre-theft history stays', () => {
    assert.deepEqual(passed(run(path.join(FIXTURES, 'round6', 'r6a_contest_ghost.ts'))), ['none of N\'s changes are offered for review (caught)']);
  });

  it('R6-E: removals are judged on verdicts settled within their own past, so a voided removal never makes its target unremovable', () => {
    const out = run(path.join(FIXTURES, 'round6', 'r6e_unremovable_puppet.ts'));
    const worked = passed(out);
    // The voiding itself and the later duplicate removal's refusal are the rules working, not the attack.
    assert.deepEqual(worked.filter((l) => !l.startsWith('r1 (X removing its own puppet) is voided') && !l.startsWith('A\'s removal of P (after syncing) is rejected too')), [], out);
    assert.match(out, /FAIL\s+B's removal of P is rejected\s+-- applied/);
  });

  it('R6-B: the vault-wide cap counts only lines of identities still in, so removing the attackers frees it', () => {
    const out = run(path.join(FIXTURES, 'round6', 'r6b_vault_full_forever.ts'));
    assert.deepEqual(passed(out), ['owner can remove the thief and both puppets'], out);
  });
});

describe('model checker counterexamples (r8), each holding', () => {
  const dir = path.join(FIXTURES, 'checker');
  for (const file of fs.readdirSync(dir).filter((f) => /^r8-.*\.ts$/.test(f)).sort()) {
    it(file.replace(/\.ts$/, ''), () => {
      const out = run(path.join(dir, file));
      assert.doesNotMatch(out, /VIOLATED/, out.split('\n').filter((l) => /VIOLATED|expected|got/.test(l)).join('\n'));
      assert.match(out, /HOLDS/);
    });
  }
});

describe('round-6 rules', () => {
  function vaultWithTwo(): { vault: MemoryVault; f: DeviceKeys; d: DeviceKeys; state: VaultState } {
    const f = device(random);
    const d = device(random);
    const vault = MemoryVault.found(f, random);
    vault.write(buildDeviceAdd(vault.state(), f, { device: d, role: 'admin', name: 'D', currentKey: openVault(vault.state(), f).currentKey, random, time: vault.now() }));
    vault.write(buildDeviceHello(vault.state(), d, vault.now()));
    return { vault, f, d, state: vault.state() };
  }

  it('a beacon at a newer epoch is no alarm when this copy holds every line it saw', () => {
    const { f, d, state } = vaultWithTwo();
    // D's beacon from a copy that judged the same lines into a newer epoch (a fork proof it hadn't read).
    const beacon = signBeacon({ ...state, epoch: state.epoch + 1 }, d, 5);
    const check = checkBeacons(state, { [d.deviceId]: JSON.stringify(beacon) }, f.deviceId);
    assert.deepEqual(check.problems, []);
    assert.equal(check.claimedEpoch, state.epoch);
  });

  it('a beacon at a newer epoch that saw a line this copy lacks still raises the alarm', () => {
    const { f, d, state } = vaultWithTwo();
    const head = state.heads[f.deviceId]!;
    const ahead = { ...state, epoch: state.epoch + 1, heads: { ...state.heads, [f.deviceId]: { ...head, seq: head.seq + 1, hash: 'h'.repeat(43) } } };
    const check = checkBeacons(state, { [d.deviceId]: JSON.stringify(signBeacon(ahead, d, 5)) }, f.deviceId);
    assert.deepEqual(check.problems.map((p) => p.kind).sort(), ['missing-entry', 'newer-epoch']);
    assert.equal(check.claimedEpoch, state.epoch + 1);
  });

  it('a beacon naming the log of an identity this copy does not know at all raises nothing for it', () => {
    const { f, d, state } = vaultWithTwo();
    const ghost = device(random);
    const named = { ...state, heads: { ...state.heads, [ghost.deviceId]: { seq: 0, hash: 'g'.repeat(43), time: 1 } } };
    const check = checkBeacons(state, { [d.deviceId]: JSON.stringify(signBeacon(named, d, 5)) }, f.deviceId);
    assert.deepEqual(check.problems, []);
  });
});
