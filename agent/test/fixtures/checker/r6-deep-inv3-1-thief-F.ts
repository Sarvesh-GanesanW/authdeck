// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r6/deep/inv3-1-thief-F: invariant 3. a true-symmetric conflict (F, D1) around F#2 device.remove D1 leaves F active.
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
      "target": "D1",
      "cut": {
        "F": 1,
        "P1": 0,
        "R1": 1,
        "D1": 0
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true,
      "fork": true
    }
  ],
  "violation": {
    "invariant": 3,
    "summary": "a true-symmetric conflict (F, D1) around F#2 device.remove D1 leaves F active",
    "expected": "F, D1 all removed",
    "got": "F active; F#2 device.remove D1: applied; D1#1 device.remove F: waiting (it names an entry that is not in the folder yet)"
  },
  "originalSteps": 7
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
