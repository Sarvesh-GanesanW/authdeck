import path from 'node:path';
import { expandExecArgs, tokenizeExec } from '../apps/desktopFile';
import type { DesktopApp, InstalledApp } from '../apps/types';
import { AgentError } from '../errors';
import { currentDesktops, linuxSession, type HostContext } from '../host';
import { FOCUS_SETTLE_MS, LAUNCH_SETTLE_MS, type OsStep, type Plan } from '../plan';
import type { Modifier } from '../protocol';
import { missingTool } from '../tools';
import { expectApp, posixShell, type BuildContext, type PlatformActions } from './context';
import {
  EVDEV_KEY_ENTER,
  EVDEV_MODIFIERS,
  WTYPE_MODIFIERS,
  XDOTOOL_MODIFIERS,
  evdevKeyCode,
  mapModifiers,
  xKeysym,
} from './keys';
import { shQuote } from './quote';

const FOCUS_TIMEOUT_MS = 3000;
const XDOTOOL_TYPE_DELAY_MS = '2';

type KeyTool = 'xdotool' | 'wtype' | 'ydotool';

/**
 * The tool that sends keys in this session. X11: xdotool. Wayland: wtype, except on GNOME, whose
 * compositor lacks the virtual-keyboard protocol wtype needs, where ydotool is preferred.
 */
export function pickKeyTool(ctx: HostContext, purpose: string): KeyTool {
  if (linuxSession(ctx.env) === 'x11') {
    if (!ctx.hasTool('xdotool')) throw missingTool('xdotool', purpose);
    return 'xdotool';
  }
  const onGnome = currentDesktops(ctx.env).some((d) => d.toUpperCase() === 'GNOME');
  if (onGnome && ctx.hasTool('ydotool')) return 'ydotool';
  if (ctx.hasTool('wtype')) return 'wtype';
  if (ctx.hasTool('ydotool')) return 'ydotool';
  throw new AgentError(
    'missing_tool',
    `Neither wtype nor ydotool is installed, so AuthDeck can't ${purpose} on this Wayland desktop.`,
    onGnome
      ? 'Install ydotool (sudo apt install ydotool) and start its service: sudo systemctl enable --now ydotool'
      : 'Install wtype with: sudo apt install wtype (or ydotool, then: sudo systemctl enable --now ydotool)',
  );
}

function keyStep(tool: KeyTool, args: string[], purpose: string, input?: string): OsStep {
  return { kind: 'run', cmd: tool, args, purpose, failure: tool, ...(input !== undefined ? { input } : {}) };
}

/**
 * Each tool's "read the text from stdin" form, so typed text never shows in `ps`:
 * `xdotool type --file -`, `wtype -` and `ydotool type --file -` (0.1.8 and 1.x). ydotool turns
 * off backslash escapes for stdin, so the text is typed exactly as sent.
 */
const TYPE_FROM_STDIN_ARGS: Record<KeyTool, string[]> = {
  xdotool: ['type', '--delay', XDOTOOL_TYPE_DELAY_MS, '--file', '-'],
  wtype: ['-'],
  ydotool: ['type', '--file', '-'],
};

export function xdotoolCombo(modifiers: readonly Modifier[], key: string): string {
  return [...mapModifiers(modifiers, XDOTOOL_MODIFIERS), xKeysym(key)].join('+');
}

export function wtypeKeyArgs(modifiers: readonly Modifier[], key: string): string[] {
  const mods = mapModifiers(modifiers, WTYPE_MODIFIERS);
  return [...mods.flatMap((m) => ['-M', m]), '-k', xKeysym(key), ...[...mods].reverse().flatMap((m) => ['-m', m])];
}

/** ydotool 1.x syntax: evdev code:1 presses, code:0 releases. */
export function ydotoolKeyArgs(modifiers: readonly Modifier[], key: string): string[] {
  const codes = [...mapModifiers(modifiers, EVDEV_MODIFIERS), evdevKeyCode(key)];
  return ['key', ...codes.map((c) => `${c}:1`), ...[...codes].reverse().map((c) => `${c}:0`)];
}

/** argv to start a desktop app from its Exec line, optionally with a file. */
export function execArgv(desktop: DesktopApp, file?: string): string[] {
  const argv = expandExecArgs(tokenizeExec(desktop.exec), file);
  if (argv.length === 0) throw new AgentError('failed', `${desktop.name} has no command to start it.`);
  return argv;
}

function detachArgv(argv: string[], purpose: string, cwd?: string): OsStep {
  return { kind: 'detach', cmd: argv[0]!, args: argv.slice(1), purpose, ...(cwd ? { cwd } : {}) };
}

/** Terminal emulators in the order tried, each with how to run a program in it. */
const TERMINALS: { name: string; argv: (shellArgv: string[], cwd: string) => string[] }[] = [
  { name: 'x-terminal-emulator', argv: (cmd) => ['-e', ...cmd] },
  { name: 'gnome-terminal', argv: (cmd, cwd) => [`--working-directory=${cwd}`, '--', ...cmd] },
  { name: 'konsole', argv: (cmd, cwd) => ['--workdir', cwd, '-e', ...cmd] },
  { name: 'kitty', argv: (cmd, cwd) => ['--directory', cwd, ...cmd] },
  { name: 'alacritty', argv: (cmd, cwd) => ['--working-directory', cwd, '-e', ...cmd] },
  { name: 'wezterm', argv: (cmd, cwd) => ['start', '--cwd', cwd, '--', ...cmd] },
  { name: 'xfce4-terminal', argv: (cmd, cwd) => [`--working-directory=${cwd}`, '-x', ...cmd] },
  { name: 'xterm', argv: (cmd) => ['-e', ...cmd] },
];

