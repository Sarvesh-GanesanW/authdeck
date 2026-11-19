// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r6/random/inv10-1-thief-D1: invariant 10. D1#2 account.put F, naming a hash that does not exist, changes honest lines that never saw it.
// Built by the vault model checker (agent/test/model). It signs every entry with the real builders
// and decides it with the real replayVault (or the module in VAULT_REPLAY_MODULE).
// Run by vaultRound5.test.ts.
// Prints the story and VIOLATED while the invariant still fails on the current rules.
const { runCounterexample } = await import(new URL('../../model/report.ts', import.meta.url).href);

const example = {
  "config": {
    "kind": "personal",
    "thief": "D1",
    "clock": "steady",
    "agent": true,
    "beacons": true
  },
  "seed": "vault-model/1800",
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
      "target": "F",
      "cut": {
        "D1": 0,
        "F": 2,
        "D2": 0
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true,
      "slander": "existing"
    },
    {
      "t": "remove",
      "by": "D2",
      "target": "F",
      "pull": true,
      "push": false
    },
    {
      "t": "recoverySet",
      "by": "F",
      "recovery": "R1",
      "pull": false,
      "push": true
    },
    {
      "t": "sync",
      "device": "D2"
    }
  ],
  "violation": {
    "invariant": 10,
    "summary": "D1#2 account.put F, naming a hash that does not exist, changes honest lines that never saw it",
    "expected": "F#2 recovery.set R1: applied",
    "got": "F#2 recovery.set R1: rejected (its author was removed or replaced, and this entry came after what the change that took it out had seen)"
  },
  "originalSteps": 8
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
