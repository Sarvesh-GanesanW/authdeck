// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r6/random/inv6-1-thief-D2: invariant 6. deleting the rejected line F#3 key.rotate (and the rejected lines after it) changes the state.
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
  "seed": "vault-model/1500",
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
      "t": "remove",
      "by": "F",
      "target": "D1",
      "pull": true,
      "push": false
    },
    {
      "t": "restore",
      "device": "D2"
    },
    {
      "t": "rotate",
      "by": "F",
      "pull": true,
      "push": false
    },
    {
      "t": "attack",
      "kind": "forkProof",
      "forkAt": 0,
      "cut": {},
      "seenMode": "applied",
      "grind": false,
      "publish": true
    },
    {
      "t": "sync",
      "device": "F"
    }
  ],
  "violation": {
    "invariant": 6,
    "summary": "deleting the rejected line F#3 key.rotate (and the rejected lines after it) changes the state",
    "expected": "the same state without it",
    "got": "D2#0 device.hello: applied with it, rejected without"
  },
  "originalSteps": 9
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
