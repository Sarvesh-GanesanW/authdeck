// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/random/inv7-1-thief-D2: invariant 7. no honest device can write to the vault any more.
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
      "t": "remove",
      "by": "D1",
      "target": "F",
      "pull": false,
      "push": false
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
    "invariant": 7,
    "summary": "no honest device can write to the vault any more",
    "expected": "an honest admin (or a restore) writes a fresh key if needed, then an account that applies",
    "got": "D1: it holds no current key (or the vault still needs a fresh key)"
  },
  "originalSteps": 8
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
