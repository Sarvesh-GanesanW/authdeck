# Env sets

Coming in 0.4.0.

An env set keeps a project's `.env` secrets in the project's own git repo, encrypted so that only
member phones and tablets can open them: yours, and your teammates'. On the computer,
`authdeck env run -- npm run dev` asks a member phone, and the values go straight into that one
process. No file is written. The computer never stores a set's key.

This page explains how env sets work and what they protect against. It is the design the code
follows; if the two ever disagree, the code is wrong. The contracts are
`agent/src/envcore/types.ts` (the file model), `agent/src/protocol.ts` (the env messages on the
link), `agent/src/envSocketContract.ts` (the `authdeck` command and the agent) and
`app/src/auth/envContract.ts` (the phone engine and its screens). The file core is
`agent/src/envcore/` (byte for byte the same as `app/src/envcore/`; `node scripts/check-protocol.mjs`
compares them).

## What you get

- One encrypted file per set, `.authdeck/<set>.env`, committed next to your code. Names are in
  clear, values are encrypted, and every line is signed by the device that wrote it.
- `authdeck env run -- <command>` starts a command with the set's variables in its environment.
  Your phone approves it with one tap. "Allow for 15 minutes" lets the next runs on that computer
  go through without a tap.
- `authdeck env push .env.local` sends changes from a file; your phone works out what changed,
  encrypts and signs it. `authdeck env pull` writes a `.env` when a tool needs a file.
- Your own phones and tablets join with a six-digit check code. A teammate asks to join with a
  request file in the repo, and you approve after comparing six key words.
- Removing someone makes a new key and lists the variables they could read, so you can rotate
  them at their providers.
- History is the git log of the file, checked on your phone against the signatures, so you see
  who changed what.
- No server and no account. The repo carries the file; the phone talks to the computer over the
  encrypted link AuthDeck already uses for the deck.

Not in 0.4: service tokens for CI and headless machines, overrides per environment inside one set
(dev, stage and prod are separate sets, each with its own members), several admins per set, an
editor in the AuthDeck Agent window, deck keys that run a command with a set, a log of releases in
the file, and reading sets from more than one computer at a time (see "On the phone or tablet").

## Who is trusted

| | Holds the set's key? | Sees values? |
|---|---|---|
| Member phones and tablets, in their secure storage | Yes | Yes |
| The owner's recovery phrase | Yes (through the vault's recovery identity) | Only on a phone restored with it |
| The computer running AuthDeck Agent | No | Only what a member device released to it, while it is in use |
| The git repo, its host and everyone who can read it | No | No |
| Your network | No | No |

Three kinds of place hold something:

- **Phones and tablets hold the keys.** Each member device opens the set's data key from its own
  wrap in the file.
- **The repo holds ciphertext and signed data.** It is untrusted: a file that fails any check is
  refused whole, never partly used.
- **A computer holds values only while you allow it.** A release is sealed to a key the
  `authdeck` command makes for that one run, or for a 15-minute grant to a key the agent keeps
  only in memory. Neither the agent nor the app logs a value.

## The model

### Members and the owner device

A set's members are **devices**, labelled by person: "Maya Rao · Pixel 8". Each member has a role:

- **owner**: exactly one device per set. It signs the member list, so only it adds and removes
  members. It also reads and changes variables. The owner can't remove itself.
- **member**: reads and changes variables. It can't add or remove anyone.

A device's env identity is its vault device keys, copied once into the env store, so its member id
is the same `deviceIdFor` of its Ed25519 public key (16 bytes, base64url) that the vault uses. Each
member carries:

- `ed`, its Ed25519 public key, which checks the lines it signs;
- `x`, its ristretto255 sealing public key, which the data key is sealed to;
- `key`, the data key of the current epoch, sealed to `x` with the vault's deterministic seal:
  `sealKey(K, x, { vault: set id, epoch, to: member id })` (see "Cryptography" in
  [authenticator.md](authenticator.md)). Because the seal is deterministic, any member holding the
  key can rebuild every wrap and spot one the owner got wrong (`findBadEnvWraps`);
- `label`: the person's name and the device's name, "Name · Device". The app asks for the name
  once (1 to 40 characters), at the first create, join or approval, and keeps it on the device.
  Labels are cleaned like join names (controls removed, whitespace collapsed, at most 64
  characters);
- `form` (phone, tablet, or not said) and `since`, when the owner added it.

One signer means there are no concurrent removals to resolve: the member list has one history,
written by one device.

A set holds at most 64 members.

### Epochs and revisions

The header carries two counters:

- `rev` goes up by 1 for every change to the member list.
- `epoch` goes up by 1 with every new data key. A new key comes with: removing a member, replacing
  or clearing the recovery identity, the recovery phrase making a new phone the owner, settling two
  member lists, and fixing lines under an old key. A new epoch means every live value is decrypted,
  encrypted again under the new key at the same name and version, and every line (deleted variables
  included) is signed again by the owner device. Deleted variables stay, so a device that saw a
  deletion can't be shown an older value of that name, and a name added again continues from the
  deleted version. They count toward the 500-variable cap.

Adding a member, or adding a recovery identity where there was none, only wraps the current key
(rev + 1, same epoch).

### The authority

Who may sign a set's member list is proven by the file alone, through a short chain of signed
certificates that every header carries:

- **The birth.** When a set is made, the first owner device signs a birth certificate: its own
  public keys, the recovery identity's (or none), the time and a random 16-byte nonce. **The set id
  is the hash of that certificate** (SHA-256 of its signed bytes, cut to 16 bytes), so nobody else
  can make a file under that id, and an id can't be reused by another set.
- **Changes.** Each later change of the authority adds one numbered certificate that names the one
  before by hash:
  - a **take-over**, signed by the recovery identity the chain names last, which makes another device
    the owner;
  - a **recovery change**, signed by the owner, which keeps the owner and names a new recovery
    identity (or none). After it, the replaced phrase can no longer take the set over: a take-over
    must be signed by the recovery identity named last.
- **Headers.** The owner the chain names last signs every header. The recovery identity signs only
  take-over certificates, never a header.

**Order.** Two files of one set are ordered by how many authority changes they hold (take-overs and
recovery changes), then by `rev`. A file behind one a device already accepted is refused as older.
Because each header proves itself, a reader never needs the versions in between: revs don't have to
be committed one by one, and gaps between them are normal.

### Recovery

A set's recovery identity is the owner's **vault** recovery identity: the identity the vault's
12-word phrase derives for that vault (HKDF-SHA-256 over the phrase's entropy, info
`"authdeck/recovery/v2/" ‖ vault id`; see "Recovery phrase" in [authenticator.md](authenticator.md)).
The phone never holds the phrase; it wraps each set it owns to the recovery public keys already in
its vault. The recovery identity holds its own sealed copy of the data key.

