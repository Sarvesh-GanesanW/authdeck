// @ts-nocheck checker counterexample, run as is by vaultRound6.test.ts
// Counterexample (checker run) r8/random/inv10-2-thief-D2: invariant 10. the fork proof against D2 rejects D2#0 device.hello, which D1#2 key.rotate built on.
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
  "seed": "vault-model/1900",
  "ops": [
    {
      "t": "recoverySet",
      "by": "F",
      "recovery": "R1",
      "pull": false,
      "push": false
    },
    {
      "t": "add",
      "by": "F",
      "device": "D1",
      "role": "admin"
    },
    {
      "t": "remove",
      "by": "D1",
      "target": "F",
      "pull": false,
      "push": false
    },
    {
      "t": "restore",
      "device": "D2"
    },
    {
      "t": "rotate",
      "by": "D1",
      "pull": true,
      "push": true
    },
    {
      "t": "attack",
      "kind": "forkProof",
      "forkAt": 0,
      "cut": {},
      "seenMode": "applied",
      "grind": false,
      "publish": true
    }
  ],
  "violation": {
    "invariant": 10,
    "summary": "the fork proof against D2 rejects D2#0 device.hello, which D1#2 key.rotate built on",
    "expected": "D2#0 device.hello applied (cutoff at least 0); D1#2 key.rotate applies without the proof",
    "got": "D2#0 device.hello: rejected (its author signed two different entries at seq 0, so nothing it wrote from there counts); D1#2 key.rotate: rejected (it starts epoch 2, but the last key it had seen was epoch 2)"
  },
  "originalSteps": 8
};

process.exitCode = (await runCounterexample(example)) ? 1 : 0;
