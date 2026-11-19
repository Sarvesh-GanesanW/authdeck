/** What the socket commands and the device methods share inside one running agent. */
import type { EnvActivityEntry } from '../envSocketContract';
import type { RandomBytes } from '../vault/bytes';
import type { GrantStore } from './grants';
import type { EnvJoins } from './joins';
import type { EnvLinkPort } from './peers';
import type { ProjectRegistry } from './registry';
import type { EnvRelay } from './relay';

export interface EnvState {
  registry: ProjectRegistry;
  grants: GrantStore;
  relay: EnvRelay;
  joins: EnvJoins;
  port: EnvLinkPort;
  now(): number;
  random: RandomBytes;
  /** How long a computer's request waits (ENV_REQUEST_TTL_MS; tests pass a short one). */
  requestTtlMs: number;
  /**
   * Member ids each paired device declared in its last env.watch, by device id, with its name:
   * which paired devices to name when nobody answers, and the person's role for `ls`. Forgotten on unpair.
   */
  declared: Map<string, { deviceName: string; members: readonly string[] }>;
  activity(entry: Omit<EnvActivityEntry, 'id' | 'at'>): void;
  /** Devices are told to read a set (or the list of sets, null) again. */
  setsChanged(setId: string | null): void;
  log(line: string): void;
}
