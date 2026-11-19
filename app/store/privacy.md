# AuthDeck privacy policy

Effective 19 November 2026. Applies to the AuthDeck app for iPhone, iPad and Android, to AuthDeck Agent for macOS, Windows and Linux, and to the authdeck.in website.

## The short version

AuthDeck collects nothing. There's no account, no analytics, no advertising, and no server of ours between your devices. Everything the app and agent do happens between your phone or tablet and the computers you pair it with. Env sets add an encrypted file to your own project, which you share through your own git repository if you choose to.

## What stays on your phone or tablet

The app keeps these on your device:
- your keys, pages and settings
- the computers you've paired, with each one's public key
- the icons of the apps on your computers, saved so keys can show them without asking the computer again
- this device's own keys: the key it uses to connect to your computers, the keys that sign and open your 2FA vault, and the keys that sign and open your env sets. These are stored in the iOS Keychain or the Android Keystore, can only be read while the device is unlocked, and are kept out of device backups.
- an encrypted copy of your 2FA vault, so codes work without a network
- a copy of each env set this device is a member of (or was removed from, until you delete it), with its values encrypted, and the set's key, which opens with the vault and locks with it

Your 2FA secrets and codes are decrypted only in the app's memory while the vault is unlocked, and are wiped from memory when it locks. Env set values are decrypted only to show one you tap, to sign a change, or to release them to a computer you allowed.

None of this is sent to us or to anyone else. Deleting the app removes what it stored. If you export a deck backup, the file goes wherever you choose to save or send it.

## What stays on your computer

AuthDeck Agent keeps on your computer:
- its own settings and connection key
- the list of devices you've paired
- the icons of your installed apps, saved so it doesn't have to draw them again
- your 2FA vault folder
- the env set files in your projects (`.authdeck/<set>.env`), which it writes when your phone or tablet makes a change, and the list of project folders it has seen them in

While it runs, the agent window lists the recent actions your devices sent, without 2FA codes or other secrets. The list is kept in memory only and is gone when the agent quits.

The vault folder is an encrypted, signed backup of the vault on your phone or tablet. The agent can't read your 2FA secrets; only your device, or your recovery phrase, can open them.

## Env sets

An env set keeps a project's `.env` secrets in a file inside that project. Its values are encrypted with a key that only the phones and tablets you made members can open, and every line is signed by the device that wrote it. The agent never holds that key.

The file also holds, readable by anyone who can read your project: the variable names, each member's label: the person's name, which the app asks for once, and the device's name, such as "Maya Rao · Pixel 8", each member device's public keys, and when each line was changed and by which device. A teammate asking to join adds a request file with their label and public keys. Sets owned by the same person also show the same recovery key id, so someone who can read several of your repositories can tell those sets have one owner.

AuthDeck never commits, pushes or uploads these files, and never contacts a git host. You commit and push them with your own git, to a repository you chose, like any other file in your project, and teammates read them from their copy. Who can see the file is decided by who can read that repository. Nothing goes through us.

When a computer asks for a set's values and you allow it, your phone sends them to that computer only, encrypted for the one command you allowed (or, with "Allow for 15 minutes", for AuthDeck Agent's memory, where they stay until the 15 minutes end, the set file changes, the computer locks or sleeps, or the agent stops). The computer then has them in plain text, in that command, or in a `.env` file if you asked for one. When you send changes from your computer, the new values travel to your phone over the encrypted connection, and the phone encrypts and signs them.

## What travels over your network

When you press a key, the app sends the action to your paired computer, for example "open this app", "run this command" or "type this code". The computer carries it out and sends back the result. So that you can put apps on keys, the agent sends the app the list of apps installed on your computer, with their icons.

Every connection between the app and your computer is encrypted, and both ends prove who they are before anything else is sent. This traffic goes only to the computers you pair with, never through any server of ours; the app and agent use none.

When another of your devices joins an env set, the two devices' names and the set's name pass through your computer in plain text, so both screens can show them.

When a 2FA key is tapped, only the code's digits are sent, to be typed on your computer. The agent never logs, shows or keeps them.

To find your computer, the app looks for the agent on your local network.

## Camera

The app uses the camera only to scan QR codes:
- the pairing code that AuthDeck Agent shows
- the 2FA setup codes that websites show
- the export codes from Google Authenticator

Images are read on your device and are not saved or sent anywhere. The 2FA secret read from a QR code is stored encrypted in your vault. You can pair by PIN and type 2FA keys by hand, and never grant camera access.

## Face ID, fingerprint and passcode

If you turn on app lock, AuthDeck asks for Face ID, your fingerprint or your device passcode before it shows codes. The operating system does that check, and the app only learns whether it passed. AuthDeck never sees or stores your face, fingerprint or passcode.

## Screenshots and clipboard

AuthDeck blocks screenshots and screen recording while your recovery phrase is on screen, and while a sheet shows or takes an env set value. It reads the clipboard only when you tap a paste button: "Paste all 12" while restoring a vault, or the paste key when typing a pairing PIN. It writes to the clipboard only when you copy a command's output.

## Local network (iOS)

iOS asks whether AuthDeck may find and connect to devices on your local network. That's how it reaches the agent on your computer; without it, the app can't connect.

## Children

AuthDeck is not directed at children and collects no personal information from anyone, of any age.

## Third parties

The app has no third-party analytics, advertising, crash reporting or tracking libraries, and shares no data with anyone. Neither the app nor AuthDeck Agent checks for updates, reports crashes or sends usage data.

## This website

This section is about https://authdeck.in, where AuthDeck is downloaded and this policy is published.

The site sets no cookies and runs no analytics, advertising or tracking scripts. Everything on it, including fonts and scripts, comes from authdeck.in itself. The pages are marked so that Cloudflare, which delivers the site, doesn't add its own analytics script to them.

If you pick a colour scheme, your browser keeps that choice in its local storage, under the name `authdeck-colorway`, so the next visit opens in the same colours. It never leaves your browser, and clearing the site's data removes it.

To suggest the right download, the page reads your browser's description of your system, and on a Mac the name of its graphics chip, to tell Apple silicon from Intel. This happens in your browser and is not sent anywhere. Clicking a checksum copies it to your clipboard.

The site is served through Cloudflare. Like any web host, Cloudflare receives your IP address and the details of each request in order to deliver the site and protect it from attacks, and handles them under [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/). The computer that serves the site's files keeps no log of visits.

If you email hello@authdeck.in, Cloudflare Email Routing forwards your message to the developer's inbox. Your address and message are used only to reply to you.

## Changes

If this policy changes, the new version will be posted at https://authdeck.in/privacy/ with a new effective date. If AuthDeck ever starts collecting any data, the policy will say so before the version that does it is released.

## Contact

Questions about this policy: [hello@authdeck.in](mailto:hello@authdeck.in)
