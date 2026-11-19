import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDesktopValue, quoteExecArg } from './apps/desktopFile';
import { vbsQuote } from './actions/quote';
import type { Platform } from './protocol';
import { runProcess } from './proc';
import { findExecutable } from './which';

const LAUNCH_AGENT_LABEL = 'dev.authdeck.agent.cli';
const WINDOWS_STARTUP_NAME = 'AuthDeck Agent.vbs';
const LINUX_AUTOSTART_NAME = 'authdeck-agent.desktop';

/** Sign-in files the agent wrote before it was renamed from DevDeck. */
const LEGACY_NAMES: Record<Platform, string> = {
  macos: 'com.devdeck.agent.plist',
  windows: 'DevDeck Agent.vbs',
  linux: 'devdeck-agent.desktop',
};

export interface AutostartTarget {
  /** Absolute path of node. */
  node: string;
  /** Absolute path of the agent script. */
  script: string;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function launchAgentPlist(target: AutostartTarget, logFile: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(target.node)}</string>
    <string>${xmlEscape(target.script)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
}

/** VBScript that starts the agent with no console window (window style 0). */
export function windowsStartupScript(target: AutostartTarget): string {
  const commandLine = `"${target.node}" "${target.script}"`;
  return `' AuthDeck agent: started at sign-in. Delete this file (or run: authdeck-agent autostart disable) to stop.\r\nCreateObject("WScript.Shell").Run ${vbsQuote(commandLine)}, 0, False\r\n`;
}

export function linuxAutostartDesktop(target: AutostartTarget): string {
  const exec = [target.node, target.script].map(quoteExecArg).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=AuthDeck Agent',
    'Comment=Lets the AuthDeck tablet app control this computer',
    `Exec=${encodeDesktopValue(exec)}`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function autostartDir(platform: Platform, home: string, env: NodeJS.ProcessEnv): string {
  switch (platform) {
    case 'macos':
      return path.join(home, 'Library', 'LaunchAgents');
    case 'windows':
      return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    case 'linux':
      return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart');
  }
}

function joinFor(platform: Platform, dir: string, name: string): string {
  return platform === 'windows' ? path.win32.join(dir, name) : path.join(dir, name);
}

export function autostartFile(platform: Platform, home: string, env: NodeJS.ProcessEnv): string {
  const names: Record<Platform, string> = { macos: `${LAUNCH_AGENT_LABEL}.plist`, windows: WINDOWS_STARTUP_NAME, linux: LINUX_AUTOSTART_NAME };
  return joinFor(platform, autostartDir(platform, home, env), names[platform]);
}

/** Where the pre-rename agent put its sign-in file; removed whenever autostart changes so only one agent starts. */
export function legacyAutostartFile(platform: Platform, home: string, env: NodeJS.ProcessEnv): string {
  return joinFor(platform, autostartDir(platform, home, env), LEGACY_NAMES[platform]);
}

/** Deletes the file only: an old agent that launchd already started keeps running until sign-out. */
function removeLegacyAutostart(platform: Platform): void {
  fs.rmSync(legacyAutostartFile(platform, os.homedir(), process.env), { force: true });
}

/** The running agent, if it can be started on its own (i.e. the built single file, not the TypeScript source). */
export function currentTarget(): AutostartTarget {
  const script = path.resolve(process.argv[1] ?? '');
  if (!/\.(c?js|mjs)$/.test(script)) {
    throw new Error('Autostart needs the built agent. Run `npm run build`, then: node dist/authdeck-agent.cjs autostart enable');
  }
  return { node: stableNodePath(process.execPath), script };
}

/**
 * process.execPath can be a versioned path (e.g. Homebrew's .../Cellar/node/22.1.0/bin/node) that
 * disappears on upgrade. Prefer the `node` on PATH when it is the same binary.
 */
function stableNodePath(execPath: string): string {
  const onPath = findExecutable('node');
  if (!onPath || onPath === execPath) return execPath;
  try {
    return fs.realpathSync(onPath) === fs.realpathSync(execPath) ? onPath : execPath;
  } catch {
    return execPath;
  }
}

export async function enableAutostart(platform: Platform, authdeckHome: string): Promise<string> {
  const target = currentTarget();
  removeLegacyAutostart(platform);
  const file = autostartFile(platform, os.homedir(), process.env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content =
    platform === 'macos'
      ? launchAgentPlist(target, path.join(authdeckHome, 'agent.log'))
      : platform === 'windows'
        ? windowsStartupScript(target)
        : linuxAutostartDesktop(target);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

export async function disableAutostart(platform: Platform): Promise<string | null> {
  removeLegacyAutostart(platform);
  const file = autostartFile(platform, os.homedir(), process.env);
  if (platform === 'macos') {
    // Stops a launchd-started agent; fails harmlessly when none is loaded.
    await runProcess('launchctl', ['bootout', `gui/${os.userInfo().uid}/${LAUNCH_AGENT_LABEL}`], { timeoutMs: 10_000 }).catch(() => null);
  }
  if (!fs.existsSync(file)) return null;
  fs.rmSync(file);
  return file;
}
