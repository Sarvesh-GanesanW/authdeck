# S5 violated: the owner's phrase change R1#2 lost to a restore attempt the owner signed before the change, kept by the computer and written over it (a device.add), even after the owner's phone synced and could repair its ack

**S5.** Old phrases are dead: after a phrase change lands, the old phrase can't restore, sign an applied line past the change, or open the key from the change on.

**Run it:** `cd agent && node --import tsx test/fixtures/checker/solo/s5-one-proof-slot-rolls-back-phrase-change.ts`

## What happened, in order

1. The owner tries a restore with the current phrase on another install Q; the computer keeps it instead of writing it.
2. The owner restores onto a new phone with the current phrase, on what the folder holds (R's device.add, the hello, R's key.rotate, through the agent).
3. The owner renames the phone in hand.
4. Weeks later the computer writes the kept restore attempt straight into the folder (with a fork proof where it collides).
5. The owner tries a restore with the current phrase on another install Q; the computer keeps it instead of writing it.
6. The owner sets a new phrase (a recovery.set signed by the current R).
7. Weeks later the computer takes the kept restore whose add hashes lowest, puts it in R's log in place of the line at its seq (and what followed), writes its hello, and publishes the fork proof.

## The folder at the end, as replayVault decides it

- F#0 vault.create: applied
- F#1 recovery.set: applied
- R1#0 device.add: applied
- D1#0 device.hello: applied
- R1#1 key.rotate: applied
- D1#1 device.rename: applied
- R1#2 device.add: applied
- Q2#0 device.hello: applied
- R1#3 key.rotate: applied
- D1#2 device.rename: rejected (the author was removed from the vault before this entry)
- Q#0 device.hello: rejected (it was built on a line of the recovery phrase that lost to another version)
