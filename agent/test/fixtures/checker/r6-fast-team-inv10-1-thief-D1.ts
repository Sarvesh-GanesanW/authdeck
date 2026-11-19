// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample /var/folders/ts/ztq4yjxx1vn3r01xm6lzzd1h0000gn/T/vault-model-g1Jt5R/inv10-1-thief-D1: invariant 10. the fork proof against D1 rejects D1#1 device.remove F, which D2#0 device.hello built on.
// Built by the vault model checker (agent/test/model). It signs every entry with the real builders
// and decides it with the real replayVault (or the module in VAULT_REPLAY_MODULE).
// Run by vaultRound5.test.ts.
// Prints the story and VIOLATED while the invariant still fails on the current rules.
const { runCounterexample } = await import(new URL('../../model/report.ts', import.meta.url).href);

const example = {
  "config": {
    "kind": "team",
    "thief": "D1",
    "clock": "steady",
    "agent": false,
    "beacons": true
  },
  "seed": "vault-model-fast-team",
  "ops": [
    {
      "t": "add",
      "by": "F",
      "device": "D1",
      "role": "admin"
    },
    {
      "t": "remove",
      "by": "D1",
      "target": "F",
      "pull": false,
      "push": true
    },
    {
      "t": "add",
      "by": "D1",
      "device": "D2",
      "role": "member"
    },
    {
      "t": "attack",
      "kind": "forkProof",
      "forkAt": 2,
      "cut": {},
      "seenMode": "applied",
      "grind": false,
      "publish": true
    }
  ],
  "violation": {
    "invariant": 10,
    "summary": "the fork proof against D1 rejects D1#1 device.remove F, which D2#0 device.hello built on",
    "expected": "D1#1 device.remove F applied (cutoff at least 2); D2#0 device.hello applies without the proof",
    "got": "D1#1 device.remove F: rejected (the last device can't be removed); D2#0 device.hello: applied"
  },
  "originalSteps": 4
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