/** First available terminal: $TERMINAL (with known flags if recognised, else `-e`), then the list above. */
export function terminalArgv(ctx: HostContext, shellArgv: string[], cwd: string): string[] {
  const preferred = ctx.env.TERMINAL;
  if (preferred && ctx.hasTool(preferred)) {
    const known = TERMINALS.find((t) => t.name === path.basename(preferred));
    return [preferred, ...(known ? known.argv(shellArgv, cwd) : ['-e', ...shellArgv])];
  }
  const found = TERMINALS.find((t) => ctx.hasTool(t.name));
  if (!found) {
    throw new AgentError('missing_tool', "No terminal app was found, so AuthDeck can't open a terminal window on this computer.", 'Install one (for example: sudo apt install gnome-terminal) or set the TERMINAL environment variable for the agent.');
  }
  return [found.name, ...found.argv(shellArgv, cwd)];
}

/** Shell argv that cds, runs the command, then stays open as an interactive shell. */
export function terminalShellArgv(ctx: HostContext, command: string, cwd: string): string[] {
  const shell = posixShell(ctx);
  // Separate lines so a trailing `# comment` in the command can't swallow the rest.
  return [shell, '-lc', `cd ${shQuote(cwd)}\n${command}\nexec ${shQuote(shell)} -l`];
}

function launchPlan(app: InstalledApp, ctx: BuildContext): Plan {
  const { desktop, entry } = expectApp(app, 'linux');
  const purpose = `open ${entry.name}`;
  if (ctx.hasTool('gtk-launch')) return [detachArgv(['gtk-launch', desktop.desktopId.replace(/\.desktop$/, '')], purpose)];
  const argv = execArgv(desktop);
  if (desktop.terminal) return [detachArgv(terminalArgv(ctx, argv, ctx.home), purpose)];
  return [detachArgv(argv, purpose)];
}

/** WM_CLASS to look for: StartupWMClass, else the Exec program name. */
export function windowClassFor(desktop: DesktopApp): string {
  return desktop.startupWMClass ?? path.basename(tokenizeExec(desktop.exec)[0] ?? desktop.desktopId.replace(/\.desktop$/, ''));
}

function regexEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const linuxActions: PlatformActions = {
  launch: launchPlan,

  focus(app, ctx) {
    // Wayland has no way for a client to raise another app's window.
    if (linuxSession(ctx.env) === 'wayland' || !ctx.hasTool('xdotool')) return [];
    const { desktop, entry } = expectApp(app, 'linux');
    const activate: OsStep = {
      kind: 'run',
      cmd: 'xdotool',
      args: ['search', '--onlyvisible', '--class', `^${regexEscape(windowClassFor(desktop))}$`, 'windowactivate', '--sync'],
      purpose: `bring ${entry.name} to the front`,
      failure: 'xdotool',
      timeoutMs: FOCUS_TIMEOUT_MS,
    };
    return [
      { kind: 'either', attempts: [[activate], [...launchPlan(app, ctx), { kind: 'wait', ms: LAUNCH_SETTLE_MS }]] },
      { kind: 'wait', ms: FOCUS_SETTLE_MS },
    ];
  },

  hotkey(modifiers, key, ctx) {
    const purpose = 'press the keys';
    const tool = pickKeyTool(ctx, purpose);
    switch (tool) {
      case 'xdotool':
        return [keyStep(tool, ['key', '--clearmodifiers', xdotoolCombo(modifiers, key)], purpose)];
      case 'wtype':
        return [keyStep(tool, wtypeKeyArgs(modifiers, key), purpose)];
      case 'ydotool':
        return [keyStep(tool, ydotoolKeyArgs(modifiers, key), purpose)];
    }
  },

  text(text, pressEnter, ctx) {
    const purpose = 'type the text';
    const tool = pickKeyTool(ctx, purpose);
    const plan: Plan = [];
    if (text !== '') {
      plan.push(keyStep(tool, [...TYPE_FROM_STDIN_ARGS[tool]], purpose, text));
    }
    if (pressEnter) {
      const enterArgs = { xdotool: ['key', 'Return'], wtype: ['-k', 'Return'], ydotool: ['key', `${EVDEV_KEY_ENTER}:1`, `${EVDEV_KEY_ENTER}:0`] }[tool];
      plan.push(keyStep(tool, enterArgs, 'press Enter'));
    }
    return plan;
  },

  terminal(command, cwd, ctx) {
    return [detachArgv(terminalArgv(ctx, terminalShellArgv(ctx, command, cwd), cwd), 'open a terminal window', cwd)];
  },

  url(url, ctx) {
    if (!ctx.hasTool('xdg-open')) throw missingTool('xdg-open', 'open links');
    return [detachArgv(['xdg-open', url], 'open the link')];
  },

  open(target, withApp, ctx) {
    if (withApp) {
      const { desktop, entry } = expectApp(withApp, 'linux');
      return [detachArgv(execArgv(desktop, target), `open it in ${entry.name}`)];
    }
    if (!ctx.hasTool('xdg-open')) throw missingTool('xdg-open', 'open files');
    return [detachArgv(['xdg-open', target], 'open it')];
  },

  background(command, ctx) {
    return { cmd: posixShell(ctx), args: ['-lc', command] };
  },
};
