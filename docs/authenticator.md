# The authenticator

AuthDeck keeps your two-factor codes on your phone or tablet and types them into your computer
when you tap a key. This page explains how the vault works and what it protects against. It is
the design the code follows; if the two ever disagree, the code is wrong.

## What you get

- Codes for TOTP (most sites), HOTP (counter-based) and Steam Guard, made on your phone or tablet.
  They work with no network and no computer.
- A 2FA key on the deck shows the live code. Tapping it types only the digits on the paired
  computer.
- Add accounts by scanning a site's QR code, typing the key by hand, or importing from
  Google Authenticator's "Transfer accounts" QR code.
- One device and a backup (0.3.0): your codes live on one phone, the vault folder on your
  computer is its encrypted backup, and the recovery phrase restores it onto a new phone.
- A 12-word recovery phrase. With it and a copy of the vault folder you can get everything back
  if the phone is lost.
- App lock with Face ID, fingerprint or your device passcode. It never locks you out: if the
  device loses its screen lock, the recovery phrase opens the vault instead.
- Coming in 0.4: the same vault on several devices (a new device joins when one you already
  trust approves it, after you check that both show the same code, names and key words), and
  team vaults, a shared folder that several people's devices can read, with a signed history of
  who changed what. The sections on those below describe that code, which ships turned off.

## Solo vaults (0.3.0)

0.3.0 ships one kind of vault, `solo` (`vault.create` carries `kind: "solo"`, so a later
conversion to a multi-device vault is one change signed by the recovery phrase). The rules
themselves keep what can be reached small, in the replay every device runs and in the agent's
append check (`planAppend`):

- **Who is in it:** at most one active device, plus the recovery identity R that the phrase
  derives.
- **Only R adds a device, by restoring.** A restore is R's `device.add` of a new device D, D's
  `device.hello`, and R's `key.rotate` right after the add, all sent together; the agent refuses a
  restore without its key change. R's approval of D also removes every earlier device, after what
  R had seen of it: restoring is removing, in one step, with no separate removal entry. The key
  change is sealed only to D and R (with deterministic seals), so the old phone can't read
  anything written after it.
- **Only R changes the phrase.** A new phrase is a `recovery.set` signed by the current R, so the
  app asks for the current 12 words first, and sends the change only once the new words are
  checked. The founding device sets the first R as its second entry, right after creating the
  vault, and never again.
- **No phrase, a new vault.** Someone who never kept the first phrase can't sign a new one, so
  "I don't have my phrase" (in the first step of making a new phrase) makes a new solo vault
  instead; see "Recovery phrase". No rule changes: a device still can't sign `recovery.set`.
- **What a device may write:** its hello, renames and its own account lines. `device.add`,
  `device.remove`, `key.rotate` and `recovery.set` from a device are rejected by the replay and
  refused by the agent. A device that signs two histories is cut at the seq before the fork, as
  in every vault.
- **A stolen old phone,** before the restore lands, can keep writing account lines until the
  cut. Lines it wrote after the cut that reached the folder first are rejected, shown for review
  labelled "made after <device> was removed", and left unselected. It can't change the phrase,
  rotate the key, add a device of its own or remove anyone. After the restore, the agent takes
  nothing more from it.
- **Limits:** the per-identity shares stay. A restore and R's key changes and phrases pass every
  share and cap, so a full vault can always be restored.
- **A computer that rolls the folder back** past a restore, or anything else the phone has seen,
  shows as withholding changes, as in every vault.
- The recovery identity may write `key.rotate` and `recovery.set` only in a solo vault; in any
  other vault the replay rejects them (R is never an admin device there) and the agent refuses
  them.
- The agent serves solo vaults only, in its own folder: it reads no team folder, refuses to
  create or change any other kind of vault ("This vault was made by a newer or test build of
  AuthDeck. Multi-device vaults arrive in 0.4."; no released build could make one, since 0.2.0
  had no vault screens, so nothing needs converting), and refuses join requests. The multi-device code
  stays behind one switch, `MULTI_DEVICE_VAULTS` (`vault/features.ts`), off in 0.3.0; the app
  hides adding, approving and joining devices, the device list, roles and team folders behind the
  same switch.
- Settings > Authenticator says where the backup lives ("Backed up, encrypted, on <computer>")
  and when this phone last synced it.

## Who is trusted

| | Trusted with secrets? |
|---|---|
| Your phones and tablets, in their secure storage | Yes |
| Your recovery phrase | Yes |
| The computer running AuthDeck Agent | No |
| The vault folder, and wherever it is synced (Dropbox, iCloud, Git…) | No |
| Your network | No |

The computer stores the vault folder, relays join messages and types codes, but it never holds a
secret or the key to read one. The folder holds only encrypted data and a history in which every
change is signed by the device that made it. Someone who copies or edits the folder can't read
your accounts, add one, or change one without it being noticed.

What the folder does reveal: how many devices you have (as public keys), how many changes were
made, each device's own claimed times, and of what kind ("an account was added"). It does not
reveal account names, issuers, secrets, device names or team names. During a join, the two device
names and the vault name travel through the computer in plain text (see "Approving a new device").

## Cryptography

| Purpose | Choice |
|---|---|
| Signatures | Ed25519, strict RFC 8032 (no ZIP-215 leniency) |
| Key agreement | ristretto255 (sealing keys); X25519 (the link) |
| Encryption | AES-256-GCM, 96-bit random nonce per message |
| Key derivation | HKDF-SHA-256 |
| Hashing, commitments | SHA-256, HMAC-SHA-256 |
| Recovery phrase | BIP-39, 12 English words (128 bits) |

The code uses `@noble/curves`, `@noble/hashes`, `@noble/ciphers` and `@scure/bip39`: small, pure
TypeScript libraries that have been independently audited. Randomness comes from the platform's
secure generator; the core copies what it gets and checks its length.

**Keys a vault refuses.** A sealing key must be a canonical ristretto255 encoding and not the
identity. An Ed25519 key must decode as a point, not of small order, and torsion-free.
A body naming any other key is malformed, wherever it appears, so it can never block a later
key rotation.

**Sealing a key to a device (deterministic).** Sealing keys are ristretto255 points. A device's
sealing secret is 32 bytes; its scalar is `s = HKDF(secret, info = "authdeck/seal-scalar/v3", 64 bytes) mod ℓ`
and its public key `R = s·G`. To give key `K` to recipient `to` with key `R`, at `epoch`:
`e = HKDF(K, salt = R, info = "authdeck/seal-ephemeral/v3" ‖ aad, 64 bytes) mod ℓ`, `E = e·G`,
`S = e·R`, `(k, nonce) = HKDF(S, salt = E ‖ R, info = "authdeck/seal/v3" ‖ aad, 44 bytes)`, and the
seal is `{ e: E, r: R, ct: AES-GCM(k, nonce, K, aad) }` with `aad` the canonical JSON
`{ kind: "seal", vault, epoch, to }`, so a sealed key can't be moved to another vault, epoch or
recipient. Every byte follows from `K`, `R` and the context, so any device holding `K` rebuilds
every seal of it (key changes, phrase changes and approvals) and sees one that differs. In
`vault.create` and `device.add` the seal's `r` must be the body's `x`; in `recovery.set` the seal
to the new recovery identity must name its `x`. A seal counts only when made to the sealing key
its recipient was given: one made to another key leaves the recipient unkeyed (and a key change
doing that strands it).

**Proving a bad seal.** A recipient whose seal doesn't open to the entry's key check (a key change's
own; an approval's is its epoch's) publishes `{ entry, to, proof }`: the shared point `S = s·E` and
a Chaum-Pedersen proof that `log_G(R) = log_E(S)` (`R` the key the seal names): nonce
`t = H(s, entry, to, E)`, `c = SHA-512("authdeck/seal-proof/v1" ‖ lp(entry, to, R, E, S, t·G, t·E)) mod ℓ`,
`z = t + c·s`; `proof = S ‖ c ‖ z`. Anyone checks it, opens the seal with `S` and sees it fail.
An honest author's seal can never be shown bad: the proof admits only the true `S`, and with it
a good seal opens. A proof about the author's own seal never counts. Proofs travel like fork
proofs (`vault.forks.write` with `sealProof`; `vault.forks.read` returns `sealProofs`); the agent
checks each and keeps `seals/<authorId>.json`, the author's earliest, and each device keeps the
ones it found with its local copy. A solo vault keeps and shares none: only its device and its
phrase hold seals, so no third party can be harmed by a bad one. Every replay applies them, judged on the replay without them:
the entry is void and its author cut off at the seq before it, like a fork no one's building on
can raise. A voided key change keeps its epoch on the chain with a key no one else holds, so
key changes built after it stay numbered right, and the vault then needs a fresh key. Account
changes made under that key are caught, to be reviewed and made again.

**A bad seal never locks a device out.** When a device's seal for the current key is bad, or it is
an active device not given the current key yet, it opens read-only on the newest older key it
holds: codes show as of that key. It can still remove a device, make a fresh key or set a new
phrase, each built on that key: its `prevKey` carries that older key, and readers match a
`prevKey` to the epoch whose key check it passes (at most 8 unmatched keys are carried). Restore
with the phrase does the same: the new device is added on the newest key the phrase opens. A
device holding the key that finds a bad seal in the change that made the current key pauses new
secrets, and an admin device among them writes a fresh `key.rotate`. The warning (kind
`bad-seal`, "A device gave out a vault key that does not open") says "<Writer> changed the vault
key, and the copy it gave <recipients> does not open, so it/they can't read accounts saved after
that." (for an approval: "<Writer> approved <device> with a copy of the vault key that does not
open."), then, on the recipient while read-only: "This device shows codes as of the last key it
could open; it can remove a device, but not change accounts.", then, when it is the current key:
"An admin device that holds the key makes a fresh one by itself.", then "If you don't trust
<Writer>, remove it."

**The server records whom a phone unpairs.** The agent remembers which paired phone sent each
vault identity's lines only for lines that actually changed the folder, and only when the append
wrote exactly one identity's log, the sender's own; a phone re-sending another device's stored
lines can't take that device's place.

**One key per purpose.** An epoch key is never used directly. Each use takes its own subkey,
`HKDF(epoch key, info = "authdeck/subkey/v2/" ‖ purpose)`: `box/<kind>` to encrypt each kind of
box, `commit/<kind>` for its commitment, and `keycheck` for the key commitment.

**Key commitment.** Every epoch's key is published as
`keyCheck = HMAC(keycheck subkey, { kind: "keycheck", vault, epoch })` in the entry that makes it
(`vault.create`, `device.remove`, `recovery.set`). A device refuses an epoch key that does not
match its key check, so an admin can't hand two devices different keys for one epoch and show them
different secrets from the same log.

