// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/random/inv3-1-thief-D2: invariant 3. a true-symmetric conflict (D1, F) around D1#2 device.remove F leaves D1 active.
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
    "agent": true,
    "beacons": true,
    "quota": true
  },
  "seed": "vault-model/500",
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
      "kind": "remove",
      "target": "F",
      "cut": {
        "D2": 0,
        "F": 2,
        "D1": 2
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
      "push": true
    },
    {
      "t": "remove",
      "by": "D1",
      "target": "F",
      "pull": false,
      "push": false
    },
    {
      "t": "release"
    },
    {
      "t": "sync",
      "device": "D1"
    }
  ],
  "violation": {
    "invariant": 3,
    "summary": "a true-symmetric conflict (D1, F) around D1#2 device.remove F leaves D1 active",
    "expected": "D1, F all removed",
    "got": "D1 active; D1#2 device.remove F: applied; F#2 device.remove D1: rejected (its author had been removed by a change it had not seen, and this is not a removal of that remover)"
  },
  "originalSteps": 9
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
