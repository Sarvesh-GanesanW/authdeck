# S4 violated: account a1, applied in what R2 saw when restoring onto D1, is gone

**S4.** The old phone is shut out: a restore with the current phrase always builds and is taken, whatever F did; afterwards every account applied in what R had seen stays (or an honest delete removed it), the restored phone reads it, F and every earlier device open no key from the rotate on, nothing F signs past its cut applies (its account lines are caught), and F, its forks, proofs and junk change nothing.

**Run it:** `cd agent && node --import tsx test/fixtures/checker/solo/s4-truncate-after-phrase-change.ts`

## What happened, in order

1. The owner sets a new phrase (a recovery.set signed by the current R).
2. The owner adds an account on the phone in hand (sent through the agent).
3. The old phone F is stolen: the thief has its keys and its copy.
4. The owner restores onto a new phone with the current phrase, on what the folder holds (R's device.add, the hello, R's key.rotate, through the agent).
5. The thief, writing the folder, replaces the last line of F's log there with junk (same entry, garbage signature).

## The folder at the end, as replayVault decides it

- F#0 vault.create: applied
- F#1 recovery.set: applied
- R1#0 recovery.set: applied
- R2#0 device.add: applied
- D1#0 device.hello: applied
- R2#1 key.rotate: applied
