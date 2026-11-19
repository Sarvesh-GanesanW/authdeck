/**
 * Pure rules for the key editor: action kinds, starting values, what makes an action
 * incomplete, and small helpers for apps and paths. No React, no I/O.
 */
import type { AccountView } from '../../auth/contract';
import type { Action, AppEntry, MacroStep, StepAction } from '../../protocol';
import type { DeckKey } from '../../state/model';
import { otpGlyph, otpKeyLabel } from '../../state/templates';
import type { GlyphName } from '../../ui/Icon';

export type ActionKind = Action['type'];
export type StepKind = StepAction['type'];

export const DEFAULT_TIMEOUT_SEC = 120;
export const MAX_TIMEOUT_SEC = 3600;
export const DEFAULT_STEP_DELAY_MS = 150;
export const MAX_STEP_DELAY_MS = 60000;

interface KindInfo<K extends string> {
  value: K;
  label: string;
  icon: GlyphName;
}

export const STEP_KINDS: KindInfo<StepKind>[] = [
  { value: 'launch', label: 'Open app', icon: 'app-windows' },
  { value: 'hotkey', label: 'Press keys', icon: 'keyboard' },
  { value: 'command', label: 'Run command', icon: 'terminal' },
  { value: 'url', label: 'Open link', icon: 'globe' },
  { value: 'open', label: 'Open file or folder', icon: 'folder' },
  { value: 'text', label: 'Type text', icon: 'text-cursor' },
];

export const ACTION_KINDS: KindInfo<ActionKind>[] = [...STEP_KINDS, { value: 'macro', label: 'Sequence', icon: 'bulletlist' }];

/** What a key can do: run an action, or show and type a 2FA code. */
export type KeyKind = ActionKind | 'otp';
export const KEY_KINDS: KindInfo<KeyKind>[] = [...ACTION_KINDS, { value: 'otp', label: '2FA code', icon: 'lock' }];

export function keyKind(key: DeckKey): KeyKind | null {
  if (key.otp) return 'otp';
  return key.action?.type ?? null;
}

export function defaultStepAction(kind: StepKind): StepAction {
  switch (kind) {
    case 'launch':
      return { type: 'launch', appId: '', appName: '' };
    case 'hotkey':
      return { type: 'hotkey', modifiers: ['mod'], key: '' };
    case 'text':
      return { type: 'text', text: '', pressEnter: false };
    case 'command':
      return { type: 'command', command: '', mode: 'terminal' };
    case 'url':
      return { type: 'url', url: '' };
    case 'open':
      return { type: 'open', path: '' };
  }
}

export function newStep(): MacroStep {
  return { action: defaultStepAction('hotkey'), delayMs: DEFAULT_STEP_DELAY_MS };
}

export function defaultAction(kind: ActionKind): Action {
  if (kind === 'macro') return { type: 'macro', steps: [newStep()] };
  return defaultStepAction(kind);
}

