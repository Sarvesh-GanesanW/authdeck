import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateAction } from '../src/actions/validate';
import { AgentError } from '../src/errors';
import { NAMED_KEYS, PRINTABLE_PUNCTUATION } from '../src/protocol';
import { EVDEV_NAMED, MAC_KEY_CODES, WIN_NAMED_VK, X_NAMED_KEYSYMS, evdevKeyCode, winKeyCode, xKeysym } from '../src/actions/keys';

const rejects = (action: unknown, pattern?: RegExp) =>
  assert.throws(() => validateAction(action), (err: AgentError) => err.code === 'bad_request' && (!pattern || pattern.test(err.message)));

describe('action validation', () => {
  it('accepts every action shape from the protocol', () => {
    const actions = [
      { type: 'launch', appId: 'mac:/A.app', appName: 'A' },
      { type: 'hotkey', modifiers: ['mod', 'shift'], key: 'p', focusAppId: 'mac:/A.app' },
      { type: 'text', text: 'hi', pressEnter: true },
      { type: 'command', command: 'ls', mode: 'background', cwd: '~/x', timeoutSec: 5 },
      { type: 'command', command: 'ls', mode: 'terminal' },
      { type: 'url', url: 'https://x' },
      { type: 'open', path: '~/x', withAppId: 'mac:/A.app' },
      { type: 'macro', steps: [{ action: { type: 'url', url: 'https://x' }, delayMs: 100 }] },
    ];
    for (const action of actions) assert.deepEqual(validateAction(action), action);
  });

  it('dedupes modifiers and drops empty optional fields', () => {
    assert.deepEqual(validateAction({ type: 'hotkey', modifiers: ['mod', 'mod'], key: 'f5', focusAppId: '' }), { type: 'hotkey', modifiers: ['mod'], key: 'f5' });
  });

  it('accepts all named keys and printable keys', () => {
    for (const key of [...NAMED_KEYS, ...PRINTABLE_PUNCTUATION, 'a', 'z', '0', '9']) validateAction({ type: 'hotkey', modifiers: [], key });
  });

  it('rejects invalid shapes with a specific message', () => {
    rejects(null);
    rejects({ type: 'nope' }, /not an action/);
    rejects({ type: 'launch' }, /app is missing/);
    rejects({ type: 'hotkey', modifiers: [], key: 'A' }, /not a key/);
    rejects({ type: 'hotkey', modifiers: [], key: 'ab' }, /not a key/);
    rejects({ type: 'hotkey', modifiers: 'mod', key: 'a' }, /modifiers/);
    rejects({ type: 'hotkey', modifiers: ['cmd'], key: 'a' }, /not a modifier/);
    rejects({ type: 'text', text: '' }, /no text/);
    rejects({ type: 'command', command: 'ls', mode: 'popup' }, /mode/);
    rejects({ type: 'command', command: '  ', mode: 'background' }, /command is missing/);
    rejects({ type: 'command', command: 'ls', mode: 'background', timeoutSec: -1 }, /timeout/);
    rejects({ type: 'macro', steps: [] }, /no steps/);
    rejects({ type: 'macro', steps: [{ action: { type: 'text', text: 'x' }, delayMs: -5 }] }, /Macro step 1 has an invalid delay/);
    rejects({ type: 'macro', steps: [{ action: { type: 'text', text: 'x' }, delayMs: 0 }, { action: { type: 'launch' }, delayMs: 0 }] }, /^Macro step 2: /);
  });
});

describe('key tables', () => {
  it('cover every named key on every platform', () => {
    for (const key of NAMED_KEYS) {
      assert.equal(typeof MAC_KEY_CODES[key], 'number', `mac ${key}`);
      assert.equal(typeof WIN_NAMED_VK[key], 'number', `win ${key}`);
      assert.equal(typeof X_NAMED_KEYSYMS[key], 'string', `x ${key}`);
      assert.equal(typeof EVDEV_NAMED[key], 'number', `evdev ${key}`);
    }
  });

  it('map every printable key on every platform', () => {
    const printable = [...'abcdefghijklmnopqrstuvwxyz0123456789', ...PRINTABLE_PUNCTUATION];
    for (const key of printable) {
      assert.ok(winKeyCode(key) > 0);
      assert.ok(xKeysym(key).length > 0);
      assert.ok(evdevKeyCode(key) > 0);
    }
    assert.equal(new Set(printable.map(evdevKeyCode)).size, printable.length, 'evdev codes are distinct');
    assert.equal(new Set(printable.map(winKeyCode)).size, printable.length, 'VK codes are distinct');
  });

  it('use the standard codes for spot checks', () => {
    assert.equal(winKeyCode('f1'), 0x70);
    assert.equal(winKeyCode('f12'), 0x7b);
    assert.equal(winKeyCode('delete'), 0x2e);
    assert.equal(evdevKeyCode('q'), 16);
    assert.equal(evdevKeyCode('z'), 44);
    assert.equal(evdevKeyCode('l'), 38);
    assert.equal(evdevKeyCode('enter'), 28);
    assert.equal(MAC_KEY_CODES.f12, 111);
    assert.equal(X_NAMED_KEYSYMS.pageup, 'Prior');
  });
});
