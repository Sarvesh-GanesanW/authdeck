# S8 violated: F's copy says the current phrase is RZ, the folder R2

**S8.** The phrase never dies: after any mix of attacker moves (R double-signs included), whoever holds the phrase that is current in the folder can restore (the agent takes it and the new phone opens the key), and every copy agrees on which phrase is current.

**Run it:** `cd agent && node --import tsx test/fixtures/checker/solo/s8-junk-r-line-picks-fork-winner.ts`

## What happened, in order

1. The owner sets a new phrase (a recovery.set signed by the current R).
2. Someone holding the current phrase signs a second R line at R's last seq: a phrase change to RZ, and publishes only the fork proof.
3. The computer appends a junk line (a copy with the next seq, signature not matching) to R1's log.

## The folder at the end, as replayVault decides it

- F#0 vault.create: applied
- F#1 recovery.set: applied
- R1#0 recovery.set: applied
