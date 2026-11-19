/** The engine's published state: what useVault returns on a phone or tablet. */
import { create } from 'zustand';

import type { JoinRequestView, JoinState, VaultSnapshot } from '../contract';
import { DEFAULT_AUTO_LOCK_MS } from './localCopy';

export type EngineView = VaultSnapshot & { join: JoinState | null; incoming: JoinRequestView[] };

const initial: EngineView = {
  status: 'loading',
  name: '',
  accounts: [],
  devices: [],
  history: [],
  caughtChanges: [],
  voidedChanges: [],
  chainOk: true,
  rollbackWarning: null,
  recovery: { savedAt: null },
  storage: { computerName: null, path: null, syncedAt: null },
  lastChangeAt: null,
  appLock: true,
  autoLockMs: DEFAULT_AUTO_LOCK_MS,
  locksAt: null,
  computerOnline: false,
  warnings: [],
  secretsPaused: false,
  removed: null,
  heldRemoval: false,
  appLockBlocked: null,
  join: null,
  incoming: [],
};

export const useEngineVault = create<EngineView>()(() => initial);
