// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r6/deep/inv15-2-thief-F: invariant 15. D2's beacon check reports newer-epoch epoch 2 from an honest device D1.
// Built by the vault model checker (agent/test/model). It signs every entry with the real builders
// and decides it with the real replayVault (or the module in VAULT_REPLAY_MODULE).
// Run by vaultRound5.test.ts.
// Prints the story and VIOLATED while the invariant still fails on the current rules.
const { runCounterexample } = await import(new URL('../../model/report.ts', import.meta.url).href);

const example = {
  "config": {
    "kind": "personal",
    "thief": "F",
    "clock": "steady",
    "agent": false,
    "beacons": true
  },
  "seed": "vault-model",
  "ops": [
    {
      "t": "recoverySet",
      "by": "F",
      "recovery": "R1",
      "pull": false,
      "push": true
    },
    {
      "t": "attack",
      "kind": "addPuppet",
      "cut": {
        "F": 1
      },
      "seenMode": "applied",
      "grind": false,
      "publish": false
    },
    {
      "t": "release"
    },
    {
      "t": "restore",
      "device": "D1"
    },
    {
      "t": "restore",
      "device": "D2"
    },
    {
      "t": "remove",
      "by": "D1",
      "target": "P1",
      "pull": false,
      "push": false
    },
    {
      "t": "sync",
      "device": "D1"
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
    "invariant": 15,
    "summary": "D2's beacon check reports newer-epoch epoch 2 from an honest device D1",
    "expected": "no problem",
    "got": "newer-epoch epoch 2 (from D1)"
  },
  "originalSteps": 9
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
