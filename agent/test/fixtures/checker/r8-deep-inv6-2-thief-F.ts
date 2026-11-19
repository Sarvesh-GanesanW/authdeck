// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/deep/inv6-2-thief-F: invariant 6. deleting the rejected line D1#1 device.remove P1 (and the rejected lines after it) changes the state.
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
      "t": "restore",
      "device": "D1"
    },
    {
      "t": "release"
    },
    {
      "t": "remove",
      "by": "D1",
      "target": "P1",
      "pull": true,
      "push": false
    },
    {
      "t": "attack",
      "kind": "put",
      "cut": {
        "F": 1,
        "P1": 0,
        "R1": 0,
        "D1": 0
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true,
      "fork": true
    },
    {
      "t": "restore",
      "device": "D2"
    },
    {
      "t": "sync",
      "device": "D1"
    }
  ],
  "violation": {
    "invariant": 6,
    "summary": "deleting the rejected line D1#1 device.remove P1 (and the rejected lines after it) changes the state",
    "expected": "the same state without it",
    "got": "F#2 account.put x1: rejected with it, applied without"
  },
  "originalSteps": 9
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
