// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r7/deep/inv8-1-thief-F: invariant 8. F#2 device.remove D1, past its author's cutoff 1 (made before it saw its removal), applies but is no true-symmetric counter-removal.
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
      "kind": "put",
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
      "kind": "remove",
      "target": "D1",
      "cut": {
        "F": 1,
        "R1": 1,
        "D1": 0
      },
      "seenMode": "heads",
      "grind": false,
      "publish": true,
      "fork": true
    },
    {
      "t": "restore",
      "device": "D2"
    },
    {
      "t": "remove",
      "by": "D1",
      "target": "F",
      "pull": false,
      "push": false
    },
    {
      "t": "sync",
      "device": "D1"
    }
  ],
  "violation": {
    "invariant": 8,
    "summary": "F#2 device.remove D1, past its author's cutoff 1 (made before it saw its removal), applies but is no true-symmetric counter-removal",
    "expected": "F#2 device.remove D1 rejected",
    "got": "F#2 device.remove D1: applied"
  },
  "originalSteps": 9
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
