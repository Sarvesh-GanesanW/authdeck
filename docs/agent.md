# AuthDeck agent

The agent runs on your computer (macOS, Windows or Linux) and does what the keys on your tablet or
phone ask for: it opens apps, presses shortcuts, types text, runs commands, and opens links, files
and folders. It also tells the AuthDeck app which apps you have installed.

There are two ways to run it. Most people should install the **AuthDeck Agent** desktop app. It
sits in the menu bar or system tray, shows the pairing code in a window, and lists your devices
and what they ran. If you'd rather run it from a terminal, or on a machine without a desktop app
build, use the command-line agent. Both are the same agent underneath, with the same settings
file, so use one or the other, not both at once: the second one to start finds the port taken.

## The desktop app

Download the installer for your system from
[authdeck.in](https://authdeck.in/#download):

| System | File |
|---|---|
| macOS, Apple silicon | `AuthDeck-Agent-<version>-mac-arm64.dmg` |
| macOS, Intel | `AuthDeck-Agent-<version>-mac-x64.dmg` |
| Windows | `AuthDeck-Agent-<version>-win-x64.exe` |
| Linux | `AuthDeck-Agent-<version>-linux-x86_64.AppImage` or `AuthDeck-Agent-<version>-linux-amd64.deb` |

The builds aren't signed by Apple or Microsoft, so the first launch takes an extra step. On macOS,
if it says the app can't be opened, go to System Settings → Privacy & Security and click Open
Anyway. On Windows, SmartScreen may say it protected your PC; click More info, then Run anyway.

Open the app and it shows a QR code, the computer's address and a 6-digit PIN. In the AuthDeck app,
scan the code, or pick the computer from the list and type the PIN. The tablet and the computer
have to be on the same network.

The code and the PIN work only while that pairing view is on screen, for up to 10 minutes: the
window counts down ("Pairing open for 9:41"). Hiding or minimizing the window closes pairing, and
so does running out of time; press Open pairing (or New PIN) for a fresh code. A pairing closes it
too: one device per window. Each time pairing opens or closes makes a new code and PIN, so one you
saw earlier never works again. To pair another device later, use Pair another device in the window or Pair a device in the
menu bar or tray menu.

Closing the window doesn't stop the agent. It keeps running in the menu bar (macOS) or the tray
(Windows and Linux), and you quit it from there. The switch at the bottom of the window starts it
when you sign in. Once a device is paired, the window lists your devices, lets you unpair any of
them, and shows what each key press did. On macOS and Windows you can also pick where command keys
run: Terminal or iTerm, or Command Prompt, Windows PowerShell or PowerShell 7.

## The command-line agent

The command-line agent is a single file, `authdeck-agent.cjs`, and needs Node.js 18 or newer.

1. Install Node.js from https://nodejs.org or your package manager.
2. Build the file once from this repo: `cd agent && npm install && npm run build`. Copy
   `agent/dist/authdeck-agent.cjs` to wherever you want to keep it.
3. Start it with `node authdeck-agent.cjs`.
4. It prints the computer's name, its network addresses and the key words. To pair a device, run
   `node authdeck-agent.cjs pair` in a second terminal while the agent runs. That terminal shows a
   PIN and a QR code for 10 minutes; pair the same way as with the desktop app. It closes pairing
   as soon as a device pairs, when the 10 minutes are up, or when you press Ctrl+C, close that
   terminal or stop the command. The agent's own
   output and its log never show the PIN or the code.

Leave it running while you use AuthDeck, and press Ctrl+C to stop it.

### Starting it when you sign in

```
node authdeck-agent.cjs autostart enable    # or: autostart disable
```

On macOS this adds a LaunchAgent at `~/Library/LaunchAgents/dev.authdeck.agent.cli.plist` and writes
its output to `~/.authdeck/agent.log`. On Windows it puts `AuthDeck Agent.vbs` in your Startup
folder, which starts the agent without a window. On Linux it adds
`~/.config/autostart/authdeck-agent.desktop`, which starts inside your desktop session so xdotool
can reach the display.

Run the command from where you'll keep the file. Autostart remembers the file's current location
and the Node.js you ran it with, and it takes effect the next time you sign in.

### Other commands

```
node authdeck-agent.cjs --port 50000      # use another port (default 47474)
node authdeck-agent.cjs --dry-run         # log what each key would do, do nothing
node authdeck-agent.cjs pair              # open pairing for 10 minutes: PIN and QR code
node authdeck-agent.cjs devices           # list paired devices
node authdeck-agent.cjs devices --revoke-all
node authdeck-agent.cjs --help
```

## Settings

Settings and paired devices live in `~/.authdeck/agent.json`, or `%USERPROFILE%\.authdeck\agent.json`
on Windows. The desktop app and the command-line agent share this file. In it you can set
`"terminal": "iTerm"` on macOS, or `"shell": "powershell"` or `"pwsh"` on Windows; the desktop app
changes the same values from its window. Set `AUTHDECK_HOME` to keep everything in another folder.

AuthDeck used to be called DevDeck and kept its settings in `~/.devdeck`. If `~/.authdeck` doesn't
exist yet but `~/.devdeck` does, the agent copies it over the first time it starts, so your paired
devices stay paired. It leaves `~/.devdeck` alone; delete it yourself once you've removed the old
DevDeck Agent. Turning start at sign-in on or off also removes the old DevDeck sign-in entry, so
only one agent starts when you sign in.

## First run on each system

### macOS

The first time a key presses a shortcut or types text, macOS blocks it until you allow it. Open
System Settings → Privacy & Security → Accessibility and turn on the app the agent runs in:

- for the desktop app, that's **AuthDeck Agent**. The window shows a banner with a button that
  takes you straight there;
- for the command-line agent, it's the terminal you started it from (Terminal, iTerm, Ghostty and
  so on), or `node` when it runs through autostart.

