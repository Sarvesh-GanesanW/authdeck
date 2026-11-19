import { AgentError } from './errors';
import type { FailureStyle } from './plan';
import { INSTALL_HINTS } from './tools';

/** The app macOS asks permission for: the terminal the agent runs in, or node under launchd. */
export function macHostAppName(env: NodeJS.ProcessEnv): string {
  const known: Record<string, string> = {
    Apple_Terminal: 'Terminal',
    'iTerm.app': 'iTerm',
    vscode: 'Visual Studio Code',
    ghostty: 'Ghostty',
    WezTerm: 'WezTerm',
    WarpTerminal: 'Warp',
    Hyper: 'Hyper',
  };
  const program = env.TERM_PROGRAM;
  if (program) return known[program] ?? program;
  return 'node';
}

const MAC_ACCESSIBILITY_REFUSAL = /not allowed (to send keystrokes|assistive access)|assistive access|\(-1719\)|-25211|\b1002\b/i;
const MAC_AUTOMATION_REFUSAL = /-1743|not authori[sz]ed to send apple events/i;

/** Turns a failed tool run into the error the tablet user sees. `hostApp` is the app macOS asks permission for. */
export function classifyFailure(style: FailureStyle, tool: string, purpose: string, stderr: string, hostApp: string): AgentError {
  const detail = lastLine(stderr);
  switch (style) {
    case 'mac-keystrokes':
      if (MAC_ACCESSIBILITY_REFUSAL.test(stderr)) {
        return new AgentError(
          'permission',
          `macOS blocked AuthDeck from controlling the keyboard, so it can't ${purpose}.`,
          `Open System Settings → Privacy & Security → Accessibility and turn on ${hostApp}, then try again.`,
          'accessibility',
        );
      }
      break;
    case 'mac-terminal':
      if (MAC_AUTOMATION_REFUSAL.test(stderr)) {
        return new AgentError(
          'permission',
          `macOS blocked AuthDeck from controlling the terminal app, so it can't ${purpose}.`,
          `Open System Settings → Privacy & Security → Automation and allow ${hostApp} to control Terminal (or iTerm).`,
          'automation',
        );
      }
      break;
    case 'xdotool':
      if (/can't open display|cannot open display/i.test(stderr)) {
        return new AgentError('unsupported', `AuthDeck can't reach the desktop display, so it can't ${purpose}.`, 'Start the AuthDeck agent from a terminal inside your desktop session (or use autostart), not over SSH.');
      }
      break;
    case 'wtype':
      if (/virtual.keyboard|compositor does not support/i.test(stderr)) {
        return new AgentError('unsupported', `This Wayland desktop does not let wtype send keys, so AuthDeck can't ${purpose}.`, INSTALL_HINTS.ydotool);
      }
      break;
    case 'ydotool':
      if (/socket|ydotoold|connect/i.test(stderr)) {
        return new AgentError('failed', `ydotool's background service is not running, so AuthDeck can't ${purpose}.`, 'Start it with: sudo systemctl enable --now ydotool (or run ydotoold).');
      }
      break;
    case 'plain':
      break;
  }
  return new AgentError('failed', detail ? `${tool} could not ${purpose}: ${detail}` : `${tool} could not ${purpose}.`);
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim() !== '');
  return (lines.at(-1) ?? '').trim().slice(0, 300);
}
