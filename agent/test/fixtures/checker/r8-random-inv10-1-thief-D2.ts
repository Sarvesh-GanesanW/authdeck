// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/random/inv10-1-thief-D2: invariant 10. after sharing fork proofs, D1's own copy disagrees with the folder.
// Built by the vault model checker (agent/test/model). It signs every entry with the real builders
// and decides it with the real replayVault (or the module in VAULT_REPLAY_MODULE).
// Run by vaultRound6.test.ts.
// Prints the story and VIOLATED while the invariant still fails on the current rules.
const { runCounterexample } = await import(new URL('../../model/report.ts', import.meta.url).href);

const example = {
  "config": {
    "kind": "personal",
    "thief": "D2",
    "clock": "steady",
    "agent": false,
    "beacons": true
  },
  "seed": "vault-model/400",
  "ops": [
    {
      "t": "recoverySet",
      "by": "F",
      "recovery": "R1",
      "pull": false,
      "push": false
    },
    {
      "t": "add",
      "by": "F",
      "device": "D1",
      "role": "admin"
    },
    {
      "t": "restore",
      "device": "D2"
    },
    {
      "t": "attack",
      "kind": "addPuppet",
      "cut": {
        "D2": 0,
        "F": 3,
        "D1": 1,
        "R1": 1
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true
    },
    {
      "t": "sync",
      "device": "D1"
    },
    {
      "t": "attack",
      "kind": "slander",
      "target": "F",
      "cut": {
        "D2": 0,
        "P1": 0,
        "F": 2,
        "D1": 0,
        "R1": 1
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true,
      "fork": true,
      "slander": "existing"
    }
  ],
  "violation": {
    "invariant": 10,
    "summary": "after sharing fork proofs, D1's own copy disagrees with the folder",
    "expected": "the folder's {\"accounts\":{},\"epoch\":1,\"forked\":{\"D2\":1},\"members\":{\"D1\":\"admin/active\",\"D2\":\"admin/removed\",\"F\":\"admin/active\"},\"needsFreshKey\":true,\"recovery\":\"R1\"}",
    "got": "D1: {\"accounts\":{},\"epoch\":1,\"forked\":{\"D2\":1},\"members\":{\"D1\":\"admin/active\",\"D2\":\"admin/removed\",\"F\":\"admin/active\",\"P1\":\"admin/active\"},\"needsFreshKey\":true,\"recovery\":\"R1\"}"
  },
  "originalSteps": 8
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
