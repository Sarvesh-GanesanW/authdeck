import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunningAgent } from '../../../agent/src/agent';
import type { AgentConfig, ShellPreference, TerminalPreference } from '../../../agent/src/config';
import type { Platform } from '../../../agent/src/protocol';
import { findExecutable } from '../../../agent/src/which';
import type { CommandRunner, CommandRunnerChoice } from '../shared/state';

const TERMINAL: CommandRunnerChoice = { value: 'Terminal', label: 'Terminal' };
const ITERM: CommandRunnerChoice = { value: 'iTerm', label: 'iTerm' };
const SHELLS: Record<ShellPreference, CommandRunnerChoice> = {
  cmd: { value: 'cmd', label: 'Command Prompt' },
  powershell: { value: 'powershell', label: 'Windows PowerShell' },
  pwsh: { value: 'pwsh', label: 'PowerShell 7' },
};

function itermInstalled(): boolean {
  return ['/Applications', path.join(os.homedir(), 'Applications')].some((dir) => fs.existsSync(path.join(dir, 'iTerm.app')));
}

/** The choices this computer can actually use, plus the saved one so it is never hidden. */
export function commandRunner(platform: Platform, config: AgentConfig): CommandRunner | null {
  switch (platform) {
    case 'macos': {
      const showIterm = config.terminal === 'iTerm' || itermInstalled();
      return { current: config.terminal, choices: showIterm ? [TERMINAL, ITERM] : [TERMINAL] };
    }
    case 'windows': {
      const current = config.shell ?? 'cmd';
      const showPwsh = current === 'pwsh' || findExecutable('pwsh') !== null;
      const choices = [SHELLS.cmd, SHELLS.powershell, ...(showPwsh ? [SHELLS.pwsh] : [])];
      return { current, choices };
    }
    case 'linux':
      return null;
  }
}

export function applyCommandRunner(agent: RunningAgent, platform: Platform, value: string): void {
  if (platform === 'macos') agent.setTerminal(value as TerminalPreference);
  if (platform === 'windows') agent.setShell(value as ShellPreference);
}
