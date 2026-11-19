/**
 * The env engine as the app runs it: wired to the active computer's session (net/connection.ts),
 * the vault engine's lock, secure storage and the device's name. Started once by useEnv
 * (../useEnv.ts) and kept while anything uses it.
 */
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { create } from 'zustand';

import type { EnvSnapshot } from '../envContract';
import { ENV_FEATURE, type EnvMethod, type EnvMethods } from '../../protocol';
import { onEnvEvent } from '../../net/client';
import { connection } from '../../net/connection';
import { useLive } from '../../state/live';
import { cleanJoinName } from '../../vault/approval';
import { fromBase64Url } from '../../vault/bytes';
import { replayVault, type VaultState } from '../../vault/replay';
import { loadForks, loadLogs, loadPrefs, loadSealProofs } from '../engine/localCopy';
import { engineActions } from '../engine/engine';
import { canUseAppLock, confirmOwner, loadDeviceKeys } from '../engine/secrets';
import { useEngineVault } from '../engine/store';
import { EnvEngine } from './engine';
import type { EnvComputer, EnvHost, EnvLink, EnvRecoveryPublic } from './host';
import { DeviceEnvStore } from './storage';

const EMPTY: EnvSnapshot = { status: 'loading', sets: [], incoming: [], ended: [], joinRequests: [], join: null, ownRequests: [], agentTooOld: false, personName: null };

/** The engine's snapshot, for useEnv. */
export const useEnvSnapshot = create<EnvSnapshot>()(() => EMPTY);

/**
 * connection.request is typed over protocol 2's methods; it hands any method to the session,
 * which sends env methods and checks their results (net/messages.ts). Only the env engine calls
 * it with these, and only on an agent listing ENV_FEATURE.
 */
const link: EnvLink = {
  request: <M extends EnvMethod>(method: M, params: EnvMethods[M]['params'], timeoutMs?: number) =>
    (connection.request as unknown as (m: M, p: EnvMethods[M]['params'], t?: number) => Promise<EnvMethods[M]['result']>)(method, params, timeoutMs),
};

const NO_VAULT_KEYS = "This device's vault keys aren't there. Open the vault, then try again.";

/** Opens a locked vault, or, with app lock on, asks for the device's own unlock even while it is open. */
async function confirmForEnv(reason: string): Promise<void> {
  const vault = useEngineVault.getState();
  if (vault.status !== 'open') {
    await engineActions.unlock();
    return;
  }
  // A device that can no longer prompt opened the vault with its phrase: that proved it already.
  if (vault.appLock && (await canUseAppLock())) await confirmOwner(reason);
}

/**
 * The vault's current recovery identity, from this device's own copy of the vault (signed logs,
 * replayed): public keys only. The vault engine keeps its state to itself, and this is read only
 * when a set is made and when the phrase changes.
 */
/**
 * The vault as this device's own copy of it says (signed logs, replayed): the vault engine keeps
 * its state to itself, and env sets read it only to make a set, change its phrase or take one over.
 */
async function replayedVault(): Promise<VaultState | null> {
  const { vaultId } = await loadPrefs();
  if (!vaultId) return null;
  const [logs, forks, sealProofs] = await Promise.all([loadLogs(vaultId), loadForks(vaultId), loadSealProofs(vaultId)]);
  return replayVault(vaultId, logs, { forks, sealProofs });
}

/** The vault's current recovery identity: public keys only. */
async function vaultRecovery(): Promise<EnvRecoveryPublic | null> {
  const recovery = (await replayedVault())?.recovery;
  if (!recovery) return null;
  return { deviceId: recovery.deviceId, edPublic: fromBase64Url(recovery.ed), xPublic: fromBase64Url(recovery.x) };
}

/** Ever a device of this vault: the founder, a member (joined or not), or one it removed (cutoffs). */
async function isVaultDevice(deviceId: string): Promise<boolean> {
  const state = await replayedVault();
  if (!state) return false;
  return state.founder === deviceId || Object.hasOwn(state.members, deviceId) || Object.hasOwn(state.cutoffs, deviceId);
}

function deviceForm(): 'phone' | 'tablet' | null {
  if (Device.deviceType === Device.DeviceType.PHONE) return 'phone';
  if (Device.deviceType === Device.DeviceType.TABLET) return 'tablet';
  return null;
}

function activeComputer(): EnvComputer | null {
  const { status, agent } = useLive.getState();
  if (status !== 'online' || !agent) return null;
  return { agentId: agent.agentId, name: agent.name, hasEnv: agent.features?.includes(ENV_FEATURE) ?? false };
}

const host: EnvHost = {
  now: () => Date.now(),
  random: (length) => Crypto.getRandomBytes(length),
  link,
  store: new DeviceEnvStore(),
  vault: {
    status: () => useEngineVault.getState().status,
    deviceKeys: async () => {
      const keys = await loadDeviceKeys();
      if (!keys) throw new Error(NO_VAULT_KEYS);
      return keys;
    },
    confirm: confirmForEnv,
    recovery: vaultRecovery,
    isVaultDevice,
    vaultId: async () => (await loadPrefs()).vaultId,
  },
  device: { label: cleanJoinName(Device.deviceName ?? Device.modelName ?? '') || 'Phone', form: deviceForm() },
};

export const envEngine = new EnvEngine(host);

const report = (err: unknown) => console.warn('Env sets:', err instanceof Error ? err.message : String(err));

let users = 0;
let stop: (() => void) | null = null;

function start(): () => void {
  const offEngine = envEngine.subscribe(() => useEnvSnapshot.setState(envEngine.snapshot(), true));
  const offEvents = onEnvEvent((message) => envEngine.handleEvent(message));
  let vaultStatus = useEngineVault.getState().status;
  const offVault = useEngineVault.subscribe((vault) => {
    if (vault.status === vaultStatus) return;
    vaultStatus = vault.status;
    envEngine.vaultChanged().catch(report);
  });
  // A new recovery phrase (or the first one) moves the vault's recovery identity: owned sets follow it.
  let recoverySavedAt = useEngineVault.getState().recovery.savedAt;
  const offRecovery = useEngineVault.subscribe((vault) => {
    if (vault.recovery.savedAt === recoverySavedAt) return;
    recoverySavedAt = vault.recovery.savedAt;
    envEngine.vaultRecoveryChanged().catch(report);
  });
  let computerKey = '';
  const followComputer = () => {
    const computer = activeComputer();
    const key = computer ? `${computer.agentId}:${computer.hasEnv}:${computer.name}` : '';
    if (key === computerKey) return;
    computerKey = key;
    envEngine.computerChanged(computer).catch(report);
  };
  const offLive = useLive.subscribe(followComputer);
  envEngine
    .load()
    .then(() => envEngine.vaultChanged())
    .then(followComputer)
    .catch(report);
  return () => {
    offEngine();
    offEvents();
    offVault();
    offRecovery();
    offLive();
    envEngine.dispose();
  };
}

/** Starts the env engine for one user (a mounted useEnv); returns the release. The last release stops it. */
export function holdEnvEngine(): () => void {
  if (users++ === 0) stop = start();
  return () => {
    if (--users > 0) return;
    stop?.();
    stop = null;
  };
}
