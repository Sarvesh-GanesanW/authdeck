// Q5: junk fork proofs the computer serves cost nothing. A proof about an id that is neither a
// member nor an identity with lines is dropped before any check, at most one proof per identity is
// checked and kept, and the keys of replaced recovery identities come from one discovery pass.
import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { provenForks } from '../src/auth/engine/sync';
import { buildAccountPut, newAccountId } from '../src/vault/build';
import { VerifyCache } from '../src/vault/chain';
import { replayVault } from '../src/vault/replay';
import { MemoryVault, device, seededRandom, totpRecord } from './helpers';

const random = seededRandom('fork-proofs-junk');

describe('junk fork proofs', () => {
  it('256 of them, about unknown ids and about a member, add under 50 ms and keep nothing', () => {
    const founder = device(random);
    const vault = new MemoryVault(founder, random);
    for (let i = 0; i < 200; i++) vault.write(buildAccountPut(vault.state(), founder, { account: newAccountId(random), record: totpRecord(), currentKey: vault.key, random, time: vault.now() }));
    const logs = vault.copy();
    const cache = new VerifyCache();
    const state = replayVault(vault.vaultId, logs, { cache });
    const line = logs[founder.deviceId]![1]!;
    const junk = Array.from({ length: 256 }, (_, i) => ({
      deviceId: i % 2 === 0 ? `${'A'.repeat(21)}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i % 26]}` : founder.deviceId,
      seq: 1,
      lines: [line, line.replace('"seq":1', '"seq":1 ')],
    }));
    const started = performance.now();
    const kept = provenForks(state, junk, logs, cache);
    const took = performance.now() - started;
    assert.deepEqual(kept, []);
    assert.ok(took < 50, `took ${took.toFixed(1)} ms`);
  });
});
