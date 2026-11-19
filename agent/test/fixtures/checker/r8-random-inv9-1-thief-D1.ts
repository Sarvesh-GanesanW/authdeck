// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/random/inv9-1-thief-D1: invariant 9. the honest agent admitted D1#1 device.add D2 although its author is removed.
// Built by the vault model checker (agent/test/model). It signs every entry with the real builders
// and decides it with the real replayVault (or the module in VAULT_REPLAY_MODULE).
// Run by vaultRound6.test.ts.
// Prints the story and VIOLATED while the invariant still fails on the current rules.
const { runCounterexample } = await import(new URL('../../model/report.ts', import.meta.url).href);

const example = {
  "config": {
    "kind": "personal",
    "thief": "D1",
    "clock": "steady",
    "agent": true,
    "beacons": true,
    "quota": true
  },
  "seed": "vault-model/1300",
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
      "kind": "plantKey",
      "target": "D2",
      "cut": {
        "D1": 0,
        "F": 2,
        "R1": 1
      },
      "seenMode": "applied",
      "grind": false,
      "publish": false
    },
    {
      "t": "remove",
      "by": "F",
      "target": "D1",
      "pull": true,
      "push": false
    },
    {
      "t": "attack",
      "kind": "remove",
      "target": "F",
      "cut": {
        "D1": 0,
        "F": 2,
        "R1": 1
      },
      "seenMode": "applied",
      "grind": false,
      "publish": false
    },
    {
      "t": "sync",
      "device": "F"
    },
    {
      "t": "release"
    }
  ],
  "violation": {
    "invariant": 9,
    "summary": "the honest agent admitted D1#1 device.add D2 although its author is removed",
    "expected": "planAppend refuses it (it is no true-symmetric counter-removal, nor a line one chains on)",
    "got": "admitted; now D1#1 device.add D2: rejected (its author was removed or replaced, and this entry came after what the change that took it out had seen)"
  },
  "originalSteps": 8
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
