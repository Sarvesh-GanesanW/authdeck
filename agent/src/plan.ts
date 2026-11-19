/**
 * An action is turned into a plan of OS steps by pure builders (actions/*), then executed
 * (executor.ts). Keeping the two apart lets every platform's commands be unit-tested on any
 * machine and lets --dry-run print exactly what would run.
 */

/** How to read a failed `run` step's stderr when turning it into a user-facing error. */
export type FailureStyle = 'mac-keystrokes' | 'mac-terminal' | 'xdotool' | 'wtype' | 'ydotool' | 'plain';

export type WinHelperRequest =
  | { op: 'keys'; modifiers: number[]; vk: number }
  | { op: 'text'; text: string }
  | { op: 'focus'; exe: string | null; aumid: string | null }
  | { op: 'foreground' };

/** How to tell whether an app is open, without ever starting it. */
export type OpenProbe =
  /** Open when the command prints anything. A failure that writes to stderr is a real error. */
  | { kind: 'run'; cmd: string; args: string[]; purpose: string; failure: FailureStyle }
  /** Windows helper `focus`: ok means it raised the app's window, `not_found` that it has none. */
  | { kind: 'helper'; request: WinHelperRequest; purpose: string };

export type OsStep =
  /** Run and wait; a nonzero exit is an error. `input` goes to stdin: typed text travels there, never in
   *  args, because any process of the same user can read another's command line (`ps`). */
  | { kind: 'run'; cmd: string; args: string[]; purpose: string; failure: FailureStyle; timeoutMs?: number; input?: string }
  /** Start and forget (GUI apps, openers, terminals). Only a failure to start is reported. */
  | { kind: 'detach'; cmd: string; args: string[]; purpose: string; cwd?: string; verbatimArgs?: boolean }
  /** Request to the persistent Windows input helper. */
  | { kind: 'helper'; request: WinHelperRequest; purpose: string }
  | { kind: 'writeFile'; path: string; content: string }
  | { kind: 'wait'; ms: number }
  /** Fails with "<appName> isn't open" unless the probe finds the app, looking again for up to
   *  `waitMs` (0: one look). Keys meant for an app must never start it. */
  | { kind: 'requireOpen'; appName: string; probe: OpenProbe; waitMs: number };

export type Plan = OsStep[];

export const FOCUS_SETTLE_MS = 150;
/** Extra time for an app that had to be started before keys can reach it. */
export const LAUNCH_SETTLE_MS = 1500;
/** How long a step waits for an app that an earlier step of the same key may have started. */
export const APP_START_WAIT_MS = 10_000;

/** One readable line per step, used by --dry-run and in tests. */
export function describePlan(plan: Plan): string[] {
  return plan.flatMap((step) => describeStep(step));
}

function describeStep(step: OsStep): string[] {
  switch (step.kind) {
    case 'run':
      // Stdin carries typed text, so it is never printed.
      return [`run: ${[step.cmd, ...step.args].map(quoteForDisplay).join(' ')}${step.input !== undefined ? '  < (input not shown)' : ''}`];
    case 'detach':
      return [`detach: ${[step.cmd, ...step.args].map(quoteForDisplay).join(' ')}${step.cwd ? `  (in ${step.cwd})` : ''}`];
    case 'helper':
      // Typed text is left out, as it is for stdin.
      return [`win-helper: ${step.request.op === 'text' ? '{"op":"text"}  (text not shown)' : JSON.stringify(step.request)}`];
    case 'writeFile':
      return [`write ${step.path}:\n${step.content}`];
    case 'wait':
      return [`wait ${step.ms} ms`];
    case 'requireOpen':
      return [`require ${step.appName} open${step.waitMs > 0 ? ` (waiting up to ${step.waitMs} ms)` : ''}: ${describeProbe(step.probe)}`];
  }
}

function describeProbe(probe: OpenProbe): string {
  return probe.kind === 'run' ? [probe.cmd, ...probe.args].map(quoteForDisplay).join(' ') : `win-helper ${JSON.stringify(probe.request)}`;
}

function quoteForDisplay(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : JSON.stringify(arg);
}
