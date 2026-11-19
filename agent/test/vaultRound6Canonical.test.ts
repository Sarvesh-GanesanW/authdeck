// Round 6, R6-F (security-review-6/findings6.md), as amended by review 8 (S7r-1, normalise on
// read): a padded or re-encoded copy of a signed line reads as the entry it encodes, but sizes,
// quotas and the copies devices keep are counted on canonical text only, so nobody who can write
// the folder can inflate an honest device's usage or hide its lines. The PoC runs from
// test/fixtures/round6 (PASS lines are attack steps that worked; the last one is a control).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildAccountPut, newAccountId } from '../src/vault/build';
import { VerifyCache } from '../src/vault/chain';
import { planAppend } from '../src/vault/logs';
import { replayVault } from '../src/vault/replay';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers/vault';

/** The fixtures cover the 0.4 multi-device code, so they run with it on (test/setup/multiDevice.ts). */
const MULTI_DEVICE_SETUP = new URL('./setup/multiDevice.ts', import.meta.url).href;

const random = seededRandom('vault-round6-canonical');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

const passed = (out: string) => out.split('\n').filter((l) => l.startsWith('PASS')).map((l) => l.slice(6).split('  --')[0]!.trim());

/** A founder with three account changes; the line at seq 2 is the one tests rewrite. */
function vaultWithPuts() {
  const founder = device(random);
  const vault = MemoryVault.found(founder, random);
  for (let i = 0; i < 3; i++) vault.write(buildAccountPut(vault.state(), founder, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
  return { founder, vault };
}

function withLine(vault: MemoryVault, author: string, seq: number, line: string): Record<string, string[]> {
  const logs = vault.snapshot() as Record<string, string[]>;
  logs[author] = logs[author]!.map((old, i) => (i === seq ? line : old));
  return logs;
}

/** Same value, other text: each parses to exactly the entry the canonical line holds. */
const REWRITES: Record<string, (line: string) => string> = {
  'a space after the brace': (line) => line.replace('{', '{ '),
  'a trailing space': (line) => `${line} `,
  'a tab between fields': (line) => line.replace(',"body"', ',\t"body"'),
  'keys in another order': (line) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(line) as object).reverse())),
  'a letter written as a \\u escape': (line) => line.replace('"kind"', '"\\u006bind"'),
  'an upper-case \\u escape': (line) => line.replace('"kind"', '"\\u006Bind"'),
  'an escaped dot in a value': (line) => line.replace('"account.put"', '"account\\u002eput"'),
  'a number with an exponent': (line) => line.replace('"v":2', '"v":2e0'),
  'a number with a fraction': (line) => line.replace('"v":2', '"v":2.0'),
  'a duplicate key': (line) => line.replace('{', '{"v":3,'),
};

describe('R6-F / S7r-1: lines are normalised on read and counted in canonical form', () => {
  it('the whitespace-share PoC is blocked', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--import', MULTI_DEVICE_SETUP, path.join(FIXTURES, 'round6', 'r6f_whitespace_share.ts')], { encoding: 'utf8', timeout: 300_000 });
    assert.deepEqual(passed(out), ['control: the same line applies on the unpadded copy'], out);
  });

  for (const [name, rewrite] of Object.entries(REWRITES)) {
    it(`a line with ${name} reads as its entry, marked re-encoded`, () => {
      const { founder, vault } = vaultWithPuts();
      const line = vault.logs[founder.deviceId]![2]!;
      const rewritten = rewrite(line);
      assert.notEqual(rewritten, line);
      const clean = replayVault(vault.vaultId, vault.logs);
      const state = replayVault(vault.vaultId, withLine(vault, founder.deviceId, 2, rewritten));
      assert.deepEqual(state.chains[founder.deviceId], clean.chains[founder.deviceId]);
      assert.deepEqual(Object.keys(state.reencoded ?? {}), [founder.deviceId]);
      assert.equal(clean.reencoded, undefined);
    });
  }

  it('a rewrite that changes a value is still a bad line, and the chain ends before it', () => {
    const { founder, vault } = vaultWithPuts();
    const line = vault.logs[founder.deviceId]![2]!;
    const state = replayVault(vault.vaultId, withLine(vault, founder.deviceId, 2, line.replace('"v":2', '"v":3')));
    assert.equal(state.chains[founder.deviceId]!.length, 2);
    assert.equal(state.rejected.find((r) => r.deviceId === founder.deviceId && !r.hash)?.seq, 2);
  });

  it('a cached verdict for the canonical line and for a padded copy agree, and neither blocks the other', () => {
    const { founder, vault } = vaultWithPuts();
    const line = vault.logs[founder.deviceId]![2]!;
    const padded = withLine(vault, founder.deviceId, 2, line.replace('{', '{ '));
    const bad = withLine(vault, founder.deviceId, 2, line.replace('"v":2', '"v":3'));
    const cache = new VerifyCache();
    assert.equal(replayVault(vault.vaultId, vault.logs, { cache }).chains[founder.deviceId]!.length, 4);
    assert.equal(replayVault(vault.vaultId, padded, { cache }).chains[founder.deviceId]!.length, 4);
    assert.equal(replayVault(vault.vaultId, bad, { cache }).chains[founder.deviceId]!.length, 2);
    assert.equal(replayVault(vault.vaultId, vault.logs, { cache }).chains[founder.deviceId]!.length, 4);
  });

  it('the agent writes the canonical line over a padded copy of it', () => {
    const { founder, vault } = vaultWithPuts();
    const lines = vault.logs[founder.deviceId]!;
    const padded = withLine(vault, founder.deviceId, 3, lines[3]!.replace('{', `{${' '.repeat(60_000)}`));
    const plan = planAppend(vault.vaultId, padded, [JSON.parse(lines[3]!)]);
    assert.equal(plan.logs[founder.deviceId]![3], lines[3]);
    assert.equal(plan.state.chains[founder.deviceId]!.length, 4);
  });
});

