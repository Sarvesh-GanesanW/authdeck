// @ts-nocheck checker counterexample, run as is by vaultRound5.test.ts
// Counterexample (checker run) r6/random/inv14-1-honest: invariant 14. the agent refuses an exact retry of F#1 recovery.set R1, lines it had just stored.
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
  "seed": "vault-model/0",
  "ops": [
    {
      "t": "recoverySet",
      "by": "F",
      "recovery": "R1",
      "pull": false,
      "push": true
    }
  ],
  "violation": {
    "invariant": 14,
    "summary": "the agent refuses an exact retry of F#1 recovery.set R1, lines it had just stored",
    "expected": "taken (an exact retry changes nothing)",
    "got": "refused: Entry 1 would replace entry 1 of its device, which is already verified in the folder."
  },
  "originalSteps": 1
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
