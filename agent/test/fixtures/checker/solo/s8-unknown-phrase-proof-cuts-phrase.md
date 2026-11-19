# S8 violated: the agent refuses a restore with the current phrase R2: Entry 1 was refused: its author signed two different entries at seq 0, so this computer takes no more changes from it.

**S8.** The phrase never dies: after any mix of attacker moves (R double-signs included), whoever holds the phrase that is current in the folder can restore (the agent takes it and the new phone opens the key), and every copy agrees on which phrase is current.

**Run it:** `cd agent && node --import tsx test/fixtures/checker/solo/s8-unknown-phrase-proof-cuts-phrase.ts`

## What happened, in order

1. The owner sets a new phrase (a recovery.set signed by the current R).
2. Someone holding the current phrase signs a second R line at the seq of the owner's phrase change (with the old phrase, on the folder as it stood before the change) (ground for the lowest hash): a restore onto its own phone Y, replacing R's line in the folder, and publishes the fork proof.
3. The owner tries a restore with the current phrase on another install Q; the computer keeps it instead of writing it.
4. The owner restores onto a new phone with the current phrase, on what the folder holds (R's device.add, the hello, R's key.rotate, through the agent).
5. Weeks later the computer writes the kept restore attempt straight into the folder (with a fork proof where it collides).

## The folder at the end, as replayVault decides it

- F#0 vault.create: applied
- F#1 recovery.set: applied
- R1#0 recovery.set: applied
- F#2 device.rename: applied
- R2#0 device.add: applied
- D1#0 device.hello: applied
- R2#1 key.rotate: rejected (its author signed two different entries at seq 1, so nothing it wrote from there counts)
- R1#0 device.add: rejected (the recovery phrase signed another version of this line, and that one counts)
- Y#0 device.hello: rejected (it was built on a line of the recovery phrase that lost to another version)