- **A lost owner phone.** On a new phone, restore the vault with the phrase first. Then, on a set
  that phone isn't in, "Become owner" asks for the 12 words. The phone derives the vault's recovery
  identity, checks it is the one the set lists and that the set's current owner was a device of your
  vault, and checks the file against its git history (see "First time on a phone" below). It then
  opens the data key through the recovery wrap, signs a take-over certificate with the recovery
  identity, and writes a member list, signed by this phone, with this phone as the only member and
  owner, under a new key. **Every other member
  is removed**, so nothing written after the take-over reaches a device the old file listed. The
  phone then lists the devices it removed, to add back the ones you still trust, and every value to
  rotate, since the lost phone could read them all. The new owner signs the header and every value
  line. Words that aren't the phrase are refused with a plain sentence. A set
  owned by someone else's device is refused: "acme-api's owner isn't a device of your vault, so your
  recovery phrase can't take it over."
- The recovery identity signs only take-over certificates, and a take-over must name a different
  owner. Readers check the whole chain in every file.
- **A new phrase.** When the owner changes the vault's phrase, the owner phone signs a recovery
  change and moves each set it
  owns (on the computer it is connected to) to the new recovery identity, with a new key, because
  the old phrase could open the old one.
- **No phrase.** A set whose owner vault has no recovery phrase has `recovery: null`. If its owner
  device is lost, nobody can change its member list again. Members can still read and change
  variables; to move on, make a new set.
- 0.4 has no way to hand ownership to another member. The recovery phrase is the only way to change
  the owner device.

Sets and vaults stay apart with one identity: env signatures use their own domains, and every wrap
names the set id where a vault wrap names the vault id.

## The file

One set is one file, `.authdeck/<set>.env`, in the `.authdeck` folder at the top of the working
tree. Set names are also file names: lower-case letters, digits, `.`, `_` and `-`, starting with a
letter or digit, at most 64 characters. Teammates' join requests sit beside it in
`.authdeck/requests/`.

### What it looks like

UTF-8, LF line ends, always ending in a line end. One space between fields; byte fields are
unpadded base64url; times are whole milliseconds. In order:

```
# AuthDeck env set: names plain, values encrypted.
# Change it with `authdeck env` or the app.
@set <name> format=<n> id=<set> rev=<n> epoch=<n> time=<ms>
@birth time=<ms> nonce=<nonce> ed=<ed> x=<x> recovery=<ed>.<x>|- sig=<sig>
@authority <n> <takeover|recovery> time=<ms> prev=<hash> ed=<ed> x=<x> recovery=<ed>.<x>|- sig=<sig>
@member <id> <owner|member> form=<phone|tablet|-> since=<ms> ed=<ed> x=<x> key=<e>.<ct> <label as a JSON string>
@recovery <id> ed=<ed> x=<x> key=<e>.<ct>
@sig <signer> <sig>
<NAME>=enc:<epoch>:<nonce>.<ct>.<commitment> ; v<version> <author> <time> <sig>
<NAME>=deleted ; v<version> <author> <time> <sig>
```

`@birth` holds the first owner's keys (`ed`, `x`), the first recovery identity's (`recovery=`, or
`-`), the time, the nonce and the owner's signature. There is one `@authority` line per authority
change, numbered from 1 in order, none for a set never taken over or given a new recovery identity;
each names the new owner's keys and recovery identity, and `prev` is the hash of the certificate
before. There is one `@member` line per member and at most one `@recovery` line (the wrap for the
recovery identity the chain names last). A wrap's recipient key
isn't written: it is the holder's `x`. Comment lines (`#`) and blank lines are skipped on reading;
every other line must be one of the above, in that order (header lines, then values). Signatures
and hashes never cover this text, only canonical JSON of the fields, so the layout can't change
what a signature means.

### The header

The header is the member list. It holds the file format (`1`), the set id, the set's name (which
must match the file name), `rev`, `epoch`, the authority chain, the members in order (exactly one
owner), the recovery identity or none, the time it was signed by the owner's clock, the signer and
the signature.

- **What's signed:**
  - the header: `"authdeck/env/header/v1\n"` followed by the canonical JSON of every header field
    but `sig` (`format, set, name, rev, epoch, authority, members, recovery, time, signer`, each
    member as `id, role, label, form, ed, x, key, since`), with Ed25519;
  - the birth: the domain `"authdeck/env/birth/v1"` and the canonical JSON of
    `{ owner, recovery, time, nonce }`, each with a 4-byte length before it;
  - a take-over or recovery change: the domain `"authdeck/env/takeover/v1"` or
    `"authdeck/env/recovery/v1"` and the canonical JSON of
    `{ set, kind, n, prev, owner, recovery, time }`, framed the same way. The set id is in them, so a
    change can't be moved to another set.
- **Who may sign:** the owner the authority chain names last, which must be the one `owner` member.
  The chain itself must check: the set id is the birth's hash, the birth is signed by its owner, and
  each change is numbered in order, names the one before, is signed by the holder allowed to sign it
  and changes what its kind changes. The `@recovery` line must be the recovery identity the chain
  names last. Anything else is `header-unsigned`.
- **Also checked:** each id is `deviceIdFor` of its usable `ed` key, no id twice, the recovery
  identity isn't also a member, rev and epoch start at 1.

### Value lines

One line per variable, in file order:

| Field | |
|---|---|
| name | Letters, digits and `_`, not starting with a digit, at most 128 characters. Lower case is allowed, so existing `.env` files import as they are. |
| version | Starts at 1; each change adds 1. |
| author | The member id of the device that signed the line. |
| time | When it was signed, by the author's clock. |
| box | The value, encrypted under the data key of the header's epoch. `deleted` for a deleted variable. |
| sig | The author's Ed25519 signature. |

- **What's encrypted.** The value, with the vault's `encryptBox`: AES-256-GCM under the subkey
  `HKDF(K, info = "authdeck/subkey/v2/box/env-value")`, a random 96-bit nonce, and associated data
  the canonical JSON of `{ vault: set id, epoch, kind: "env-value", name, version }`, so a value
  can't be moved to another name, set or version. The box also carries a key commitment (HMAC under
  the subkey `"…/commit/env-value"` over the nonce and the same associated data), so it opens under
  one key only.
- **What's signed.** `"authdeck/env/value/v1\n"` followed by the canonical JSON of
  `{ author, box, epoch, name, set, time, version }`, with `box` the whole box (`epoch, n, ct, c`)
  or null for a deletion, and `epoch` the epoch the line is under, so a tombstone is bound to its
  epoch too.
- **Deleted variables stay as tombstones**, also across new keys, so a merge can't bring an older
  value back.
- Values may span several lines (PEM keys); in the file each is one ciphertext.

### What's in clear, and why

Anyone who can read the repo sees:

- variable names;
- member labels, which hold each person's name and device name, the devices' forms, and how many
  members there are;
- public keys, member ids, the set id and the recovery identity's id. The recovery id is the
  owner's vault recovery identity, so sets owned by one vault show the same recovery id;
- versions, authors and times of every line, and so when things changed and who changed them;
- the size of each ciphertext, which is the size of each value;
- the join request files, with each requester's label and public keys.

They never see a value.

