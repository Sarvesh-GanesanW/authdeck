/**
 * The one hook screens use for the authenticator. On a phone or tablet it is the vault engine
 * (./engine). On web, where there is no secure storage, it is always the sample vault from
 * ./mock, so screens can be built and screenshotted there (add ?mockVault=1 to the URL by habit;
 * web is mock either way).
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import type { CodeView, VaultActions, VaultApi } from './contract';
import { engineActions } from './engine/engine';
import { useEngineVault } from './engine/store';
import { mockActions, useMockVault } from './mock';

/** True when useVault serves the sample vault instead of the real one. */
export const isMockVault = Platform.OS === 'web';

const useSnapshot = isMockVault ? useMockVault : useEngineVault;
const actions: VaultActions = isMockVault ? mockActions : engineActions;

export function useVault(): VaultApi {
  const state = useSnapshot();
  return { ...state, ...actions };
}

/** A code that re-renders each second while the vault is open. */
export function useCode(accountId: string): CodeView | null {
  const vault = useVault();
  const [at, setAt] = useState(() => Date.now());
  useEffect(() => {
    if (vault.status !== 'open') return;
    const timer = setInterval(() => setAt(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [vault.status]);
  return vault.code(accountId, at);
}
