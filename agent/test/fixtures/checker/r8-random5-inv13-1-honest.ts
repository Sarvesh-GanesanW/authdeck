// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/random5/inv13-1-honest: invariant 13. the agent refuses D2's true-symmetric counter-removal D2#2 device.remove F.
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
  "seed": "vault-model/800",
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
      "by": "D2",
      "target": "D1",
      "pull": false,
      "push": false
    },
    {
      "t": "remove",
      "by": "F",
      "target": "D2",
      "pull": true,
      "push": true
    },
    {
      "t": "remove",
      "by": "D2",
      "target": "F",
      "pull": false,
      "push": true
    }
  ],
  "violation": {
    "invariant": 13,
    "summary": "the agent refuses D2's true-symmetric counter-removal D2#2 device.remove F",
    "expected": "taken (its author is removed, but its removal of F was made in true symmetry)",
    "got": "refused: Entry 1 (device.remove) is by a device that was removed from this vault; only its removal of the device that removed it is taken, and the lines before it only if they change nothing."
  },
  "originalSteps": 7
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
