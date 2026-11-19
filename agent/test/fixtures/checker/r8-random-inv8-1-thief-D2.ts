// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/random/inv8-1-thief-D2: invariant 8. the thief D2 is active after a valid honest removal of it.
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
  "seed": "vault-model/2700",
  "ops": [
    {
      "t": "add",
      "by": "F",
      "device": "D1",
      "role": "admin"
    },
    {
      "t": "add",
      "by": "D1",
      "device": "D2",
      "role": "admin"
    },
    {
      "t": "attack",
      "kind": "slander",
      "target": "D1",
      "cut": {
        "D2": 0,
        "F": 2,
        "D1": 2
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true,
      "slander": "existing"
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
      "target": "D1",
      "cut": {
        "D2": 0,
        "F": 2,
        "D1": 2
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true
    },
    {
      "t": "remove",
      "by": "D1",
      "target": "D2",
      "pull": false,
      "push": false
    },
    {
      "t": "sync",
      "device": "D1"
    },
    {
      "t": "sync",
      "device": "F"
    }
  ],
  "violation": {
    "invariant": 8,
    "summary": "the thief D2 is active after a valid honest removal of it",
    "expected": "D2 removed",
    "got": "D2 active; D1#2 device.remove D2: rejected (its author had been removed by a change it had not seen, and this is not a removal of that remover)"
  },
  "originalSteps": 9
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
