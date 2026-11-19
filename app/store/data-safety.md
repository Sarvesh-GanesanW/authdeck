# Data safety (Google Play) and App Privacy (App Store)

Both forms ask about data the developer, or a third party, gets from the app. AuthDeck sends nothing to the developer or to any third party, and runs no server. The only data that leaves the phone goes to a computer the user owns and paired themselves, over an encrypted connection on their own network, and the developer never has access to it. Neither store treats that as collection, so the answer to both forms is that no data is collected.

Env sets (0.4) don't change this. The app sends a set's values only to the user's own paired computer, encrypted end to end to the one process or grant the user allowed. The set file the agent writes into the user's project holds the values encrypted with keys only member devices have. The file also holds, in clear, variable names, member labels (the person's name, which the app asks for once, and the device's name), public keys and times. AuthDeck never commits or pushes it and never contacts a git host. The user commits and pushes it with their own git, to a repo they chose, as with any other file in their project. Teammates' devices read it from their own copy of that repo. Nothing passes through the developer.

## Google Play: Data safety form

### Data collection and security

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | **No** |

When you answer No, Play skips the per-data-type questions, and the listing shows "No data collected" and "No data shared with third parties".

Why each data type the app touches is not "collected":

| What | Where it goes | Why it isn't collection |
| --- | --- | --- |
| Keys, pages, settings, paired computers and their public keys | Stored on the device only | Never leaves the device |
| Device keys (connection key, vault and env set signing and encryption keys) | Keychain or Keystore on the device, excluded from backups | The private keys never leave the device. Public keys go into env set files and join requests (below) |
| 2FA vault (accounts and their secrets) | Encrypted on the device, and as an encrypted, signed backup folder on the user's own computer | Encrypted with keys only the user's device and recovery phrase can open; the developer has no access and runs no server |
| Env set values (`.env` secrets) | Encrypted on the device; released, at the user's tap, to the user's own paired computer, sealed to the one process or 15-minute grant they allowed; sent over the encrypted connection when the user pushes changes or creates a set from the computer | Goes only to the user's own computer. The developer has no access and runs no server |
| Env set file (`.authdeck/<set>.env` in the user's project) | Written by the agent on the user's computer into the user's own project folder. Values are encrypted; variable names, member labels, public keys, versions and times are in clear | AuthDeck doesn't transmit it anywhere. The user commits and pushes it with their own git to a repo they chose, which teammates they added read from |
| The user's name and device names (member labels such as "Maya Rao · Pixel 8"; the app asks for the name once, for env sets, and keeps it on the device) | Shown to the user's other devices, through the paired computer, when one of them joins an env set; written in clear in env set files and teammates' join request files | Goes only to the user's own computer and their own project; seen by people the user chose to share the repo with, never by the developer |
| Key presses and the actions they carry (shortcuts, commands, text snippets, links, 2FA codes to type) | Sent to the paired computer over an encrypted connection | Goes only to the user's own device, never to the developer or a third party |
| The computer's installed apps and their icons (for the app picker and app keys) | Sent by the user's own paired computer to the app over the encrypted connection; the icons are cached on the device | Comes from the user's own computer and stays on the device; never sent to the developer or a third party |
| Camera frames | Read on the device to decode pairing, 2FA setup and Google Authenticator export QR codes | Not stored, not transmitted |
| Device IP address | Read on the device to scan the local /24 network for the agent | Not transmitted to anyone |
| Deck backup file | Saved or shared where the user chooses, via the system share sheet | User-initiated export to a destination the user picks |
| Face ID, fingerprint or passcode (app lock) | Handled by iOS or Android; the app gets only pass or fail | The app never receives biometric data |
| Clipboard | Read only when the user taps a paste button: "Paste all 12" while restoring a vault, or the paste key when typing a pairing PIN. Written only when the user copies a command's output | Used on the device, not stored or transmitted |

### Other questions on the form

| Question | Answer |
| --- | --- |
| Is all of the user data collected by your app encrypted in transit? | Not asked when nothing is collected |
| Do you provide a way for users to request that their data is deleted? | Not asked when nothing is collected (there is no data held by the developer; uninstalling removes everything the app stored) |
| Independent security review | No |

### Permissions the build declares

The release manifest keeps only:

- `CAMERA`: scanning pairing, 2FA setup and Google Authenticator export QR codes.
- `INTERNET`: the WebSocket connection to the agent on the LAN.
- `ACCESS_NETWORK_STATE`: reading the phone's own IP address to scan the local network.
- `VIBRATE`: haptic feedback on key presses.
- `MODIFY_AUDIO_SETTINGS` (from expo-audio): key click sounds.
- `USE_BIOMETRIC` and `USE_FINGERPRINT` (from expo-local-authentication): app lock with fingerprint, face or passcode.

Removed with `android.blockedPermissions` because nothing uses them: `ACCESS_WIFI_STATE`, `SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `RECORD_AUDIO`, `WAKE_LOCK`.

## App Store: App Privacy

| Question | Answer |
| --- | --- |
| Do you or your third-party partners collect data from this app? | **No, we do not collect data from this app** |

The listing then shows **Data Not Collected**. Apple's definition of collection is "transmitting data off the device in a way that allows you and/or your third-party partners to access it for longer than necessary to service the request in real time"; data that only goes to the user's own computer doesn't meet it. An env set file goes from the user's computer to a repo only by the user's own git, never through the app or the developer, and its values are encrypted with keys only the user's and their teammates' devices hold.

Tracking: **No.** The privacy manifest (`ios.privacyManifests` in `app.json`) declares `NSPrivacyTracking: false`, no tracking domains and no collected data types, which matches these answers.

## Revisit when

- any crash reporting, analytics, cloud sync or account feature is added;
- AuthDeck ever runs a server of its own (a relay for reaching the computer from anywhere, or push notifications for env set requests, for example);
- any SDK is added that talks to a server;
- AuthDeck ever commits, pushes or talks to a git host itself, or env sets get service tokens for CI (a machine outside the user's own devices holding values);
- multi-device or team vaults are turned on (`MULTI_DEVICE_VAULTS`, off in 0.4.0): add the shared-folder wording to the 2FA vault row and to privacy.md. The device-name row is already here, for env sets;
- the env set sheet ever reads the clipboard itself ("Paste lines from a .env" is a text field the user pastes into, so the app doesn't read the clipboard there): add it to the clipboard row and to privacy.md.

The note for 0.4 is resolved: env sets brought back the device-name row, and added the env set rows above. Team vaults didn't ship in 0.4, so the vault row stays as it was.
