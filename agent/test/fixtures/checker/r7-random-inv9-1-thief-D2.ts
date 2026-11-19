// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r7/random/inv9-1-thief-D2: invariant 9. the honest agent admitted D2#1 device.remove F although its author is not a device of the vault.
// Built by the vault model checker (agent/test/model). It signs every entry with the real builders
// and decides it with the real replayVault (or the module in VAULT_REPLAY_MODULE).
// Run by vaultRound5.test.ts.
// Prints the story and VIOLATED while the invariant still fails on the current rules.
const { runCounterexample } = await import(new URL('../../model/report.ts', import.meta.url).href);

const example = {
  "config": {
    "kind": "personal",
    "thief": "D2",
    "clock": "steady",
    "agent": true,
    "beacons": true
  },
  "seed": "vault-model/1900",
  "ops": [
    {
      "t": "add",
      "by": "F",
      "device": "D1",
      "role": "admin"
    },
    {
      "t": "add",
      "by": "F",
      "device": "D2",
      "role": "admin"
    },
    {
      "t": "remove",
      "by": "D1",
      "target": "F",
      "pull": false,
      "push": true
    },
    {
      "t": "attack",
      "kind": "remove",
      "target": "F",
      "cut": {
        "D2": 0,
        "F": 3,
        "D1": 1
      },
      "seenMode": "applied",
      "grind": false,
      "publish": false
    },
    {
      "t": "release"
    }
  ],
  "violation": {
    "invariant": 9,
    "summary": "the honest agent admitted D2#1 device.remove F although its author is not a device of the vault",
    "expected": "planAppend refuses it (it is no true-symmetric counter-removal, nor a line one chains on)",
    "got": "admitted; now D2#1 device.remove F: applied"
  },
  "originalSteps": 7
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
