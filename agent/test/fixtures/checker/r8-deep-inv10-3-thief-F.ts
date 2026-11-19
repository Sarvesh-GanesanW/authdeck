// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/deep/inv10-3-thief-F: invariant 10. the fork proof against F rejects F#2 account.put D1, which R1#1 device.add D2 built on.
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
        "D1": 1
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true,
      "fork": true,
      "slander": "existing"
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
    "invariant": 10,
    "summary": "the fork proof against F rejects F#2 account.put D1, which R1#1 device.add D2 built on",
    "expected": "F#2 account.put D1 applied (cutoff at least 2); R1#1 device.add D2 applies without the proof",
    "got": "F#2 account.put D1: rejected (its author signed two different entries at seq 2, so nothing it wrote from there counts); R1#1 device.add D2: applied"
  },
  "originalSteps": 9
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
