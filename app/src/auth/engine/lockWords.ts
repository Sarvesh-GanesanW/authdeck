/**
 * The device's own unlock, in plain words for its platform (iOS: Face ID and a passcode;
 * Android: fingerprint, face unlock and the screen lock). Pure: callers pass Platform.OS, so the
 * app-lock rules stay testable without React Native.
 */
export type LockPlatform = 'ios' | 'android' | string | undefined;

/** "Face ID or your passcode" / "your fingerprint, face or screen lock". */
export function deviceUnlockWords(platform: LockPlatform): string {
  return platform === 'ios' ? 'Face ID or your passcode' : 'your fingerprint, face or screen lock';
}

/** What to set up in the device settings: "Face ID or a passcode" / "a fingerprint, face unlock or screen lock". */
export function deviceUnlockSetupWords(platform: LockPlatform): string {
  return platform === 'ios' ? 'Face ID or a passcode' : 'a fingerprint, face unlock or screen lock';
}
