/**
 * A switch for emulator and simulator runs, so a test never reaches a real AuthDeck Agent or the
 * local network: with it set, the app sweeps nothing (no /24 scan, no search for a moved
 * computer), uses the test agent's port as the default, and probes only the listed test hosts,
 * which it may then also connect to even when they are loopback addresses.
 *
 * Set at build time, development builds only:
 *   EXPO_PUBLIC_AUTHDECK_TEST_PORT=47592 EXPO_PUBLIC_AUTHDECK_TEST_HOSTS=127.0.0.1 npx expo start
 * A release bundle ignores it completely: `__DEV__` is false there, so nothing below is read.
 */
import { DEFAULT_PORT } from '../protocol';

export interface TestOverrides {
  port: number;
  /** Probed in place of a network sweep, and allowed as addresses. */
  hosts: string[];
}

/** The switch as given; null unless this is a development build and the port is valid. */
export function readTestOverrides(isDevBuild: boolean, port: string | undefined, hosts: string | undefined): TestOverrides | null {
  if (!isDevBuild || port === undefined) return null;
  const parsed = /^\d{1,5}$/.test(port) ? Number(port) : NaN;
  if (!(parsed >= 1 && parsed <= 65535)) return null;
  const list = (hosts ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0 && h.length <= 255)
    .slice(0, 8);
  return { port: parsed, hosts: list };
}

function isDevBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

// Expo inlines EXPO_PUBLIC_* only where they are written out in full like this.
export const testOverrides: TestOverrides | null = isDevBuild()
  ? readTestOverrides(true, process.env.EXPO_PUBLIC_AUTHDECK_TEST_PORT, process.env.EXPO_PUBLIC_AUTHDECK_TEST_HOSTS)
  : null;

/** The port to assume when none is given: the agent's, or the test agent's under the switch. */
export function defaultPort(): number {
  return testOverrides?.port ?? DEFAULT_PORT;
}
