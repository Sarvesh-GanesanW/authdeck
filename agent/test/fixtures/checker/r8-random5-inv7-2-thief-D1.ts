// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/random5/inv7-2-thief-D1: invariant 7. no honest device can write to the vault any more.
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
  "seed": "vault-model/1500",
  "ops": [
    {
      "t": "add",
      "by": "F",
      "device": "D1",
      "role": "admin"
    },
    {
      "t": "put",
      "by": "F",
      "account": "a1",
      "pull": true,
      "push": true
    },
    {
      "t": "remove",
      "by": "D1",
      "target": "F",
      "pull": true,
      "push": false
    },
    {
      "t": "attack",
      "kind": "plantKey",
      "target": "D2",
      "cut": {
        "D1": 0,
        "F": 2
      },
      "seenMode": "applied",
      "grind": false,
      "publish": false
    },
    {
      "t": "add",
      "by": "F",
      "device": "D2",
      "role": "admin"
    },
    {
      "t": "attack",
      "kind": "put",
      "cut": {
        "D1": 0,
        "F": 2,
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
    "got": "D2: it holds no current key (or the vault still needs a fresh key)"
  },
  "originalSteps": 9
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
