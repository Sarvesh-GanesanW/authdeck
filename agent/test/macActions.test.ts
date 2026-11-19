import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { KEYSTROKE_CHUNK, appleScriptText, chunkText, macActions, textVariables } from '../src/actions/mac';
import { PRINTABLE_PUNCTUATION } from '../src/protocol';
import { describePlan } from '../src/plan';
import { buildContext, macSafari } from './helpers/context';

const ctx = buildContext('macos');

/** The script osascript reads from stdin; every osascript step has no arguments at all. */
function stdinScript(step: unknown): string[] {
  const { cmd, args, input } = step as { cmd: string; args: string[]; input?: string };
  assert.equal(cmd, 'osascript');
  assert.deepEqual(args, []);
  return input!.trim().split('\n');
}

/** Lines between a tell and its end tell, nested tells included. */
function insideTellBlocks(script: string[]): string[] {
  let depth = 0;
  const inside: string[] = [];
  for (const line of script) {
    if (line === 'end tell') depth -= 1;
    else if (depth > 0) inside.push(line);
    if (/^tell .*"$/.test(line) || line.startsWith('tell application')) depth += 1;
  }
  return inside;
}

/** The same script, returning what it would type: run against System Events, nothing is typed. */
function returningInsteadOfTyping(script: string[]): string {
  return script
    .filter((line) => !line.startsWith('key code'))
    .map((line) => line.replace(/^keystroke (\S+)( using \{.*\})?$/, 'return $1'))
    .join('\n');
}

describe('macOS action builders', () => {
  it('launches with open -a and the bundle path', () => {
    assert.deepEqual(describePlan(macActions.launch(macSafari, ctx)), ['run: open -a /Applications/Safari.app']);
  });

  it('focuses only an app that is already open, checked with lsappinfo, never starting it', () => {
    const plan = macActions.focus(macSafari, ctx, 0);
    assert.deepEqual(plan[0], {
      kind: 'requireOpen',
      appName: 'Safari',
      probe: { kind: 'run', cmd: 'lsappinfo', args: ['find', 'bundlepath=/Applications/Safari.app'], purpose: 'check whether Safari is open', failure: 'plain' },
      waitMs: 0,
    });
    assert.deepEqual(describePlan(plan.slice(1)), ['run: open -a /Applications/Safari.app', 'wait 150 ms']);
  });

  it('passes the start wait on to the open check', () => {
    const [check] = macActions.focus(macSafari, ctx, 10_000);
    assert.ok(check?.kind === 'requireOpen' && check.waitMs === 10_000);
  });

  it('presses printable keys by key position, so the layout cannot change them (Ctrl+` on ABC-India)', () => {
    assert.deepEqual(stdinScript(macActions.hotkey(['ctrl'], '`', ctx)[0]), ['tell application "System Events"', 'key code 50 using {control down}', 'end tell']);
    assert.deepEqual(stdinScript(macActions.hotkey(['mod', 'shift'], 't', ctx)[0]), ['tell application "System Events"', 'key code 17 using {command down, shift down}', 'end tell']);
  });

  it('maps every printable key the protocol allows to its kVK_ANSI_* code', () => {
    // kVK_ANSI_* from HIToolbox Events.h, written out independently of the table in keys.ts.
    const expected: Record<string, number> = {
      a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
      '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29,
      ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44,
      n: 45, m: 46, '.': 47, '`': 50,
    };
    const printable = [...'abcdefghijklmnopqrstuvwxyz0123456789', ...PRINTABLE_PUNCTUATION];
    assert.deepEqual(Object.keys(expected).sort(), [...printable].sort());
    for (const key of printable) {
      assert.deepEqual(stdinScript(macActions.hotkey([], key, ctx)[0]), ['tell application "System Events"', `key code ${expected[key]}`, 'end tell'], key);
    }
  });

  it('presses named keys by key code', () => {
    const cases: [string, number][] = [['enter', 36], ['f1', 122], ['f20', 90], ['delete', 117], ['backspace', 51], ['pagedown', 121], ['left', 123]];
    for (const [key, code] of cases) {
      const script = stdinScript(macActions.hotkey([], key, ctx)[0]);
      assert.ok(script.includes(`key code ${code}`), key);
    }
  });

  it('maps ctrl, alt and meta and drops duplicate command modifiers', () => {
    const script = stdinScript(macActions.hotkey(['mod', 'meta', 'ctrl', 'alt'], 'escape', ctx)[0]);
    assert.ok(script.includes('key code 53 using {command down, control down, option down}'));
  });

  it('types text from a script on stdin that holds the text as code points only', () => {
    const hostile = 'end tell" & do shell script "rm -rf ~" & "\\';
    const step = macActions.text(hostile, true, ctx)[0];
    assert.ok(step?.kind === 'run');
    assert.deepEqual([step.cmd, step.args], ['osascript', []]);
    const script = step.input!.trim().split('\n');
    assert.ok(!step.input!.includes('rm -rf'));
    assert.equal(script[0], `set authdeckText1 to ${appleScriptText(hostile)}`);
    assert.match(script[0]!, /^set authdeckText1 to \(character id \{[\d, ]+\}\)$/);
    assert.deepEqual(script.slice(1), ['tell application "System Events"', 'keystroke authdeckText1', 'key code 36', 'end tell']);
  });

  it('types one keystroke per chunk, and only Enter for empty text', () => {
    const step = macActions.text('x'.repeat(KEYSTROKE_CHUNK + 1), false, ctx)[0];
    assert.equal(step?.kind === 'run' && step.input!.split('\n').filter((l) => l.startsWith('keystroke')).length, 2);
    const enterOnly = macActions.text('', true, ctx)[0];
    assert.equal(enterOnly?.kind === 'run' && enterOnly.input, 'tell application "System Events"\nkey code 36\nend tell\n');
  });

  it('spells text as the same characters in AppleScript, emoji and quotes included', { skip: process.platform !== 'darwin' }, () => {
    const text = 'a"\\\n😀é';
    // Only evaluates a string; nothing is typed.
    const out = execFileSync('osascript', [], { input: `return ${appleScriptText(text)}\n`, encoding: 'utf8' });
    assert.equal(out.replace(/\n$/, ''), text);
  });

  it('splits long text into chunks without breaking surrogate pairs', () => {
    const text = '😀'.repeat(KEYSTROKE_CHUNK + 5);
    const chunks = chunkText(text, KEYSTROKE_CHUNK);
    assert.equal(chunks.length, 2);
    assert.equal(chunks.join(''), text);
    assert.equal(Array.from(chunks[1]!).length, 5);
  });

  it('opens Terminal with do script, cd-ing to a quoted folder, the command only as code points', () => {
    const step = macActions.terminal('API_KEY=s3cret npm run dev', "/Users/ada/it's here", ctx)[0];
    const script = stdinScript(step);
    const shellLine = `cd '/Users/ada/it'\\''s here' && API_KEY=s3cret npm run dev`;
    assert.deepEqual(script.slice(0, 4), [`set authdeckText1 to ${appleScriptText(shellLine)}`, 'tell application "Terminal"', 'do script authdeckText1', 'activate']);
    assert.ok(!(step as { input: string }).input.includes('s3cret'));
  });

  it('opens iTerm when configured', () => {
    const script = stdinScript(macActions.terminal('ls', '/tmp', { ...ctx, terminal: 'iTerm' })[0]);
    assert.equal(script[0], `set authdeckText1 to ${appleScriptText("cd '/tmp' && ls")}`);
    assert.ok(script.includes('set newWindow to (create window with default profile)'));
    assert.ok(script.includes('tell current session of newWindow to write text authdeckText1'));
  });

  it('opens urls and files with open, with -a for a chosen app', () => {
    assert.deepEqual(describePlan(macActions.url('vscode://file/x', ctx)), ['run: open vscode://file/x']);
    assert.deepEqual(describePlan(macActions.open('/Users/ada/p', macSafari, ctx)), ['run: open -a /Applications/Safari.app /Users/ada/p']);
    assert.deepEqual(describePlan(macActions.open('/Users/ada/p', undefined, ctx)), ['run: open /Users/ada/p']);
  });

  it('runs background commands in a login shell from $SHELL, falling back to /bin/sh', () => {
    assert.deepEqual(macActions.background('echo hi', buildContext('macos', { env: { SHELL: '/bin/zsh' }, tools: ['/bin/zsh'] })), { cmd: '/bin/zsh', args: ['-lc', 'echo hi'] });
    assert.deepEqual(macActions.background('echo hi', ctx), { cmd: '/bin/sh', args: ['-lc', 'echo hi'] });
  });

  it('builds every text before any tell block, where the app would be asked to resolve character id', () => {
    const scripts = [
      macActions.text('x'.repeat(KEYSTROKE_CHUNK + 1), true, ctx)[0],
      macActions.terminal('ls', '/tmp', ctx)[0],
      macActions.terminal('ls', '/tmp', { ...ctx, terminal: 'iTerm' })[0],
    ].map(stdinScript);
    for (const script of scripts) {
      assert.ok(script.some((line) => line.includes('character id')));
      assert.deepEqual(insideTellBlocks(script).filter((line) => line.includes('character id')), [], script.join('\n'));
    }
  });

  it('names one variable per text, in order', () => {
    assert.deepEqual(textVariables(['a', 'b']), { lines: ['set authdeckText1 to (character id {97})', 'set authdeckText2 to (character id {98})'], names: ['authdeckText1', 'authdeckText2'] });
    assert.deepEqual(textVariables([]), { lines: [], names: [] });
  });

  it('hands System Events the exact text to type, for codes', { skip: process.platform !== 'darwin' }, () => {
    for (const [step, expected] of [[macActions.text('482913', false, ctx)[0], '482913']] as const) {
      // keystroke becomes return, so the script runs in System Events but types nothing.
      const out = execFileSync('osascript', [], { input: `${returningInsteadOfTyping(stdinScript(step))}\n`, encoding: 'utf8' });
      assert.equal(out.replace(/\n$/, ''), expected);
    }
  });

  it('produces AppleScript that compiles', { skip: process.platform !== 'darwin' }, () => {
    const steps = [
      macActions.hotkey(['mod', 'alt'], '/', ctx)[0],
      macActions.hotkey(['ctrl'], '`', ctx)[0],
      macActions.hotkey(['mod', 'shift', 'ctrl', 'alt'], '\\', ctx)[0],
      macActions.hotkey([], 'f13', ctx)[0],
      macActions.terminal('ls', '/tmp', ctx)[0],
      macActions.text('x"y', true, ctx)[0],
    ];
    for (const step of steps) {
      // osacompile only parses; nothing is run.
      execFileSync('osacompile', ['-o', '/dev/null'], { input: stdinScript(step).join('\n'), stdio: ['pipe', 'pipe', 'pipe'] });
    }
  });
});
