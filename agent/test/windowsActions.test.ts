import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { terminalScript, windowsActions } from '../src/actions/windows';
import type { OsStep } from '../src/plan';
import { buildContext, winCalculator, winCode, winOffice } from './helpers/context';

const ctx = buildContext('windows');

describe('Windows action builders', () => {
  it('launches Start Menu links and Store apps through explorer.exe without waiting', () => {
    assert.deepEqual(windowsActions.launch(winCode, ctx), [
      { kind: 'detach', cmd: 'explorer.exe', args: ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Visual Studio Code.lnk'], purpose: 'open Visual Studio Code' },
    ]);
    assert.deepEqual(windowsActions.launch(winCalculator, ctx)[0], {
      kind: 'detach',
      cmd: 'explorer.exe',
      args: ['shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'],
      purpose: 'open Calculator',
    });
  });

  it('focuses via the helper by exe, launching when the app has no window', () => {
    const [either, settle] = windowsActions.focus(winCode, ctx);
    assert.equal(either!.kind, 'either');
    const attempts = (either as Extract<OsStep, { kind: 'either' }>).attempts;
    assert.deepEqual(attempts[0], [{ kind: 'helper', request: { op: 'focus', exe: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', aumid: null }, purpose: 'bring Visual Studio Code to the front' }]);
    assert.equal(attempts[1]![0]!.kind, 'detach');
    assert.deepEqual(attempts[1]![1], { kind: 'wait', ms: 1500 });
    assert.deepEqual(settle, { kind: 'wait', ms: 150 });
  });

  it('focuses Store apps by AUMID', () => {
    const attempts = (windowsActions.focus(winCalculator, ctx)[0] as Extract<OsStep, { kind: 'either' }>).attempts;
    assert.deepEqual((attempts[0]![0] as Extract<OsStep, { kind: 'helper' }>).request, { op: 'focus', exe: null, aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' });
  });

  it('sends hotkeys as virtual-key codes (mod = Ctrl, meta = left Windows key)', () => {
    const keys = (modifiers: Parameters<typeof windowsActions.hotkey>[0], key: string) =>
      (windowsActions.hotkey(modifiers, key, ctx)[0] as Extract<OsStep, { kind: 'helper' }>).request;
    assert.deepEqual(keys(['mod', 'shift'], 'p'), { op: 'keys', modifiers: [0x11, 0x10], vk: 0x50 });
    assert.deepEqual(keys(['meta'], 'd'), { op: 'keys', modifiers: [0x5b], vk: 0x44 });
    assert.deepEqual(keys(['mod', 'ctrl', 'alt'], 'f20'), { op: 'keys', modifiers: [0x11, 0x12], vk: 0x83 });
    assert.deepEqual(keys([], '`'), { op: 'keys', modifiers: [], vk: 0xc0 });
    assert.deepEqual(keys([], '7'), { op: 'keys', modifiers: [], vk: 0x37 });
    assert.deepEqual(keys([], 'pageup'), { op: 'keys', modifiers: [], vk: 0x21 });
  });

  it('types text as Unicode and presses Enter separately', () => {
    const plan = windowsActions.text('héllo 👋', true, ctx);
    assert.deepEqual(plan.map((s) => (s as Extract<OsStep, { kind: 'helper' }>).request), [
      { op: 'text', text: 'héllo 👋' },
      { op: 'keys', modifiers: [], vk: 0x0d },
    ]);
  });

  it('opens a terminal with Windows Terminal running a cmd script that cds first', () => {
    const plan = windowsActions.terminal('npm run dev && echo "done"', 'C:\\Users\\Ada\\My Project', buildContext('windows', { tools: ['wt.exe'] }));
    assert.deepEqual(plan, [
      {
        kind: 'writeFile',
        path: 'C:\\Users\\Ada\\.authdeck\\run\\fixed-id.cmd',
        content: '@chcp 65001 >nul\r\n@cd /d "C:\\Users\\Ada\\My Project"\r\nnpm run dev && echo "done"\r\n',
      },
      {
        kind: 'detach',
        cmd: 'wt.exe',
        args: ['-d', 'C:\\Users\\Ada\\My Project', 'cmd.exe', '/k', 'C:\\Users\\Ada\\.authdeck\\run\\fixed-id.cmd'],
        purpose: 'open Windows Terminal',
        cwd: 'C:\\Users\\Ada\\My Project',
      },
    ]);
  });

  it('falls back to cmd start with exact quoting when Windows Terminal is missing', () => {
    const plan = windowsActions.terminal('dir', 'C:\\Users\\Ada\\My Project', ctx);
    const open = plan[1] as Extract<OsStep, { kind: 'detach' }>;
    assert.equal(open.cmd, 'cmd.exe');
    assert.equal(open.verbatimArgs, true);
    assert.equal(open.args.join(' '), '/d /c start "AuthDeck" /D "C:\\Users\\Ada\\My Project" cmd.exe /k C:\\Users\\Ada\\.authdeck\\run\\fixed-id.cmd');
  });

  it('quotes a script path with spaces for the start fallback', () => {
    const spaced = buildContext('windows', { scratchDir: 'C:\\Users\\Ada Lovelace\\.authdeck\\run' });
    const open = windowsActions.terminal('dir', 'C:\\', spaced)[1] as Extract<OsStep, { kind: 'detach' }>;
    assert.equal(open.args.join(' '), '/d /c start "AuthDeck" /D "C:\\" cmd.exe /k "C:\\Users\\Ada Lovelace\\.authdeck\\run\\fixed-id.cmd"');
  });

  it('uses a PowerShell script when the shell setting says powershell or pwsh', () => {
    const plan = windowsActions.terminal("Write-Host 'hi'", "C:\\it's", buildContext('windows', { shell: 'pwsh', tools: ['wt.exe'] }));
    const write = plan[0] as Extract<OsStep, { kind: 'writeFile' }>;
    assert.equal(write.path, 'C:\\Users\\Ada\\.authdeck\\run\\fixed-id.ps1');
    assert.equal(write.content, "\ufeffSet-Location -LiteralPath 'C:\\it''s'\r\nWrite-Host 'hi'\r\n");
    assert.deepEqual((plan[1] as Extract<OsStep, { kind: 'detach' }>).args, ['-d', "C:\\it's", 'pwsh.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Users\\Ada\\.authdeck\\run\\fixed-id.ps1']);
  });

  it('terminalScript keeps the command exactly as typed', () => {
    assert.equal(terminalScript('echo %PATH% & ver', 'D:\\x', false).content.split('\r\n')[2], 'echo %PATH% & ver');
  });

  it('opens links with url.dll and verbatim args (no cmd parsing)', () => {
    assert.deepEqual(windowsActions.url('https://example.com/?a=1&b=2', ctx), [
      { kind: 'detach', cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'https://example.com/?a=1&b=2'], verbatimArgs: true, purpose: 'open the link' },
    ]);
  });

  it('opens files with the default app, or hands them to an app exe', () => {
    assert.deepEqual(windowsActions.open('C:\\p', undefined, ctx), [{ kind: 'detach', cmd: 'explorer.exe', args: ['C:\\p'], purpose: 'open it' }]);
    assert.deepEqual(windowsActions.open('C:\\p', winCode, ctx), [
      { kind: 'detach', cmd: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', args: ['C:\\p'], purpose: 'open it in Visual Studio Code' },
    ]);
    // Advertised (MSI) shortcuts have no exe target, and Store apps can't take a path: default app.
    assert.equal((windowsActions.open('C:\\p', winOffice, ctx)[0] as { cmd: string }).cmd, 'explorer.exe');
    assert.equal((windowsActions.open('C:\\p', winCalculator, ctx)[0] as { cmd: string }).cmd, 'explorer.exe');
  });

  it('runs background commands with cmd /d /s /c and verbatim quoting', () => {
    assert.deepEqual(windowsActions.background('git status && echo "ok"', ctx), { cmd: 'cmd.exe', args: ['/d', '/s', '/c', '"git status && echo "ok""'], verbatimArgs: true });
  });

  it('runs background commands in PowerShell via -EncodedCommand when configured', () => {
    const invocation = windowsActions.background("Get-ChildItem 'C:\\' | Select -First 1", buildContext('windows', { shell: 'powershell' }));
    assert.equal(invocation.cmd, 'powershell.exe');
    const encoded = invocation.args.at(-1)!;
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), "Get-ChildItem 'C:\\' | Select -First 1");
    assert.deepEqual(invocation.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  });
});
