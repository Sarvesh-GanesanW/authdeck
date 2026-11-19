import type { Modifier, NamedKey } from '../protocol';

// Printable keys are US-layout key positions, as the protocol defines them.

const PUNCTUATION_NAMES = {
  '`': 'grave',
  '-': 'minus',
  '=': 'equal',
  '[': 'bracketleft',
  ']': 'bracketright',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'apostrophe',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
} as const;

function fKeys<T>(make: (n: number) => T): Record<string, T> {
  return Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i + 1}`, make(i + 1)]));
}

/** AppleScript `key code` values (kVK_* from HIToolbox Events.h). */
export const MAC_KEY_CODES: Record<NamedKey, number> = {
  enter: 36, tab: 48, space: 49, escape: 53, backspace: 51, delete: 117,
  up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
};

export const MAC_MODIFIERS: Record<Modifier, string> = {
  mod: 'command down', meta: 'command down', ctrl: 'control down', alt: 'option down', shift: 'shift down',
};

export const VK_RETURN = 0x0d;

/** Win32 virtual-key codes. */
export const WIN_NAMED_VK: Record<NamedKey, number> = {
  enter: VK_RETURN, tab: 0x09, space: 0x20, escape: 0x1b, backspace: 0x08, delete: 0x2e,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  ...(fKeys((n) => 0x6f + n) as Record<`f${number}`, number>),
} as Record<NamedKey, number>;

/** VK_OEM_* codes for the US layout. */
const WIN_PUNCTUATION_VK: Record<keyof typeof PUNCTUATION_NAMES, number> = {
  '`': 0xc0, '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, '\\': 0xdc, ';': 0xba, "'": 0xde, ',': 0xbc, '.': 0xbe, '/': 0xbf,
};

export const WIN_MODIFIER_VK: Record<Modifier, number> = {
  mod: 0x11, ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b, // VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN
};

export function winKeyCode(key: string): number {
  const named = WIN_NAMED_VK[key as NamedKey];
  if (named !== undefined) return named;
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  return lookup(WIN_PUNCTUATION_VK, key);
}

/** X keysym names, used by xdotool and wtype. */
export const X_NAMED_KEYSYMS: Record<NamedKey, string> = {
  enter: 'Return', tab: 'Tab', space: 'space', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
  ...(fKeys((n) => `F${n}`) as Record<`f${number}`, string>),
} as Record<NamedKey, string>;

export function xKeysym(key: string): string {
  const named = X_NAMED_KEYSYMS[key as NamedKey];
  if (named !== undefined) return named;
  if (/^[a-z0-9]$/.test(key)) return key;
  return lookup(PUNCTUATION_NAMES, key);
}

export const XDOTOOL_MODIFIERS: Record<Modifier, string> = { mod: 'ctrl', ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super' };
export const WTYPE_MODIFIERS: Record<Modifier, string> = { mod: 'ctrl', ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'logo' };

// Linux evdev key codes, used by ydotool 1.x.
export const EVDEV_KEY_ENTER = 28;

export const EVDEV_NAMED: Record<NamedKey, number> = {
  enter: EVDEV_KEY_ENTER, tab: 15, space: 57, escape: 1, backspace: 14, delete: 111,
  up: 103, down: 108, left: 105, right: 106, home: 102, end: 107, pageup: 104, pagedown: 109,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
  f11: 87, f12: 88, f13: 183, f14: 184, f15: 185, f16: 186, f17: 187, f18: 188, f19: 189, f20: 190,
};

const EVDEV_LETTERS = 'qwertyuiop|asdfghjkl|zxcvbnm';
const EVDEV_ROW_STARTS = [16, 30, 44];
const EVDEV_PUNCTUATION: Record<keyof typeof PUNCTUATION_NAMES, number> = {
  '`': 41, '-': 12, '=': 13, '[': 26, ']': 27, '\\': 43, ';': 39, "'": 40, ',': 51, '.': 52, '/': 53,
};

export const EVDEV_MODIFIERS: Record<Modifier, number> = { mod: 29, ctrl: 29, alt: 56, shift: 42, meta: 125 };

export function evdevKeyCode(key: string): number {
  const named = EVDEV_NAMED[key as NamedKey];
  if (named !== undefined) return named;
  if (/^[1-9]$/.test(key)) return 1 + Number(key); // KEY_1 = 2 … KEY_9 = 10
  if (key === '0') return 11;
  const rows = EVDEV_LETTERS.split('|');
  for (const [row, letters] of rows.entries()) {
    const column = letters.indexOf(key);
    if (column >= 0 && /^[a-z]$/.test(key)) return EVDEV_ROW_STARTS[row]! + column;
  }
  return lookup(EVDEV_PUNCTUATION, key);
}

function lookup<T>(table: Record<string, T>, key: string): T {
  const value = table[key];
  if (value === undefined) throw new Error(`No key mapping for "${key}"`);
  return value;
}

/** Modifiers mapped and deduplicated (mod and meta can map to the same key). */
export function mapModifiers<T>(modifiers: readonly Modifier[], table: Record<Modifier, T>): T[] {
  return [...new Set(modifiers.map((m) => table[m]))];
}
