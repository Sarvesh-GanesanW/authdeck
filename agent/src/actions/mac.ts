import type { Modifier, NamedKey } from '../protocol';
import { FOCUS_SETTLE_MS, type OsStep } from '../plan';
import { expectApp, posixShell, type PlatformActions } from './context';
import { MAC_KEY_CODES, MAC_MODIFIERS, mapModifiers } from './keys';
import { shQuote } from './quote';
import { isPrintableKey } from './validate';

/** keystroke handles this many characters per call reliably; longer text is split. */
export const KEYSTROKE_CHUNK = 100;

/**
 * AppleScript that osascript reads from stdin, with no arguments, so nothing in it shows in `ps`.
 * User data goes in only through appleScriptText (code points), so it cannot change the script.
 */
export function osascript(lines: readonly string[], purpose: string, failure: 'mac-keystrokes' | 'mac-terminal'): OsStep {
  return { kind: 'run', cmd: 'osascript', args: [], input: `${lines.join('\n')}\n`, purpose, failure };
}

/**
 * AppleScript text value built from Unicode code points only (`character id {72, 105}`), so the
 * script source holds nothing but digits and no text can change it.
 */
export function appleScriptText(text: string): string {
  return `(character id {${Array.from(text, (char) => char.codePointAt(0)).join(', ')}})`;
}

/**
 * Lines that put each text in a variable, to go before any tell block: inside one, `character id
 * {…}` is sent to the application to resolve, and System Events can't (-1728), so nothing typed.
 */
export function textVariables(texts: readonly string[]): { lines: string[]; names: string[] } {
  const names = texts.map((_, index) => `authdeckText${index + 1}`);
  return { lines: texts.map((text, index) => `set ${names[index]} to ${appleScriptText(text)}`), names };
}

function usingClause(modifiers: readonly Modifier[]): string {
  const names = mapModifiers(modifiers, MAC_MODIFIERS);
  return names.length > 0 ? ` using {${names.join(', ')}}` : '';
}

export function chunkText(text: string, size: number): string[] {
  const chars = Array.from(text); // never split a surrogate pair
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) chunks.push(chars.slice(i, i + size).join(''));
  return chunks;
}

export const macActions: PlatformActions = {
  launch(app) {
    const mac = expectApp(app, 'macos');
    return [{ kind: 'run', cmd: 'open', args: ['-a', mac.bundlePath], purpose: `open ${mac.entry.name}`, failure: 'plain' }];
  },

  focus(app, ctx) {
    // `open -a` brings a running app forward and starts it otherwise.
    return [...macActions.launch(app, ctx), { kind: 'wait', ms: FOCUS_SETTLE_MS }];
  },

  hotkey(modifiers, key) {
    const using = usingClause(modifiers);
    if (!isPrintableKey(key)) {
      const press = `key code ${MAC_KEY_CODES[key as NamedKey]}${using}`;
      return [osascript(['tell application "System Events"', press, 'end tell'], 'press the keys', 'mac-keystrokes')];
    }
    const { lines, names } = textVariables([key]);
    return [osascript([...lines, 'tell application "System Events"', `keystroke ${names[0]}${using}`, 'end tell'], 'press the keys', 'mac-keystrokes')];
  },

  text(text, pressEnter) {
    const { lines, names } = textVariables(chunkText(text, KEYSTROKE_CHUNK));
    const presses = names.map((name) => `keystroke ${name}`);
    if (pressEnter) presses.push(`key code ${MAC_KEY_CODES.enter}`);
    return [osascript([...lines, 'tell application "System Events"', ...presses, 'end tell'], 'type the text', 'mac-keystrokes')];
  },

  terminal(command, cwd, ctx) {
    const { lines, names } = textVariables([`cd ${shQuote(cwd)} && ${command}`]);
    const shellLine = names[0];
    const tellLines =
      ctx.terminal === 'iTerm'
        ? [
            'tell application "iTerm"',
            'set newWindow to (create window with default profile)',
            `tell current session of newWindow to write text ${shellLine}`,
            'activate',
            'end tell',
          ]
        : ['tell application "Terminal"', `do script ${shellLine}`, 'activate', 'end tell'];
    return [osascript([...lines, ...tellLines], `open ${ctx.terminal}`, 'mac-terminal')];
  },

  url(url) {
    return [{ kind: 'run', cmd: 'open', args: [url], purpose: 'open the link', failure: 'plain' }];
  },

  open(target, withApp) {
    const args = withApp ? ['-a', expectApp(withApp, 'macos').bundlePath, target] : [target];
    return [{ kind: 'run', cmd: 'open', args, purpose: 'open it', failure: 'plain' }];
  },

  background(command, ctx) {
    return { cmd: posixShell(ctx), args: ['-lc', command] };
  },
};
