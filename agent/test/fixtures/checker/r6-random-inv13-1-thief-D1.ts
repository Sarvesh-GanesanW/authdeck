// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r6/random/inv13-1-thief-D1: invariant 13. the agent refuses F's true-symmetric counter-removal F#3 device.remove D1.
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
  "seed": "vault-model/0",
  "ops": [
    {
      "t": "add",
      "by": "F",
      "device": "D1",
      "role": "admin"
    },
    {
      "t": "attack",
      "kind": "remove",
      "target": "F",
      "cut": {
        "D1": 0,
        "F": 2
      },
      "seenMode": "applied",
      "grind": false,
      "publish": true
    },
    {
      "t": "recoverySet",
      "by": "F",
      "recovery": "R1",
      "pull": false,
      "push": true
    },
    {
      "t": "remove",
      "by": "F",
      "target": "D1",
      "pull": false,
      "push": true
    }
  ],
  "violation": {
    "invariant": 13,
    "summary": "the agent refuses F's true-symmetric counter-removal F#3 device.remove D1",
    "expected": "taken (its author is removed, but its removal of D1 was made in true symmetry)",
    "got": "refused: Entry 1 (recovery.set) is by a device that was removed from this vault; only its removal of the device that removed it is taken, never another change of who is in the vault."
  },
  "originalSteps": 5
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