Names stay in clear so the file works with git: diffs say which variable changed, review reads like
any other change, and the merge driver merges per name without a key. Labels stay in clear so anyone
in the repo can see who is in a set. Versions, authors and times are what merges and the rollback
checks run on.

### What readers check

One core (`verifyEnvFile`) checks every file, on phones and tablets, in the agent and in the
`authdeck` command. A file that fails is refused whole, with the first problem found: it releases
nothing and accepts no change until it is fixed. On the computer the command ends with exit 65.

| Problem | What it means |
|---|---|
| `unreadable` | A line AuthDeck doesn't write, or a field that isn't what it should be. |
| `conflict-markers` | Git left `<<<<<<<` in it: this clone has no merge driver yet. |
| `newer-format` | Written by a newer AuthDeck. |
| `too-large` | Over one of the caps below. |
| `bad-name` | A variable name the rules don't allow. |
| `duplicate-name` | A name appears twice. |
| `header-unsigned` | The member list isn't signed by the owner its authority chain names, or the chain doesn't check (a file claiming a set id it can't prove). |
| `header-chain` | The member list doesn't follow the one this device accepted: another set id, a different header at the same rev, or a lower key epoch under the same authority. |
| `authority-fork` | Two lines of ownership: the file's authority chain went another way than the one this device accepted, or than another version in the history. See "Two lines of ownership". |
| `older-header` | Rollback: a member list behind the one this device accepted (fewer take-overs and recovery changes, or the same and a lower rev). |
| `unsigned-line` | A value line whose signature doesn't check. |
| `not-a-member` | A value line signed by a device that isn't in the member list. |
| `older-value` | Rollback: within the accepted epoch, a variable at a lower version than this device accepted, or a remembered name missing. |
| `wrong-epoch` | A value still under an earlier data key, which a removed member could read. |

Every message names the file, the line and, when git knows it, the commit that brought the line in,
and says what to do:

```
✗ .authdeck/acme-api.env line 14 (DATABASE_URL) isn't signed by a member of acme-api.
  It came in with commit 77b0e1d. Nothing was released.
  Revert that commit, or set DATABASE_URL again from a member's phone.  (exit 65)
```

**Remembered heads.** Phones, tablets and the agent remember, per set id, the header they last
accepted (rev, epoch, its hash and the header itself) and the highest version of each name,
tombstones included. A later file must continue the remembered authority chain and not be behind it
in the order above (take-overs, then rev); every name must be at its remembered version or higher.
Anything lower is a rollback and is refused.

- The **agent** keeps them in `<AuthDeck folder>/env/projects.json` (owner-only), with the set files
  it has seen. It never forgets a head. If the file can't be read, env sets stay off until it is
  moved aside, so a rolled-back file can't slip through.
- The **phone** keeps its copy of each set with its heads, and a hash of them in secure storage, so a
  copy rolled back or edited on the phone's disk is refused.
- The **`authdeck` command** keeps none of its own: it checks format, caps and every signature, and
  the agent checks for rollback.
- **First time on a phone.** A phone with no remembered head for a set (its first join, a take-over,
  a phone restored from the phrase) reads the file's whole git history through the agent before it
  takes the set: every version reachable from HEAD, merges included, each once. It folds the history
  in page by page, reading at most 64 MB (bytes, as the agent sends them), and counts every version
  that verifies on its own under the set's id. Other files claiming the id fail as unsigned and are
  left out, since only the set's own owners can sign under it. The phone refuses the file if it is
  behind that history, holds an older version of any variable (a deleted one included), or if the
  history holds a second line of ownership (see "Two lines of ownership" below). So a repo writer
  can't hand a new phone a deleted value brought back from an old commit.
- **After a take-over, members check too.** A member whose phone remembers the set runs the same
  history check when the computer's file holds more take-overs and recovery changes than it
  remembers. If the history can't be read, the set shows "The computer's file wasn't taken" with the
  reason, and the phone keeps using its own copy meanwhile.
  - **The history read is all or nothing.** The agent serves every version or refuses with one of
    these sentences, which the phone shows:
    - "This repo is a shallow clone, so its history can't be checked. Run git fetch --unshallow, then
      try again."
    - "This repo is missing part of the set file's history (a partial clone), so it can't be
      checked. Run git fetch --refetch, then try again."
    - "The history changed while it was being read. Read it again from the start."
    - "Git couldn't read this repo's history of the set file, so it can't be checked."
    - "More than 50000 commits touched this set file, so its history can't be checked."

    Git's replace refs and grafts are ignored: the history is read as the commits say.
  - **History too long.** If the phone can't read the history to its end within its budget, it
    refuses the set and suggests making a new one (`authdeck env init` in a fresh folder) and moving
    the values there.
  - A set the phone refused to take stays outside, with the reason shown on its sheet.
  - The phone trusts the history as the computer shows it. See the accepted limits.

**Two lines of ownership.** Someone who still holds a key the set retired can start a second line
of ownership that is genuinely signed: a lost owner phone that keeps signing after the take-over, or
a replaced recovery phrase that signs a take-over. Both lines then verify. AuthDeck doesn't pick
one: two lines mean one of the set's keys is in someone else's hands, and whichever line it kept,
that person might hold it. Phones refuse the set (`authority-fork`) wherever they meet both lines:

- when taking a set for the first time, and when taking it over;
- on a member whose phone remembers the set from before a take-over, when the file is on the other
  line;
- in the merge driver, which stops the merge.

The phone says: "<file> has two competing lines of ownership in its git history (change <n>: a
take-over by the recovery phrase on one, a new recovery phrase set by the owner on the other), so one
of its keys is in someone else's hands. AuthDeck won't take either." and "Make a new set and rotate
every value that was in <set>." Members already on a line keep their copy readable on their phone,
so the values can be moved to the new set.
- **The agent trusts first sight.** A computer that has never seen a set takes the first valid file
  as it is. Phones still release from their own copy.
- Heads are per set, not per clone: a second clone of a set that is behind is refused as older.
- A phone releases from its own newest valid copy, so a computer showing an older file gets the
  newer values and a warning ("MacBook Pro shows an older acme-api").

### Limits

| | Cap |
|---|---|
| Variables per set | 500 |
| One value | 32 KB |
| All values together | 128 KB |
| Members | 64 |
| The file | 384 KB |
| A variable name | 128 characters |
| A set name | 64 characters |
| A member label | 64 characters |
| A join request file | 4 KB |

