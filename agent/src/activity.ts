import { validateAction } from './actions/validate';
import type { ActivitySummary } from './events';
import type { Action, Modifier, NamedKey, Platform, StepAction } from './protocol';

export type AppNameLookup = (appId: string) => string | undefined;

const MAC_MODIFIER_ORDER: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'mod', 'meta'];
const MAC_MODIFIER_GLYPHS: Record<Modifier, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘', meta: '⌘' };
const PC_MODIFIER_ORDER: readonly Modifier[] = ['mod', 'ctrl', 'alt', 'shift', 'meta'];

const MAC_NAMED_KEYS: Partial<Record<NamedKey, string>> = {
  enter: '↩', tab: '⇥', escape: '⎋', backspace: '⌫', delete: '⌦', up: '↑', down: '↓', left: '←', right: '→',
};
const PC_NAMED_KEYS: Partial<Record<NamedKey, string>> = {
  escape: 'Esc', backspace: 'Backspace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
};
const COMMON_NAMED_KEYS: Partial<Record<NamedKey, string>> = { space: 'Space', home: 'Home', end: 'End', pageup: 'Page Up', pagedown: 'Page Down', enter: 'Enter', tab: 'Tab' };

function keyName(key: string, platform: Platform): string {
  const named = (platform === 'macos' ? MAC_NAMED_KEYS : PC_NAMED_KEYS)[key as NamedKey] ?? COMMON_NAMED_KEYS[key as NamedKey];
  return named ?? key.toUpperCase();
}

/** ⌥⌘S on macOS, Ctrl+Alt+S elsewhere. */
export function shortcutLabel(modifiers: readonly Modifier[], key: string, platform: Platform): string {
  if (platform === 'macos') {
    const glyphs = [...new Set(MAC_MODIFIER_ORDER.filter((m) => modifiers.includes(m)).map((m) => MAC_MODIFIER_GLYPHS[m]))];
    return `${glyphs.join('')}${keyName(key, platform)}`;
  }
  const metaName = platform === 'windows' ? 'Win' : 'Super';
  const pcNames: Record<Modifier, string> = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: metaName };
  const names = [...new Set(PC_MODIFIER_ORDER.filter((m) => modifiers.includes(m)).map((m) => pcNames[m]))];
  return [...names, keyName(key, platform)].join('+');
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function describeStep(action: StepAction, platform: Platform, appName: AppNameLookup): ActivitySummary {
  switch (action.type) {
    case 'launch':
      return { title: 'Open app', detail: appName(action.appId) ?? (action.appName || 'An app that is no longer installed') };
    case 'hotkey': {
      const keys = shortcutLabel(action.modifiers, action.key, platform);
      const target = action.focusAppId ? appName(action.focusAppId) : undefined;
      return { title: 'Shortcut', detail: target ? `${keys} in ${target}` : keys };
    }
    case 'text': {
      // The device's label names it ("Typed a code for GitHub"); not even the length is shown.
      if (action.secret) return { title: 'Typed a code', detail: action.pressEnter ? 'Hidden, then Enter' : 'Hidden' };
      const typed = action.text.length > 0 ? plural(action.text.length, 'character') : '';
      const detail = [typed, action.pressEnter ? 'Enter' : ''].filter(Boolean).join(', then ');
      return { title: 'Type text', detail };
    }
    case 'command':
      return { title: action.mode === 'terminal' ? 'Command in terminal' : 'Command', detail: action.command };
    case 'url':
      return { title: 'Open link', detail: action.url };
    case 'open': {
      const withApp = action.withAppId ? appName(action.withAppId) : undefined;
      return { title: 'Open', detail: withApp ? `${action.path} in ${withApp}` : action.path };
    }
  }
}

/** Describes an action from a device for the activity list. `raw` is unchecked input from the device. */
export function describeActivity(raw: unknown, platform: Platform, appName: AppNameLookup): ActivitySummary {
  let action: Action;
  try {
    action = validateAction(raw);
  } catch {
    return { title: 'Unreadable action', detail: 'The device sent an action this agent does not understand.' };
  }
  if (action.type !== 'macro') return describeStep(action, platform, appName);
  const steps = action.steps.map((step) => describeStep(step.action, platform, appName).title);
  return { title: 'Macro', detail: `${plural(steps.length, 'step')}: ${steps.join(', ')}` };
}
