/**
 * Mounts the authenticator: starts the vault engine, renders the surface useAuthUi names, and
 * shows the approval dialog whenever another device asks to join. Env sets' request and join
 * sheets (EnvHostSheets) go above all of it, so they appear at once over any screen, locked or not.
 */
import { useEffect, useState, type ComponentType } from 'react';

import type { SurfaceProps } from './contract';
import { startVaultEngine } from './engine/engine';
import { SurfaceVisibleContext } from './surfaceVisibility';
import { useAuthUi, type AuthSurface } from './ui';
import { isMockVault, useVault } from './useVault';
import { vaultFeatures } from '../vault/features';
import { ApproveDialog } from '../screens/authflows/ApproveDialog';
import { JoinFlow } from '../screens/authflows/JoinFlow';
import { RecoverySetup } from '../screens/authflows/RecoverySetup';
import { RestoreFlow } from '../screens/authflows/RestoreFlow';
import { VaultIntro } from '../screens/authflows/VaultIntro';
import { EnvHostSheets } from '../screens/env/EnvHostSheets';
import { AddAccountSheet } from '../screens/vault/AddAccountSheet';
import { VaultScreen } from '../screens/vault/VaultScreen';

const SURFACES: Record<AuthSurface, ComponentType<SurfaceProps>> = {
  vault: VaultScreen,
  'add-account': AddAccountSheet,
  intro: VaultIntro,
  'recovery-setup': RecoverySetup,
  restore: RestoreFlow,
  join: JoinFlow,
};

/** Sheets slide closed (springs.smooth, 480 ms); the full-screen vault closes at once. */
const CLOSE_MS = 520;
const SHEET_SURFACES = new Set<AuthSurface>(['add-account', 'intro', 'recovery-setup', 'restore', 'join']);

export function AuthHost() {
  const surface = useAuthUi((s) => s.surface);
  const close = useAuthUi((s) => s.close);
  const { incoming, denyJoin } = useVault();
  // The surface on screen: the open one, or a sheet still sliding closed.
  const [shown, setShown] = useState<AuthSurface | null>(surface);

  useEffect(() => (isMockVault ? undefined : startVaultEngine()), []);

  useEffect(() => {
    if (surface) {
      setShown(surface);
      return;
    }
    if (!shown || !SHEET_SURFACES.has(shown)) {
      setShown(null);
      return;
    }
    const timer = setTimeout(() => setShown(null), CLOSE_MS);
    return () => clearTimeout(timer);
    // `shown` is read only to decide how to close; reacting to it would restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface]);

  // Joining is multi-device (0.4): without it, the join surface never shows.
  const Surface = shown && (shown !== 'join' || vaultFeatures.multiDevice) ? SURFACES[shown] : null;
  const request = incoming[0];
  return (
    <>
      {Surface ? (
        <SurfaceVisibleContext.Provider value={surface !== null}>
          <Surface key={shown!} onClose={close} />
        </SurfaceVisibleContext.Provider>
      ) : null}
      {request && vaultFeatures.multiDevice ? <ApproveDialog key={request.id} request={request} onClose={() => denyJoin(request.id)} /> : null}
      <EnvHostSheets />
    </>
  );
}
