// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r7/team/inv13-3-honest: invariant 13. the agent refuses D1's true-symmetric counter-removal D1#2 device.remove F.
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
    "agent": true,
    "beacons": true
  },
  "seed": "vault-model",
  "ops": [
    {
      "t": "add",
      "by": "F",
      "device": "D1",
      "role": "admin"
    },
    {
      "t": "remove",
      "by": "F",
      "target": "D1",
      "pull": false,
      "push": true
    },
    {
      "t": "put",
      "by": "D1",
      "account": "a1",
      "pull": false,
      "push": true
    },
    {
      "t": "remove",
      "by": "D1",
      "target": "F",
      "pull": false,
      "push": true
    }
  ],
  "violation": {
    "invariant": 13,
    "summary": "the agent refuses D1's true-symmetric counter-removal D1#2 device.remove F",
    "expected": "taken (its author is removed, but its removal of F was made in true symmetry)",
    "got": "refused: Entry 1 (account.put) was refused: its device never joined: its own hello did not apply."
  },
  "originalSteps": 4
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
