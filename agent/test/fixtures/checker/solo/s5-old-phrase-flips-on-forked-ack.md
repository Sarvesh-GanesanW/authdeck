# S5 violated: the owner's phrase change R1#0 lost to another version signed with the old phrase (a recovery.set), even after the owner's phone synced and could repair its ack

**S5.** Old phrases are dead: after a phrase change lands, the old phrase can't restore, sign an applied line past the change, or open the key from the change on.

**Run it:** `cd agent && node --import tsx test/fixtures/checker/solo/s5-old-phrase-flips-on-forked-ack.ts`

## What happened, in order

1. The owner sets a new phrase (a recovery.set signed by the current R).
2. Someone holding the current phrase signs a second R line at R's last seq (ground for the lowest hash, with R's next line chained on it): a phrase change to RZ, and publishes only the fork proof.
3. The owner restores onto a new phone with the current phrase, on what the folder holds (R's device.add, the hello, R's key.rotate, through the agent).
4. The old phone F is stolen: the thief has its keys and its copy.
5. The thief signs a second version of F's last line (an account.put) on the folder and writes it straight into the folder.

## The folder at the end, as replayVault decides it

- F#0 vault.create: applied
- F#1 recovery.set: applied
- R1#0 recovery.set: applied
- F#2 account.put: applied
- R1#0 recovery.set: rejected (the recovery phrase signed another version of this line, and that one counts)
