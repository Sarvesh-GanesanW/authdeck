import path from 'node:path';
import type { Platform } from './protocol';

export type LinuxSession = 'x11' | 'wayland';

/** Everything about the machine that command builders need, captured once so builders stay pure. */
export interface HostContext {
  platform: Platform;
  home: string;
  /** Environment variables as seen by the agent. */
  env: NodeJS.ProcessEnv;
  /** Returns true when an executable with this name is on PATH (or the absolute path exists). */
  hasTool: (name: string) => boolean;
}

export function currentPlatform(): Platform {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

export function linuxSession(env: NodeJS.ProcessEnv): LinuxSession {
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) return 'wayland';
  return 'x11';
}

/** Desktop names from XDG_CURRENT_DESKTOP, e.g. "ubuntu:GNOME" -> ["ubuntu", "GNOME"]. */
export function currentDesktops(env: NodeJS.ProcessEnv): string[] {
  return (env.XDG_CURRENT_DESKTOP ?? '').split(':').filter(Boolean);
}

/** Expands a leading `~` and resolves relative paths against the home folder. */
export function resolveUserPath(input: string, home: string, platform: Platform): string {
  const pathApi = platform === 'windows' ? path.win32 : path.posix;
  if (input === '~') return home;
  let expanded = input;
  if (input.startsWith('~/') || (platform === 'windows' && input.startsWith('~\\'))) {
    expanded = pathApi.join(home, input.slice(2));
  }
  return pathApi.resolve(home, expanded);
}
