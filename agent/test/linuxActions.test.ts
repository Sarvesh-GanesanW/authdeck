import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  execArgv,
  linuxActions,
  pickKeyTool,
  terminalArgv,
  terminalShellArgv,
  windowClassFor,
  wtypeKeyArgs,
  xdotoolCombo,
  ydotoolKeyArgs,
} from '../src/actions/linux';
import { AgentError } from '../src/errors';
import type { OsStep } from '../src/plan';
import { buildContext, linuxCode } from './helpers/context';

const x11 = (tools: string[] = ['xdotool', 'xdg-open', 'gtk-launch'], env: NodeJS.ProcessEnv = { XDG_SESSION_TYPE: 'x11', SHELL: '/bin/bash' }) =>
  buildContext('linux', { tools: [...tools, '/bin/bash'], env });
const wayland = (tools: string[], desktop = 'KDE') => buildContext('linux', { tools, env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: desktop } });

function args(step: OsStep | undefined): string[] {
  assert.ok(step && (step.kind === 'run' || step.kind === 'detach'));
  return [step.cmd, ...step.args];
}

describe('Linux key mapping', () => {
  it('builds xdotool combos with X keysyms', () => {
    assert.equal(xdotoolCombo(['mod', 'shift'], 't'), 'ctrl+shift+t');
    assert.equal(xdotoolCombo(['meta'], 'pagedown'), 'super+Next');
    assert.equal(xdotoolCombo(['alt'], 'enter'), 'alt+Return');
    assert.equal(xdotoolCombo([], '`'), 'grave');
    assert.equal(xdotoolCombo(['ctrl'], '/'), 'ctrl+slash');
    assert.equal(xdotoolCombo([], 'backspace'), 'BackSpace');
    assert.equal(xdotoolCombo([], 'f20'), 'F20');
  });

  it('builds wtype press/release args', () => {
    assert.deepEqual(wtypeKeyArgs(['mod', 'shift'], 'p'), ['-M', 'ctrl', '-M', 'shift', '-k', 'p', '-m', 'shift', '-m', 'ctrl']);
    assert.deepEqual(wtypeKeyArgs(['meta'], 'escape'), ['-M', 'logo', '-k', 'Escape', '-m', 'logo']);
    assert.deepEqual(wtypeKeyArgs([], ']'), ['-k', 'bracketright']);
  });

  it('builds ydotool evdev codes, releasing in reverse order', () => {
    assert.deepEqual(ydotoolKeyArgs(['mod', 'shift'], 't'), ['key', '29:1', '42:1', '20:1', '20:0', '42:0', '29:0']);
    assert.deepEqual(ydotoolKeyArgs([], 'a'), ['key', '30:1', '30:0']);
    assert.deepEqual(ydotoolKeyArgs([], 'm'), ['key', '50:1', '50:0']);
    assert.deepEqual(ydotoolKeyArgs([], '0'), ['key', '11:1', '11:0']);
    assert.deepEqual(ydotoolKeyArgs([], '1'), ['key', '2:1', '2:0']);
    assert.deepEqual(ydotoolKeyArgs(['meta'], 'f12'), ['key', '125:1', '88:1', '88:0', '125:0']);
    assert.deepEqual(ydotoolKeyArgs([], ';'), ['key', '39:1', '39:0']);
  });
});

describe('Linux key tool choice', () => {
  it('uses xdotool on X11 and says how to install it when missing', () => {
    assert.equal(pickKeyTool(x11(), 'press the keys'), 'xdotool');
    assert.throws(
      () => pickKeyTool(x11([]), 'press the keys'),
      (err: AgentError) =>
        err.code === 'missing_tool' &&
        err.message === "xdotool is not installed, so AuthDeck can't press the keys on this computer." &&
        err.hint!.startsWith('Install it with: sudo apt install xdotool'),
    );
  });

  it('prefers wtype on Wayland, but ydotool on GNOME', () => {
    assert.equal(pickKeyTool(wayland(['wtype', 'ydotool']), 'x'), 'wtype');
    assert.equal(pickKeyTool(wayland(['wtype', 'ydotool'], 'ubuntu:GNOME'), 'x'), 'ydotool');
    assert.equal(pickKeyTool(wayland(['wtype'], 'ubuntu:GNOME'), 'x'), 'wtype');
    assert.equal(pickKeyTool(wayland(['ydotool']), 'x'), 'ydotool');
  });

  it('treats WAYLAND_DISPLAY as Wayland even without XDG_SESSION_TYPE', () => {
    assert.equal(pickKeyTool(buildContext('linux', { tools: ['wtype', 'xdotool'], env: { WAYLAND_DISPLAY: 'wayland-0' } }), 'x'), 'wtype');
  });

  it('reports missing_tool naming both Wayland tools', () => {
    assert.throws(() => pickKeyTool(wayland([]), 'press the keys'), (err: AgentError) => err.code === 'missing_tool' && /wtype nor ydotool/.test(err.message) && /apt install/.test(err.hint!));
  });
});

