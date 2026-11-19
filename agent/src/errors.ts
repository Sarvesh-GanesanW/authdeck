import type { ErrorCode, ProtocolError } from './protocol';
import { sendableError } from './resultLimits';

/** The macOS privacy setting that refused an action. */
export type MacPermission = 'accessibility' | 'automation';

/** An error that is shown to the tablet user as-is: one plain sentence plus an optional fix. */
export class AgentError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  /** Not sent to the tablet; lets the desktop app name the setting to turn on. */
  readonly permission?: MacPermission;

  constructor(code: ErrorCode, message: string, hint?: string, permission?: MacPermission) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.hint = hint;
    this.permission = permission;
  }

  toProtocol(): ProtocolError {
    // A message can quote a path or a command's output: never more than the app takes.
    return sendableError(this.hint ? { code: this.code, message: this.message, hint: this.hint } : { code: this.code, message: this.message });
  }
}

export function badRequest(message: string): AgentError {
  return new AgentError('bad_request', message);
}

export function rateLimited(message: string): AgentError {
  return new AgentError('rate_limited', message);
}

/** A key aimed at an app that isn't running: the agent never starts it, and says so on the key. */
export function appNotOpen(appName: string, waitedMs: number): AgentError {
  const hint =
    waitedMs > 0
      ? `It didn't start within ${Math.round(waitedMs / 1000)} seconds. Give the step that opens it a longer delay, or open it first.`
      : `Open ${appName} first, then press the key again.`;
  return new AgentError('not_found', `${appName} isn't open.`, hint);
}

/**
 * Converts anything thrown into the wire error shape. An unexpected error's message can name
 * files on this computer, so it stays in the agent's log and the device gets a generic sentence.
 */
export function toProtocolError(err: unknown): ProtocolError {
  if (err instanceof AgentError) return err.toProtocol();
  return { code: 'failed', message: 'Something went wrong on the computer.', hint: 'The AuthDeck agent\'s log on the computer has the details.' };
}
