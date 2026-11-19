// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r7/deep/inv10-2-thief-F: invariant 10. after sharing fork proofs, D1's own copy disagrees with the folder.
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
      "push": true
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
    }
  ],
  "violation": {
    "invariant": 10,
    "summary": "after sharing fork proofs, D1's own copy disagrees with the folder",
    "expected": "the folder's {\"accounts\":{\"6vwU8Vv5i7IcoKa0xvBysw\":\"ffPT36jv1eE73hVcZNbUQyVjhWtXPME_EfyId0mE46A\"},\"epoch\":1,\"forked\":{\"F\":2},\"members\":{\"D1\":\"admin/active\",\"D2\":\"admin/active\",\"F\":\"admin/removed\"},\"needsFreshKey\":true,\"recovery\":\"R1\"}",
    "got": "D1: {\"accounts\":{},\"epoch\":1,\"forked\":{\"F\":2},\"members\":{\"D1\":\"admin/active\",\"D2\":\"admin/active\",\"F\":\"admin/removed\",\"P1\":\"admin/removed\"},\"needsFreshKey\":true,\"recovery\":\"R1\"}"
  },
  "originalSteps": 8
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
