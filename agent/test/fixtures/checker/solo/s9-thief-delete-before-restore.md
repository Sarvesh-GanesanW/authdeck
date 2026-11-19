# S9 violated: account a1, deleted by the stolen phone (F#3, applied) before the restore onto D1, is gone and its delete is not offered for review

**S9.** Deletes by the thief come back (review P3): an account the stolen phone deleted before the restore is, once the restore lands, still there, or its delete is marked for review (caught or voided) so the restored phone is offered it back.

**Run it:** `cd agent && node --import tsx test/fixtures/checker/solo/s9-thief-delete-before-restore.ts`

## What happened, in order

1. The owner adds an account on the phone in hand (sent through the agent).
2. The old phone F is stolen: the thief has its keys and its copy.
3. The thief signs an F delete on its stale copy and sends it through the agent.
4. The owner restores onto a new phone with the current phrase, on what the folder holds (R's device.add, the hello, R's key.rotate, through the agent).

## The folder at the end, as replayVault decides it

- F#0 vault.create: applied
- F#1 recovery.set: applied
- F#2 account.put: applied
- F#3 account.delete: applied
- R1#0 device.add: applied
- D1#0 device.hello: applied
- R1#1 key.rotate: applied
