// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r6/deep/inv8-2-thief-F: invariant 8. the current key (epoch 3) was made by P1#1 device.remove D1, so the thief, which is out of the vault, knows it.
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
      "target": "F",
      "pull": true,
      "push": true
    },
    {
      "t": "attack",
      "kind": "remove",
      "as": "P1",
      "target": "D1",
      "cut": {
        "F": 1,
        "P1": 0,
        "R1": 1,
        "D1": 2
      },
      "seenMode": "applied",
      "grind": false,
      "publish": false
    },
    {
      "t": "release"
    }
  ],
  "violation": {
    "invariant": 8,
    "summary": "the current key (epoch 3) was made by P1#1 device.remove D1, so the thief, which is out of the vault, knows it",
    "expected": "a key the thief never saw, or needsFreshKey",
    "got": "P1#1 device.remove D1: applied; needsFreshKey false"
  },
  "originalSteps": 8
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