**Encrypting with the vault key.** Account records, names and older keys are boxes
`{ epoch, n, ct, c }`. The AAD is the canonical JSON of what the box is:
`{ kind: "account", vault, epoch, author, account }`, `{ kind: "vault.name", vault, epoch }`,
`{ kind: "device.name", vault, epoch, device }` or `{ kind: "prevKey", vault, epoch }`.
`c = HMAC(commit subkey, nonce ‖ aad)` commits the box to its key and is checked before
decrypting, so one ciphertext can't open to two records under two keys. A box copied from another
vault, account, author or field fails to open.

**Ids and key words.** A device id is the first 16 bytes of `SHA-256(ed25519 public key)`,
base64url. A vault id is the first 16 bytes of
`SHA-256("authdeck/vault/v2" ‖ founder's ed25519 public key ‖ salt)`, where `salt` is 16 random
bytes stored in `vault.create`. A device's key words are three BIP-39 words taken from
`SHA-256("authdeck/keywords/v1" ‖ ed25519 public key)`. People compare them by eye.

**Canonical form.** Entries are JSON. Before hashing or signing, an entry is written with object
keys sorted, no whitespace, integers only (no floats), bytes as unpadded base64url, and strings in
printable ASCII: `"` and `\` are escaped, and every other character is written as `\uXXXX`
(lower-case hex, UTF-16 units), so every JavaScript engine writes the same bytes. `hash(entry)` is
SHA-256 of the canonical form including `sig`. The signature covers
`"authdeck/entry/v2\n" ‖ canonical form without sig`.

**Lines are normalised on read.** The hash and signature cover only an entry's canonical form.
A log line is parsed (if it is within the raw cap of 128 KiB, `MAX_RAW_LINE_BYTES`) and its
signature checked over the canonical form of what it parses to, so a padded or re-encoded copy of
a signed line (extra spaces, reordered keys, other escapes, `2e0` for `2`) reads as the entry it
encodes: re-encoding a log can't hide an honest device's lines or stop a restore building on
them. Every replay keeps the canonical text (`VerifiedEntry.text`) and notes which logs hold
another encoding (`state.reencoded`). Sizes, shares and quotas count canonical bytes only, so
nobody who can write the folder can inflate an honest device's usage. The agent stores what it is
sent in canonical form, and rewrites a re-encoded log canonically on its next append to the
vault (an exact retry included). A repair writes the verified canonical line over junk at that
seq for any identity, the recovery identity and the vault's founder among them. The app stores
and adopts only canonical text, and compares exact retries on canonical text.

## The vault folder

```
<vault folder>/<vaultId>/        personal: $AUTHDECK_HOME/vault (default ~/.authdeck/vault); team: the team folder
  vault.json             { "v": 1, "vaultId": "…", "kind": "personal" | "team" }  (a hint only)
  log/<deviceId>.jsonl   one file per identity: its own signed entries, one per line
  heads/<deviceId>.json  one signed head beacon per device, overwritten (see "Withheld changes")
  forks/<deviceId>.json  proof that a device signed two entries at one seq (see "Forks")
