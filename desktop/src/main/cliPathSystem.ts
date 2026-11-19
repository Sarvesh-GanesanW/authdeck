/** The real file system, macOS admin prompt and Windows user PATH behind cliPath.ts. */
import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ENV_CLI_NAME } from '../../../agent/src/envSocketContract';
import type { Platform } from '../shared/state';
import { CliPathCancelled, CliPathError, type CliFiles, type CliLayout, type CliSystem, type MacAdmin, type UserPathStore } from './cliPath';

const run = promisify(execFile);
const PROMPT_TIMEOUT_MS = 5 * 60_000;
const POWERSHELL_TIMEOUT_MS = 30_000;
/** osascript's exit text when the person cancels the password prompt. */
const USER_CANCELED = '(-128)';
const LINUX_DATA_DIR = 'authdeck-agent';

const files: CliFiles = {
  exists: (file) => fs.existsSync(file) || isLink(file),
  readLink(file) {
    try {
      return fs.readlinkSync(file);
    } catch {
      return null;
    }
  },
  readText(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  writeExecutable(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  },
  symlink: (target, file) => fs.symlinkSync(target, file),
  remove: (file) => fs.rmSync(file, { force: true }),
};

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The paths travel as osascript arguments, quoted by AppleScript itself, never pasted into the script. */
const MAC_LINK_SCRIPT = [
  'on run argv',
  'set target to item 1 of argv',
  'set linkFile to item 2 of argv',
  'set binDir to item 3 of argv',
  'do shell script "/bin/mkdir -p " & quoted form of binDir & " && /bin/ln -sfn " & quoted form of target & " " & quoted form of linkFile with prompt "AuthDeck Agent wants to put the authdeck command in " & binDir & "." with administrator privileges',
  'end run',
];
const MAC_UNLINK_SCRIPT = [
  'on run argv',
  'set linkFile to item 1 of argv',
  'do shell script "/bin/rm -f " & quoted form of linkFile with prompt "AuthDeck Agent wants to remove the authdeck command from " & linkFile & "." with administrator privileges',
  'end run',
];

async function osascript(lines: string[], args: string[]): Promise<void> {
  try {
    await run('osascript', [...lines.flatMap((line) => ['-e', line]), ...args], { timeout: PROMPT_TIMEOUT_MS });
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '');
    if (stderr.includes(USER_CANCELED)) throw new CliPathCancelled();
    throw new CliPathError(`macOS did not allow the change: ${stderr.trim() || (err as Error).message}`, 'Try again, and enter an administrator password when asked.');
  }
}

const macAdmin: MacAdmin = {
  link: (target, file) => osascript(MAC_LINK_SCRIPT, [target, file, path.dirname(file)]),
  unlink: (file) => osascript(MAC_UNLINK_SCRIPT, [file]),
};

/**
 * Reads and writes HKCU\Environment\Path as REG_EXPAND_SZ without expanding it, so entries like
 * %USERPROFILE%\bin survive. Clearing a dummy user variable afterwards makes Windows broadcast
 * the change, so terminals opened from now on see it. The value travels in an environment
 * variable, never inside the script.
 */
const READ_USER_PATH = "(Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')";
const WRITE_USER_PATH = [
  "Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value $env:AUTHDECK_USER_PATH -Type ExpandString",
  "[Environment]::SetEnvironmentVariable('AUTHDECK_PATH_CHANGED', $null, 'User')",
].join('; ');

async function powershell(script: string, extraEnv: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: POWERSHELL_TIMEOUT_MS,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
    throw new CliPathError(`Could not change your PATH: ${stderr || (err as Error).message}`, 'Try again. You can also add the folder in Settings > System > About > Advanced system settings > Environment Variables.');
  }
}

const userPath: UserPathStore = {
  read: async () => (await powershell(READ_USER_PATH)).replace(/\r?\n$/, ''),
  write: async (value) => {
    await powershell(WRITE_USER_PATH, { AUTHDECK_USER_PATH: value });
  },
};

export const cliSystem: CliSystem = { files, admin: macAdmin, userPath };

/**
 * The packaged app keeps the command in resources/cli. Null under `npm start`: the wrappers find
 * the runtime relative to an installed app, so a link made from a development build would break.
 */
export function cliLayout(platform: Platform): CliLayout | null {
  if (!app.isPackaged) return null;
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return {
    platform,
    name: ENV_CLI_NAME,
    cliDir: path.join(process.resourcesPath, 'cli'),
    home,
    executable: process.env.APPIMAGE || process.execPath,
    appImage: !!process.env.APPIMAGE,
    dataDir: path.join(dataHome, LINUX_DATA_DIR),
    envPath: process.env.PATH ?? '',
  };
}