Sizes are UTF-8 bytes of the plain values (read from the ciphertext length: AES-GCM adds exactly
16 bytes), and bytes of the file as written. Deleted names count toward the 500 (they are kept so a
deleted value can't come back); a set past it is refused with "…holds more than 500 variable names,
counting deleted ones (kept so a deleted value can't come back). Make a new set and move the values
there." The total and file caps keep a set, and a push carrying
its new values, inside one 1 MiB link message. Keep large files out of a set and store a path to
them instead.

## A release, step by step

`authdeck env run -- npm run dev`, with no grant open:

1. **The command** finds the set file, reads it and checks its format, caps and every signature. It
   makes a one-time sealing key pair in memory.
2. **The command → the agent.** Over the agent's local socket it sends the project (repo root,
   remote, file path), the file exactly as it checked it, the command, the folder, where it was
   started ("Terminal · zsh", from `TERM_PROGRAM` and `SHELL`), and the one-time public key.
3. **The agent** checks the file against the head it remembers (a rollback is refused here), picks
   the link request id, and sends the request over the encrypted link to every connected device
   that holds a member of the set. A device that connects while the request waits still gets it.
   The command prints which devices it is asking and waits up to 60 seconds.
4. **The phone** shows the request as a sheet over whatever is on screen: the computer, the
   command, the folder, where it started and how many variables it gets. A locked vault offers
   Unlock or Decline. The phone checks the computer's file against its own newest copy, adopting
   the file first when it is newer and passes. If the file fails the phone's check, only Deny is
   offered and the sheet says why.
5. **You answer** with Allow for 15 minutes (the default), Allow once, or Deny. With app lock on,
   every answer but Deny asks for the device's own unlock (Face ID, fingerprint or device PIN)
   first. Answering on one device closes the sheet on the others.
   - **Allow once:** the phone opens the data key, decrypts the values, and seals them to the
     command's one-time key, under the request id. The agent passes them on and can't open them.
   - **Allow for 15 minutes:** the phone seals them to the agent's grant key instead, a key whose
     secret exists only in the agent's memory. The agent keeps them sealed and, for each run,
     opens them and seals them again to that run's one-time key, under that run's request id.
6. **The agent → the command:** the sealed values, the request id they are sealed under, the device
   that allowed them, how (once, inside a grant, or a new grant), when the grant ends, and which copy
   they came from. A copy other than the computer's file means a device had a newer one, and the
   command says so ("Pixel 8 used its newer copy of acme-api (rev 8). Run git pull…").
7. **The command** opens them with its one-time key and starts `npm run dev` with them added to its
   own environment (a set's value replaces a variable of the same name). SIGTERM, SIGHUP and
   SIGUSR2 pass on to the child (SIGINT and SIGQUIT too when there is no terminal, which already
   sends them to both). The command exits with the child's exit code, 128 + n when a signal stopped
   it, 127 when the command isn't found and 126 when it can't be started.

   **Variables that make programs load code are skipped.** Any member can set any name, so `run`
   leaves out names that make a program load or run other code, or stop checking TLS, unless you
   name them with `--allow NAME` for this run. The rule covers: preload and library paths for
   dynamic loaders and language runtimes (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, `PYTHONPATH`…),
   shell startup files and prompts, every git variable (`GIT_*`, so even `GIT_AUTHOR_NAME` needs
   `--allow`), compilers and build flags (`CC`, `CXX`, `*FLAGS`, `RUSTC*`, `CARGO_*`, `CGO_*`), .NET
   and CLR profilers, JVM and Erlang `*_OPTS`, Go toolchain and proxy settings, package-index URLs
   and package-manager settings, PowerShell's `PSMODULEPATH` and `PROMPT`, the config paths of
   container, cluster and cloud tools, switches that turn TLS checks off or trust other roots, proxy
   settings that send traffic through another host (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`), the
   TLS key log (`SSLKEYLOGFILE`),
   programs other tools start (`EDITOR`, `PAGER`…), and `PATH`. Names compare in upper case. The
   command says which it skipped: "Skipped NODE_OPTIONS: it changes how programs start. Add --allow
   NODE_OPTIONS to use it." The phone flags these names in the set and in a push ("Changes how
   programs start on every computer that runs this set"). The full list is
   `agent/src/envcore/codeLoading.ts`.

A release bundle is a fresh 32-byte transfer key sealed to the recipient
(`sealKey(T, recipient, { vault: set id, epoch: 0, to: "env-release/" + request id })`) and one box
under it (`kind "env-release"`, bound to the set and the request id) holding the values in file
order. The agent picks the request id, never the command, so a local process can't steer one
release into another.

Inside an open grant, steps 3 to 5 don't happen: the agent seals the values it holds to the
command's one-time key at once, and nobody is asked.

**pull** is the same, except the command writes a file instead of starting a process: `.env` in the
current folder, or the file you name, inside the repo. It refuses a target whose folder, with links
followed, is outside the repo ("… is outside this repo (its folder is …). Pull writes only inside the
repo.", exit 64), and refuses to replace an existing file without `--force` (exit 73). It writes beside the target with mode 0600 from the start, then renames it into place,
so the values are never readable by others and a reader never sees half a file. A file on disk
outlives the process, so the sheet says where it goes and warns when git doesn't ignore it ("A
commit from this folder could publish the values"); the command prints the same warning before it
asks. `pull` writes code-loading names too, since the file is yours to read, and warns about each:
"! .env sets NODE_OPTIONS: it changes how programs start. Check its value before a program loads
.env."

Values are written so a shell that sources the `.env` reads them as data. Plain values (letters,
digits and `_ . / : @ % + , = -`) are written bare; others go in single quotes, which shells and
dotenv readers take literally; a value holding a `'` goes in double quotes with `\`, `"`, `$` and
the backtick escaped. Two kinds of value are skipped, because programs would read them differently:
one with a `'` together with `$`, a backtick or `\` (common dotenv loaders keep the backslashes), and
one with a carriage return before a line break (a shell keeps the escaped `\r` as a backslash and an
`r`). The skip sentence gives the reason: "Skipped NAME: its value can't be written to a .env safely
(it has a carriage return before a line break). Use authdeck env run to pass it." The summary line
lists what was skipped.

The command closing (Ctrl-C) cancels the request on every device. When no member device answers in
60 seconds, the command ends with exit 75 and names the paired member devices to open. If the file
changes while a device is answering, nothing is released and the command ends with exit 75; run it
again.

The sheet shows the command and folder **as the computer reports them**. Nothing proves them.
Allow only a command you just started.

### Changes from the computer

`authdeck env push` and `authdeck env init` send plain values to the phone, because the computer
has no key to encrypt with. They travel only inside the encrypted link.

- **push** always asks; there is no 15-minute option for a change. The phone works out what changes
  by name (only it can read the current values) and shows them: added, new value, removed (with
  `--prune`). "Show new values" shows a new value on demand. Sign change makes the phone encrypt and
  sign the new lines and send back the whole new file; the agent checks it and writes it. The
  command then prints what was added, changed and removed, and a suggested commit. A push that
  changes nothing says so.
- Both read the file in the common dotenv dialect, without variable expansion: blank lines and `#`
  lines skipped, `export ` allowed, spaces allowed around `=`, unquoted values trimmed and ended by
  ` #`, single and backtick quotes literal, double quotes understanding `\n \r \t \\ \" \'`, all
  three able to span lines. Only whitespace or a comment may follow a closing quote. A name given
  twice keeps its last value, in the place it first appeared. A line that can't be read ends the
  command with exit 65 and never echoes the line.

### Changes on the phone

Adding, changing, renaming and deleting a variable happen in the set's sheet on any member device,
with the vault open. Saving signs a new line (the next version, by this device) and has the agent
write it into the file. "Paste lines from a .env" adds several at once. Processes already running
keep the old value until they restart. Commit the file on the computer to share the change.

**To undo a change, make a new one.** Set the old value again from a phone (or push it), which
writes the next version. Don't `git revert` a commit that changed a value: that brings back a lower
version, and every device that saw the newer one refuses the file (`older-value`). Reverting a commit
is right only for lines no member signed, as the refusal message says.

When the computer is offline, the set shows its variables as of the last sync, and changes wait on
the phone until the computer is back. Every write names the file's hash it was based on; if the file
changed since, the phone reads it again and redoes the change.

## Grants

"Allow for 15 minutes" opens a grant: one set file (its path and set id), on one computer, for runs
and pulls. A second clone of the same set needs its own grant. Pushes always ask. A grant lives only
in the agent's memory, with the values sealed to the grant key.

While a grant is open, the set's row on the phone, the set's sheet, `authdeck env ls` and the
AuthDeck Agent window all show it, with the last 8 commands that used it. Every use is a row in the
Agent window's Activity list ("Ran with acme-api · npm test · 12 variables · Inside the 15-min
grant"), never with a value.

A grant ends, and its values and grant key leave the agent's memory, when:

| Reason | |
|---|---|
| `expired` | 15 minutes are up. |
| `ended-on-device` | End now on a phone or tablet. |
| `ended-on-computer` | End now in the AuthDeck Agent window. |
| `computer-locked` | The screen locked (from the desktop app). |
| `computer-slept` | The computer went to sleep (from the desktop app). |
| `clock-jumped` | Every 5 seconds the agent compares the wall clock with one that stops during sleep; a gap of more than 20 seconds means it slept (or the clock was set) and every grant ends. This covers sleep when no desktop app runs. |
| `set-changed` | The set file at that path is now different (any change, including a `git pull` or checkout) or gone. |
| `unpaired` | The device that allowed it was unpaired. |
| (restart) | AuthDeck Agent stopped or restarted. Nothing outlives the process, so there is no message. |

Each end except a restart tells the phones why.

## Joining

### Your own devices

A device of yours that isn't in a set joins through the computer both are paired with, using the
vault's check-code approval (see "Approving a new device" in [authenticator.md](authenticator.md)):

1. On the new device, open the set (it shows, marked as one you're not in, when the device is
   connected to a computer that has it) and choose Join.
2. The owner device shows the request and answers it, after its own unlock when app lock is on.
   Both compute a six-digit code over the same transcript as a vault join (both devices' keys and
   names, the set's id and name in place of the vault's, and both nonces, with a commitment so a
   relay can't try keys until the codes match), hashed under `"authdeck/env-check/v1"` instead of
   `"authdeck/check/v2"`, so an env join's code never matches a vault join's.
3. Compare the code, names and key words on both screens. Approve on the owner only if they match.
4. The owner signs a new member list (rev + 1) with the new device's wrap, and the agent writes it.
   The new device then checks that the file is the set it was offered, lists it with the keys it
   sent, was signed by the device it compared codes with, and gives it a key that opens; anything
   else shows as intercepted. Commit the file to share it.

Requests expire after five minutes. Each paired device may start at most 4 join requests at once,
then one more every 15 seconds.

### Teammates

A teammate's phone isn't paired with your computer, and shouldn't be: pairing lets a phone run
commands there. So the live check code can't run between you. Their request travels as a file in the
repo instead:

1. They clone the repo and run `authdeck env init`. It sees the set already lives there and asks to
   join from their phone, which makes its keys and signs a request with them. The command writes
   `.authdeck/requests/<member id>.json` and prints six key words.
2. They commit it and push, or open a pull request.
3. Once your computer has the commit, the request shows on your owner device with their name.
4. Check the words both ways, on a call or side by side:
   - **Their words, on your owner device.** They read their six words out. For each, in order, you
     pick the word you heard from three choices ("Word 1 of 6: which word did Chen Wei say?"). Only
     after all six are right can you approve, which asks for your device's unlock first when app
     lock is on.
   - **Your words, on their phone.** You read your owner device's six words out, and they pick each
     one the same way. Their phone computes your words from the owner key in the file they asked to
     join.
   - The choices are dealt once per request, so opening the sheet again doesn't deal new ones. A
     wrong pick says "That word doesn't match." and allows one more try from word 1 ("One more try: a
     second wrong word ends the request."). After a wrong word nothing counts until you tap Try
     again, even if the sheet is closed and opened again. A second wrong pick declines the request on your side
     ("The words didn't match, so this request was declined.") or withdraws it on theirs. On their
     phone, "They don't match" also withdraws the request and deletes its request file.
5. Approving signs a member list (rev + 1) that wraps the key for their phone and removes the request
   file, in one change. Declining removes the request file. Commit the file to send it.
6. Their phone takes the set only after they picked all six of your words, and only from a file whose
   owner key is the one they checked. If the owner key changes before then (another owner after a
   take-over, say), their phone shows the new words and they check again. A withdrawal wins over a
   set that was on its way to their phone.

The request file is canonical JSON of `format, set, member, label, form, ed, x, time` and `sig`,
signed by the requester's own key over `"authdeck/env/join-request/v1\n"` and the canonical JSON of
every field but `sig` (proof it holds the key). The owner's device refuses one that is larger than
4 KB, not written exactly the way AuthDeck writes it, for another set, from a newer format, with a
member id that isn't its key's, with unusable keys or label, or with a bad signature, and one whose
file name doesn't match the member it names.

The agent shows only request files that pass those checks, newest commit first, at most 64 per set.
Junk files a repo writer adds to `.authdeck/requests/` are skipped and don't count toward that cap,
so they can't hide a real request. The agent looks at no more than 1,024 files or 2 MB per read.

The six key words are `SHA-256("authdeck/env-keywords/v1" ‖ lp(ed, x))`, with `lp` the 4-byte
big-endian length before each key, read as six 11-bit big-endian indices into the BIP-39 English
list: 66 bits, too many for anyone in between to make a key whose words match.

The owner device's "Share these steps" gives a teammate the steps above as text.

## Removal, re-keying and rotation

Only the owner device removes a member, after its own unlock when app lock is on. A removal:

1. makes a new random data key (epoch + 1);
2. decrypts every live value and encrypts it again under the new key at the same name and version,
   signed by the owner device (with a time later than the line it replaces, so a merge keeps it),
   and signs deleted variables again too;
3. wraps the new key for each remaining member and the recovery identity, and signs the new member
   list (rev + 1);
4. lists every live variable, since the removed device could read them all.

Rotate those at their providers (a new API key, a new database password), then set the new values. A
removed device already saw the old ones, and git keeps every old ciphertext, which its old key still
opens. A new key protects only what is written after it.

On the removed device the set stays, read-only, with a note: "Ben Okafor's Pixel 9 removed this phone
from tidepool-web in commit 3d2f8aa and made a new key." The values it saw stay readable there until
you delete them from that device.

**Values under an old key.** A member that hadn't seen a re-key can still save a value under the
old key; a merge keeps that line if it wins, and every reader then refuses the file (`wrong-epoch`).
Nothing is released until the owner decides. The owner device lists those names for review (it
checks that the only faults are such lines, each signed under its epoch by a current member) and
offers two choices, after its own unlock when app lock is on:

- **Keep** encrypts them again under a new key (epoch + 1) and puts every kept name on the rotate
  list. Their values were written under a key a removed member holds, and that ciphertext stays in
  git history.
- **Drop** re-keys the set and deletes those variables. The dropped names go on the rotate list
  too: removed members can still read them in git history, so rotate any that are still used
  elsewhere.

The choice applies only to the names the owner reviewed. If the old-key values change on the
computer in the meantime, the phone says so and asks for the review again.

## Merges

`authdeck env init` sets up AuthDeck's merge driver:

- in the repo's `.gitattributes` (committed), when the line isn't there yet:
  ```
  .authdeck/*.env text eol=lf merge=authdeck-env
  ```
  `eol=lf` keeps Windows checkouts byte-identical, which the signatures need;
- in the clone's `.git/config` (which git never commits, so every clone runs `init` once):
  `merge.authdeck-env.driver = authdeck env merge %O %A %B`.

For the three versions of a set file, the driver (`mergeEnvFiles`):

- **checks both sides** with the same checks as every reader, except that a value line under an
  older key is let through. It checks without remembered heads; the agent checks the result for
  rollback when it next reads it. A side that fails, or names another set, stops the merge.
- **keeps one header:** both the same, or the newer one in the order above (take-overs, then rev),
  whose authority chain must continue the other's and, under the same authority, whose key epoch is
  no lower. Anything else stops the merge;
- **stops on two headers:** two different member lists at one rev under one authority (for example, the owner device
  signed two member changes that reached two clones built on the same rev). The owner device settles
  it with a new header above both: the members in both, plus those either side added since the
  merge base (a removal on either side stands), values merged per name, and a new key. If anyone was
  dropped, every live variable is listed to rotate;
- **merges values per name:** the higher version wins; at equal versions the later signed time; then
  the lower line hash, SHA-256 of the canonical JSON of the line with its set, epoch and signature,
  compared as raw bytes. Lines by authors who aren't members of the kept header don't take part,
  nor do tombstones from an older epoch. Names keep "ours"'s order, then "theirs"'s new names in
  their order. A winning line under an older key stays, and the owner device re-keys it (above).

It writes the merged file over `%A` and exits 0, or leaves `%A` alone, says why on stderr, and exits
1 so git keeps the conflict. A merge never makes a new signature; it only picks among signed lines.

A clone without the driver leaves git's conflict markers in the file, and every reader refuses it
(`conflict-markers`): run `authdeck env init` in that clone once, then redo the merge.

## The `authdeck` command

`authdeck` ships inside AuthDeck Agent (in its `resources/cli`). The launcher runs it through the
app's own CLI mode, `AuthDeck Agent --authdeck-cli -- <args>`, which runs only that bundled command:
no window, no agent, and no script or path taken from the arguments. The app can't be used as a
general script runtime (that switch is turned off in the build), and on macOS it runs with the
hardened runtime. So no other program can borrow AuthDeck Agent's Accessibility and Automation
permissions by running its own code under the app's name.

AuthDeck Agent refuses every launch argument it doesn't use itself, Chromium's launcher and
debugging switches included, and exits: "AuthDeck Agent doesn't take the argument "…", so it didn't
start. Open it from its app icon, or run the authdeck command." On Linux `--no-sandbox` is allowed,
because the AppImage needs it on some distributions (Ubuntu 24.04, for one).

The Agent window's "Put the authdeck command on your PATH" adds it: a link in `/usr/local/bin` on
macOS (one admin prompt where that folder isn't writable), the user's PATH on Windows, and a launcher
in `~/.local/bin` on Linux. It works only while the agent runs on the same computer, and only inside
a git working tree.

The command finds sets in the `.authdeck/` folder at the repo's top. With one set there, every
command uses it; with several, name one with `--set <name>`. The agent addresses each set by its
file's path plus its set id: a set cloned twice shows twice, and the id guards against a different
set at the same path.

### Commands

| Command | |
|---|---|
| `authdeck env init [--from <file>] [--set <name>]` | Creates the set, or asks to join it when the repo already has it. Creating imports the variables in `--from`, or none; the device that answers becomes the owner, sealed also to your vault's recovery identity when it has one. After an import it offers to delete the plain file. Joining makes a request file and prints six key words; if one of your devices is already a member, it only sets up the merge driver. Either way it adds the merge driver. `--from` on a set that already exists is refused: use `push`. |
| `authdeck env ls` | The sets in this repo: variables, members, your role, and whether a grant is open here. Also the join requests waiting. Asks no device. |
| `authdeck env run [--set <name>] [--allow <NAME>]… [--] <command> [<arg>…]` | Starts the command with the set's variables in its environment. Writes no file. Skips variables that make programs load code unless named with `--allow` (repeat it for several). Options for `run` come before the command; `--` or the first word that isn't an option starts it. |
| `authdeck env pull [<file>] [--file <file>] [--force] [--set <name>]` | Writes the set to `<file>` (default `.env`) with mode 0600. Warns first when git doesn't ignore it. `--force` replaces a file that is already there. |
| `authdeck env push [<file>] [--file <file>] [--prune] [--set <name>]` | Sends the variables in `<file>` (default `.env`) to a member device to sign. Adds and changes; `--prune` also removes names missing from the file. Prints what was added, changed and removed once the device signed. |
| `authdeck env merge <base> <ours> <theirs>` | The merge driver. Git runs it; you don't. |
| `authdeck env --help` (`-h`), `authdeck env --version` (`-v`) | Usage, and the version. |

Options take their value as `--set name` or `--set=name`. Name the file once: a positional file and
`--file` together are refused.

Without `--set`, `init` uses the set already in the repo when there is exactly one, refuses when
there are several (exit 64), and otherwise names the new set after the repo: the last part of the
origin remote's path, or the folder's name, lower-cased, with runs of other characters turned into
`-`, leading characters that aren't a letter or digit removed, cut to 64 characters, trailing `-`
removed ("Acme API" becomes "acme-api"). If nothing usable is left, it asks for `--set`.

`init` creating a set, in a repo without it:

```
~/code/acme-api $ authdeck env init --from .env
Project  acme/api (git@git.example.com:acme/api.git)
Set      acme-api → .authdeck/acme-api.env
Import   12 names from .env
Waiting for Pixel 8 to create the set… 0:06
✔ Pixel 8 created acme-api: owner Pixel 8, 12 variables,
  encrypted for 1 device and your recovery phrase.
Wrote .authdeck/acme-api.env and a merge rule in .gitattributes.
.env still holds the plain values. Delete it? [y/N] y
Deleted .env.
Next: git add .authdeck .gitattributes
      git commit -m "Add acme-api env set"
```

`init` in a repo that has the set, by someone not in it:

```
~/src/acme-api $ authdeck env init
acme-api already lives here (owner: Maya Rao · Pixel 8).
Ask to join it from your phone? [Y/n] y
Waiting for iPhone 16 to make its keys… 0:03
✔ Wrote .authdeck/requests/<member id>.json
Your key words:  harbor velvet quarry mosaic lantern ember
Commit and push it, or open a pull request. Then read the six
words to Maya Rao; they approve on their phone.
```

`create` and the join's key-making go to every device of yours watching on that computer; `run`,
`pull` and `push` go to the devices that are members of the set.

### Exit codes

From BSD sysexits where one fits. `run` otherwise exits with its child's code.

| Code | Name | When |
|---|---|---|
| 0 | ok | Done (`run`: the command's own code). |
| 64 | usage | Bad arguments, or several sets here and no `--set`, or no set by that name. |
| 65 | file refused | The set file failed its checks, or the file you gave can't be read or breaks the rules (a bad name, a bad quote, over a cap). |
| 66 | no input | No set here, no file to read, or not a git repository. |
| 69 | unavailable | AuthDeck Agent isn't running, or doesn't speak this command's socket version. |
| 70 | internal | Anything else. |
| 73 | can't create | `pull`: the file is already there and `--force` wasn't given. |
| 75 | no answer | No member device answered in 60 seconds, the file changed while one was answering, or too many requests just now. |
| 77 | denied | A device denied it. |
| 130 | interrupted | Stopped with Ctrl-C. |

### Errors

| Error | Exit | What the command says |
|---|---|---|
| `denied` | 77 | "Pixel 8 denied acme-api-prod. npm run seed:prod did not start." (pull: "… .env was not written."; push: "Nothing was changed."; create: "No set was made."; join: "No join request was made.") |
| `no-answer` | 75 | "No member device answered in 60 s." Open AuthDeck on the named devices, on the same network as this computer, and run it again. |
| `changed-meanwhile` | 75 | The file changed while a device was answering. Run it again. |
| `rate-limited` | 75 | Too many env requests from this computer just now. Wait the seconds it names, then try again. |
| `file-refused` | 65 | The file's problem (above), then "Nothing was released." or "Nothing was changed." |
| `bad-name` | 65 | A line in the file you gave has a name that isn't allowed. |
| `bad-dotenv` | 65 | A line in the file you gave opens a quote and never closes it, or has text after the closing quote. The line itself is never shown. |
| `too-large` | 65 | The file you gave is over a cap. |
| `target-exists` | 73 | `pull`: the file already exists. Add `--force`, or name another file with `--file`. |
| `no-set` | 66 | No env set in this folder. Run `authdeck env init`. |
| `no-repo` | 66 | Not inside a git repository. |
| `no-input` | 66 | The file to read doesn't exist. |
| `several-sets` | 64 | Several sets here. Name one with `--set`. |
| `unknown-set` | 64 | No set by that name; lists the sets here. |
| `usage` | 64 | What was wrong with the arguments. |
| `agent-unavailable` | 69 | AuthDeck Agent isn't running. Open it, or run `authdeck-agent`. |
| `agent-version` | 69 | The command and the agent don't match. Update AuthDeck Agent; the command comes with it. |
| `failed` | 70 | What failed. Try again; if it keeps failing, restart AuthDeck Agent. |

### The agent

- **The socket.** The command talks to the agent over a Unix socket, `agent.sock` in the AuthDeck
  folder (`~/.authdeck`, mode 0600 in a 0700 folder), or a per-user named pipe on Windows. Only your
  own processes reach it; anything running as you could reach your secrets anyway. One request per
  connection, one line of JSON each way plus progress lines while devices are asked.
- **What it remembers.** Each request names the set file the command read and checked, which is how
  the agent learns working trees. `<AuthDeck folder>/env/projects.json` (owner-only) lists the set
  files it has seen (at most 512, the oldest forgotten first) and the remembered head of every set
  (never forgotten). Never values, never keys.
- **Rate limits.** From the command: 30 requests at once, then one a second; at most 6 asks to
  devices, then one every 10 seconds; at most 4 waiting at a time. A command over a limit ends with
  exit 75 and says how long to wait. From each paired device: 60 reads, then one every half second;
  30 writes, then one every half second; join requests as above.
- **The window.** Env activity joins the Activity list, newest first, with the command and how it
  was allowed; an open grant shows as a banner whose End now also tells the phone. The desktop app
  ends every grant when the computer locks or sleeps.

## On the phone or tablet

- Env sets are a section of the Vault: under Accounts on phones, at the top of the middle column on
  tablets. There is no new tab; the vault's usual ways in reach it.
- **One computer at a time.** In 0.4.0 the phone reads sets only from the computer it is connected
  to now. Sets on other computers show as of their last sync.
- Requests from the computer need no navigation. Release, push and join sheets open over whatever is
  on screen, even while the vault is locked (they offer Unlock or Decline until it opens). A request
  answered on another device, run out or cancelled closes with the reason.
- **Confirmation.** With app lock on, the device's own unlock (Face ID, fingerprint or device PIN) is
  asked before every answer to a computer except Deny, and before approving a join (teammate or own
  device), removing a member and becoming owner. Variable edits only need the vault open.
- **Storage.** Each set's copy (the file as written, values still encrypted, and the remembered
  head) is a file in the app's private folder; nothing in it opens a value. The env identity, each
  set's data keys by epoch and a hash of each copy's head are in the iOS Keychain or Android Keystore,
  readable only while the device is unlocked, on this device only, never in backups. Env keys open
  with the vault and lock with it. Values are decrypted to show one, to sign a change, or to release
  them.
- Values stay masked until you tap the eye, and a revealed value hides itself after 30 seconds.
  Sheets that show or take a value block screenshots, screen recording and the app switcher preview.
- History is the git log of the file, read through the agent; each commit is checked against its
  signatures on the phone, and one with a line no member signed is marked.
- No push notifications: there is no server to send them. AuthDeck must be open on a member device
  on the same network as the computer (or one it reaches, such as a private VPN) to answer.

## Threat model and limits

### A lost or stolen owner phone

Take the set over with your recovery phrase as soon as you can. Until you do, whoever holds the
phone (and can unlock it) is the owner: they can read every value, add or remove members, and replace
the set's recovery phrase. **If they replace the phrase first, your phrase no longer opens the set**,
and the only way out is a new set with every value rotated. If they keep signing with the phone
after your take-over, the set has two lines of ownership and phones refuse it; again, make a new set
and rotate.

### A stolen laptop

- **Can't** read any value from the set files: they are ciphertext, and the computer holds no set's
  key.
- **Can't** get a release without a member device approving it. A paired laptop can send requests;
  the phone shows them, and you deny.
- **Can** read any `.env` that `authdeck env pull` wrote, like any other file on its disk. Prefer
  `run`.
- **Can** use an open grant if it is taken unlocked and awake within the grant's 15 minutes. The
  grant ends when the screen locks, the computer sleeps, or the agent restarts.
- **Can** read every old ciphertext in the repo's history. If a device key leaks later, values from
  the epochs it held can be read.
- Deny any request you didn't start, and unpair the laptop.

### Someone who can write to the repo but isn't a member

- **Can't** read values, add a value, change one, or add or remove a member. Every value line must be
  signed by a member, and the member list by the owner.
- **Can't** roll a set back on a device that has seen a newer file: each device remembers the head
  it accepted. A phone that has never seen the set checks the file against its git history first, so
  it refuses an older member list or value too. The agent on a computer that has never seen the set
  takes the first valid file, so it can be shown an older, validly signed one; phones still release
  from their own newest copy.
- **Can't** make a file under an existing set's id: the id is the hash of the set's signed birth
  certificate, so any other file claiming it fails as unsigned.
- **Can't** get a release by swapping in a set of their own: requests go only to that set's members,
  and your devices aren't in it.
- **Can** see variable names, member labels (with people's names), how many members there are, value
  sizes, and when things changed.
- **Can** break the set for everyone: a changed or deleted line makes every reader refuse the file
  until someone reverts the commit. Nothing is partly used.
- **Can** fill `.authdeck/requests/` with junk. Files that fail their checks are skipped, so real
  requests still show.
- **Can** hide or delete a real join request file. The teammate asks again.
- **Can** force-push a rewritten history. Devices that saw the set refuse anything older, but a
  phone with no memory of the set reading a fresh clone can't tell. Protect branches that hold set
  files against force-push.
- **Can** put a second line of ownership, made with a retired key, on a branch that doesn't contain
  the take-over. A phone checks the history of the branch that is checked out, so a teammate who
  checks out that branch first isn't warned. Take sets from the main branch.
- **Can** commit a join request under any name. Its key words won't match the ones on the real
  person's phone; compare them over a channel you trust, never from the request alone.
- **Can change the code you run.** `authdeck env run -- npm run dev` gives the values to whatever
  `npm run dev` runs. Someone who can change the repo's scripts or dependencies gets the values the
  next time you allow a run. Review what you pull before you run it.

### A removed member

- **Keeps** every value it saw: on its device, and in git history, under the old key it held.
  AuthDeck lists those variables to rotate.
- **Can't** read values written under the new key: it is sealed only to the remaining members and
  the recovery identity. A value a member saved under the old key before seeing the removal is the
  exception (see "Values under an old key"): kept or dropped, it goes on the rotate list.
- **Can't** change the set: lines it signs after the removal are refused (`not-a-member`), and a
  merge drops them.
- If it can still write to the repo, it is also "someone who can write to the repo" above.

### A member who turns hostile

- **Can** read every value and change any of them; every change is signed with their device and
  shows in the history. Remove them, then rotate.
- **Can't** run code on your computer by setting a variable that makes programs load code
  (`NODE_OPTIONS`, `LD_PRELOAD`, `GIT_*` and the rest): `run` skips those unless you `--allow` them,
  and the phone flags them. A value your program itself treats as code or a URL to trust is beyond
  what AuthDeck can check.
- **Can't** add or remove members; only the owner device can.

### A compromised computer

AuthDeck Agent doesn't defend against other programs running as you on the same computer (see
Accepted limits): such a program can edit `~/.authdeck`, pair itself, and drive the agent as a phone
would.

Malware running as you, or with more rights, on a computer where you allow releases:

- **Can** see every value of a set you release to it: in the process you allowed, in a pulled
  `.env`, and **for as long as a grant lasts, in the agent's memory and in every run and pull it
  makes without asking you**. It can start its own commands inside the grant, and show the phone any
  command and folder it likes when asking.
- **Can** offer you a push with values of its choosing. The phone shows the change by name, and
  "Show new values" shows the values; if you sign it, it is a real change.
- **Can** show a phone that has no memory of a set (restored, or joining for the first time) a
  made-up history, so that phone's history check proves nothing there.
- **Can** hide or delay changes, serve an older file, stop requests, and refuse to write. Phones
  release from their own newest copy and say when the computer shows an older one.
- **Can't** get the data key, so it can't read a set you never release to it, or values written after
  it is cleaned up and the set re-keyed.
- **Can't** sign anything: changes need a member device, and member list changes the owner device.
- **Can't** make a check code match for a device it slips into an own-device join, or make a forged
  teammate request's key words match.

After a compromise, rotate every value of every set released to that computer.

### Accepted limits

- **AuthDeck Agent doesn't defend against other programs running as you on the same computer.** Such
  a program can change the agent's settings in `~/.authdeck`, its list of paired devices included,
  and then drive the agent the way a paired phone does. It can also start the agent with a PATH of
  its own, or change the installed app. Keep the computer free of malware. What is covered: other
  programs can't use AuthDeck Agent as a script runtime, or start it with Chromium's launcher or
  debugging switches. A later release will keep pairings in the system keychain and sign the Mac app
  with a Developer ID, which narrows this.

- A lost owner phone in someone else's hands can replace the set's recovery phrase before you take
  the set over. Your phrase then no longer opens it; the way out is a new set with rotated values.
  Take over as soon as an owner phone is lost.
- Someone holding a retired key (a lost owner phone, a replaced phrase) can start a second line of
  ownership. Phones refuse the set where they meet both lines; the way out is a new set and rotating
  every value.

- A computer you allow sees the values while the process runs, and so does anything else running as
  you. The sheet shows the command the computer reports; it can't prove it.
- During a 15-minute grant the values sit in the agent's memory.
- Anyone who can read the repo sees variable names, member labels with people's names, how many
  members there are and when things changed. Never values.
- A removed member keeps what it already saw. AuthDeck lists those variables to rotate.
- Git keeps every old ciphertext. If a device key leaks later, values from the epochs it held can be
  read.
- The agent trusts first sight: a computer that has never seen a set accepts the first validly signed
  file. Phones check git history first.
- A phone with no memory of a set (restored, or joining for the first time) trusts the repo's
  history as the computer shows it. A force-pushed history in a fresh clone, or a compromised
  computer, can't be caught. Protect branches that hold set files against force-push.
- A phone checks the history of the checked-out branch only. Someone holding a retired key who
  commits a second line of ownership on a branch without the take-over isn't caught by a teammate
  who checks out that branch first. Take sets from the main branch.
- A repo writer can hide or delete join request files; the teammate asks again.
- A set owned by a device outside your vault can't be taken over with your recovery phrase.
- Becoming owner with the recovery phrase removes every other member; add back the ones you trust.
- No server means no push notifications. A member device must have AuthDeck open and reach the
  computer to answer; `run` waits 60 seconds. In 0.4.0 a phone reads sets only from the computer it
  is connected to.
- One owner device per set. Without a recovery phrase, losing it freezes the member list.
- Times in the file are each device's own clock. A clock far ahead wins ties between two changes to
  one variable at the same version; it never changes who is in the set.
- Dev, stage and prod are separate sets, each with its own members. CI and headless machines have no
  way to get values in 0.4.
