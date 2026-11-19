// Round 5 (security-review-5/findings5.md, N2, N3 and the junk-files item). The PoCs run from
// test/fixtures/round5 (each prints PASS for an attack step that worked). The rest pins the rules:
// every line's own signature counts, a log is trusted up to just before its first bad line, a bad
// line is checked once per cache, a signed line that doesn't follow its author's line before it is
// a fork proof, and junk files never hide fork proofs or beacons.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { signBeacon } from '../src/vault/beacon';
import { afterOwnEntry, buildAccountPut, buildDeviceAdd, buildDeviceHello, createVault, newAccountId } from '../src/vault/build';
import { toBase64Url } from '../src/vault/bytes';
import { forkProofProblem, verifyChain, VerifyCache, type ForkProof, type KnownIdentity, type VaultLogs } from '../src/vault/chain';
import { generateDeviceKeys, sign, signatureCheckFor, verifySignature, type DeviceKeys } from '../src/vault/crypto';
import { entryHash, serializeEntry, signEntry, type EntryDigest, type SignedEntry } from '../src/vault/entry';
import { openVault } from '../src/vault/open';
import { replayVault } from '../src/vault/replay';
import { findForks } from '../src/vault/rollback';
import { VaultStore } from '../src/vaultStore';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers/vault';

/** The fixtures cover the 0.4 multi-device code, so they run with it on (test/setup/multiDevice.ts). */
const MULTI_DEVICE_SETUP = new URL('./setup/multiDevice.ts', import.meta.url).href;

const random = seededRandom('vault-round5-chain-tests');
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'round5');
const AT_CAP = '20000';
const COLD_BUDGET_MS = 15_000;
const WARM_BUDGET_MS = 1_000;
const APPEND_BUDGET_MS = 2_000;
const GARBAGE_SIG = 'A'.repeat(86);

/** Runs one PoC and returns its PASS lines (attack steps that worked) and its output. */
function attackSteps(file: string, ...args: string[]): { passed: string[]; out: string } {
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--import', MULTI_DEVICE_SETUP, path.join(FIXTURES, file), ...args], { encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { passed: out.split('\n').filter((l) => l.startsWith('PASS')).map((l) => l.slice(6).split('  --')[0]!.trim()), out };
}

function msFrom(out: string, pattern: RegExp): number {
  const match = pattern.exec(out);
  assert.ok(match, `no timing matching ${pattern} in:\n${out}`);
  return Number(match[1]);
}

