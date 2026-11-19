import type { DesktopEndReason } from '../shared/envView';

/** The powerMonitor events that end every env grant, and the reason each device is told. */
export const GRANT_ENDING_POWER_EVENTS = {
  'lock-screen': 'computer-locked',
  suspend: 'computer-slept',
} as const satisfies Record<string, DesktopEndReason>;

/** The part of Electron's powerMonitor this needs, so a plain EventEmitter can stand in for it. */
export interface PowerEvents {
  on(event: keyof typeof GRANT_ENDING_POWER_EVENTS, listener: () => void): unknown;
}

/**
 * A locked or sleeping computer ends every grant, so nobody at the keyboard later inherits one.
 * powerMonitor sends lock-screen on macOS and Windows only; on Linux the agent's clock-jump
 * check covers sleep, and suspend still arrives.
 */
export function endGrantsOnLockAndSleep(power: PowerEvents, endAllGrants: (reason: DesktopEndReason) => void): void {
  for (const [event, reason] of Object.entries(GRANT_ENDING_POWER_EVENTS) as [keyof typeof GRANT_ENDING_POWER_EVENTS, DesktopEndReason][]) {
    power.on(event, () => endAllGrants(reason));
  }
}
