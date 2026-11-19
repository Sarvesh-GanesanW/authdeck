import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDesktopValue, quoteExecArg } from '../../../agent/src/apps/desktopFile';
import { runProcess } from '../../../agent/src/proc';
import type { Platform } from '../../../agent/src/protocol';
import { HIDDEN_FLAG } from './launchArguments';

const WINDOWS_RUN_NAME = 'dev.authdeck.agent';
const LINUX_AUTOSTART_NAME = 'authdeck-agent-app.desktop';

/**
 * Sign-in entries made by the app before it was renamed from DevDeck. They are removed whenever
 * the setting changes, so the old and new apps never both start at sign-in.
 */
const LEGACY_APP_NAME = 'DevDeck Agent';
/** The old app never set an AppUserModelId, so Electron named its Run value after this default. */
const LEGACY_WINDOWS_RUN_NAME = `electron.app.${LEGACY_APP_NAME}`;
const LEGACY_LINUX_AUTOSTART_NAME = 'devdeck-agent-app.desktop';
const LEGACY_MAC_APP_DIRS = ['/Applications', path.join(os.homedir(), 'Applications')];
const OSASCRIPT_TIMEOUT_MS = 10_000;

function linuxAutostartFile(name: string): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'autostart', name);
}

/** The AppImage itself when running from one: process.execPath points inside its temporary mount. */
function linuxExecutable(): string {
  return process.env.APPIMAGE || process.execPath;
}

function linuxAutostartEntry(): string {
  const exec = [linuxExecutable(), HIDDEN_FLAG].map(quoteExecArg).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=AuthDeck Agent',
    'Comment=Lets the AuthDeck tablet and phone app control this computer',
    `Exec=${encodeDesktopValue(exec)}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function isStartAtSignInEnabled(platform: Platform): boolean {
  switch (platform) {
    case 'macos':
      return app.getLoginItemSettings().openAtLogin;
    case 'windows':
      return app.getLoginItemSettings({ args: [HIDDEN_FLAG] }).openAtLogin;
    case 'linux':
      return fs.existsSync(linuxAutostartFile(LINUX_AUTOSTART_NAME));
  }
}

/**
 * Only asks System Events when the old app is installed: the first ask shows an automation
 * prompt, which people who never had the old app should not see.
 */
function removeLegacyMacLoginItem(): void {
  const installed = LEGACY_MAC_APP_DIRS.some((dir) => fs.existsSync(path.join(dir, `${LEGACY_APP_NAME}.app`)));
  if (!installed) return;
  const script = `tell application "System Events" to delete (every login item whose name is "${LEGACY_APP_NAME}")`;
  runProcess('osascript', ['-e', script], { timeoutMs: OSASCRIPT_TIMEOUT_MS })
    .then((outcome) => {
      if (outcome.exitCode !== 0) console.error(`Could not remove the old ${LEGACY_APP_NAME} login item: ${outcome.stderr.trim()}. Remove it in System Settings > General > Login Items.`);
    })
    .catch((err: unknown) => console.error(`Could not remove the old ${LEGACY_APP_NAME} login item: ${(err as Error).message}`));
}

function removeLegacyEntry(platform: Platform): void {
  switch (platform) {
    case 'macos':
      removeLegacyMacLoginItem();
      return;
    case 'windows':
      app.setLoginItemSettings({ openAtLogin: false, name: LEGACY_WINDOWS_RUN_NAME });
      return;
    case 'linux':
      fs.rmSync(linuxAutostartFile(LEGACY_LINUX_AUTOSTART_NAME), { force: true });
  }
}

export function setStartAtSignIn(platform: Platform, enabled: boolean): void {
  removeLegacyEntry(platform);
  switch (platform) {
    case 'macos':
      app.setLoginItemSettings({ openAtLogin: enabled });
      return;
    case 'windows':
      app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_FLAG], name: WINDOWS_RUN_NAME });
      return;
    case 'linux': {
      const file = linuxAutostartFile(LINUX_AUTOSTART_NAME);
      if (!enabled) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, linuxAutostartEntry(), 'utf8');
    }
  }
}

/** macOS login items can't pass arguments, so a sign-in launch there is detected instead. */
export function startedHidden(platform: Platform): boolean {
  if (process.argv.includes(HIDDEN_FLAG)) return true;
  return platform === 'macos' && app.getLoginItemSettings().wasOpenedAtLogin === true;
}
