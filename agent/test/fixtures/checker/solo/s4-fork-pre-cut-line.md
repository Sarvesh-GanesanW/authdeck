# S4 violated: account a1, applied in what R1 saw when restoring onto D1, is gone

**S4.** The old phone is shut out: a restore with the current phrase always builds and is taken, whatever F did; afterwards every account applied in what R had seen stays (or an honest delete removed it), the restored phone reads it, F and every earlier device open no key from the rotate on, nothing F signs past its cut applies (its account lines are caught), and F, its forks, proofs and junk change nothing.

**Run it:** `cd agent && node --import tsx test/fixtures/checker/solo/s4-fork-pre-cut-line.ts`

## What happened, in order

1. The computer adds a junk fork proof and a junk seal proof.
2. The owner adds an account on the phone in hand (sent through the agent).
3. The owner restores onto a new phone with the current phrase, on what the folder holds (R's device.add, the hello, R's key.rotate, through the agent).
4. The old phone F is stolen: the thief has its keys and its copy.
5. The thief signs a second version of F's last line (an account.put) on the folder and holds it back.
6. The thief signs an account.put with a garbage signature on its stale copy and writes it straight into the folder.

## The folder at the end, as replayVault decides it

- F#0 vault.create: applied
- F#1 recovery.set: applied
- R1#0 device.add: applied
- D1#0 device.hello: applied
- R1#1 key.rotate: applied
- F#2 account.put: rejected (caught) (the author was removed from the vault before this entry)
