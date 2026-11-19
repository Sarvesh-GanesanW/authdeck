# S8 violated: the agent refuses a restore with the current phrase R1: Entry 3 has seq 2, but the next entry of its device is 3. Read the vault again and retry.

**S8.** The phrase never dies: after any mix of attacker moves (R double-signs included), whoever holds the phrase that is current in the folder can restore (the agent takes it and the new phone opens the key), and every copy agrees on which phrase is current.

**Run it:** `cd agent && node --import tsx test/fixtures/checker/solo/s8-later-r-lines-flip-fork-winner.ts`

## What happened, in order

1. The owner restores onto a new phone with the current phrase, on what the folder holds (R's device.add, the hello, R's key.rotate, through the agent).
2. The owner tries 8 restores with the current phrase on another install Q; the computer keeps them instead of writing them.
3. The owner adds an account on the phone in hand (sent through the agent).
4. Someone holding the current phrase signs a second R line at R's last seq (ground for the lowest hash, with R's next line chained on it): a restore onto its own phone Y, and publishes only the fork proof.
5. Weeks later the computer takes the kept restore whose add hashes lowest, puts it in R's log in place of the line at its seq (and what followed), writes its hello, and publishes the fork proof.

## The folder at the end, as replayVault decides it

- F#0 vault.create: applied
- F#1 recovery.set: applied
- R1#0 device.add: applied
- D1#0 device.hello: applied
- D1#1 account.put: rejected (caught) (the author was removed from the vault before this entry)
- R1#1 device.add: applied
- R1#1 key.rotate: rejected (the recovery phrase signed another version of this line, and that one counts)
