/** Small formatting the command's lines share. */
import path from 'node:path';

/**
 * Text from the repo or the agent (labels, device names) with control and format characters
 * removed, so a crafted label can't move the cursor or rewrite earlier lines.
 */
export function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/ {2,}/g, ' ').trim();
}

/** "Pixel 8", "Pixel 8 or iPad mini", "Pixel 8, iPad mini or Pixel 9". */
export function listWords(names: readonly string[]): string {
  const shown = names.map(printable);
  if (shown.length <= 1) return shown[0] ?? '';
  return `${shown.slice(0, -1).join(', ')} or ${shown[shown.length - 1]}`;
}

/** "11:58", local time. */
export function clockTime(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** "0:12", "1:00". */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const TERMINAL_NAMES: Record<string, string> = {
  Apple_Terminal: 'Terminal',
  'iTerm.app': 'iTerm',
  vscode: 'VS Code',
  WarpTerminal: 'Warp',
  ghostty: 'Ghostty',
  WezTerm: 'WezTerm',
};

/** "Terminal · zsh", from TERM_PROGRAM and SHELL, for the phone's sheet; null when neither is known. */
export function startedIn(env: NodeJS.ProcessEnv): string | null {
  const terminal = env.TERM_PROGRAM ? (TERMINAL_NAMES[env.TERM_PROGRAM] ?? env.TERM_PROGRAM.replace(/\.app$/, '')) : null;
  const shell = env.SHELL ? path.basename(env.SHELL) : null;
  const parts = [terminal, shell].filter((part): part is string => !!part).map(printable);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One argument as a POSIX shell would need it typed. */
export function shellQuote(arg: string): string {
  if (SHELL_SAFE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}

/** A git remote without a user name or password: "https://github.com/acme/api.git". */
export function remoteWithoutCredentials(remote: string): string {
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/** "acme/api" from "git@github.com:acme/api.git" or "https://github.com/acme/api"; null when there's no such path. */
export function repoSlug(remote: string): string | null {
  const match = /[:/]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/.exec(remoteWithoutCredentials(remote));
  return match ? match[1]! : null;
}

/** A path as the person would type it from `cwd`: ".env", ".authdeck/acme-api.env", "../x/.env". */
export function shownPath(cwd: string, target: string): string {
  const relative = path.relative(cwd, target);
  return relative === '' ? '.' : relative;
}
