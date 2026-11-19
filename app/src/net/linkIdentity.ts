/**
 * This install's static link key: the key every computer knows this device by. Made once, kept in
 * platform secure storage "when unlocked, this device only" (never in backups), and separate from
 * the vault's keys so pairing a computer never touches the vault.
 *
 * On the web there is no secure storage, so the key sits in the browser's local storage: any script
 * that runs on the app's origin, a browser extension with access to it, or anyone with the browser
 * profile can copy it and connect as this device. The pairing screen and the Computers sheet say so
 * (KEY_IN_BROWSER_NOTICE).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { generateLinkKey, linkKeyFromSecret, type LinkKeyPair } from '../link/keys';
import { fromBase64Url, toBase64Url, type RandomBytes } from '../vault/bytes';

const LINK_KEY_NAME = 'authdeck_link_v1';
const STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** True where this device's link key sits in browser storage rather than secure storage. */
export const keyIsInBrowserStorage = Platform.OS === 'web';

export const KEY_IN_BROWSER_NOTICE =
  "This browser keeps this device's key in its site storage, where other code in the browser could reach it. The AuthDeck phone app keeps it in secure storage, which is safer.";

export const linkRandom: RandomBytes = (length) => Crypto.getRandomBytes(length);

export const LINK_KEY_READ_FAILED =
  "AuthDeck couldn't read this device's link key from secure storage, so it can't talk to your computer. Unlock the device, close and reopen AuthDeck, then try again.";
export const LINK_KEY_WRITE_FAILED =
  "AuthDeck couldn't save this device's link key to secure storage, so it can't pair yet. Unlock the device, close and reopen AuthDeck, then try again.";

/** A storage call whose native failure becomes a plain message; the raw text goes to the log only. */
async function guarded<T>(call: () => Promise<T>, message: string): Promise<T> {
  try {
    return await call();
  } catch (err) {
    console.warn('link key storage:', err instanceof Error ? err.message : String(err));
    throw new Error(message, { cause: err });
  }
}

const storage =
  Platform.OS === 'web'
    ? {
        read: () => guarded(() => AsyncStorage.getItem(LINK_KEY_NAME), LINK_KEY_READ_FAILED),
        write: (value: string) => guarded(() => AsyncStorage.setItem(LINK_KEY_NAME, value), LINK_KEY_WRITE_FAILED),
      }
    : {
        read: () => guarded(() => SecureStore.getItemAsync(LINK_KEY_NAME, STORE_OPTIONS), LINK_KEY_READ_FAILED),
        write: (value: string) => guarded(() => SecureStore.setItemAsync(LINK_KEY_NAME, value, STORE_OPTIONS), LINK_KEY_WRITE_FAILED),
      };

let loading: Promise<LinkKeyPair> | null = null;

async function loadOrCreate(): Promise<LinkKeyPair> {
  const stored = await storage.read();
  if (stored !== null) {
    try {
      return linkKeyFromSecret(fromBase64Url(stored, 'The link key'));
    } catch (err) {
      throw new Error("This device's link key in secure storage is damaged. Reinstall AuthDeck and pair your computers again.", { cause: err });
    }
  }
  const created = generateLinkKey(linkRandom);
  await storage.write(toBase64Url(created.secret));
  return created;
}

/** The device's link key, made on first use. Loaded once per app run. */
export function deviceLinkKey(): Promise<LinkKeyPair> {
  loading ??= loadOrCreate().catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}
