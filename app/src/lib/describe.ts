/** Human-readable text for actions: keycap sublegends, summaries, accessibility labels. */
import type { Action, HotkeyAction, Modifier, Platform } from '../protocol';

const MAC_GLYPH: Record<Modifier, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘', meta: '⌘' };
const MAC_ORDER: Modifier[] = ['ctrl', 'alt', 'shift', 'mod', 'meta'];
const PC_ORDER: Modifier[] = ['mod', 'ctrl', 'meta', 'alt', 'shift'];

export function modifierName(m: Modifier, platform: Platform): string {
  if (platform === 'macos') {
    return { ctrl: 'Control', alt: 'Option', shift: 'Shift', mod: 'Command', meta: 'Command' }[m];
  }
  const meta = platform === 'windows' ? 'Windows' : 'Super';
  return { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', mod: 'Ctrl', meta }[m];
}

export function modifierGlyph(m: Modifier, platform: Platform): string {
  if (platform === 'macos') return MAC_GLYPH[m];
  return modifierName(m, platform);
}

const NAMED: Record<string, [mac: string, pc: string]> = {
  enter: ['↩', 'Enter'],
  tab: ['⇥', 'Tab'],
  space: ['Space', 'Space'],
  escape: ['esc', 'Esc'],
  backspace: ['⌫', 'Backspace'],
  delete: ['⌦', 'Del'],
  up: ['↑', '↑'],
  down: ['↓', '↓'],
  left: ['←', '←'],
  right: ['→', '→'],
  home: ['↖', 'Home'],
  end: ['↘', 'End'],
  pageup: ['⇞', 'PgUp'],
  pagedown: ['⇟', 'PgDn'],
};

export function keyLabel(key: string, platform: Platform): string {
  const named = NAMED[key];
  if (named) return platform === 'macos' ? named[0] : named[1];
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
  return key.length === 1 ? key.toUpperCase() : key;
}

export function formatHotkey(a: Pick<HotkeyAction, 'modifiers' | 'key'>, platform: Platform): string {
  const mods = [...new Set(a.modifiers.map((m) => (platform === 'macos' && m === 'meta' ? 'mod' : m)))];
  if (platform === 'macos') {
    const ordered = MAC_ORDER.filter((m) => mods.includes(m));
    return ordered.map((m) => MAC_GLYPH[m]).join('') + keyLabel(a.key, platform);
  }
  const ordered = PC_ORDER.filter((m) => mods.includes(m));
  const names = [...new Set(ordered.map((m) => modifierName(m, platform)))];
  return [...names, keyLabel(a.key, platform)].join('+');
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Relative paths open inside the page's project folder; "." is that folder itself. */
function isProjectFolder(p: string): boolean {
  return /^(\.[\\/]*)?$/.test(p.trim());
}

function shortUrl(u: string): string {
  return u.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Short text printed on the key's front edge. */
export function sublegend(action: Action | null, platform: Platform): string {
  if (!action) return '';
  switch (action.type) {
    case 'hotkey':
      return formatHotkey(action, platform);
    case 'command':
      return action.command;
    case 'url':
      return shortUrl(action.url);
    case 'open':
      return isProjectFolder(action.path) ? 'Project folder' : basename(action.path);
    case 'text':
      if (!action.text) return action.pressEnter ? keyLabel('enter', platform) : '';
      return `“${action.text}”`;
    case 'launch':
      return '';
    case 'macro':
      return action.steps.length === 1 ? '1 step' : `${action.steps.length} steps`;
  }
}

/** One line describing what the key does, for menus and screen readers. */
export function summary(action: Action | null, platform: Platform): string {
  if (!action) return 'Does nothing yet';
  switch (action.type) {
    case 'launch':
      return `Opens ${action.appName}`;
    case 'hotkey':
      return `Presses ${formatHotkey(action, platform)}`;
    case 'text':
      return action.text ? (action.pressEnter ? 'Types text and presses Enter' : 'Types text') : 'Presses Enter';
    case 'command':
      return action.mode === 'terminal' ? `Runs ${action.command} in a terminal` : `Runs ${action.command}`;
    case 'url':
      return `Opens ${shortUrl(action.url)}`;
    case 'open':
      return isProjectFolder(action.path) ? 'Opens the project folder' : `Opens ${basename(action.path)}`;
    case 'macro':
      return `Runs ${sublegend(action, platform)}`;
  }
}

/** How long to wait for the agent before giving up on a run. */
export function runTimeoutMs(action: Action): number {
  switch (action.type) {
    case 'command':
      return action.mode === 'background' ? ((action.timeoutSec ?? 120) + 10) * 1000 : 20000;
    case 'macro':
      return action.steps.reduce((t, s) => t + s.delayMs + runTimeoutMs(s.action), 0) + 5000;
    case 'text':
      return 20000 + action.text.length * 30;
    default:
      return 20000;
  }
}

export function platformName(p: Platform): string {
  return p === 'macos' ? 'macOS' : p === 'windows' ? 'Windows' : 'Linux';
}

/** "350 ms", "4.2 s", "1 min 5 s". Number and unit never split across lines. */
export function formatDuration(ms: number): string {
  const nb = '\u00a0';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}${nb}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}${nb}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}${nb}s`;
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec ? `${m}${nb}min ${sec}${nb}s` : `${m}${nb}min`;
}

/** Codes of 6 or more digits split in the middle ("482 913"); Steam's letters and short codes stay whole. */
export function formatOtpCode(code: string): string {
  if (!/^\d{6,}$/.test(code)) return code;
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

/** "GitHub (ada-lovelace)": an account named for menus, banners and screen readers. */
export function accountName(account: { issuer: string; label: string }): string {
  if (account.issuer && account.label) return `${account.issuer} (${account.label})`;
  return account.issuer || account.label || 'Unnamed account';
}

/** "locks in 4 min" for the vault's auto-lock, rounded up so it never claims more time than is left. */
export function locksInText(locksAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((locksAt - now) / 60_000));
  return `locks in ${minutes}\u00a0min`;
}
