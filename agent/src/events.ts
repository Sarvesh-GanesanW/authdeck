import type { MacPermission } from './errors';
import type { ErrorCode } from './protocol';

/** What a device asked for, in words for the person at the computer. Never contains typed text. */
export interface ActivitySummary {
  title: string;
  detail: string;
}

export interface ActionFailure {
  code: ErrorCode;
  message: string;
  hint?: string;
  permission?: MacPermission;
}

/**
 * Structured events for a UI hosting the agent (the desktop app). The CLI ignores them and
 * keeps printing its log lines.
 */
export type AgentEvent =
  | { type: 'listening'; port: number; hosts: string[] }
  /**
   * The pairing window opened or closed, or its PIN or QR secret changed (after a pairing, or
   * after too many wrong PINs): read it again with RunningAgent.pairingWindow(). Never carries them.
   */
  | { type: 'pairing.changed' }
  | { type: 'device.paired'; deviceId: string; deviceName: string }
  | { type: 'device.connected'; deviceId: string; deviceName: string }
  | { type: 'device.disconnected'; deviceId: string }
  | { type: 'device.revoked'; deviceId: string }
  | ({ type: 'action.started'; actionId: number; deviceName: string; at: number } & ActivitySummary)
  | { type: 'action.finished'; actionId: number; ok: true; durationMs: number; exitCode?: number }
  | { type: 'action.finished'; actionId: number; ok: false; durationMs: number; failure: ActionFailure };

export type AgentEventListener = (event: AgentEvent) => void;
