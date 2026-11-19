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
  /** Try each alternative in order until one succeeds; the last one's error is reported. */
  | { kind: 'either'; attempts: OsStep[][] };

export type Plan = OsStep[];

export const FOCUS_SETTLE_MS = 150;
/** Extra time for an app that had to be started before keys can reach it. */
export const LAUNCH_SETTLE_MS = 1500;

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
    case 'either':
      return step.attempts.flatMap((attempt, index) =>
        describePlan(attempt).map((line) => `${index === 0 ? 'try' : `else ${index}`}: ${line}`),
      );
  }
}

function quoteForDisplay(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : JSON.stringify(arg);
}
