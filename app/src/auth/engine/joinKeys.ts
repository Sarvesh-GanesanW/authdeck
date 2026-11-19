/**
 * Which device keys this device brings to a new membership (founding, joining, restoring). Keys a
 * vault already ties to this device are retired, never reused: a vault that removed them refuses
 * them for good, and a join someone squatted lists them with a key that isn't this device's. The
 * iOS keychain outlives deleting the app, so a reinstalled phone finds such keys still stored.
 */
import type { DeviceKeys } from '../../vault/crypto';

/** Where this device's keys live (secure storage in the app). */
export interface DeviceKeyStore {
  load(): Promise<DeviceKeys | null>;
  save(keys: DeviceKeys): Promise<void>;
  make(): DeviceKeys;
}

/** True when a vault already ties these stored keys to a membership they can't be used for again. */
export type KeysRetired = (deviceId: string) => boolean | Promise<boolean>;

/** Makes and stores new device keys, replacing whatever was stored. */
export async function renewDeviceKeys(store: DeviceKeyStore): Promise<DeviceKeys> {
  const keys = store.make();
  await store.save(keys);
  return keys;
}

/** The stored keys, unless there are none or `retired` says a vault already used them up; then new ones. */
export async function keysUnlessRetired(store: DeviceKeyStore, retired: KeysRetired): Promise<DeviceKeys> {
  const stored = await store.load();
  if (stored && !(await retired(stored.deviceId))) return stored;
  return renewDeviceKeys(store);
}
