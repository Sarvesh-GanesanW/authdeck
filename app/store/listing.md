# Store listing

Character limits are the stores' own; the counts here were checked.

## Name

**AuthDeck** (8 characters; both stores allow 30)

## Subtitle (App Store, 30 max)

Keys and 2FA for your computer

(30 characters)

## Short description (Google Play, 80 max)

Keys for your computer, 2FA codes it types, .env secrets your phone approves.

(77 characters)

## Full description (both stores, 4000 max)

AuthDeck turns a spare phone or tablet into a deck of keys for the computer you work on. Tap a key and your computer opens an app, presses a shortcut, types a snippet, runs a command or opens a link.

AuthDeck works together with AuthDeck Agent, a free app for macOS, Windows and Linux. The agent runs on your computer and carries out what the keys ask. You pair the two once by scanning a QR code or typing a six-digit PIN, and after that they talk directly over your own Wi-Fi. There is no account, no sign-up and no server in between.

What a key can do:
- Open an app, picked from the apps installed on your computer.
- Press a keyboard shortcut, optionally bringing a particular app to the front first.
- Type a snippet of text.
- Run a command in a new terminal window, or in the background and show you its output and exit code.
- Open a link, a file or a folder.
- Do several of these in a row.

You start with four pages of keys (Code, Git, Run and Apps) set up for VS Code on your system. Tap Edit to move keys around, change what they do or add your own. AuthDeck can also switch pages for you when you change apps on your computer.

Keys click when you press them (you can turn that off), a small light on each key shows how its last action went, and a running command marches a line of pixels around its key. There are three colour schemes: Graphite, Paper and Tide.

A built-in authenticator:
- 2FA codes are made on your phone or tablet, and work with no network.
- Tap a code's key and AuthDeck types it on your computer, digits only.
- Add accounts by scanning a site's QR code, typing the key, or moving them over from Google Authenticator. Steam Guard codes work too.
- Your accounts live in an encrypted vault on your phone or tablet. Your computer keeps an encrypted backup of it, but it can't read your codes.
- Every change to the vault is signed, so nothing can be added or changed behind your back.
- A 12-word recovery phrase restores the vault on a new phone or tablet, and shuts out the old one.
- Lock codes behind Face ID, your fingerprint or your passcode.

Env sets, for a project's .env secrets:
- A set is one file in your project's git repo. Variable names are readable; values are encrypted so that only member phones and tablets can open them.
- Your phone approves every use. Run a command with the authdeck command on your computer, tap Allow, and the values go into that one process. Allow for 15 minutes to skip the tap for the next runs on that computer.
- Your computer never stores the set's key.
- Every change is signed by the device that made it, and the app shows who changed what from the git history.
- Add your own devices with a six-digit check code, and teammates after comparing six key words.
- Removing someone makes a new key and lists the variables to change at their providers.

Privacy: AuthDeck collects nothing, and has no account and no server. Your keys, settings, codes and env values stay on your devices, and everything the app sends goes only to the computer you paired, over an encrypted connection. Env set files stay in your own project; you decide where to push them. The camera is used only to scan QR codes.

AuthDeck needs AuthDeck Agent running on a computer on the same network.

## Keywords (App Store, 100 max, comma separated, no spaces)

2fa,authenticator,totp,macro,keypad,shortcut,hotkey,dotenv,secrets,developer,terminal,command

(93 characters)

## Category

| Store | Primary | Secondary |
| --- | --- | --- |
| App Store | Developer Tools | Productivity |
| Google Play | Productivity | (Play has one category) |

## Support URL / website

Required by the App Store. Use the public page where the agent is downloaded, or the page hosting the privacy policy.

## Age rating

### App Store (age rating questionnaire)

Answer **None** or **No** to every item:

| Question | Answer |
| --- | --- |
| Cartoon or fantasy violence, realistic violence, prolonged graphic or sadistic violence | None |
| Profanity or crude humour | None |
| Mature or suggestive themes | None |
| Horror or fear themes | None |
| Medical or treatment information | None |
| Alcohol, tobacco or drug use or references | None |
| Simulated gambling, gambling, contests | None / No |
| Sexual content or nudity, graphic sexual content | None |
| Unrestricted web access (an in-app browser) | No (links open on the paired computer, not in the app) |
| User-generated content shared with other users, messaging or chat | No (env sets are shared through the user's own git repository, not through the app; the app has no way to send anything to another person) |
| Advertising | No |
| Parental controls, age assurance | No |
| Made for kids | No |

Result: **4+**.

### Google Play (IARC questionnaire)

- Category: **Utility, Productivity, Communication, or Other**.
- Violence, fear, sexuality, language, controlled substances, crude humour, gambling: **No** to all.
- Does the app let users interact or exchange content with other users? **No.** Env set files reach teammates only through the user's own git repository; the app itself sends nothing to another person.
- Does the app share the user's current physical location with other users? **No.**
- Does the app allow users to purchase digital goods? **No.**
- Does the app contain or promote unrestricted internet access (such as a browser)? **No.**

Result: **Everyone / PEGI 3 / USK 0**.

## Pricing

Free, no in-app purchases, no ads.
