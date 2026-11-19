/**
 * Where the env screens get their data: the one seam between them and the engine. It is the env
 * engine (src/auth/useEnv.ts); only a debug build under the dev-shots switch (./devShots) serves
 * the sample sets in ./mock instead, so every screen and state can be screenshotted.
 */
import { useMemo } from 'react';
import { Platform } from 'react-native';

import type { EnvApi, EnvSnapshot } from '../../auth/envContract';
import type { VaultStatus } from '../../auth/contract';
import { useEnv as useEngineEnv } from '../../auth/useEnv';
import { useVault } from '../../auth/useVault';
import { ENV_SHOTS } from './devShots';
import { type MockEnvScenario, type MockRequestKind, mockEnvActions, mockEnvOwnDeviceJoin, mockEnvRequest, mockEnvScenario, useMockEnv } from './mock';

/** Sample keys open and lock with the vault, as the engine's do; requests then ask to unlock first. */
function followVaultLock(snapshot: EnvSnapshot, vault: VaultStatus): EnvSnapshot {
  if (vault === 'open') return snapshot;
  const status = vault === 'loading' ? 'loading' : 'locked';
  return {
    ...snapshot,
    status,
    incoming: snapshot.incoming.map((r) => ({ ...r, needsUnlock: true })),
    joinRequests: snapshot.joinRequests.map((r) => ({ ...r, needsUnlock: true })),
  };
}

function useShotsEnv(): EnvApi {
  const snapshot = useMockEnv();
  const vaultStatus = useVault().status;
  return useMemo(() => ({ ...followVaultLock(snapshot, vaultStatus), ...mockEnvActions }), [snapshot, vaultStatus]);
}

export const useEnv: () => EnvApi = ENV_SHOTS ? useShotsEnv : useEngineEnv;

/**
 * Web runs on sample data only, so screens can be screenshotted in a browser: ?env=<scenario>
 * picks the sets, ?envRequest=<kind> puts a computer's request on screen, ?envJoin=own an
 * own-device join request.
 */
function applyWebScenario(): void {
  if (Platform.OS !== 'web') return;
  const params = new URLSearchParams((globalThis as { location?: { search?: string } }).location?.search ?? '');
  const scenario = params.get('env');
  if (scenario) mockEnvScenario(scenario as MockEnvScenario);
  const request = params.get('envRequest');
  if (request) mockEnvRequest(request as MockRequestKind);
  if (params.get('envJoin') === 'own') mockEnvOwnDeviceJoin();
}

applyWebScenario();

