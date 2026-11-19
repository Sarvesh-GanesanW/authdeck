import { AgentError } from './errors';

function packageHint(apt: string, dnf = apt, pacman = apt): string {
  return `Install it with: sudo apt install ${apt} (Fedora: sudo dnf install ${dnf}, Arch: sudo pacman -S ${pacman})`;
}

/** How to install the OS tools the agent relies on. */
export const INSTALL_HINTS: Record<string, string> = {
  xdotool: packageHint('xdotool'),
  wtype: packageHint('wtype'),
  ydotool: `${packageHint('ydotool')}, then start its service: sudo systemctl enable --now ydotool`,
  'xdg-open': packageHint('xdg-utils'),
  xprop: packageHint('x11-utils', 'xprop', 'xorg-xprop'),
  osascript: 'osascript ships with macOS; check that /usr/bin is on PATH.',
  'powershell.exe': 'Windows PowerShell ships with Windows; check that it has not been removed or blocked by policy.',
};

/** Error for a tool that is not installed, e.g. "xdotool is not installed, so AuthDeck can't press the keys on this computer." */
export function missingTool(tool: string, purpose: string): AgentError {
  return new AgentError('missing_tool', `${tool} is not installed, so AuthDeck can't ${purpose} on this computer.`, INSTALL_HINTS[tool]);
}
