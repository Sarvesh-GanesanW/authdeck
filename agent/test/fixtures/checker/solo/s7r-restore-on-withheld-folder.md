# S7r violated: the restore was built on a folder rolled back or withheld by the computer: it lacks F#3

**S7r.** The computer can't sign: every applied line was signed by its author (an honest device, R, or a thief holding keys). A restore built on a rolled-back folder is reported with what it loses.

**Run it:** `cd agent && node --import tsx test/fixtures/checker/solo/s7r-restore-on-withheld-folder.ts`

## What happened, in order

1. The owner adds an account on the phone in hand (sent through the agent).
2. The computer swallows the next honest send.
3. The owner adds an account on the phone in hand (sent through the agent).
4. The owner restores onto a new phone with the current phrase, on what the folder holds (R's device.add, the hello, R's key.rotate, through the agent).

## The folder at the end, as replayVault decides it

- F#0 vault.create: applied
- F#1 recovery.set: applied
- F#2 account.put: applied
- R1#0 device.add: applied
- D1#0 device.hello: applied
- R1#1 key.rotate: applied
