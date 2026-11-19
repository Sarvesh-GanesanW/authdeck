# Notes for App Review (App Store) and App access (Google Play)

Paste the block below into App Store Connect › App Review Information › Notes, and into Play Console › App content › App access (choose "All or some functionality is restricted" and add it as the instructions). Replace the two placeholders first.

---

AuthDeck is a remote key deck for the user's own computer, with a built-in 2FA authenticator and encrypted sharing of a project's .env secrets that the phone approves. It works together with AuthDeck Agent, a free desktop app for macOS, Windows and Linux. There is no account and no sign-in; the phone pairs directly with the computer over the local network, and the connection is encrypted.

Because the app needs a computer running the agent on the same Wi-Fi network, it may not be possible to pair it during review. A demo video showing the full flow is here: DEMO_VIDEO_URL

To try it yourself:
1. On a Mac, Windows or Linux computer, download and open AuthDeck Agent from AGENT_DOWNLOAD_URL. On macOS, allow it under System Settings › Privacy & Security if asked, and allow incoming network connections. The agent window shows a QR code and a six-digit PIN.
2. Put the iPhone or iPad on the same Wi-Fi network as the computer.
3. Open AuthDeck and allow local network access when iOS asks.
4. Tap Scan QR code and scan the code in the agent window (allow camera access), or pick the computer from the list and type the PIN.
5. Tap any key on the Apps page, for example one that opens an app, and it opens on the computer. Tap Edit to change what a key does.

To try the authenticator:
1. Open Settings, then Authenticator, and tap "Set up the authenticator", then "Set up a new vault".
2. Write down the 12 words shown, then type the three words it asks for.
3. Add an account: tap "Type the key" and enter Name "Demo" and Key JBSWY3DPEHPK3PXP (a public example key, not a real account).
4. Open a page's settings and tap "Make 2FA page". The Demo key shows a 6-digit code that changes every 30 seconds.
5. Click into a text field on the computer, then tap the Demo key: the code is typed there.

To try env sets (optional; needs git and a project folder on the computer):
1. With the vault set up as above, open a terminal in any git repository on the computer and run: authdeck env init (AuthDeck Agent offers to put the authdeck command on the PATH).
2. Approve "create the set" on the phone (it asks once for a name to show beside the device name; any name works). The set appears in the Vault under ".env sets".
3. In the set, tap Add and enter Name DEMO_TOKEN and Value hello (an example, not a secret).
4. On the computer (macOS or Linux), run: authdeck env run -- printenv DEMO_TOKEN
5. The phone asks; tap Allow once. The computer prints hello. Nothing is sent anywhere but the computer.

Permissions:
- The camera is used only to scan QR codes: the pairing code, and 2FA setup codes.
- Face ID or fingerprint is used only for the optional app lock.
- Local network access is used only to reach the agent.
- The app collects no data.

---

## The demo video

App Review can't be expected to set up a computer on its network, so the video is what they will judge the app by. Record it before submitting and host it where a link opens without signing in (an unlisted YouTube video, or a file link that doesn't need an account).

Show, in one continuous take with both screens visible (phone and computer side by side, or a screen recording of each):

1. Opening the agent on the computer, with the QR code.
2. Opening AuthDeck, the local network and camera prompts, and scanning the code.
3. Pressing a few keys and the computer reacting each time: opening an app, a keyboard shortcut, a command with its output shown on the key.
4. Editing a key and using it.
5. Setting up the authenticator, adding an account by scanning a site's QR code, and tapping its key to type the code on the computer.
6. Turning on app lock and unlocking with Face ID.
7. Env sets: `authdeck env init` in a project, approving it on the phone, then `authdeck env run -- <command>` and the release sheet with Allow once.

Three to four minutes is enough.

## Placeholders

- `AGENT_DOWNLOAD_URL`: a public download page for AuthDeck Agent. The repo is private, so its release assets won't download for reviewers.
- `DEMO_VIDEO_URL`: the video above.
