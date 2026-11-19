// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/random/inv13-1-honest: invariant 13. the agent refuses F's true-symmetric counter-removal F#4 device.remove D1.
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
  "seed": "vault-model/2800",
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
      "by": "F",
      "target": "D2",
      "pull": false,
      "push": false
    },
    {
      "t": "remove",
      "by": "F",
      "target": "D1",
      "pull": false,
      "push": false
    },
    {
      "t": "remove",
      "by": "D1",
      "target": "F",
      "pull": false,
      "push": true
    },
    {
      "t": "sync",
      "device": "F"
    }
  ],
  "violation": {
    "invariant": 13,
    "summary": "the agent refuses F's true-symmetric counter-removal F#4 device.remove D1",
    "expected": "taken (its author is removed, but its removal of D1 was made in true symmetry)",
    "got": "refused: Entry 1 (device.remove) is by a device that was removed from this vault; only its removal of the device that removed it is taken, and the lines before it only if they change nothing."
  },
  "originalSteps": 9
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
