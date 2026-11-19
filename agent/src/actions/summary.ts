import type { Action, StepAction } from '../protocol';

const MAX_SUMMARY = 80;

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_SUMMARY ? `${oneLine.slice(0, MAX_SUMMARY - 1)}…` : oneLine;
}

/** One short line describing an action for the agent's log. Typed text is never logged (it may be a password); a secret's length isn't either. */
export function summarizeAction(action: unknown): string {
  if (typeof action !== 'object' || action === null) return 'invalid action';
  const typed = action as Action;
  if (typed.type === 'macro') {
    const count = Array.isArray(typed.steps) ? typed.steps.length : 0;
    return `macro (${count} step${count === 1 ? '' : 's'})`;
  }
  return summarizeStep(typed);
}

function summarizeStep(action: StepAction): string {
  switch (action.type) {
    case 'launch':
      return `launch ${action.appName || action.appId}`;
    case 'hotkey':
      return `hotkey ${[...(action.modifiers ?? []), action.key].join('+')}${action.focusAppId ? ` in ${action.focusAppId}` : ''}`;
    case 'text':
      if (action.secret === true) return `type a secret${action.pressEnter ? ' + enter' : ''}`;
      return `type text (${String(action.text ?? '').length} chars)${action.pressEnter ? ' + enter' : ''}`;
    case 'command':
      return `command [${action.mode}] ${clip(String(action.command ?? ''))}`;
    case 'url':
      return `url ${clip(String(action.url ?? ''))}`;
    case 'open':
      return `open ${clip(String(action.path ?? ''))}${action.withAppId ? ` with ${action.withAppId}` : ''}`;
    default:
      return `unknown action ${String((action as { type?: unknown }).type)}`;
  }
}
