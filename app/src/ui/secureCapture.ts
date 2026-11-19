/**
 * Capture blocking for SecureSheet, kept apart from React so it can be tested. Each activation
 * blocks under a key of its own, so a sheet closed and quickly reopened can't be released by the
 * first activation's delayed release. On iOS the app-switcher snapshot is also hidden while any
 * activation is held; that is one switch for the whole app, so it is counted.
 */

import { testOverrides } from '../net/testOverrides';

/** The parts of expo-screen-capture this uses. */
export interface CaptureApi {
  prevent(key: string): Promise<void>;
  allow(key: string): Promise<void>;
  /** iOS only: hide the app's snapshot in the app switcher. */
  hideSnapshot?(): Promise<void>;
  showSnapshot?(): Promise<void>;
}

export interface CaptureBlock {
  /** Resolves true once capture is blocked, false if it couldn't be. */
  readonly ready: Promise<boolean>;
  /** Lets capture through again after `delayMs` (the sheet still shows while it slides away). */
  release(delayMs: number): void;
}

export class SecureCapture {
  private nextKey = 0;
  private snapshotHolders = 0;
  /** The app-switcher hiding under way or done for the current holders; every activation waits on it. */
  private hiding: Promise<void> | null = null;

  constructor(
    private readonly api: CaptureApi,
    private readonly schedule: (run: () => void, ms: number) => void = (run, ms) => void setTimeout(run, ms),
  ) {}

  block(): CaptureBlock {
    const key = `authdeck-secret-${++this.nextKey}`;
    const holdsSnapshot = this.api.hideSnapshot !== undefined;
    let released = false;
    let heldSnapshot = false;
    const ready = (async () => {
      try {
        await this.api.prevent(key);
        if (holdsSnapshot) {
          heldSnapshot = true;
          this.snapshotHolders++;
          // Not only the first holder: a second sheet opening while the first's hide is still
          // queued must not draw its secret before the snapshot is hidden either.
          if (!this.hiding) {
            this.hiding = this.api.hideSnapshot!().catch((e: unknown) => {
              this.hiding = null;
              throw e;
            });
          }
          await this.hiding;
        }
        return true;
      } catch {
        return false;
      }
    })();
    return {
      ready,
      release: (delayMs) => {
        if (released) return;
        released = true;
        this.schedule(() => {
          this.api.allow(key).catch(() => undefined);
          if (holdsSnapshot) {
            void ready.then(() => {
              if (!heldSnapshot) return;
              this.snapshotHolders = Math.max(0, this.snapshotHolders - 1);
              if (this.snapshotHolders === 0) {
                this.hiding = null;
                this.api.showSnapshot!().catch(() => undefined);
              }
            });
          }
        }, delayMs);
      },
    };
  }
}

/**
 * Two dev-only modes for emulator and simulator runs, honoured only under the test switch
 * (net/testOverrides), so a release build ignores them:
 *   EXPO_PUBLIC_AUTHDECK_TEST_ALLOW_CAPTURE=1  secret screens are not blocked, so store shots can be taken
 *   EXPO_PUBLIC_AUTHDECK_TEST_CAPTURE_FAILS=1  blocking always fails, to show the fail-closed sheet
 */
export interface CaptureTestModes {
  allowCapture: boolean;
  failBlock: boolean;
}

export const CAPTURE_TEST_MODES_OFF: CaptureTestModes = { allowCapture: false, failBlock: false };

/** The modes as given; both off unless the test switch is on, and each needs exactly "1". */
export function readCaptureTestModes(testSwitchOn: boolean, allow: string | undefined, fail: string | undefined): CaptureTestModes {
  if (!testSwitchOn) return CAPTURE_TEST_MODES_OFF;
  return { allowCapture: allow === '1', failBlock: fail === '1' };
}

// Expo inlines EXPO_PUBLIC_* only where they are written out in full like this.
export const captureTestModes: CaptureTestModes = readCaptureTestModes(
  testOverrides !== null,
  process.env.EXPO_PUBLIC_AUTHDECK_TEST_ALLOW_CAPTURE,
  process.env.EXPO_PUBLIC_AUTHDECK_TEST_CAPTURE_FAILS,
);

/** `api` under the test modes: a failing block wins over an allowed capture, so the sheet shows. */
export function withCaptureTestModes(api: CaptureApi, modes: CaptureTestModes): CaptureApi {
  if (modes.failBlock) {
    return { prevent: () => Promise.reject(new Error('Screen capture blocking refused by the test switch')), allow: () => Promise.resolve() };
  }
  if (modes.allowCapture) return { prevent: () => Promise.resolve(), allow: () => Promise.resolve() };
  return api;
}

