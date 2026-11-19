# S3 violated: the agent refused D1#1 account.put (Entry 1 is by a device that was removed from this vault (or cut off), so this computer takes no more changes from it.) but replay applies it

**S3.** Device lines are limited: only device.hello, account.put, account.delete and device.rename by a device ever apply; every other kind by a device is refused by planAppend and rejected by replay, and the two agree on every line offered.

**Run it:** `cd agent && node --import tsx test/fixtures/checker/solo/s3-cut-device-flips-r-fork.ts`

## What happened, in order

1. The owner restores onto a new phone with the current phrase, on what the folder holds (R's device.add, the hello, R's key.rotate, through the agent).
2. Someone holding the current phrase signs a second R line at R's last seq: a restore onto its own phone Y, replacing R's line in the folder, and publishes the fork proof.
3. The owner adds an account on the phone in hand (sent through the agent).

## The folder at the end, as replayVault decides it

- F#0 vault.create: applied
- F#1 recovery.set: applied
- R1#0 device.add: applied
- D1#0 device.hello: applied
- R1#1 device.add: applied
- Y#0 device.hello: applied
- R1#2 key.rotate: applied
