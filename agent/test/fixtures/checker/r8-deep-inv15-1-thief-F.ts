// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/deep/inv15-1-thief-F: invariant 15. D1's beacon check reports newer-epoch epoch 2 from an honest device D2.
// Built by the vault model checker (agent/test/model). It signs every entry with the real builders
// and decides it with the real replayVault (or the module in VAULT_REPLAY_MODULE).
// Run by vaultRound6.test.ts.
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
      "t": "attack",
      "kind": "slander",
      "target": "D1",
      "cut": {
        "F": 1,
        "P1": 0,
        "R1": 0,
        "D1": 0
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true,
      "fork": true,
      "slander": "pastEnd"
    },
    {
      "t": "restore",
      "device": "D2"
    },
    {
      "t": "remove",
      "by": "D2",
      "target": "D1",
      "pull": false,
      "push": true
    }
  ],
  "violation": {
    "invariant": 15,
    "summary": "D1's beacon check reports newer-epoch epoch 2 from an honest device D2",
    "expected": "no problem",
    "got": "newer-epoch epoch 2 (from D2)"
  },
  "originalSteps": 8
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
