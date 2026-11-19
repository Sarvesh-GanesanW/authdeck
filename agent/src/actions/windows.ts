import path from 'node:path';
import type { InstalledApp } from '../apps/types';
import { FOCUS_SETTLE_MS, LAUNCH_SETTLE_MS, type OsStep, type Plan } from '../plan';
import { expectApp, type BuildContext, type PlatformActions, type ShellInvocation } from './context';
import { VK_RETURN, WIN_MODIFIER_VK, mapModifiers, winKeyCode } from './keys';
import { cmdQuotePath, encodePowerShellCommand, psQuote } from './quote';

const win = path.win32;
const TERMINAL_TITLE = 'AuthDeck';

function powerShellExe(ctx: BuildContext): string | null {
  if (ctx.shell === 'powershell') return 'powershell.exe';
  if (ctx.shell === 'pwsh') return 'pwsh.exe';
  return null;
}

function launchStep(app: InstalledApp): OsStep {
  const winApp = expectApp(app, 'windows');
  // explorer.exe returns exit code 1 even on success, so it is started, not awaited.
  const target = winApp.kind === 'lnk' ? winApp.lnkPath : `shell:AppsFolder\\${winApp.aumid}`;
  return { kind: 'detach', cmd: 'explorer.exe', args: [target], purpose: `open ${winApp.entry.name}` };
}

/** Script file for a terminal window: cd to the folder, then the command as typed. */
export function terminalScript(command: string, cwd: string, usePowerShell: boolean): { ext: string; content: string } {
  if (usePowerShell) {
    // BOM so Windows PowerShell 5.1 reads non-ASCII text as UTF-8.
    return { ext: '.ps1', content: `﻿Set-Location -LiteralPath ${psQuote(cwd)}\r\n${command}\r\n` };
  }
  // Lines starting with @ are not echoed; the user's command is, like typing it at the prompt.
  return { ext: '.cmd', content: `@chcp 65001 >nul\r\n@cd /d ${cmdQuotePath(cwd)}\r\n${command}\r\n` };
}

export const windowsActions: PlatformActions = {
  launch(app) {
    return [launchStep(app)];
  },

  focus(app) {
    const winApp = expectApp(app, 'windows');
    const request =
      winApp.kind === 'lnk'
        ? { op: 'focus' as const, exe: winApp.targetPath || null, aumid: null }
        : { op: 'focus' as const, exe: null, aumid: winApp.aumid };
    return [
      {
        kind: 'either',
        attempts: [
          [{ kind: 'helper', request, purpose: `bring ${winApp.entry.name} to the front` }],
          [launchStep(app), { kind: 'wait', ms: LAUNCH_SETTLE_MS }],
        ],
      },
      { kind: 'wait', ms: FOCUS_SETTLE_MS },
    ];
  },

  hotkey(modifiers, key) {
    return [{ kind: 'helper', request: { op: 'keys', modifiers: mapModifiers(modifiers, WIN_MODIFIER_VK), vk: winKeyCode(key) }, purpose: 'press the keys' }];
  },

  text(text, pressEnter) {
    const plan: Plan = [];
    if (text !== '') plan.push({ kind: 'helper', request: { op: 'text', text }, purpose: 'type the text' });
    if (pressEnter) plan.push({ kind: 'helper', request: { op: 'keys', modifiers: [], vk: VK_RETURN }, purpose: 'press Enter' });
    return plan;
  },

  terminal(command, cwd, ctx) {
    const psExe = powerShellExe(ctx);
    const script = terminalScript(command, cwd, psExe !== null);
    const scriptPath = win.join(ctx.scratchDir, `${ctx.newId()}${script.ext}`);
    const inner = psExe ? [psExe, '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath] : ['cmd.exe', '/k', scriptPath];
    const open: OsStep = ctx.hasTool('wt.exe')
      ? { kind: 'detach', cmd: 'wt.exe', args: ['-d', cwd, ...inner], purpose: 'open Windows Terminal', cwd }
      : {
          kind: 'detach',
          cmd: 'cmd.exe',
          // Verbatim so cmd/start see exactly these quotes: start "<title>" /D "<cwd>" <program> <args>.
          args: ['/d', '/c', 'start', `"${TERMINAL_TITLE}"`, '/D', cmdQuotePath(cwd), ...inner.map(quoteIfNeeded)],
          verbatimArgs: true,
          purpose: 'open a terminal window',
          cwd,
        };
    return [{ kind: 'writeFile', path: scriptPath, content: script.content }, open];
  },

  url(url) {
    // url.dll's handler receives the rest of the command line untouched; verbatim avoids added quotes.
    return [{ kind: 'detach', cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url], verbatimArgs: true, purpose: 'open the link' }];
  },

  open(target, withApp) {
    if (withApp?.platform === 'windows' && withApp.kind === 'lnk' && isExePath(withApp.targetPath)) {
      return [{ kind: 'detach', cmd: withApp.targetPath, args: [target], purpose: `open it in ${withApp.entry.name}` }];
    }
    return [{ kind: 'detach', cmd: 'explorer.exe', args: [target], purpose: 'open it' }];
  },

  background(command, ctx): ShellInvocation {
    const psExe = powerShellExe(ctx);
    if (psExe) {
      return { cmd: psExe, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(command)] };
    }
    // Same shape Node uses for `shell: true`: /s strips exactly the outer quotes we add.
    return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatimArgs: true };
  },
};

/** True when open-with on Windows can hand the path straight to the app's exe. */
export function windowsOpenWithIsDirect(app: InstalledApp): boolean {
  return app.platform === 'windows' && app.kind === 'lnk' && isExePath(app.targetPath);
}

function isExePath(file: string): boolean {
  return /\.exe$/i.test(file);
}

function quoteIfNeeded(arg: string): string {
  return /[\s&()^|<>]/.test(arg) ? cmdQuotePath(arg) : arg;
}
