import type { InstalledApp } from '../apps/types';
import type { ShellPreference, TerminalPreference } from '../config';
import type { HostContext } from '../host';
import type { Modifier } from '../protocol';
import type { Plan } from '../plan';

export interface BuildContext extends HostContext {
  terminal: TerminalPreference;
  shell?: ShellPreference;
  /** Folder for helper files the agent writes (Windows terminal scripts). */
  scratchDir: string;
  /** Unique id for helper file names. */
  newId: () => string;
}

/** How to run a background command: one program with argv. */
export interface ShellInvocation {
  cmd: string;
  args: string[];
  verbatimArgs?: boolean;
}

/** Per-platform translation of actions into OS steps. Every function is pure. */
export interface PlatformActions {
  launch(app: InstalledApp, ctx: BuildContext): Plan;
  /** Bring an app forward before keys are sent. */
  focus(app: InstalledApp, ctx: BuildContext): Plan;
  hotkey(modifiers: readonly Modifier[], key: string, ctx: BuildContext): Plan;
  text(text: string, pressEnter: boolean, ctx: BuildContext): Plan;
  terminal(command: string, cwd: string, ctx: BuildContext): Plan;
  url(url: string, ctx: BuildContext): Plan;
  open(target: string, withApp: InstalledApp | undefined, ctx: BuildContext): Plan;
  background(command: string, ctx: BuildContext): ShellInvocation;
}

/** Narrows an app to the platform being built for; catalog entries always match, so a mismatch is a bug. */
export function expectApp<P extends InstalledApp['platform']>(app: InstalledApp, platform: P): Extract<InstalledApp, { platform: P }> {
  if (app.platform !== platform) throw new Error(`App ${app.entry.id} is not a ${platform} app.`);
  return app as Extract<InstalledApp, { platform: P }>;
}

/** Posix login shell from $SHELL, falling back to /bin/sh. */
export function posixShell(ctx: HostContext): string {
  const shell = ctx.env.SHELL;
  return shell && shell.startsWith('/') && ctx.hasTool(shell) ? shell : '/bin/sh';
}