```

Each device writes only its own log file, so sync tools never see two devices editing the same
file. Each recovery identity has a log too, for the `device.add` entries it signs on a restore.
Files with other names (a sync tool's conflict copies, temporary files) are ignored. Folders are
owner-only (mode 0700), files are written to a temporary name and renamed, and files are opened
without following links, so a link planted in a synced folder is never read.

## Log entries

```json
{
  "v": 2,
  "vault": "<vaultId>",
  "author": "<deviceId>",
  "seq": 4,
  "prev": "<hash of this identity's entry 3, or null at seq 0>",
  "seen": { "<deviceId>": { "seq": 7, "hash": "<hash of that identity's entry 7>" } },
  "time": 1794845050123,
  "kind": "account.put",
  "body": { },
  "sig": "<Ed25519 signature>"
}
```

`seen` names, for every identity, the latest entry of theirs the author had **applied** when it
signed. `time` is the author's own clock in milliseconds. It is at least the author's previous
`time` and at least the `time` of every entry named in `seen`, so it never runs backwards along
what a device had seen. It only orders account edits made at the same time; nothing about who may
do what depends on it, and History shows it as that device's clock.

| Kind | Body | Who may write it |
|---|---|---|
| `vault.create` | vault kind, salt, founder's public keys, encrypted vault and device names, epoch 0 key sealed to the founder, key check | only the founder, as its entry 0, with a vault id that matches its key and salt |
| `device.hello` | its sealing key, and the hash of the `device.add` it confirms | a device introduced by that `device.add`, as its entry 0, with it in `seen` |
| `device.add` | new device's id and public keys, role, encrypted name, epoch, current key sealed to it | an admin device, or the current recovery identity (its entry 0 and later) |
| `device.remove` | removed device id; the new epoch, its key sealed to every remaining device and the recovery key, the previous key encrypted under it (`prevKey`), the key check | an admin device, for another device |
| `key.rotate` | the new epoch, its key sealed to every device and the recovery key, `prevKey`, the key check; removes no one | an admin device, when the vault needs a fresh key |
| `device.rename` | device id, encrypted name | the device itself, or an admin |
| `recovery.set` | recovery public keys; the new epoch, its key sealed to every device and the new recovery key, `prevKey`, the key check | an admin device |
| `account.put` | account id, a box of the account record under the current epoch | any device |
| `account.delete` | account id | any device |

In a personal vault every device is an admin, and a `device.add` with the member role is
rejected. A device can't remove itself, and no single removal takes out a team vault's last
admin, though two admins removing each other at the same time both go (see "Deciding what is
real"). A removed device
can't be added back with the same keys; it makes new ones. A device a rotation left without the
new key (approved at the same time as the rotation) is approved again by any admin device,
automatically, with a `device.add` that must carry exactly the keys and role it already has.
`prevKey` lets a device walk back from the key it was given to every older key (each checked
against its key check), so it can read accounts written before it joined; nothing gives a removed
device or a replaced phrase a newer key.

An account record is `{ issuer, label, secret, type, algorithm, digits, period, counter }`, plus an
optional icon and its position on the deck. The secret must decode to 10–128 bytes, the period is
1 s to 1 day, and every record passes the same check on every device. A change rewrites the whole
record. A change made after seeing another one wins; when two devices change one account at once,
the higher `time` wins, ties broken by entry hash. HOTP counters take the higher of the two values,
so a counter never goes backwards.

## Deciding what is real

Every device, and the agent, applies the same rules. The result depends only on the folder's
contents (and any fork proofs, below). It doesn't depend on the order files are read. For who is
in the vault, it never depends on anyone's clock, on which device is older, or on which change
reached the folder first.

1. **Chains.** The founder is the identity whose log starts with a `vault.create` that matches the
   vault id. Any other log is read once a verified entry names its identity in a `device.add`, or
   in a `recovery.set` for a recovery identity. Each log is checked once per replay, however long
   the chain of approvals. Whether that entry counts is decided by the rules below.
   In each log:
   - `seq` counts up from 0, and every `prev` is the hash of the entry before it;
   - every body has the right shape for its kind, and `time` never goes backwards;
   - the first entry has the kind its role needs;
   - every line carries a valid signature by its identity. A log is trusted up to just before
     its first bad line; nothing after a bad line counts, even a signed line that chains on it.
     Each line's signature is checked once: devices and the agent remember every verdict, good
     or bad, so a junk tail costs one check, once.

   A log is trusted up to its first bad line.
2. **Causal order.** Each entry's causal past is its own earlier entries and everything named in
   its `seen`, transitively.
   - An entry that names a seq past the end of a log waits, with everything after it in its
     author's log, until that entry arrives.
   - An entry that names a hash different from the folder's at that seq counts as having seen that
     log up to the entry before. Both versions share that part. The conflict is recorded, but the
     naming entry is never rejected for it, so a device can't undo what others built on its entry
     by signing that entry again.
     Without a fork proof (below) anyone could write such a hash, so the warning names the device
     that wrote the naming entry, not the device it names. Only a fork proof accuses a device of
     signing two versions.
   - Entries are sorted so that each comes after its causal past. Entries with no order between
     them are sorted by `time`, then by hash. This order only matters for account edits.
3. **Membership** (`vault.create`, `device.add`, `device.hello`, `device.remove`, `recovery.set`,
   `key.rotate`). Each change is checked against its own view: the applied changes in its causal
   past.
   - Its author must be an admin there, and not removed there.
   - A removal's target must be in the vault there.
   - A key change (`key.rotate`, `recovery.set`, and the key every removal carries) must start the
     epoch after the last key it had seen, and seal the new key to every device staying in that
     view and the recovery key only. "Staying" means devices that have joined, plus devices
     approved but not joined yet whose approver is still in and is not the one being removed.
   - **Joining.** A device is in the vault only once its own `device.hello` applies. The hello
     names the approval it confirms (by hash) and the device's sealing key (`x`), which must match
     that approval's, or the hello is rejected and the device never joins. Its keys, role, name and
     the key it was given all come from that approval, whatever other approvals of it say. So an admin can't approve your phone's signing key with
     a sealing key of its own and receive your keys later. New keys are sealed only to devices that
     have joined, plus a just-approved device through its approval.

   **The principle.** An identity that is cut off, by a removal or by a fork, can never change
   anything outside a true-symmetric conflict. Changes made at the same time (neither had the
   other in its causal past) are decided by three rules, never by who made them or when they
   arrived:

   1. **The better-informed side wins.** A removal of X that applies takes X out from what it had
      seen of X: everything X signed after that is cut off (rule 4). Nothing X signed without
      seeing that removal can reject, cut off or out-rank what the removal's author had seen. If X
      removed some device Y at the same time, Y's cutoff is never below what X's remover had seen
      of Y.

      This holds for every membership change X signed past its cutoff (a removal, an approval, a
      recovery phrase, a key change), even when X was honest and simply hadn't seen its own
      removal: such a change is **void**, unless it is a true-symmetric counter-removal (rule 2).
      Its account changes are rejected the same way. So "D2 removes F" can be undone after the
      fact by "D1 removes D2" that D2 hadn't seen. In the folder this honest case looks exactly
      like a removed device writing stale changes on purpose, so the app only tells it, in neutral
      words, and offers no button to redo it: "<D2>, which was removed, also tried to remove <F>.
      Nothing changed." with "If you want <F> removed, remove it from its page." while F is still
      in. Voided approvals, phrases and key changes are told the same way ("<D2>, which was
      removed, also tried to approve <N>. <N> didn't join."). Nothing voided is ever redone;
      caught account changes keep their own review (below). The same holds for a device brought
      in only by a cut-off device's lines it signed past its cutoff: it was never really in, and
      its removals never apply.
   2. **True symmetry, and only true symmetry, removes both.** Two removals are truly symmetric
      when each was made, or made possible, by the other's target through lines the other had not
      seen: T1 removes T2 while T2 removes T1; or T1 removes T2 while T2 approves T3 (unseen by
      T1) and T3 removes T1. Then T1, T2 and T3 are all out, and neither side protects anything.
      Nothing in the folder can tell the honest side from the thief here (the same lines with the
      names swapped are the opposite story), so the only answer that is safe both ways is "all
      out". A removed device never comes back with the same keys.
   3. **Rejected entries have no effect.** The rules decide in layers, each on the survivors of
      the one before, and there is exactly one outcome:
      1. *Authors, views and removals.* A removal applies if and only if it passes its own view,
         replayed from its causal past alone, and its author is not cut off by another applied
         removal it hadn't seen (unless it is a true-symmetric counter-removal). The second part
         is settled as a grounded labelling of the "attacks" between removals: q attacks r when q
         is a removal of r's author, passes its own view, hadn't seen r, and r is not a counter to
         q. A removal nothing attacks applies; one attacked by an applied removal is rejected;
         the rest (removals that attack each other in a cycle, which is exactly true symmetry)
         apply, so every party goes out. The labelling only adds verdicts as it goes (an applied
         label never turns rejected within the computation), it is computed over a fixed set of
         removals each judged on its own past, so it is monotone, ends after at most as many
         steps as there are removals, and has a single least fixed point: the answer.
         A removal's own judgement reads the removals in its past as they stand once settled
         within that past: one that a removal of its author voids there removes nothing, so a
         thief can't make its puppet unremovable by "removing" it itself before its own removal
         lands. Each removal in that past was judged the same way on its own, smaller past, and
         causal order is well founded, so judging in that order gives every removal one verdict,
         and judging again changes none: one fixed point, reached in one pass, that only the
         removal's past decides. A counter-removal survives only when it targets the remover
         that cut its author off, directly or through whom that remover is in. Nothing
         that arrives later can take an applied removal back except a removal of its author it
         hadn't seen, and that is a property of the lines, not of when they arrived. Cutoffs (rule 4) and recovery phrases replaced at the same time (two at
         once keep the one with the lower hash; a kept phrase cuts off every earlier one it saw)
         are then settled together with every other membership change. Ranking phrases can
         change which phrases apply, so it repeats. Each round is a fixed function of the round
         before (hash and causal order only), so every replay walks the same rounds. Rejections
         by ranking only grow and are bounded by the number of phrases; between them the rounds
         move in a finite space, so they reach either a fixed point (the answer: every kept
         phrase passes the rules under the cutoffs it makes) or a repeated round. A repeated
         round, or a guard bound of 256 rounds, is the fail-safe: every phrase whose standing
         changed in the cycle is rejected and ranking starts again. The vault then needs a fresh
         key, so new secrets pause with a warning, until an admin writes a key change after all
         of them; set a new phrase afterwards. No state is ever taken from an unfinished round.
         The deepest ranking the tests build settles in 4 rounds.
      2. *Key changes,* ranked only among those that applied (5).
      3. *Account edits and names* (6).
   4. **A device is in only once its own hello applies** (above).

   Why these rules, in short: removals are judged on their own past, so an applied removal stays
   applied whatever arrives later (nothing is lost in an honest run); cutoffs only grow from what
   removals saw, so what was cut off stays cut off; protection (1) keeps a thief from undoing what
   its remover had seen by removing that remover's approver; and true symmetry gets no protection,
   so a thief can't use the mirror image of that move (approving a puppet from its stale copy that
   removes the honest device) to keep the vault. The thief can cost you availability ("all out"),
   never access: it never ends up holding a key nobody else is using, never sets the recovery
   phrase after its removal, and none of its puppets stay in.
4. **Cutoffs.** A `device.remove` sets the removed device's cutoff: the highest seq of that device
   in the removal's causal past, raised by rule 1 protection. If several removals took it out, the
   one that had seen least decides. A `recovery.set` does the same for the recovery identity it
   replaces. A proven fork (below) is a cutoff too. Every later entry of a cut-off identity is
   rejected, wherever it sorts and whatever time it claims, except a true-symmetric
   counter-removal (3, layer 1).
5. **The vault key.** The current key is the end of the chain of key changes, each of which saw the
   one before and starts the next epoch. A key change that saw another one at its own epoch
   replaced it (its author found the earlier one off the chain, for example stranding a device,
   and wrote that epoch again). Of key changes at one epoch that nothing replaced, one is on the
   chain: first one whose key reached no removed device, then a new recovery phrase, then the
   lower hash. A key
   change by a device that never joined, or past its author's cutoff, is not on the chain. Nor is
   one that leaves a device stranded: any key-bearing change (`key.rotate`, `recovery.set` or a
   removal's key) that missed a device that joined and is still in, unless an approval made after
   it hands that device the key. An approval hands it on only if it carries that key (its epoch
   or a newer one): an approver the change also left out seals an older key. Another holder doesn't save it (it may be the author's puppet).
   Then the vault stays on the earlier key, and an admin writes a fresh one. A
   device may make at most 256 key changes; replay at that cap takes well under a second warm.

   Replay never opens a `prevKey`, so a device that holds both keys of a key change checks it;
   if it doesn't open to the previous key, the vault screen names the device that wrote it:
   devices that join later can't read accounts last changed before that change.

   The vault **needs a fresh key** when:
   - the current key was sealed to someone no longer in the vault;
   - the recovery key can't open it.

   Then adding or changing a secret pauses. Typing an HOTP code, which only moves its counter,
   still works. An admin device that holds the current key writes a `key.rotate` by itself, sealed
   to every device in the vault and the recovery key. If two do so at once, one is kept. A vault
   kept on one device has no admin device to do this: there only the recovery phrase makes a
   fresh key, and the warning says so ("Make a new phrase" under Backup, with your current words).
   Codes still work.
6. **Everything else** is applied in the causal order.
   - The author's introduction must be in the entry's causal past, and the entry within the
     author's cutoff.
   - `device.rename` of another device needs an admin.
   - An `account.put` (or a name) must be under the vault key of its epoch, and must not have seen
     the next key change. An edit made at the same time as a key change still applies: it is
     already in the folder under a key the other side held, so rejecting it would hide nothing.
7. Entries that fail are listed in History as rejected, with the reason.
8. **Rollback check.** Each device remembers, in secure storage, the latest seq and hash the folder
   has shown it for every log. A shorter log, or a different hash at a known seq, means history was
   rolled back or changed. The device warns and writes its verified copy back as a repair (below).

Each device keeps a full verified copy of the vault, so codes keep working when the computer is
off, and it can rebuild the folder if the folder is lost.

A device names only applied entries in `seen`, so one entry that waits or is rejected never holds
up anyone else's changes. Rejected changes are handled as follows:

- **Remade by the app.** When the rules reject a change this device made (another device changed
  the vault's devices at the same time), the app makes it again as a new entry on the vault as it
  now stands, whether or not the change was already sent.
- **Never signed twice.** The app never signs a second entry at a seq it already sent. Before
  sending, it saves the lines locally and records the last one in secure storage as sent. If the
  answer is lost, the next sync sends the same bytes again; it never signs that seq anew.
- **Placeholders.** If the rules now reject such a line, the agent still keeps it, as long as its
  author is still in the vault. A rejected line changes nothing in the replay, so it only holds
  that seq. The app then makes the change again as a new entry after it. The agent refuses a
  removed author's lines outright, so they can't fill the folder. It also refuses a rejected
  approval that names a device whose log is already in the folder, so a placeholder never brings
  a log in. Each identity has a share of the vault: a member 2,000 lines or 4 MB, an admin 8,000
  or 12 MB. The vault-wide caps (20,000 lines and 32 MB, and the reserve) count only lines of
  identities still in, within their cutoff and within their share, so removing whoever filled
  the vault frees it. Only verified lines of identities the vault knows count, and the agent skips junk
  files in the log folder with a warning. Every byte field of an entry has an exact or tight
  size: a `prevKey` holds exactly one key (48 bytes), a name at most 1 KB and an account record
  at most 6 KB, and a key change can be no larger than a fixed part plus 172 bytes per device its
  new key is sealed to. No share, reserve or cap ever refuses an active admin's removal of a
  device still in the vault, or a restore with the recovery phrase (its approval and the new
  device's hello); these are bounded by the number of devices (at most 256 removals apply), not
  by bytes, and a removal that wouldn't apply gets no such pass. A `key.rotate` uses the reserve
  only when the vault needed a fresh key before it; any other key change or new phrase counts
  toward its device's share. Team folders can be written straight, so replay applies the shares
  too, in each log's order: past its share, an identity's account changes and renames are
  rejected (removals, hellos, approvals and key changes have caps of their own per device). A batch of nothing but placeholders must leave every applied entry applied.
- **New recovery phrase.** If that change was a new recovery phrase, it is made again with the
  same recovery keys, so the phrase you already wrote down stays the one that works. The remade
  entry still seals a fresh vault key. The app asks you to confirm the phrase is written down.
  If another device's new phrase applied meanwhile, nothing is made again and the app says which
  phrase now works.
- **Rejected fresh key.** A rejected `key.rotate` is not made again, since another took its place.
- **This device removed.** If the change was rejected because this device was removed, nothing is
  made again. The app says so instead.

**Removed devices.** A device that finds itself removed doesn't delete anything on its own. It
keeps its copy read-only and names who removed it. When two devices removed each other, it says so
and suggests the recovery phrase to take the vault back. It deletes its keys only when you confirm.

**Full rights until removed.** Any device in the vault can do anything its role allows until it
is removed. Remove a lost or stolen device promptly, and keep app lock on so a stolen phone can't
be used before you do.

**When everyone ends up out.** In true symmetry (3, rule 2) every device involved is out. With an
honest computer this can only happen when a removed device's counter-removal reaches it (below), or
when someone writes straight into the folder (a team folder member, or a hostile computer). If no
other device is left, take the vault back with your recovery phrase. Account changes the conflict
cut off are kept in the folder; after the restore, or on any device that can read them, the app
says "N account changes were made while your devices disagreed. Review them." and lets you pick
which to make again. Each is labelled "made after <device> was removed", and none is ticked. It never applies them by itself, since some may be the thief's.

**What the computer takes.** The agent takes no line from a device that is removed, cut off or
forked in the folder as it is before the append. From such a device it takes only the
counter-removal itself and the lines of any kind it chains on, removals included, as placeholders
that change nothing (account lines are caught for review, other lines are void); if any of those
lines would apply, or bring in a log, the whole batch is refused. So an honest counter-removal is
never blocked by its own author's earlier unsent lines. So through your computer a stolen phone that was
removed can't add, change, delete, approve or set a phrase. The one exception: its removal of the
device that removed it, or of the device that approved its remover without its having seen it,
made before it saw its own removal. That is true symmetry, and taking it means whoever reaches the
computer first can't win: both sides go out. An exact retry of lines already stored is taken
and changes nothing, from any device; it is compared by entry hash on the verified chain, so
canonically. Changes caught in a symmetric conflict are kept, for review as above.

**Removing a device also unpairs it.** The agent remembers which paired phone sent each vault
device's lines (in its own state, not in the folder). When a removal of that vault device applies
through this computer, the agent cuts that phone off and removes its pairing, so a stolen phone
can't keep pressing keys or running commands here. The removing device's sheet says "<name> is also
unpaired from <computer>." If the lines came through another computer, or the agent doesn't know
the phone, it says "To stop <name> controlling <computer>, unpair it in AuthDeck Agent."

Physical presence at the computer settles the race. If a stolen phone removes your phone through
the computer first, your phone is unpaired there, but it keeps any removal of the thief it signed
earlier and hasn't sent. Its removed screen says "<F> removed this phone. You removed <F> on this
phone before that. To send your removal, pair this phone with <computer> again." and offers
Re-pair. Once paired again it sends that removal (a true-symmetric counter-removal, so the agent
takes it); both are out, and you restore with the recovery phrase. While a vault with more than one
device has no recovery phrase, the vault screen shows a warning that stays until one is set.

## Withheld changes

The computer could show a device an old copy of the folder. For example, it could leave out a
`device.remove`, so the device keeps adding accounts under a key the removed device still holds.
Head beacons make this visible, but they can't prevent it.

- **Writing a beacon.** After each sync that sent everything, a device signs a beacon for the
  folder as it saw it: `{ v: 2, vault, device, epoch, heads: { <id>: { seq, hash } }, time, sig }`,
  signed over `"authdeck/beacon/v2\n" ‖ canonical form`. It stores the beacon with
  `vault.beacons.write` as `heads/<deviceId>.json`. The agent keeps only a beacon signed by a
  device of the vault and not older than the stored one.
- **Checking beacons.** Every sync reads every beacon (`vault.beacons.read`) before the logs, and
  checks those of active devices. Beacons leave out, and readers ignore, the heads of removed or
  cut-off identities, so a removed device that rewrites its own log can't make an honest beacon
  look like a lie. So are heads of identities this copy doesn't know at all (brought in only by
  a line the rules voided, such as the other version of a fork): hiding a real approval shows as a
  missing line of the approver. A repair of such a log that the agent refuses never holds up a
  device's beacon or its own changes. Something is being held back when a beacon names any of these:
  - an entry this device's copy lacks;
  - a different entry at a known seq;
  - a newer epoch, together with one of the above. A newer epoch alone, with every line the
    beacon's writer saw present here, means the two copies judged the same lines differently (a
    fork proof the writer hadn't read yet); its next beacon agrees, so it raises nothing.

  So is a folder below the highest epoch this device verified itself, which it keeps in secure
  storage.
- **Beacon claims.** What a beacon claims is never stored as this device's own knowledge. It
  counts only while its signer is an active device that keeps claiming it. Claims no real vault
  could reach (more than 64 epochs, or 20,000 entries, ahead) are ignored, and the banner names
  the signer.
- **While something is missing,** the app shows "has seen changes the vault folder doesn't have"
  and names the device. It refuses to add or change accounts until the missing changes arrive.
  Codes keep working. A folder that is still syncing clears this by itself.
- **Last heard.** Devices show when each other device was last heard from: its latest beacon or
  applied change, by its own clock. Before you add or change a secret, the app warns if another
  active admin device hasn't been heard from in 24 hours. For example: "Pixel 8 hasn't been heard
  from since 3 Nov."

**What a hostile computer can still hide.** It can serve an old folder together with the old,
validly signed beacons that match it. Then nothing on this device looks wrong. If that old folder
lacks a removal, a secret you add is readable by the removed device, through this computer's copy.
The 24-hour warning is the only signal: a remover that keeps syncing writes fresh beacons, and the
computer can only withhold them by going stale. A computer you don't control can delay what your
devices see indefinitely. It can't make them accept a change that isn't signed.

## Forks

A device that signs two different entries at one seq has shown two histories. The two signed lines
are the proof, and nobody else can make one.

- **Finding a fork.** A device can find two such lines by comparing its own copy with the folder.
  It then publishes them with `vault.forks.write`. The agent checks both signatures and keeps the
  proof as `forks/<deviceId>.json`. The folder keeps the forker's other line as it is.
- **Applying a proof.** Every replay (the agent's and each device's) applies every valid proof. It
  cuts the forker off at the higher of the seq before the fork and the highest seq of the forker
  that an identity not itself cut off had in the causal past of one of its entries that apply (a
  rejected line builds on nothing). This is found from the top down: start with no cut, cut
  below what nothing that applies built on, and repeat; cuts only fall and never below the seq
  before the fork, so it ends, at the cut that keeps everything anyone built on. A fork cut and a
  removal's cut combine: the lower one holds, since the fork rule only protects lines against the
  proof, never against a removal. That counts as removing it: its later entries are rejected, it can't be approved again with the same
  keys, and if the current key reached it, the vault needs a fresh key. A proof never rejects
  anything others built on, so a removed device can't sign a second history to take back what it
  did while it was in (and the same holds for a recovery identity).
- **Which version counts.** At the forked seq, the version others named is the one that counts.
  If the folder holds the version nobody named and a proof carries the named one, every replay
  reads the named one there; names count in the logs the other version itself brings in too, so
  every copy decides the same whichever version it holds. If nobody named either, the cut is
  before the forked seq. If identities still standing built on both versions, the seq is
  **contested**: neither version counts, the cut is before the forked seq, and the forker's
  account changes from there are caught for review. Standing is judged where the cuts settle,
  never earlier: the identity is in (its introduction not voided, directly or through another),
  its line is within its cutoff, and it isn't in only through the forker's own lines from the
  forked seq. Such a line counts even if the rules reject it for another reason. One identity
  naming both versions never contests. A forker never gains from a fork.
- **The recovery phrase of a solo vault is never cut by a fork** (`replay.ts`,
  `soloRecoveryVersions`). R is the phrase: a computer that collects two lines R signed at one
  seq (a refused phrase change or restore, signed again) must not be able to kill it. At R's
  forked seq one version counts, the same on every copy. The versions are the line the folder's
  log of R holds there and the lines of every valid proof about that seq; until the folder holds a
  line of R at that seq, proofs change nothing. The winner, in this order:
  1. **A version an independent identity built on.** A verified line that applies names it in
     `seen`, or a `device.hello` names it as its approval. Its author is not a recovery identity
     and stands outside the fork: it is a member in the vault as it reads with every version, so
     no version brings it in. The line is judged in the reading where the version it names
     counts: applied there, its author not cut or forked at or before it. So a version that cuts
     the builder (an old phrase's restore cutting the phone before its ack) can't void the line
     that built on the other version, and R's own chaining, junk and devices a version brings in
     never decide. Only each builder's earliest verified line naming any version at that seq
     counts, so a builder whose key was pulled from a phone can't add a later line naming another
     version. A builder forked at or below that line keeps the version the folder holds there: a
     fork proof about the builder doesn't void its ack.
  2. **A `recovery.set` beats a restore.**
  3. **Restore against restore:** the one whose new device signed more lines beyond its hello
     (its log checked against the add's key, starting with a hello approving that add). A
     computer can't sign those, nor change their number by withholding R's key change, so the
     restore the owner went on using wins over attempts the computer refused and kept. Once a
     folder read shows a solo restore applied, the app writes a line past its hello at once (a
     `device.rename` to its own name), separately from the restore append so kept attempts never
     carry one. Before trusting the result, the app reads the folder again, with its proofs:
     - **This phone is in:** the restore is settled. The app drops its kept attempts.
     - **An earlier attempt of this phone's counts instead:** the app adopts that attempt, using
       the device keys it kept for it. It keeps every attempt's keys and signed lines until one
       attempt settles.
     - **The folder lacks the restore** (rewound or held back): nothing is signed again. The phone
       keeps the vault, says "This computer is showing an older copy of your vault", and sends
       the same bytes on every sync. The restore screen doesn't say the vault is back.
     - **Another device's version counts:** the app signs a restore again on top of the winner,
       with new device keys. That cuts the winner's device at the next seq. After three such
       losses it stops and says "This computer keeps showing an older copy of your vault. Your
       phrase still works; try again later."
     A phone whose restore loses to an earlier restore after the restore finished says so: the
     computer had hidden that earlier restore, and a fork proof now holds both adds. The phone
     can't sign without the phrase, so it says "This computer now shows an earlier restore with
     your recovery phrase counting in place of the one on this phone…" and asks the person to
     delete the vault there and restore again. The new restore is made on top of the earlier one
     and takes that phone out. A computer that keeps doing this, working with whoever holds the
     earlier phone, falls under the accepted limit in "Limits" below.
  4. **The lowest entry hash.**

  The app's own phrase change is built on at once: it is sent in one batch with a `device.rename`
  of the active device to its own name, whose `seen` names R's new line. A repair always writes
  that ack back (it applies in its own version's reading), so a computer that withholds it can
  only delay the outcome, not flip it. Someone holding an old phrase can grind as many versions
  as they like (restores or phrase changes) and never beat a phrase change the folder holds the
  ack of.

  **The honest computer refuses a late version.** The replay can't tell which version came first,
  but the computer that holds the folder can. `vault.forks.write` refuses a proof about a
  recovery identity at seq s when two things are true:
  - the folder holds that identity's line at s, or at a later seq of the same `prev` chain;
  - an applied line of a standing device builds on it, either naming it in `seen` or approving it
    in a `device.hello`.

  So the phone's first line after a restore protects that restore at once. A phrase change's ack
  protects every line of the old phrase up to the change. Someone holding an old phrase can no
  longer sign a version at the seq of a restore or phrase change the owner built on, even if the
  owner's own device was brought in by that line. Someone holding the *current* phrase can still
  sign at the next seq: the phrase is the master key.

  **The edge left:** it needs a hostile computer, one that writes the proof into the folder itself
  or withholds the ack, together with someone who holds an old phrase. Then two `recovery.set`s,
  or a set against a restore, are decided by rules 2 to 4. That falls under the accepted limit
  in "Limits". The phone whose restore lost says which line won:
  - when it was a phrase change: "Your recovery phrase was changed from another copy of your
    phrase…";
  - when it was an earlier restore: the earlier-restore text.

  It says this while open, while locked, and when you try to unlock.
  Losing versions, and the lines of a device only a losing `device.add` brings in, show in the history
  as rejected ("lost to another version"), account lines among them caught. A winning
  `recovery.set` then cuts R at its own seq, as every applied phrase change does. A proof of the
  second kind (below) cuts nothing for R. The vault screen never says "remove that device" about
  the phrase. When the app's own line loses, a lost restore is handled as in rule 3 above, and a
  lost phrase change tells the person which phrase
  works ("If you made a newer phrase, use that one"); since the active device builds on its own
  change at once, that happens only when the device's rename is itself lost to a fork.
- **Every divergence is provable.** An identity also shows two histories when it signs a line at
  seq k+1 whose `prev` is not the hash of its own signed line at seq k. Those two signed lines are
  a proof too, with k+1 as the forked seq, and every rule here treats it like two lines at one
  seq. So any line an identity signed that departs from its own history can be proven.
- **Naming what the folder doesn't share.** A line that names a log the folder holds but no line
  that counts brings in (its approval was on the other version) records a conflict instead of
  waiting, so nothing freezes on a fork.
- **Naming a forked entry.** An entry that named either version of the forked entry counts as
  having seen the part both share (rule 2), so honest entries built on the original are never
  rejected.

## Approving a new device

Coming in 0.4, with multi-device vaults; 0.3.0 adds a device only by restoring with the phrase.

Both devices must be connected to the same AuthDeck Agent. The agent only relays.

1. The new device N makes its keys and sends `{ ed_N, x_N, name_N, commit }`, where
   `commit = SHA-256("authdeck/commit/v2" ‖ lp(ed_N, x_N, name_N, nonce_N))` for a random 16-byte
   `nonce_N` and `lp` writes each part with a 4-byte big-endian length before it.
2. The trusted device A shows the request with N's name and key words, and answers
   `{ ed_A, x_A, vault, vaultName, name_A, nonce_A }` with a fresh 16-byte `nonce_A`. The first
   device to answer becomes the approver.
3. N reveals `nonce_N`; A checks it against `commit` and shows no code if it differs.
4. Both compute
   `code = SHA-256("authdeck/check/v2" ‖ lp(ed_N, x_N, name_N, ed_A, x_A, vault, vaultName, name_A, nonce_A, nonce_N))`
   as six digits (the first four bytes as a big-endian number, modulo 1,000,000, zero-padded). N
   shows the code with the approver's name, its key words and the vault name; A shows the code with
   N's name and key words. You approve on A only if they all match.
5. A writes `device.add` from the exact request it checked. N reads the vault the challenge named
   and looks for an applied approval by the device whose keys were in the challenge (only that
   device's), carrying the signing and sealing keys N sent, with a key that opens and matches the
   key check, and the vault name it showed. Another admin's approval of N's keys, even one with a
   key that doesn't open, can't hold the join up. Only then does it write `device.hello`, naming
   exactly the approval it checked, so the vault takes N's keys, role, name and key from that one.
   A device whose key doesn't open (an approval gave it a bad one) can be approved again with the
   same keys, and it tries every key its approvals gave it. Anything else is shown as "This join was
   intercepted", and nothing is added to N.

While approvals of N disagree on its sealing key and N hasn't joined, nobody can tell which is
N's, so N is not counted as staying and new keys aren't sealed to it (the app's builder and the
rules agree on this). After an intercepted join, or when the vault lists the device as removed
(for example an iPhone reinstalled from a backup), the app makes new keys before it asks again.
A join that waits on such an approval shows why, with "Cancel this join".

Every key and name either side acts on is under the code, so a relay that changes any of them
shows two different codes. N commits before it sees A's nonce, so a relay can't keep trying keys
until the codes match: an attended attempt succeeds about once in a million. Names are cleaned
the same way on every device (controls removed, whitespace collapsed, at most 64 characters), and
the agent refuses a name that isn't clean instead of changing it. Requests expire after five
minutes; the agent holds at most 16 at a time and two per device, and limits each paired device
to a few requests a minute.

## Recovery phrase

- The founding device makes 12 BIP-39 words (128 bits) and shows them once. You confirm three of
  them. The phrase is never saved on any device.
- For each vault, the phrase derives a recovery identity: HKDF-SHA-256 over the phrase's 128-bit
  entropy, no salt, `info = "authdeck/recovery/v2/" ‖ vault id`, 64 bytes (the Ed25519 seed, then
  the sealing secret). A phrase reused for two vaults gives two unrelated identities.
- `recovery.set` rotates the vault key, like a removal: the new key is sealed to every device and
  to the new recovery key, and the replaced recovery identity is cut off. A replaced phrase can't
  open any key made after it, and its `device.add` entries made after its replacement, or at the
  same time, are rejected. A new phrase made at the same time as a removal, while its device
  still saw the removed device, is rejected; the app makes another and asks you to write it down.
- **To restore:** install AuthDeck, choose "Restore with recovery phrase" and connect to the
  computer with the vault folder. The app reads each vault, finds the one whose current recovery
  identity matches, opens the key with it and signs a `device.add` for the new device as that
  identity, then the new device's `device.hello`. The signed `device.add` is saved before it is
  sent, and every retry sends those same bytes, so a computer that drops the answer can't get the
  phrase to sign two entries at one seq (which would be a fork proof against your phrase). The
  restore counts only once a read of the folder shows it applied. If the seq was taken by another
  restore, the restore stops and says so instead of signing again; in a solo vault, whose phrase
  a fork can't cut, it is signed again on top of the line that counts. In a solo vault the saved
  lines also hold R's key change, and the restore removes the phone the vault was on before (not
  the paired link it was sent through, when that is the same phone). Afterwards it asks you to
  make a new phrase. The search reads at most 64 vaults, one at a time, and stops at the match;
  a vault the computer set aside (below) is found too, and the app says "Replaced on <date>".
- **A solo phrase change.** Signed with the current phrase and held in memory while the new words
  are shown. Once they are checked, it is saved, then sent, and sent again on every sync until a
  read of the folder shows it applied; only then does Settings date the phrase as saved. It goes
  with the active device's `device.rename` to its own name naming it in `seen` (rule A1.2,
  "Forks"), which this device places in its own copy at once. Until
  then Settings says "Your new phrase isn't on the computer yet", the vault opens with either
  phrase, and a second phrase change (or a replacement) is refused: "Your last phrase change
  hasn't reached the computer yet. Keep the words you wrote down for it. AuthDeck finishes it when
  the computer is reachable." R never signs a second line while one is on its way. R's head is
  remembered with the others, so a computer that drops the change later shows as a rollback.
  If the stored record of a pending change can't be read back, the app says "Your last phrase
  change couldn't be read back. Make a new phrase." once, instead of forgetting it silently; a
  change this device already counts (its ack placed) still goes to the computer from its copy.
- **One phrase screen at a time.** Each phrase the app shows belongs to a flow; only that flow's
  token confirms it, and closing the screen (or starting another flow) drops what it held unsaved.
  "Check words" with nothing to check is an error, never "saved".
- **Without the phrase (solo vaults).** A solo vault's phrase changes only with the current one.
  If you never kept it, "I don't have my phrase" makes a new solo vault instead
  (`app/src/auth/engine/replaceVault.ts`):
  1. The device's own prompt (Face ID, a fingerprint or the passcode), even with app lock off.
     A device with no screen lock is told it needs one.
  2. A new solo vault with the same device keys, holding every account of the old one (labels,
     icons, order and account ids), and a new phrase, shown and checked like any other. Until the
     words are checked it exists only in memory: nothing is sent and the old vault is untouched.
  3. Once they are checked, the new lines are saved as the new vault's local copy, then a record
     "old replaced by new", bound to the computer it was confirmed with; the run finishes only
     there. The lines go to the computer, the new folder is read back and must
     hold every line as sent, all applied, and every account of the old vault; an account the old
     vault changed since is copied as more lines, saved before they go. Only then does the phone
     switch to the new vault.
  4. Then the phone asks the computer to set the old folder aside (`vault.retire`, signed by the
     old vault's device for that computer, within five minutes). Anything but a well-formed
     answer counts as not done and is tried again later. The computer keeps the old folder 30
     days, listed as "replaced on <date>", and shows a notification: "Your AuthDeck vault was
     replaced from <device name>. The old backup is kept until <date>." Then the phone forgets its
     old copy (its logs and vault keys, not the device keys), and the record goes.

  A stop at any point is finished on the next start or sync; while the old vault is locked it
  waits. Every retry sends the same bytes. The phone always has a vault that opens: the old copy
  is forgotten only after the switch. Why this is safe: the prompt is the phone's own lock, and
  someone past it can already read every code in the open vault, so the replacement shows them
  nothing new. What it could take is recovery: a thief who replaced the vault would hold the only
  phrase. That is what the 30-day copy and the notice stop. The owner sees the notification on the
  computer, and the paper phrase still finds the old folder in those 30 days and restores it, which
  takes the thief's phone out of it; a computer only ever retires a vault for a request signed by
  that vault's own device. This is a new vault, not a change to the old one, so the vault rules
  stay as they are.
- **App lock and the phrase:** when app lock is on and the device can no longer authenticate
  (its screen lock was removed), the vault says "Set a screen lock on this device to unlock
  AuthDeck" and opens with the current recovery phrase instead. App lock turns on only on a
  device that can authenticate, and always turns off once the vault was opened, by the prompt or
  the phrase.

## On the phone or tablet

- The phone keeps the vault folder's path only to show it in Settings. A path longer than 4096
  characters (`LIMITS.fsPath`) is refused when the computer lists vaults, and the phone never
  saves vault settings larger than 32 KB, nor a pending restore line longer than any entry, so a
  computer can't make them too large to read back (Android's 2 MB row limit).
- `requireUnlock(reason)` (`auth/contract.ts`) is the gate the deck's edit screens use before
  edit mode: with app lock on it asks for Face ID, a fingerprint or the passcode unless the vault
  was unlocked within the auto-lock time; on a device that can no longer prompt, the vault must
  be unlocked with the recovery phrase first.

- The device's private keys, the epoch keys it has opened, the remembered heads, the highest
  epoch it verified itself and its own highest sent entry live in the platform's secure storage
  (iOS Keychain, or encrypted with Android Keystore), as `WHEN_UNLOCKED_THIS_DEVICE_ONLY` items:
  readable while the device is unlocked, never synced or restored to another device. App lock's
  Face ID, fingerprint or passcode prompt is a gate inside the app, not an access control on those
  items.
- The device's copy of the vault holds no secret (every line is signed, its contents encrypted)
  and lives in files in the app's private document folder, not in AsyncStorage, which on Android
  refuses a value over about 2 MB and caps the store at 6 MB. Each identity's log is one file of
  rows, only ever appended to; fork proofs and the handled caught changes are files too. A save
  writes new data where nothing points yet, then commits by writing a checksummed manifest to the
  other of two slots; a load takes the newest whole manifest and reads each log up to its row
  count. A crash at any write leaves the old copy or the new one. A damaged file costs only the
  lines it held, which the next sync reads again from the computer and checks against the
  remembered heads. Settings and a pending restore are small and stay in AsyncStorage.
- A read from the computer keeps no line over the core's raw line cap (128 KiB,
  `MAX_RAW_LINE_BYTES`, the same cap the agent and every replay use). A longer line, or one that
  is not text, is replaced by a placeholder that fails the chain check. The agent serves lines in
  canonical form, and a sync adopts only verified lines in canonical form, so a hostile computer
  can't make the device store padded or oversized lines, nor see the folder differently from the
  agent. Every read derived from a folder (a `vault.read` across its pages, fork
  and seal proofs) is capped in total at the agent's folder cap plus its reserve (64 MiB); past
  that the read ends with an error.
- **A lost own line.** The device raises its own head (secure storage) before sending a line, and
  never signs a seq at or below it. expo-file-system has no fsync, so a power loss can drop that
  line from the local copy. If the folder still has it, the next sync reads it back. If neither
  the folder nor the local copy holds the signed line, the device can never write under that
  identity again: signing that seq a second time would prove a fork and cut it off. AuthDeck says
  so, stops writing, and shows a warning that stays. The person deletes the vault from the device
  (which also deletes its keys), then restores it with the recovery phrase, which removes the old
  entry in the same step.
- Secrets are decrypted only in memory, only while the vault is open. The vault locks after a set
  time (5 minutes by default) and when the app has been in the background for a minute.
- Screens that show or take a secret (the recovery phrase, shown or typed; a 2FA setup key; an
  account import) block screenshots and screen recording, and hide the app's picture in the app
  switcher (Android's recents thumbnail; on iOS, app-switcher protection while any such screen is
  open). They are drawn in a `SecureSheet`, inside the app's own window: on Android the block
  covers that window only, and a sheet in a separate Modal window would not be covered. Each
  opening takes a block of its own, so closing and quickly reopening never lifts it. The secret is
  drawn only once the block is in place; if it can't be, the sheet says "AuthDeck couldn't hide
  this screen from screenshots and screen recording." with Show anyway and Cancel. While a secure
  sheet is open, sheets that were already open step aside, and a sheet it opens (such as its "are
  you sure?" question) is drawn above it; toasts wait until it closes. Their fields turn off keyboard suggestions and autofill.
  Key words are not blocked: they are public fingerprints.
- Codes are computed on the device: RFC 4226 (HOTP), RFC 6238 (TOTP), and Steam Guard (five
  characters from `23456789BCDFGHJKMNPQRTVWXY`).

## On the computer

- AuthDeck Agent stores personal vaults in `$AUTHDECK_HOME/vault/` (default `~/.authdeck/vault/`)
  and team vaults in a team folder you choose (`authdeck-agent team-folder <path>`).
- It offers these calls over its encrypted, paired connection (see "Between the phone and the
  computer"):
  - `vault.list` lists vaults with their folder path and each log's length.
  - `vault.read` returns each log's raw lines from a given line per device, plus every log's
    length. A page holds at most 1000 lines and 512 KB, devices in sorted order, so a file may stop
    short and later files may come back empty; the device asks again until every file is complete.
  - `vault.append` adds entries. Each must be the next one in its author's log. The agent refuses
    an entry that waits on something missing. It also refuses one the rules reject, except as a
    placeholder from an author still in the vault (see "Deciding what is real"). The first
    `vault.create` makes the folder. `repair: true` writes back lines the folder lost: for each log
    it needs `proof`, the head the device remembers the folder having, and it only refills up to
    that head, never past it and never over a verified line. One exception, **pinning**: an
    identity that is out (removed, cut off or forked) gets back only lines that standing
    identities' applied lines pin, the line another identity's applied line names in `seen`
    (`state.pins`), and through `prev` every line below it. A repair may write such a run back
    over junk, or over another version the folder holds at that seq, when it verifies, matches the
    pin and chains on the folder's verified line below it; nothing past the pin, and nothing else
    from an author that is out, is ever accepted. In replay a pinned version beats any other
    version or junk at that seq.
  - `vault.beacons.read` and `vault.beacons.write` read and store head beacons.
  - `vault.forks.read` and `vault.forks.write` read and store fork proofs. A proof is kept only
    when both lines are signed by that device; the agent's own replay applies it from then on.
  - `vault.retire` sets a solo vault aside: a phone retiring the vault it replaced without its
    phrase. The request (`vault/retire.ts`) must be signed by the vault's active device, judged by
    a full replay of the folder (not the `vault.json` hint), for this computer's agent id, and
    within 5 minutes of the computer's clock; a signature already taken is refused, so a request
    can't be sent again, and any other kind of vault is refused. Nothing is deleted: the folder
    moves to `vault/.retired/<vaultId>/` with a `retired.json` and is kept 30 days (`keptUntil`
    in the answer). It is listed by `vault.list` with `retired` set, and can still be read and
    restored with its phrase: a restore through this computer makes it a live vault again. Retiring
    it again answers the same `keptUntil`. The desktop app shows a notification ("Your AuthDeck
    vault was replaced from <device>. The old backup is kept until <date>."); the agent's log has
    a line naming the device. After 30 days the agent deletes the folder (checked at start and on
    every `vault.list`). It counts against the same per-device limit as appends.
  - `vault.join.request`, `.challenge`, `.reveal`, `.finish` and `.cancel` relay approval
    messages between two connected devices, in that order only.
- Limits: 256 logs, 20,000 entries and 32 MB per vault; 1000 entries and 512 KB per append, 128 KB
  per entry. Appends, beacon and fork writes, and reads are limited per paired device, across its
  connections, and answered with `rate_limited` when it sends too fast. A malformed append is
  refused before the folder is replayed. The agent keeps each log's verified prefix in
  memory, so an append checks signatures only on new lines.
- It watches the vault folders and tells connected devices (`vault.changed`) when a sync tool or
  another device changes one.
- Vault errors sent to devices never name files or folders on the computer; unexpected errors go to the
  agent's own log.
- Typing a code uses the normal "type text" action with `secret: true`. The activity list shows the
  label the device sends, such as "Typed a code for GitHub", with the detail "Hidden". The digits,
  and even their count, never reach a log, an event or an error message.

## Between the phone and the computer

The phone or tablet and AuthDeck Agent talk over the local network, and the network is not trusted.
Every connection is encrypted and both ends prove who they are before anything else is sent:
typed codes, typed text, commands, vault calls and their replies.

- **Keys.** The computer has a static X25519 link key, kept owner-only in `link-key` next to
  `agent.json`. Each app install has its own, kept in secure storage ("when unlocked, this device
  only"), apart from the vault's keys. The computer stores each paired device's public link key;
  there are no passwords or bearer tokens.
  The browser build of the app is for trying AuthDeck, not for daily use: a browser has no secure
  storage, so it keeps the device's link key in the site's local storage, where other code
  running in that browser could reach it. The app says so when pairing and in its Computers sheet.
- **Sessions** use Noise `Noise_IK_25519_ChaChaPoly_SHA256` inside the WebSocket. The app already
  knows the computer's key, so only that computer can answer, and the app's own key is proven in
  the same handshake; the computer accepts only keys it has paired. After the handshake every frame
  is a Noise transport message: altered, replayed, reordered or cut frames fail and close the
  connection, and a plain-text call is refused. Long messages are split into chunks inside the
  encryption; an empty chunk that says more follow, or more chunks than the size limit needs, closes
  the connection too. Frames are at most one Noise message (65,535 bytes), and handshake frames on
  the app side at most 8 KiB. React Native hands the app a WebSocket message only once it has
  arrived whole, so the app checks a frame's size after receiving it: a hostile computer the
  device is paired with can still make it use up memory, though nothing it sends is trusted.
- **Messages.** The app checks the shape of every message from the computer (replies, errors and
  each kind of event) and of the computer's details in the handshake; anything malformed closes
  the session instead of being stored or crashing the app. Each method's result is checked
  against that method's expected shape before any screen or the vault engine sees it; a wrong
  shape fails only that request ("The computer sent something AuthDeck does not understand."),
  and a result that isn't an object ends the session. Discovery answers (`/hello`) are checked
  the same way before the network list shows them. If a screen still fails to draw, the app shows
  "Something went wrong" with a Try again button instead of closing; computers, keys and pages
  are kept.
- **Replayed hellos.** IK's first message carries no freshness from the computer, so someone who
  recorded it can send it again and get an answer. They can't read that answer or send anything
  that opens, so the computer treats a device as signed in (connected, "last seen" updated) only
  after its first encrypted transport frame opens, and drops a connection that hasn't sent one
  within 10 seconds. At most 8 unfinished connections per address, and 64 in all, are kept,
  counted from their first byte until they are accepted or closed; the last 16 are kept for
  addresses a device signed in from lately. A new connection from an address at its limit closes
  that address's oldest connection that hasn't proved a paired key, so someone sharing the
  owner's address can't keep the owner's phone out. A connection whose first IK message proves a
  paired key stops counting, and each key may have only 2 such connections waiting to sign in, so
  replayed hellos can't pile up. A refused connection (wrong path, a web page's origin, over the
  limit) is closed as soon as the refusal is sent.
- **Failures.** Nothing a peer sends can stop the agent: every handler reachable from outside
  (WebSocket messages and closes, HTTP requests, upgrades and new connections, timers, file
  watches) catches any unexpected error, drops only that connection and logs the error's name,
  never its text. A transport message that isn't valid UTF-8 is a broken link like any other.
  Every socket gets an error listener the moment it is accepted, and every child process, its
  pipes and every file watch get one before first use, so a peer resetting a connection or a
  system out of file handles can't stop it either. A command's captured output is capped at 4M
  characters each for stdout and stderr. If `agent.json` can't be watched, the agent checks it
  every 2 seconds instead; if setup fails after the port is open, the port is released. A
  Windows input helper that failed to start is tried again on the next request. A paired device may have at most 4 signed-in
  connections (its newest win) and the computer at most 64. Unpairing cuts the device off before
  `agent.json` is written, so it is out even if that write fails.
- **Revoking.** Unpairing a device, from the desktop app or with `devices --revoke-all` in a
  terminal, cuts its open connections off at once: the agent watches `agent.json`, and checks the
  device is still paired with that key before every request and every event it sends, and every
  15 seconds. That check reads the agent's copy of `agent.json`, not the file: the agent's own
  writes update the copy at once, and another process's writes reach it through the watch, or
  within 2 seconds when the folder can't be watched. The 15-second check reads the file again in
  case the watch missed a change. Device names lose control and format characters (ESC, bidi
  overrides) before they are stored or printed to a terminal, and every line the agent's server
  logs has them replaced by spaces, so nothing a device sends can drive the terminal or forge a
  log line. On Linux an icon is read only from a regular file, at most 256 KB, so a link to
  `/dev/zero` or a FIFO is no icon. Writes to `agent.json` take a lock that names its owner and is released only by it,
  so a "last seen" update can never write a revoked device back.
- **The pairing window.** The QR secret and the PIN work only while pairing is open: while the
  desktop app's pairing view is on screen (up to 10 minutes, shown as a countdown), or for 10
  minutes after `authdeck-agent pair` in a terminal. A pairing closes it. Both are replaced when
  the agent starts and when the window opens or closes. Neither is ever written to a log.
- **Pairing by QR code.** The code carries the computer's link key and a one-time 128-bit secret,
  so scanning it is what authenticates the computer. The app runs the same IK handshake to that
  key with the secret inside it. The app never pairs straight from a link or a scan: it first
  shows the computer's name, addresses and key words, says whether it is a new computer or one
  already saved, and asks; a link names at most 8 addresses (the rest are ignored); a link opened from another app adds "This link came from another app.
  Pair only if you just opened it from AuthDeck Agent on your computer." A computer added from a
  link or a scan becomes the one in use only when the person taps Pair. It accepts only addresses on the
  local network (private and link-local addresses, `.local` names, and Tailscale's 100.64/10 and
  `fd7a:115c:a1e0::/48` addresses but not its `.ts.net` names, which Funnel can make public;
  loopback only in the browser build). If the computer that answers claims the id of one already paired with a different key,
  the app refuses ("This isn't the computer you paired before…") unless the person deliberately
  chooses to pair anyway, for a computer whose agent was reinstalled or reset. The same goes for
  a different computer with the name of one already saved: "You already have a computer called
  <name>, and this is a different one. Only continue if you know why."
- **When the app trusts a computer.** One rule decides, for every way of pairing (started from a
  saved computer's Re-pair, the network list, a typed address, a scanned QR code or a link) and
  for each reconnect, in this order:
  0. If the start named a computer's id (a saved computer, a network-list entry, a typed address
     that answered discovery) and the computer that answers the handshake gives another id, the
     app refuses ("This isn't <name>."). From a saved computer's Re-pair it says instead: "A
     computer with a different id answered. If you reset AuthDeck Agent on <name>, forget it and
     pair it again.", followed by the key words saved for <name> and those of the computer that
     answered, each in two lines of three. The answer may come from a reset agent or from another
     computer, so this is no reason on its own to forget the saved one. On reconnect, another id
     under the saved key is a failed attempt.
  1. A QR code or link names a computer; if the computer that answers gives a different name, the
     app refuses ("This isn't <name>.") without showing the other name.
  2. A saved computer's link key is pinned: another key for its id is a key conflict (above).
  3. A computer saved before link keys (AuthDeck 0.2 or earlier) takes its key without a question
     only from that computer's own Re-pair, by PIN or by a QR code for it scanned with the app's
     camera there: the PIN read off a screen proves which screen, not which computer. A link from
     another app is refused for it: "To pair <name> again, open it in Computers and tap Re-pair."
     Any other way, the app asks "Is this <name>? Do these words match
     the ones AuthDeck Agent shows on <name>?" with the key words, and saves nothing until the
     person taps They match.
  4. A new computer with a saved computer's name gets the name question (above).
  Every name and key question shows key words (both sets when comparing), as does each computer in
  the Computers sheet. Names never decide trust on their own; they are compared by the UTS #39
  skeleton (Unicode 16.0.0, generated by `app/scripts/gen-unicode-tables.mjs` from Unicode data
  under the Unicode License v3): NFKD, marks and everything that draws nothing removed (default
  ignorables, format and control characters, U+2800, U+1D159, the Hangul fillers, U+FFFC), then
  every character mapped to its confusable prototype, ignoring case, spaces and punctuation (every
  Unicode P* category, removed after the mapping, so "Ada's" and "Adas" read alike while a
  punctuation mark that reads as a letter still counts). Two names clash when their skeletons are
  equal or one non-empty skeleton starts with the other, since a list too narrow for a long name
  shows only its start. A few Latin small
  letters whose capitals confusables.txt maps to a letter plus a mark (ꝁ, like Ꝁ) read as that
  letter too. A name that fails UTS #39's Highly
  Restrictive check is flagged in red ("This name mixes letters from different alphabets."); a
  Latin name with a Greek or Cyrillic word is flagged too. Invisible characters are removed from
  every name the app receives before it is shown or stored. When a paired computer reports a new
  name or platform, the app keeps the saved one if the new name would clash (as above) with
  another saved computer. Computer names wrap in every list and picker; none is cut off. A refusal from a computer that isn't saved on the device is shown in the app's own
  words for its code; only a saved computer, proven by its key, has its own words shown.
- **What the app keeps from a computer.** App icons must be PNG files: standard base64, at most
  256 KB, starting with the PNG signature and an IHDR chunk that gives at most 256 x 256 pixels.
  SVG is refused, since react-native-svg follows `<use>` references with no cycle or depth guard.
  The agent sends only such PNGs: macOS and Windows render at 128 (macOS scales a larger one down
  with `sips`, Windows scales in its icon helper), and Linux picks a PNG from the icon theme and
  checks its header; an icon that is SVG only is sent as no icon, and the app shows its
  placeholder. The agent keeps only the chunks an icon needs (IHDR, PLTE, tRNS, sRGB, gAMA, IDAT,
  IEND), dropping colour profiles, text, Exif and animation, and the app refuses an icon with more
  than 64 chunks or any `iCCP`, `zTXt`, `iTXt` or APNG chunk. Everything else a computer sends is capped: app ids 256 characters, app names 128,
  details 1,024, at most 2,000 apps; folder entry names 1,024, paths 4,096, at most 10,000
  entries and 64 roots; command output 8,192 and notes 1,000; focus names 128; error codes 64 and
  error messages and hints 1,000; at most 48 icons per reply. A computer's name in the handshake or its `/hello` answer is at most
  1,024 characters before the app cleans it to 64, its version at most 32 letters, digits, `.`,
  `+` or `-`, and a `/hello` fingerprint is 22 base64url characters; anything else is refused like
  any wrong shape. A reply past a cap fails like any
  wrong shape, so the agent leaves out apps and folder entries that don't fit and cuts long names
  and error text before sending. Anything stored from a computer (icon cache, saved computers,
  decks) is checked again, against the same caps, when it is loaded, and a bad entry is dropped on
  its own. A computer id must be 1 to 64 letters, digits, `-` or `_` and not a name JavaScript
  objects carry (`__proto__`, `constructor`, `toString`…); a handshake or discovery answer with
  any other id is refused, and saved entries under one are dropped. Icons are drawn behind their
  own error guard, falling back to the placeholder. Because a native decoder failure closes the
  app instead of reaching that guard, the app saves a mark naming the computer before its icons
  first draw in a launch and clears it once they have drawn; an icon that starts while the mark is
  being cleared waits until the mark is saved again; a launch that finds the mark still
  set shows that computer's icons as placeholders, says "Icons from <name> are hidden", and offers
  "Clear this computer's icons" (also in Settings > Computers), which removes the cached icons and
  the mark. The decks, computers and settings are one saved value of at most 1,000,000 bytes, half
  of what Android can read back in one row; a save past that is skipped with a message and the
  last good save stays. Each computer's icons are saved separately, up to about 1 MB each, and
  icons past that load from the computer instead; all computers' saved icons together stay under
  about 4 MB, and the computer used longest ago loses its saved icons first. On Android the app's
  AsyncStorage database may grow to 64 MB (a config plugin sets it; a single value is still
  limited to about 2 MB). Forgetting a computer (in Settings > Computers or
  on the recovery screen) deletes its saved icons and its crash mark, and each launch deletes saved
  icons of computers no longer saved, and DevDeck 0.1.0's, touching no other stored data. In
  memory, the app keeps about 8 MB of icons besides those on screen, dropping the least recently
  shown first; a dropped icon loads from the computer again when it is shown, one request per icon
  at a time. Icons that arrive after the app switched computers are dropped, and are never saved
  under another computer. If the saved value can't be read (too large, or
  damaged), the app shows "Saved decks couldn't be loaded" instead of its splash, writes nothing
  over the value, and offers Try again and "Reset decks and computers" (tapped twice), which
  deletes only that value, never the vault. There is no export there: the storage has no partial
  read, so a value too large to read can't be read at all. If a screen still fails, the recovery screen offers Try again, Switch computer
  (when more than one is saved), and after a second failure "Clear this computer's cached apps and
  icons", which removes only that display data, never keys, pages, pairings or the vault, and
  "Forget this computer" (tapped twice), which removes it with its pages, even when it is the only
  one, and never touches the vault. A computer that closes each session at once is reconnected to
  with a growing wait (0.5 s up to 8 s); the wait resets only after a session stays up 10 seconds,
  and a reconnect that learns nothing new writes nothing to the device's storage. The app
  asks for the app list once at a time (one more queued, however many `apps.changed` arrive) and
  redraws for focus changes at most every 250 ms.
- **Pairing by PIN** (the computer was found on the network or typed in). The 6-digit PIN goes
  through CPace (draft-irtf-cfrg-cpace, ristretto255 and SHA-512), a password-authenticated key
  exchange: someone watching learns nothing to test PINs against, and someone in the middle gets one
  guess per attempt. Its key keys a `Noise_XXpsk0_25519_ChaChaPoly_SHA256` handshake that swaps and
  proves both link keys, so each side knows the other typed the same PIN before trusting it.
  One PIN attempt runs at a time. An attempt counts only once it has tested a PIN (the app's first
  PIN-keyed message arrived), so abandoned attempts can't lock the owner out; every way an attempt
  ends frees it for the next. An attempt must send its guess within 3 seconds of starting, and an
  address that leaves 3 attempts without a guess within a minute is paused for a minute, so no one
  can hold the attempt. The app tries a PIN at one address after another only until one answers
  `bad_pin` or `locked`, so one typo costs one guess. Leaving the PIN screen, or picking another
  computer, stops the search before the next address, so the PIN is not tried anywhere else. After 3 wrong PINs the computer shows a new PIN and pauses PIN
  pairing for 30 seconds, doubling after each new PIN up to an hour, until a pairing succeeds. The
  count and the pause are kept in `agent.json` across restarts.
- **Key words.** The computer's pairing screen and the app show its link key as six BIP-39 words
  (66 bits; the first three are the words earlier versions showed). The app always shows them as
  two lines of three under a "Key words" label, never cut off; the desktop pairing view does the
  same, and the terminal prints the six on one line. Comparing them is a check for the careful,
  not part of the pairing.
- **Computer names.** At most 64 characters. A longer or blank name in `agent.json` is not given
  out: the agent uses the host name, trimmed to 64. The app trims names to 64 after cleaning them.
- **Link transport on phones.** On iOS and Android, AuthDeck doesn't use React Native's WebSocket
  or fetch to talk to AuthDeck Agent. Both decompress and buffer whole messages in native code with
  no size limit, so a hostile machine on the network could crash the app on every launch. Instead
  AuthDeck opens a plain TCP connection through its own native module (`modules/authdeck-socket`)
  and speaks a minimal WebSocket client in JavaScript (`src/net/linkSocket.ts`). It never offers
  compression and refuses a server that asks for any extension. It checks every frame's length from
  its header before keeping any of it: 8 KiB per message during the handshake, one Noise message
  after it. A frame or message over the limit is answered with close code 1009 and the connection
  ends. The native module stops reading while 256 KiB are delivered and not yet consumed, and keeps
  at most 64 sockets open. A data frame that is empty and not final is refused (1002), and a message
  of more than 64 fragments is refused (1008). Response heads are parsed without backtracking
  regular expressions. Before the link handshake finishes, more than 4 pings or pongs end the
  connection (close code 1008); inside a session, pings beyond a burst of 20 refilled at 10 a
  second, or more than 60 pongs (AuthDeck never pings), end it the same way. Many pings read at
  once get one pong, for the latest. Writes waiting for the native socket are capped at 4 MiB and
  256 writes, above the largest request the protocol allows. The WebSocket upgrade has its own
  deadline. `/hello` is read the same way: a plain HTTP/1.1 GET, read up to 4 KB in
  total, headers included, and in at most 64 reads, then refused (a chunked body is decoded as it
  arrives, never again from the start); only a 200 with no content encoding, delimited by Content-Length or
  strictly parsed chunked. The web build keeps the browser's WebSocket and fetch. The agent never
  negotiates `permessage-deflate` either.
- **Test switch (development builds only).** `EXPO_PUBLIC_AUTHDECK_TEST_PORT` (and optionally
  `EXPO_PUBLIC_AUTHDECK_TEST_HOSTS`, a comma list of up to 8) set when starting Metro makes a
  development build sweep nothing, use that port as the default, and probe and allow only the
  listed hosts (loopback included), so emulator and simulator runs never reach a real agent or the
  local network. It is read only when `__DEV__` is true; a release bundle drops it (checked: the
  values are absent from an exported production bundle).
- **Connection crash canary.** Before AuthDeck opens a session or pairing connection on a phone,
  it saves a mark naming the address, and clears it once the handshake finishes or fails cleanly.
  A launch that finds an address still marked counts a strike against it. If the launch before had
  also struck it, so two launches in a row closed while connecting there, the address is held:
  AuthDeck doesn't contact it and says "AuthDeck closed while connecting to <address>. Connect
  again?". Connect tries again; Not now keeps the computer offline until you choose Connect, in
  that notice, on a key press for that computer, or in the computer's sheet in Settings. One
  strike is never enough, because swiping AuthDeck away or the system closing it in the background
  also leaves a mark. Holds end on their own after 7 days, and a strike older than 7 days no
  longer counts. After Connect, the address keeps one strike, so one more close while connecting
  there holds it again. Addresses probed by a network sweep are never marked, and a launch that
  closed during a sweep holds nothing. If the mark can't be saved (for example, storage is full),
  AuthDeck connects anyway and shows "AuthDeck couldn't save its connection notes. Storage may be
  full." Nothing in the canary can block every connection.
- **Network sweep.** The pairing screen and the search for a computer whose address changed share
  one sweep of the local /24. It asks at most 32 addresses at a time, leaving half of the 64
  sockets the native module allows for the session and pairing, and stops when the active
  computer changes or the pairing screen closes.
- **In the clear:** discovery (`GET /authdeck/hello`: the computer's id, name, platform, versions,
  port and a fingerprint of its link key; the app reads up to 4 KB of a `/hello` answer, headers
  included, then refuses it), and, before a handshake finishes, a refusal the
  computer can't encrypt (wrong PIN, wrong key, pairing closed or paused, other version). Neither
  carries a secret, and anyone can forge either, so the app treats both as unverified hints: a
  computer found by discovery is added to the saved addresses only after a handshake there
  succeeds, a plain-text refusal shows only the app's own words for its code, and the app tries
  the next address and keeps retrying. Discovery tries every address that answers with the
  computer's id, not just the first. Only a refusal inside the encrypted IK reply, which only
  the paired computer can write, marks a computer as needing to be paired again, or shows that
  the versions differ; a plain-text "other version" counts only when every address failed and
  that address's discovery answer matches the saved computer's key.
- **Web pages.** The agent refuses a WebSocket from a web page unless it is on `localhost`, and
  sends CORS headers for discovery only to `localhost` pages; the app itself sends no `Origin`.
- **Versions.** The link is protocol 2. An app or agent from before it gets a plain message saying
  which side to update, and a device paired before it must pair once more; its keys and pages stay.

### Accepted limits of the link

- **Wrong PINs from the network.** While pairing is open, anyone on the network can try wrong
  PINs. Each try is one guess; every 3 replace the PIN and pause PIN pairing for longer each time
  (up to an hour), and only a successful pairing resets the pause. Someone doing this keeps PIN
  pairing paused, but scanning the QR code still works.
- **Many addresses.** The limits on unfinished connections and abandoned PIN attempts are per
  address, so someone who can use many addresses on the network can spread out over them. The
  overall limit and the slots kept for addresses a device signed in from still apply.
- **`pair` killed outright.** `authdeck-agent pair` closes pairing on Ctrl+C, a closed terminal
  or a normal kill. Killed with SIGKILL (or a crash) it can't, and pairing stays open until its
  10 minutes are up; the PIN and QR code it showed work until then.

## Team vaults

Coming in 0.4. 0.3.0 has no team folder option.

- A team vault is a folder that every member syncs their own way: Dropbox, Google Drive, iCloud,
  Syncthing, or a Git repository. Each member's agent points at the folder.
- It uses the same format with `kind: "team"`. Each device has a role, admin or member.
  - Members can add, change and remove accounts.
  - Admins also approve and remove devices.
  - A new member's device is approved by an admin with the check code, in person or read out on a
    call, comparing the names and key words too.
- **Removing someone** means removing their devices. That rotates the key, so they can't read
  anything added afterwards, and cuts off everything they sign later. AuthDeck then lists the
  accounts they could see, so you can reset those 2FA secrets on the sites.
- **History:** who added, changed or removed each account, by each device's clock, every line
  signed by the device that did it.

## Limits

- Anyone holding your phone while the vault is open can see your codes.
- A computer you type a code into sees that code, as with any 2FA. A code lasts 30 seconds.
- Removing a lost device stops it reading anything new, but it can't forget what it already had.
  Reset the 2FA on sites that matter.
- If you lose every device and the recovery phrase, nobody can open the vault. That is the point.
- **A hostile computer can hide a removal.** Served an old folder with the matching old beacons, a
  device sees nothing wrong. The only signal is that the remover hasn't been heard from: the app
  warns after 24 hours. Beacons from a removed device are ignored, and a beacon that is merely old
  proves nothing. A computer can delay what a device sees; it can't make it accept something
  unsigned. Add secrets from a device synced through a computer you trust.
- **Removals made at the same time both apply only in true symmetry.** If two devices remove each
  other, both are out, and what each wrote after the other's removal is rejected. Otherwise the
  better-informed removal wins and the other device's later membership changes are void, even if
  that device was honest; the app says so and offers to make them again. Use the recovery phrase or another
  admin device to get back in. A vault with no admin left and no recovery phrase can't be changed
  again.
- **Clocks.** A device with its clock far ahead pulls the times of entries made after it forward;
  this changes which of two simultaneous account edits wins, never who is in the vault.
- **A repair can't bring back a change the rules reject**, such as one from a device removed at
  the same time. The device keeps its own complete copy and the rollback banner says the folder
  differs.
- **A stolen phone writes until the restore cuts it.** Account deletes and edits it made before
  the restore apply. After the restore, the review sheet ("Your old phone made … before the
  restore") offers back:
  - every account delete by the removed devices, however old;
  - edits among each removed device's last 50 account lines, by their order in its log, never
    by the clock that device wrote.
  Offers are listed newest first, in log order. Nothing is ticked. "Bring back selected" writes
  each account again as it was before the removed device's last changes to it, edits included,
  with its secret. The new phone writes it as its own change; it holds the older keys through the
  key chain. Only changes that still stand are offered.
- **A restore on a withheld folder loses what the folder lacked.** A hostile computer can serve
  a restore a folder that lacks the old phone's latest changes. The restore is built on what the
  phrase holder saw, and it cuts the old phone off at the last line in that folder; the old
  phone's later lines then show as caught (in the history, for review), not applied. This is the
  rollback exception the vault accepts: a phrase restore must work without the old phone.
- **A forked device is cut off only with proof.** A device that sees two lines signed at one seq
  publishes the proof, and every replay then cuts the forker off. An entry that merely names a hash
  the folder lacks proves nothing on its own: the banner names the device, and an admin should
  remove it.
- **A computer working with a thief can keep the thief's phone in, on that computer.** A
  compromised computer can refuse or rewind the backup. That can stall a recovery done through
  it. Working with someone who holds your old phone (or your old phrase, plus keys pulled from the
  phone), it can keep that phone in charge of the vault on that computer. The same holds for a
  computer that writes in a version signed with an old phrase, which an honest computer refuses
  (see "Forks"). That is the limit 0.3.0 accepts. Even then, the computer can't read your secrets, and it can't get a change
  accepted that nobody signed. It also can't fool your phone without the phone noticing:
  - The phone tells you when it sees an older copy of your vault.
  - The phone never says a change was saved, or that the vault is back, when the change didn't
    take.
  - The phrase never signs a new phrase or a restore on a copy older than the one the phone has
    seen: "This computer is showing an older copy of your vault. Try again once it has caught
    up."
  If this happens, sync the vault folder through a computer you trust, and restore from there.
- **A phone can run commands on the computer it is paired with.** A phone with the vault open,
  or with app lock off, can send the computer's commands (deck buttons, typing a code). Remove a
  lost phone from the computer too: unpair it in AuthDeck Agent. Removing it from the vault
  unpairs it only on the computer it was removed through.
- **The relay can see and stop joins.** Device and vault names travel in plain text through the
  computer, and a computer in the middle can end a join whose codes would not match. It can't make
  them match.
- **Cost.** The first replay of a large vault after the agent starts checks every line's hash and
  signature; each verdict, good or bad, is remembered, so later replays check only new lines. A
  removal is judged on its own past only after cheap checks (a target known and still in, an
  author still in and seen to be brought in); an author's removals stop being judged after 8 that
  fail, and any removal after 64 failed ones in its own past is refused unread. A judged verdict
  depends only on the removal's past and the fork proofs, so it is kept across replays. On a
  laptop: an honest 20,000-line vault replays in about 5 s cold and well under 0.1 s warm;
  20,000 junk lines on one log cost one check; 7,680 key changes followed by 240 failing removals
  take about 5 s cold and 0.12 s warm; and 19,000 judged removals, each naming everything before
  it, are the slowest shape, at up to about 15 s cold (load-dependent) and 0.25 s warm.