describe('round-5 PoCs, each blocked', () => {
  it('N3: a junk tail of 20,000 lines is checked once; replays stay within budget', () => {
    const { passed, out } = attackSteps('t1_walkback_cost.ts', AT_CAP);
    assert.deepEqual(passed, []);
    assert.ok(msFrom(out, /cold=(\d+)ms/) < COLD_BUDGET_MS, out);
    assert.ok(msFrom(out, /warm\(2nd\)=(\d+)ms/) < WARM_BUDGET_MS, out);
  });

  it('N3: agent appends stay fast after 20,000 junk lines on a removed device\'s log', () => {
    const { passed, out } = attackSteps('t1b_walkback_agent.ts', AT_CAP);
    assert.deepEqual(passed, []);
    assert.ok(msFrom(out, /put #3: (\d+) ms/) < APPEND_BUDGET_MS, out);
  });

  it('N2: a line with a garbage signature is never applied, and the fork it hides is provable', () => {
    assert.deepEqual(attackSteps('t5_unprovable_fork.ts').passed, []);
  });
});

function identityOf(keys: DeviceKeys): KnownIdentity {
  return { deviceId: keys.deviceId, ed: keys.edPublic, role: 'device' };
}

/** A team vault with admin A and member X, and X's key. */
function teamWithMember() {
  const a = device(random);
  const x = device(random);
  const vault = MemoryVault.found(a, random, 'team');
  const s = vault.state();
  vault.write(buildDeviceAdd(s, a, { device: x, role: 'member', name: 'X', currentKey: openVault(s, a).currentKey, random, time: vault.now() }));
  vault.write(buildDeviceHello(vault.state(), x, vault.now()));
  return { vault, a, x };
}

function putBy(vault: MemoryVault, author: DeviceKeys, state = vault.state()): SignedEntry {
  return buildAccountPut(state, author, { account: newAccountId(random), record: totpRecord(), currentKey: openVault(vault.state(), author).currentKey, random, time: vault.now() });
}

/** A cache that counts the signature checks it really makes (not the verdicts it reuses). */
class CountingCache extends VerifyCache {
  checks = 0;

  override signatureValid(edPublic: Uint8Array, digest: EntryDigest): boolean {
    return super.signatureValid(edPublic, {
      ...digest,
      signatureValid: (check) => {
        this.checks++;
        return digest.signatureValid(check);
      },
    });
  }
}

describe('every line\'s own signature counts', () => {
  it('a bad signature mid-log cuts the log there, even when the next signed line chains on it', () => {
    const { vault, a } = teamWithMember();
    const good = vault.write(putBy(vault, a));
    const forged: SignedEntry = { ...putBy(vault, a, afterOwnEntry(vault.state(), good)), sig: GARBAGE_SIG };
    vault.write(forged);
    // A validly signed line over the forged one: the old head-only check vouched for both.
    const vouching = putBy(vault, a, afterOwnEntry(afterOwnEntry(vault.state(), good), forged));
    vault.write(vouching);
    const lines = vault.logs[a.deviceId]!;
    const { chain, rejection } = verifyChain(vault.vaultId, { ...identityOf(a), role: 'founder' }, lines);
    assert.equal(chain.length, forged.seq);
    assert.equal(rejection?.seq, forged.seq);
    assert.match(rejection!.reason, /signature is not valid \(and the 1 entry after it\)/);
    const state = vault.state();
    assert.equal(state.heads[a.deviceId]!.seq, good.seq);
    assert.ok(!state.history.some((h) => h.seq >= forged.seq && h.author === a.deviceId));
  });

  it('a junk tail costs one signature check, once; a warm replay checks nothing again', () => {
    const { vault, x } = teamWithMember();
    const honest = vault.write(putBy(vault, x));
    let prev = entryHash(honest);
    const junk: string[] = [];
    for (let i = 1; i <= 500; i++) {
      const line: SignedEntry = { ...honest, seq: honest.seq + i, prev, time: honest.time + i, sig: GARBAGE_SIG };
      junk.push(serializeEntry(line));
      prev = entryHash(line);
    }
    const lines = [...vault.logs[x.deviceId]!, ...junk];
    const cache = new CountingCache();
    const first = verifyChain(vault.vaultId, identityOf(x), lines, cache);
    assert.equal(first.chain.length, honest.seq + 1);
    assert.equal(cache.checks, honest.seq + 2, 'each good line once, and the first junk line');
    cache.checks = 0;
    const again = verifyChain(vault.vaultId, identityOf(x), lines, cache);
    assert.equal(again.chain.length, honest.seq + 1);
    assert.equal(cache.checks, 0);
  });

  it('a verdict is reused across copies, so replaying another copy with the same cache checks only its new lines', () => {
    const { vault, a } = teamWithMember();
    vault.write(putBy(vault, a));
    const cache = new CountingCache();
    replayVault(vault.vaultId, vault.logs, { cache });
    const total = Object.values(vault.logs).reduce((n, l) => n + l.length, 0);
    assert.equal(cache.checks, total);
    cache.checks = 0;
    const shorter: VaultLogs = { ...vault.logs, [a.deviceId]: vault.logs[a.deviceId]!.slice(0, -1) };
    replayVault(vault.vaultId, shorter, { cache });
    replayVault(vault.vaultId, vault.logs, { cache });
    assert.equal(cache.checks, 0);
  });
});

describe('the second kind of fork proof: a signed line that does not follow its author\'s line before it', () => {
  /** X shows one copy a valid line at k, the folder a garbage-signed line at k and a signed k+1 over it. */
  function hiddenFork() {
    const { vault, a, x } = teamWithMember();
    const base = vault.snapshot();
    const s0 = vault.state();
    const shown = putBy(vault, x, s0);
    const hidden: SignedEntry = { ...putBy(vault, x, s0), sig: GARBAGE_SIG };
    const over = putBy(vault, x, afterOwnEntry(s0, hidden));
    const mine: VaultLogs = { ...base, [x.deviceId]: [...base[x.deviceId]!, serializeEntry(shown)] };
    const folder: VaultLogs = { ...base, [x.deviceId]: [...base[x.deviceId]!, serializeEntry(hidden), serializeEntry(over)] };
    return { vault, a, x, shown, hidden, over, mine, folder };
  }

  it('is found by findForks and accepted by forkProofProblem, with the forked seq after the line it skips', () => {
    const { vault, x, shown, over, mine, folder } = hiddenFork();
    const forks = findForks(mine, replayVault(vault.vaultId, mine), folder, replayVault(vault.vaultId, folder));
    const expected: ForkProof = { deviceId: x.deviceId, seq: over.seq, lines: [serializeEntry(shown), serializeEntry(over)] };
    assert.deepEqual(forks, [expected]);
    assert.equal(over.seq, shown.seq + 1);
    assert.equal(forkProofProblem(vault.vaultId, identityOf(x), expected), null);
    // Found the same way with the copies swapped, and every replay applies it.
    assert.deepEqual(findForks(folder, replayVault(vault.vaultId, folder), mine, replayVault(vault.vaultId, mine)), [{ ...expected, lines: [serializeEntry(shown), serializeEntry(over)] }]);
    assert.equal(replayVault(vault.vaultId, folder, { forks: [expected] }).forked[x.deviceId], over.seq);
  });

  it('is found within one copy when a signed line skips the verified line before it', () => {
    const { vault, x } = teamWithMember();
    const s0 = vault.state();
    const kept = putBy(vault, x, s0);
    const other = putBy(vault, x, s0);
    const skipping = putBy(vault, x, afterOwnEntry(s0, other));
    const mine: VaultLogs = { ...vault.snapshot(), [x.deviceId]: [...vault.logs[x.deviceId]!, serializeEntry(kept)] };
    const folder: VaultLogs = { ...mine, [x.deviceId]: [...mine[x.deviceId]!, serializeEntry(skipping)] };
    const forks = findForks(mine, replayVault(vault.vaultId, mine), folder, replayVault(vault.vaultId, folder));
    assert.deepEqual(forks, [{ deviceId: x.deviceId, seq: skipping.seq, lines: [serializeEntry(kept), serializeEntry(skipping)] }]);
  });

  it('refuses forged or non-fork proofs', () => {
    const { vault, a, x, shown, over } = hiddenFork();
    const id = identityOf(x);
    const proof = (lines: [string, string], seq = over.seq): ForkProof => ({ deviceId: x.deviceId, seq, lines });
    const unsignedOver = { ...over, sig: GARBAGE_SIG };
    assert.match(forkProofProblem(vault.vaultId, id, proof([serializeEntry(shown), serializeEntry(unsignedOver)]))!, /not signed by that device/);
    assert.match(forkProofProblem(vault.vaultId, id, proof([serializeEntry({ ...shown, sig: GARBAGE_SIG }), serializeEntry(over)]))!, /not signed by that device/);
    // A line and the one that follows it: one history, not two.
    const next = putBy(vault, x, afterOwnEntry(vault.state(), shown));
    assert.match(forkProofProblem(vault.vaultId, id, proof([serializeEntry(shown), serializeEntry(next)]))!, /no fork/);
    // A stranger signing in X's name.
    const { sig: _overSig, ...overUnsigned } = over;
    assert.match(forkProofProblem(vault.vaultId, id, proof([serializeEntry(shown), serializeEntry(signEntry(overUnsigned, device(random)))]))!, /not signed by that device/);
    // Wrong seqs, and the other identity's key.
    assert.match(forkProofProblem(vault.vaultId, id, proof([serializeEntry(shown), serializeEntry(over)], over.seq + 1))!, /seq/);
    assert.match(forkProofProblem(vault.vaultId, id, proof([serializeEntry(over), serializeEntry(shown)], shown.seq))!, /seq/);
    assert.match(forkProofProblem(vault.vaultId, identityOf(a), { ...proof([serializeEntry(shown), serializeEntry(over)]), deviceId: a.deviceId })!, /not that device's entry/);
  });
});

describe('the per-key signature check agrees with verifySignature', () => {
  it('accepts and refuses exactly what verifySignature does, tampered and malformed signatures included', () => {
    const keys = generateDeviceKeys(random);
    const check = signatureCheckFor(keys.edPublic);
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const cases: [Uint8Array, Uint8Array][] = [];
    for (let i = 0; i < 40; i++) {
      const message = random(1 + (i * 37) % 300);
      const signature = sign(message, keys.edSecret);
      cases.push([signature, message]);
      const flipped = Uint8Array.from(signature);
      flipped[i % 64]! ^= 1 << (i % 8);
      cases.push([flipped, message]);
      const otherMessage = Uint8Array.from(message);
      otherMessage[0]! ^= 1;
      cases.push([signature, otherMessage]);
      // s + L: the same point equation, refused because s is not below the group order.
      const s = signature.subarray(32).reduceRight((n, b) => (n << 8n) | BigInt(b), 0n) + L;
      if (s < 2n ** 256n) cases.push([Uint8Array.from([...signature.subarray(0, 32), ...Array.from({ length: 32 }, (_, j) => Number((s >> BigInt(8 * j)) & 0xffn))]), message]);
      // R with y >= p (non-canonical).
      cases.push([Uint8Array.from([...new Uint8Array(32).fill(0xff).map((b, j) => (j === 31 ? 0x7f : b)), ...signature.subarray(32)]), message]);
      cases.push([signature.subarray(0, 63), message]);
    }
    for (const [signature, message] of cases) assert.equal(check(signature, message), verifySignature(signature, message, keys.edPublic));
    assert.ok(cases.some(([s, m]) => check(s, m)) && cases.some(([s, m]) => !check(s, m)));
    // Small-order and malformed keys are refused for everything.
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const [signature, message] = cases[0]!;
    assert.equal(signatureCheckFor(identity)(signature, message), false);
    assert.equal(signatureCheckFor(new Uint8Array(31))(signature, message), false);
  });
});

describe('junk files never hide fork proofs or beacons', () => {
  const JUNK_FILES = 300;

  /** Ids that sort before any real one ('-' is the lowest base64url character). */
  function junkIds(): string[] {
    return Array.from({ length: JUNK_FILES }, (_, i) => `-${toBase64Url(random(16)).slice(0, 21 - String(i).length)}${i}`.slice(0, 22));
  }

  it('reads the fork proof and beacon of each known identity by name', () => {
    const personal = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-round5-'));
    try {
      const store = new VaultStore({ personal, team: () => null });
      const founder = device(random);
      const created = createVault({ founder, kind: 'personal', name: 'Home', deviceName: 'Phone', random, time: 1_000 });
      store.append(created.vaultId, [created.entry], false);
      const readState = () => replayVault(created.vaultId, Object.fromEntries(Object.entries(store.read(created.vaultId, undefined).logs).map(([id, log]) => [id, log.lines])));
      const put = buildAccountPut(readState(), founder, { account: newAccountId(random), record: totpRecord(), currentKey: created.key, random, time: 2_000 });
      store.append(created.vaultId, [put], false);
      const { sig: _sig, ...unsigned } = put;
      const proof: ForkProof = { deviceId: founder.deviceId, seq: put.seq, lines: [serializeEntry(put), serializeEntry(signEntry({ ...unsigned, time: put.time + 1 }, founder))] };
      // The beacon first: once the proof is stored, the founder is cut off and signs nothing more.
      const beacon = signBeacon(readState(), founder, 5_000);
      store.writeBeacon(created.vaultId, beacon);
      store.writeFork(created.vaultId, proof);
      const dir = path.join(personal, created.vaultId);
      for (const id of [...junkIds(), '__proto__', 'constructor']) {
        fs.writeFileSync(path.join(dir, 'forks', `${id}.json`), `${JSON.stringify({ ...proof, deviceId: id })}\n`);
        fs.writeFileSync(path.join(dir, 'heads', `${id}.json`), `${JSON.stringify({ ...beacon, device: id })}\n`);
      }
      assert.ok(fs.readdirSync(path.join(dir, 'forks')).length > JUNK_FILES);
      assert.deepEqual(store.readForks(created.vaultId).forks, [proof]);
      const { beacons } = store.readBeacons(created.vaultId);
      assert.deepEqual(Object.keys(beacons), [founder.deviceId]);
      assert.equal(beacons[founder.deviceId], `${JSON.stringify(beacon)}\n`);
      assert.equal(Object.getPrototypeOf(beacons), Object.prototype);
    } finally {
      fs.rmSync(personal, { recursive: true, force: true });
    }
  });
});
