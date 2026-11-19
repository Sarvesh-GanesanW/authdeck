// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r6/deep/inv12-1-thief-F: invariant 12. D3's join, approved by the honest admin D1, never completes.
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
      "kind": "rotate",
      "cut": {
        "F": 1,
        "R1": 0,
        "D1": 0
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true,
      "fork": true
    },
    {
      "t": "restore",
      "device": "D2"
    },
    {
      "t": "add",
      "by": "D1",
      "device": "D3",
      "role": "admin"
    }
  ],
  "violation": {
    "invariant": 12,
    "summary": "D3's join, approved by the honest admin D1, never completes",
    "expected": "D3's checkJoinedVault says ok and it writes its hello",
    "got": "intercepted: the key given to this device does not open the vault"
  },
  "originalSteps": 8
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
