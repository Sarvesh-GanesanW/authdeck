# S8 violated: the agent refuses a restore with the current phrase R1: Entry 3 has seq 2, but the next entry of its device is 3. Read the vault again and retry.

**S8.** The phrase never dies: after any mix of attacker moves (R double-signs included), whoever holds the phrase that is current in the folder can restore (the agent takes it and the new phone opens the key), and every copy agrees on which phrase is current.

**Run it:** `cd agent && node --import tsx test/fixtures/checker/solo/s8-stale-r-proof-kills-phrase.ts`

## What happened, in order

1. The owner tries a restore with the current phrase on another install Q; the computer keeps it instead of writing it.
2. The owner restores onto a new phone with the current phrase, on what the folder holds (R's device.add, the hello, R's key.rotate, through the agent).
3. The owner sets a new phrase (a recovery.set signed by the current R).
4. The owner's phrase change is signed again (same new phrase) at R's last seq: a second recovery.set to the same phrase, and publishes only the fork proof.
5. Weeks later the computer takes the kept restore whose add hashes lowest, puts it in R's log in place of the line at its seq (and what followed), writes its hello, and publishes the fork proof.

## The folder at the end, as replayVault decides it

- F#0 vault.create: applied
- F#1 recovery.set: applied
- R1#0 device.add: applied
- Q#0 device.hello: applied
- R1#1 key.rotate: applied
