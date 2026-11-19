// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/random5/inv7-3-thief-D1: invariant 7. no honest device can write to the vault any more.
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
    "quota": true
  },
  "seed": "vault-model/2300",
  "ops": [
    {
      "t": "recoverySet",
      "by": "F",
      "recovery": "R1",
      "pull": false,
      "push": false
    },
    {
      "t": "put",
      "by": "F",
      "account": "a1",
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
      "t": "attack",
      "kind": "plantKey",
      "target": "D2",
      "cut": {
        "D1": 0,
        "F": 4
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true
    },
    {
      "t": "add",
      "by": "F",
      "device": "D2",
      "role": "admin"
    },
    {
      "t": "attack",
      "kind": "remove",
      "target": "F",
      "cut": {
        "D1": 0,
        "F": 4,
        "D2": 0
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true
    }
  ],
  "violation": {
    "invariant": 7,
    "summary": "no honest device can write to the vault any more",
    "expected": "an honest admin (or a restore) writes a fresh key if needed, then an account that applies",
    "got": "D2: its account.put is rejected"
  },
  "originalSteps": 7
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