// A scheme, but not host:port (localhost:3000 has no scheme).
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i;
const LOOKS_LIKE_HOST = /^(localhost|[\w-]+(\.[\w-]+)+|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i;

/** For a url without a scheme that looks like a web address, the same url with https:// added. */
export function urlWithScheme(url: string): string | null {
  const u = url.trim();
  if (!u || URL_SCHEME.test(u) || !LOOKS_LIKE_HOST.test(u)) return null;
  return `${u.startsWith('localhost') || /^\d/.test(u) ? 'http' : 'https'}://${u}`;
}

/** What still has to be filled in before the action can run, or null when it is complete. */
export function actionProblem(action: Action): string | null {
  switch (action.type) {
    case 'launch':
      return action.appId ? null : 'Choose an app to open.';
    case 'hotkey':
      return action.key ? null : 'Choose the key to press.';
    case 'text':
      return action.text || action.pressEnter ? null : 'Type the text to send, or turn on Press Enter after.';
    case 'command':
      return action.command.trim() ? null : 'Type the command to run.';
    case 'url': {
      const u = action.url.trim();
      if (!u) return 'Type the address to open.';
      if (/\s/.test(u)) return 'Addresses cannot contain spaces.';
      if (!URL_SCHEME.test(u)) return 'Start the address with https:// (or another scheme such as mailto:).';
      return null;
    }
    case 'open':
      return action.path.trim() ? null : 'Choose a file or folder to open.';
    case 'macro': {
      if (action.steps.length === 0) return 'Add at least one step.';
      const bad = action.steps.findIndex((s) => actionProblem(s.action) !== null);
      return bad < 0 ? null : `Step ${bad + 1}: ${actionProblem(action.steps[bad]!.action)}`;
    }
  }
}

/** A key the user never really set up: removed when the editor closes. */
export function isBlankKey(key: DeckKey): boolean {
  if (key.otp?.accountId) return false;
  const unsetAction = key.action === null || actionProblem(key.action) !== null;
  return key.label.trim() === '' && key.icon.kind === 'none' && unsetAction;
}

/** The app whose icon the key may show: the launched app, or the open-with app. */
export function iconAppOf(action: Action | null): string | null {
  if (action?.type === 'launch') return action.appId || null;
  if (action?.type === 'open') return action.withAppId ?? null;
  return null;
}

/**
 * Picking a launch app also names the key and shows the app's icon,
 * unless the user already chose their own label or icon.
 */
export function withLaunchApp(key: DeckKey, app: AppEntry): DeckKey {
  const prev = key.action?.type === 'launch' ? key.action : null;
  const labelIsAuto = key.label.trim() === '' || (prev !== null && key.label === prev.appName);
  const iconIsAuto = key.icon.kind === 'none' || (key.icon.kind === 'app' && prev !== null && key.icon.appId === prev.appId);
  return {
    ...key,
    label: labelIsAuto ? app.name : key.label,
    icon: iconIsAuto ? { kind: 'app', appId: app.id } : key.icon,
    action: { type: 'launch', appId: app.id, appName: app.name },
  };
}

/** Readable name for an app id when the app list is not available (offline, or app removed). */
export function appNameFromId(id: string): string {
  if (id.startsWith('win:aumid:')) {
    // e.g. Microsoft.WindowsTerminal_8wekyb3d8bbwe!App -> WindowsTerminal
    const family = id
      .slice('win:aumid:'.length)
      .split('!')[0]!
      .replace(/_[a-z0-9]+$/i, '');
    return family.split('.').pop() || id;
  }
  const tail =
    id
      .replace(/^(mac|win:lnk|linux):/, '')
      .split(/[\\/]/)
      .pop() ?? id;
  return tail.replace(/\.(app|lnk|desktop)$/i, '') || id;
}

export interface Crumb {
  name: string;
  path: string;
}

/** Breadcrumbs for an absolute path, root first. Works for / and \ separators (C:\, \\server\share). */
export function breadcrumbs(path: string, sep: '/' | '\\'): Crumb[] {
  if (sep === '/') {
    const parts = path.split('/').filter(Boolean);
    const crumbs: Crumb[] = [{ name: '/', path: '/' }];
    parts.forEach((p, i) => crumbs.push({ name: p, path: '/' + parts.slice(0, i + 1).join('/') }));
    return crumbs;
  }
  const unc = path.startsWith('\\\\');
  const parts = path.split('\\').filter(Boolean);
  const rootParts = unc ? 2 : 1;
  const root = (unc ? '\\\\' : '') + parts.slice(0, rootParts).join('\\') + '\\';
  const crumbs: Crumb[] = [{ name: parts.slice(0, rootParts).join('\\') || root, path: root }];
  for (let i = rootParts; i < parts.length; i++) {
    crumbs.push({ name: parts[i]!, path: root + parts.slice(rootParts, i + 1).join('\\') });
  }
  return crumbs;
}

/** Normalised text for matching "git branch" against "git-branch" or "GitBranch". */
export function searchable(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Parses a whole number typed by the user; null when it is not one or is out of range. */
export function parseWhole(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= min && n <= max ? n : null;
}

/**
 * Pointing a 2FA key at an account also names the key after it and gives it the account's
 * symbol, unless the user chose their own label or icon.
 */
export function withOtpAccount(key: DeckKey, account: AccountView, previous: AccountView | undefined): DeckKey {
  const label = key.label.trim();
  const labelIsAuto = label === '' || (previous !== undefined && label === otpKeyLabel(previous));
  const iconIsAuto = key.icon.kind === 'none' || (previous !== undefined && key.icon.kind === 'glyph' && key.icon.name === otpGlyph(previous));
  return {
    ...key,
    label: labelIsAuto ? otpKeyLabel(account) : key.label,
    icon: iconIsAuto ? { kind: 'glyph', name: otpGlyph(account) } : key.icon,
    action: null,
    otp: { accountId: account.id },
  };
}