describe('Linux action builders', () => {
  it('launches with gtk-launch and the desktop id', () => {
    assert.deepEqual(args(linuxActions.launch(linuxCode, x11())[0]), ['gtk-launch', 'code']);
  });

  it('launches from Exec with field codes removed when gtk-launch is missing', () => {
    assert.deepEqual(args(linuxActions.launch(linuxCode, x11(['xdotool']))[0]), ['/usr/share/code/code', '--unity-launch']);
  });

  it('launches Terminal=true apps inside a terminal when gtk-launch is missing', () => {
    const htop = { ...linuxCode, desktop: { ...(linuxCode as { desktop: object }).desktop, exec: 'htop', terminal: true } } as typeof linuxCode;
    assert.deepEqual(args(linuxActions.launch(htop, x11(['xterm']))[0]), ['xterm', '-e', 'htop']);
  });

  it('focuses by WM class with xdotool once a window is found, never launching the app', () => {
    const plan = linuxActions.focus(linuxCode, x11(), 0);
    assert.deepEqual(plan[0], {
      kind: 'requireOpen',
      appName: 'Visual Studio Code',
      probe: { kind: 'run', cmd: 'xdotool', args: ['search', '--onlyvisible', '--class', '^Code$'], purpose: "find Visual Studio Code's window", failure: 'xdotool' },
      waitMs: 0,
    });
    assert.deepEqual(args(plan[1]), ['xdotool', 'search', '--onlyvisible', '--class', '^Code$', 'windowactivate', '--sync']);
    assert.deepEqual(plan[2], { kind: 'wait', ms: 150 });
    assert.equal(plan.length, 3);
  });

  it('escapes regex characters in the WM class and falls back to the Exec name', () => {
    const app = { ...linuxCode, desktop: { ...(linuxCode as { desktop: object }).desktop, startupWMClass: null, exec: '/opt/my.app/run+me %U' } } as typeof linuxCode;
    assert.equal(windowClassFor((app as { desktop: Parameters<typeof windowClassFor>[0] }).desktop), 'run+me');
    assert.equal(args(linuxActions.focus(app, x11(), 0)[1])[4], '^run\\+me$');
  });

  it('skips focusing on Wayland, where it is not possible', () => {
    assert.deepEqual(linuxActions.focus(linuxCode, wayland(['wtype']), 0), []);
  });

  it('presses keys with each tool', () => {
    assert.deepEqual(args(linuxActions.hotkey(['mod'], 'c', x11())[0]), ['xdotool', 'key', '--clearmodifiers', 'ctrl+c']);
    assert.deepEqual(args(linuxActions.hotkey(['mod'], 'c', wayland(['wtype']))[0]), ['wtype', '-M', 'ctrl', '-k', 'c', '-m', 'ctrl']);
    assert.deepEqual(args(linuxActions.hotkey(['mod'], 'c', wayland(['ydotool']))[0]), ['ydotool', 'key', '29:1', '46:1', '46:0', '29:0']);
  });

  it('types text from stdin with each tool, so it is never an argument', () => {
    const typed = (plan: OsStep[]) => plan.map((step) => [...args(step), ...(step.kind === 'run' && step.input !== undefined ? [`<${step.input}`] : [])]);
    assert.deepEqual(typed(linuxActions.text('--help me', true, x11())), [
      ['xdotool', 'type', '--delay', '2', '--file', '-', '<--help me'],
      ['xdotool', 'key', 'Return'],
    ]);
    assert.deepEqual(typed(linuxActions.text('-x', true, wayland(['wtype']))), [['wtype', '-', '<-x'], ['wtype', '-k', 'Return']]);
    assert.deepEqual(typed(linuxActions.text('a\\nb', false, wayland(['ydotool']))), [['ydotool', 'type', '--file', '-', '<a\\nb']]);
    assert.deepEqual(typed(linuxActions.text('', true, wayland(['ydotool']))), [['ydotool', 'key', '28:1', '28:0']]);
  });

  it('opens a terminal that cds, runs the command and stays open', () => {
    const ctx = x11(['gnome-terminal']);
    const shellArgv = terminalShellArgv(ctx, 'npm test # all', "/home/ada/it's");
    assert.deepEqual(shellArgv, ['/bin/bash', '-lc', "cd '/home/ada/it'\\''s'\nnpm test # all\nexec '/bin/bash' -l"]);
    const step = linuxActions.terminal('npm test', '/home/ada/p', ctx)[0] as Extract<OsStep, { kind: 'detach' }>;
    assert.deepEqual(args(step).slice(0, 3), ['gnome-terminal', '--working-directory=/home/ada/p', '--']);
    assert.equal(step.cwd, '/home/ada/p');
  });

  it('uses each terminal\'s own flags', () => {
    const shell = ['sh', '-lc', 'x'];
    const expectations: Record<string, string[]> = {
      'x-terminal-emulator': ['x-terminal-emulator', '-e', ...shell],
      konsole: ['konsole', '--workdir', '/p', '-e', ...shell],
      kitty: ['kitty', '--directory', '/p', ...shell],
      alacritty: ['alacritty', '--working-directory', '/p', '-e', ...shell],
      wezterm: ['wezterm', 'start', '--cwd', '/p', '--', ...shell],
      'xfce4-terminal': ['xfce4-terminal', '--working-directory=/p', '-x', ...shell],
      xterm: ['xterm', '-e', ...shell],
    };
    for (const [tool, expected] of Object.entries(expectations)) {
      assert.deepEqual(terminalArgv(buildContext('linux', { tools: [tool] }), shell, '/p'), expected, tool);
    }
  });

  it('prefers $TERMINAL, using known flags when it is a known terminal', () => {
    assert.deepEqual(terminalArgv(buildContext('linux', { tools: ['/usr/bin/kitty', 'xterm'], env: { TERMINAL: '/usr/bin/kitty' } }), ['sh'], '/p'), ['/usr/bin/kitty', '--directory', '/p', 'sh']);
    assert.deepEqual(terminalArgv(buildContext('linux', { tools: ['foot'], env: { TERMINAL: 'foot' } }), ['sh'], '/p'), ['foot', '-e', 'sh']);
  });

  it('reports missing_tool when no terminal exists', () => {
    assert.throws(() => linuxActions.terminal('ls', '/p', buildContext('linux')), (err: AgentError) => err.code === 'missing_tool');
  });

  it('opens urls and files with xdg-open, or with an app by its Exec line', () => {
    assert.deepEqual(args(linuxActions.url('https://x.dev', x11())[0]), ['xdg-open', 'https://x.dev']);
    assert.deepEqual(args(linuxActions.open('/home/ada/p', undefined, x11())[0]), ['xdg-open', '/home/ada/p']);
    assert.deepEqual(args(linuxActions.open('/home/ada/my project', linuxCode, x11())[0]), ['/usr/share/code/code', '--unity-launch', '/home/ada/my project']);
    assert.throws(() => linuxActions.url('https://x.dev', buildContext('linux')), (err: AgentError) => err.code === 'missing_tool' && /xdg-utils/.test(err.hint!));
  });

  it('execArgv appends the file when Exec has no file field code', () => {
    const desktop = { ...(linuxCode as { desktop: Parameters<typeof execArgv>[0] }).desktop, exec: 'gedit' };
    assert.deepEqual(execArgv(desktop, '/tmp/a b.txt'), ['gedit', '/tmp/a b.txt']);
  });
});
