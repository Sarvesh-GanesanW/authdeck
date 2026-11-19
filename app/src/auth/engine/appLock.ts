/**
 * App lock decisions, kept apart from the prompt so every case is testable. App lock asks for the
 * device's own authentication (Face ID, a fingerprint or the passcode) before the vault opens. It
 * must never lock the person out: when the device can no longer authenticate (its screen lock was
 * removed after app lock went on), the vault opens with the recovery phrase instead, and once open
 * the switch can always be turned off. Pure.
 */
import { deviceUnlockSetupWords } from './lockWords';

/** What the device can authenticate with (secrets.ts deviceAuth reads it). */
export interface DeviceAuth {
  /** Biometric hardware (LocalAuthentication.hasHardwareAsync). */
  hardware: boolean;
  /** Biometrics enrolled (LocalAuthentication.isEnrolledAsync). */
  enrolled: boolean;
  /** A device passcode, PIN or pattern is set (enrolled level SECRET or higher). */
  passcode: boolean;
  /** Platform.OS, for the wording only (deviceAuth fills it). */
  platform?: string;
}

export const SCREEN_LOCK_NEEDED = 'Set a screen lock on this device to unlock AuthDeck.';
export const replaceNeedsScreenLock = (auth: DeviceAuth) =>
  `A new phrase without the old one needs a screen lock. Set up ${deviceUnlockSetupWords(auth.platform)} in your device settings, then try again.`;
const noScreenLockToTurnOn = (auth: DeviceAuth) =>
  `App lock needs a screen lock. Set up ${deviceUnlockSetupWords(auth.platform)} in your device settings, then turn app lock on.`;
const UNLOCK_FIRST = 'Unlock the vault with your recovery phrase first, then turn app lock off.';

/** True when the device can confirm it's the owner: enrolled biometrics, or a passcode. */
export function canAuthenticate(auth: DeviceAuth): boolean {
  return (auth.hardware && auth.enrolled) || auth.passcode;
}

/** How the vault opens: at once (no app lock), by the device prompt, or only with the recovery phrase. */
export type UnlockRoute = { kind: 'open' } | { kind: 'device' } | { kind: 'phrase'; message: string };

export function unlockRoute(appLock: boolean, auth: DeviceAuth): UnlockRoute {
  if (!appLock) return { kind: 'open' };
  return canAuthenticate(auth) ? { kind: 'device' } : { kind: 'phrase', message: SCREEN_LOCK_NEEDED };
}

/**
 * What turning app lock on or off takes. On: a device that can authenticate, and the prompt. Off:
 * the prompt when the device can still authenticate; otherwise the person already proved it by
 * opening the vault (with the prompt earlier, or the phrase), and is let through.
 */
export type AppLockChange = { kind: 'nothing' } | { kind: 'prompt' } | { kind: 'allow' } | { kind: 'refuse'; message: string };

export function appLockChange(input: { on: boolean; current: boolean; auth: DeviceAuth; open: boolean }): AppLockChange {
  const { on, current, auth, open } = input;
  if (on === current) return { kind: 'nothing' };
  if (on) return canAuthenticate(auth) ? { kind: 'prompt' } : { kind: 'refuse', message: noScreenLockToTurnOn(auth) };
  if (canAuthenticate(auth)) return { kind: 'prompt' };
  return open ? { kind: 'allow' } : { kind: 'refuse', message: UNLOCK_FIRST };
}

const UNLOCK_WITH_PHRASE_FIRST = 'Unlock the vault with your recovery phrase first, then try again.';

/**
 * What a guarded change outside the vault (editing deck keys and commands) takes when app lock
 * may be on: nothing without a vault or app lock, or while the vault is open (it locks after the
 * auto-lock time); else the device prompt, or, on a device that can no longer prompt, the vault
 * opened with the phrase first.
 */
export type UnlockGate = { kind: 'allow' } | { kind: 'prompt' } | { kind: 'refuse'; message: string };

export function unlockGate(input: { hasVault: boolean; appLock: boolean; open: boolean; auth: DeviceAuth }): UnlockGate {
  const { hasVault, appLock, open, auth } = input;
  if (!hasVault || !appLock || open) return { kind: 'allow' };
  return canAuthenticate(auth) ? { kind: 'prompt' } : { kind: 'refuse', message: UNLOCK_WITH_PHRASE_FIRST };
}
