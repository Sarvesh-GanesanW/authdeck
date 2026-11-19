// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/deep/inv17-1-thief-F: invariant 17. D2 is listed as unkeyed, but no honest admin or phrase can approve it again so that it opens the key.
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
      "t": "restore",
      "device": "D1"
    },
    {
      "t": "attack",
      "kind": "recoverySet",
      "cut": {
        "F": 1,
        "R1": 1,
        "D1": 0
      },
      "seenMode": "applied",
      "grind": false,
      "publish": false
    },
    {
      "t": "release"
    },
    {
      "t": "add",
      "by": "D1",
      "device": "D2",
      "role": "admin"
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
    "invariant": 17,
    "summary": "D2 is listed as unkeyed, but no honest admin or phrase can approve it again so that it opens the key",
    "expected": "a re-approval of D2 that gives it the current key",
    "got": "tried R1: none worked"
  },
  "originalSteps": 9
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