Keys that run a command in a terminal window also ask once for permission to control Terminal or
iTerm. If you said no, turn it back on under Privacy & Security → Automation for the same app.

### Windows

The first start may bring up a Windows Defender Firewall prompt, for AuthDeck Agent or for Node.js.
Allow it on private networks, or the tablet won't be able to connect. If SmartScreen or your
antivirus asks about the app, `node.exe` or the autostart script, allow it.

Windows only lets a program send keys to apps running at the same or a lower privilege level. So
shortcuts can't reach an app you started as administrator, unless the agent runs as administrator
too.

### Linux

Shortcuts and typing need a keyboard tool for your session.

On X11, which most setups use, install xdotool: `sudo apt install xdotool` (`dnf` on Fedora,
`pacman -S xdotool` on Arch). The agent also uses `xprop` (in the `x11-utils` package) to see which
app is in front.

On Wayland, install wtype with `sudo apt install wtype`. GNOME's compositor doesn't support wtype,
so on GNOME install ydotool 1.x instead and start its service with
`sudo systemctl enable --now ydotool`.

Links and files open with `xdg-open` (in `xdg-utils`). If `gtk-launch` (part of GTK) is installed,
the agent uses it to start apps.

## Security

Everything between the AuthDeck app and the agent is encrypted, and both ends prove who they are
before anything is sent. [The authenticator's design](authenticator.md#between-the-phone-and-the-computer)
has the details.

Pairing proves the computer to the device and the device to the computer:

- Pairing is closed unless you open it: the desktop app opens it while its pairing view is on
  screen, and `pair` on the command line opens it for 10 minutes. Outside that window neither
  the QR code nor the PIN works. A pairing closes it. Both are replaced every time the agent
  starts and every time pairing opens or closes.
- The QR code carries the computer's key and a one-time secret.
- The 6-digit PIN pairs a computer found on the network or typed in. Each attempt is at most one
  guess, and one attempt runs at a time. Only an attempt that actually tests a PIN counts: someone
  who starts attempts and hangs up can't use up your guesses. An attempt must send its guess
  within 3 seconds, and an address that leaves 3 attempts without a guess within a minute can't
  start PIN attempts for a minute; the PIN itself is untouched. After 3 wrong PINs the agent makes a
  new PIN and pauses PIN pairing for 30 seconds, then longer after each new PIN, up to an hour. The
  count and the pause are kept in `agent.json`, so restarting the agent doesn't reset them.
- The pairing screen shows the computer's key words. After pairing, the app shows the same three
  words in its Computers sheet.

Each paired device has its own key; the agent stores only the public half, and its own key in
`link-key` next to `agent.json`, readable only by you. You can unpair one device from the desktop
app, or every device with `devices --revoke-all`. Either cuts the device off at once, even while
the agent is running and the device is connected: the agent watches `agent.json` and also checks
that a device is still paired before every request and every event it is sent, and again every
15 seconds. Everything that writes `agent.json` (the agent, the desktop app and the commands above)
takes a lock file, `agent.json.lock`, so no change is lost to another one made at the same moment.
The lock names the process holding it. A lock left by a process that has exited is taken over at
once, and any lock older than 1.5 seconds is taken over too (a write takes milliseconds). The
running agent waits at most 0.4 seconds for it, so a stuck lock never freezes the agent; the change
fails instead, and the desktop app says so if it was an unpair.

A device counts as connected, and its "last seen" time moves, only once it sends its first
encrypted message, so a recorded connection attempt replayed by someone else does neither. The
agent drops a connection that hasn't got that far within 10 seconds, or that hasn't finished its
HTTP request within 8, and turns away new ones while 8 such connections from one address, or 64
in all, are waiting. The last 16 of those are kept for addresses a device signed in from in the
past day, so strangers can't fill them all. A new connection from an address at its limit
replaces that address's oldest one that hasn't proved a paired key, and a connection that has
proved one no longer counts, so someone else on your own network address can't keep your phone
out.

Devices paired with AuthDeck 0.2 or earlier must pair once more: the agent refuses their old,
unencrypted connection and says so. Their keys and pages stay on the device.

Anyone on your network can see that an agent is there. `GET /authdeck/hello` returns the computer's
name, platform and a fingerprint of its key, never the PIN or the QR secret. Everything else needs
the encrypted connection.

The AuthDeck app sends no `Origin`. A web page does, and the agent refuses the WebSocket unless
that page is on `localhost` (the browser build of the app while developing, on any port). The
discovery URL sends CORS headers only to `localhost` pages too, so a web page from any other site,
open in a browser on your network, can't read the computer's name or key or start pairing.

A paired device can run commands as you. Only pair devices you own, and unpair one if you lose it.

The log has one line per action. It never contains keys, PINs, QR codes or the text a key types.

## What each action does

| Action | macOS | Windows | Linux |
|---|---|---|---|
| Open app | `open -a <app>` (brings it forward if running) | Start Menu shortcut or Store app via `explorer.exe` | `gtk-launch <id>`, else the app's `Exec` line |
| Shortcut | System Events `keystroke` / `key code` | `SendInput` from a background PowerShell helper | X11 `xdotool key`; Wayland `wtype` or `ydotool` |
| Shortcut "in app" | opens/activates the app first | raises its window (starts it if not running) | X11: `xdotool windowactivate` by window class, else starts it. Wayland: not possible, keys go to the app in front |
| Type text | `keystroke` (long text in chunks) | Unicode `SendInput` | `xdotool type` / `wtype` / `ydotool type` |
| Command in terminal | new Terminal (or iTerm) window | Windows Terminal, else a `cmd` window (`powershell`/`pwsh` if configured) | `$TERMINAL`, then x-terminal-emulator, gnome-terminal, konsole, kitty, alacritty, wezterm, xfce4-terminal, xterm |
| Command in background | your login shell (`$SHELL -lc`) | `cmd.exe` (or PowerShell if configured) | your login shell (`$SHELL -lc`) |
| Link | `open <url>` | `url.dll` file protocol handler | `xdg-open` |
| File or folder | `open` / `open -a <app>` | default app, or the app's exe | `xdg-open`, or the app's `Exec` line |
| Macro | runs the steps in order, waiting after each; stops at the first failing step |||

A background command runs in the key's folder, or the page's project folder, or else your home
folder. It returns the exit code and the last 8000 characters of output. If it's still going when
its timeout runs out (120 seconds unless the key sets another), it's stopped along with everything
it started. A nonzero exit code is shown to you, not treated as an error.

A terminal command opens a window in the folder, runs, and leaves the window open.

## Known limits

On Wayland the agent can't tell which app is in front, so focus tracking is off, and it can't
bring a window forward before sending a shortcut. wtype doesn't work on GNOME; use ydotool there.

Letter and punctuation shortcuts go out as characters on macOS and X11, and as US-layout key
positions on Windows and with ydotool. On a non-US layout, a few punctuation shortcuts may land on
a different key.

On Windows, "open with" works for apps whose Start Menu shortcut points at an `.exe`. Store apps
and some Office installs open the file in its default app instead, and the agent logs that it did.
Shortcuts can't reach apps running as administrator, as described above. Terminal commands run from
a small batch file, so `%` behaves as it does in a `.cmd` script: write `%%` for a literal percent
sign. Some Store apps show no icon, when Windows has no logo for them.

On macOS, background commands use a login shell, which reads `~/.zprofile` but not `~/.zshrc`. If a
command can't find a tool, move your PATH changes (nvm, pyenv and the like) into `~/.zprofile`.
