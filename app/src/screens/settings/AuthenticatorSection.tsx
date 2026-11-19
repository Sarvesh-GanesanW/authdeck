/** Settings for the authenticator: set it up or open the vault, where its backup is, app lock, and when it locks. */
import { useState } from 'react';
import { Platform, View } from 'react-native';

import { useAuthUi } from '../../auth/ui';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { Choice, GhostButton } from '../../ui/controls';
import { Text } from '../../ui/Text';
import { Group, Row, Section, SwitchRow } from './rows';
import { whenPhrase } from '../vault/format';
import { vaultFeatures } from '../../vault/features';
import { deviceUnlockWords } from '../../auth/engine/lockWords';

const MINUTE = 60_000;
const AUTO_LOCK_OPTIONS = [1, 5, 15].map((m) => ({ value: String(m * MINUTE), label: `${m} min` }));

/** `onLeave` closes settings, so the surface it opens isn't stacked under it. */
export function AuthenticatorSection({ onLeave }: { onLeave: () => void }) {
  const vault = useVault();
  const [lockError, setLockError] = useState<string | null>(null);

  const openSurface = (surface: 'intro' | 'vault') => {
    onLeave();
    useAuthUi.getState().open(surface);
  };

  const toggleAppLock = async (on: boolean) => {
    setLockError(null);
    try {
      await vault.setAppLock(on);
    } catch (e) {
      haptics.error();
      setLockError(e instanceof Error && e.message ? e.message : "App lock couldn't be changed. Try again.");
    }
  };

  if (vault.status === 'loading' || vault.status === 'none') {
    return (
      <Section title="Authenticator">
        <Group>
          <Row label="Set up the authenticator" detail="Two-factor codes on this device, typed on your computer with one tap.">
            <GhostButton small label="Set up" icon="chevron-right" disabled={vault.status === 'loading'} onPress={() => openSurface('intro')} />
          </Row>
        </Group>
      </Section>
    );
  }

  const offline = vault.computerOnline ? undefined : 'Your computer is offline: codes still work, and changes sync when it is back.';
  return (
    <Section title="Authenticator" footer={offline}>
      <Group>
        <Row label={vault.name} detail={vaultSummary(vault.accounts.length, vault.devices.length, vault.status === 'locked')}>
          <GhostButton small label="Open vault" icon="chevron-right" onPress={() => openSurface('vault')} />
        </Row>
        <Row label="Backup" detail={backupLine(vault.storage)} />
        {vault.recovery.pending ? <Row label="Recovery phrase" detail={PHRASE_NOT_ON_COMPUTER} /> : null}
        <SwitchRow
          label="App lock"
          detail={`Ask for ${deviceUnlockWords(Platform.OS)} to see codes.`}
          value={vault.appLock}
          onChange={(on) => void toggleAppLock(on)}
        />
        <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 16, gap: 12 }}>
          <View style={{ gap: 2 }}>
            <Text weight="semibold">Lock after</Text>
            <Text variant="caption" tone="dim">
              The vault locks when AuthDeck goes unused this long.
            </Text>
          </View>
          <Choice label="Lock after" options={AUTO_LOCK_OPTIONS} value={String(vault.autoLockMs)} onChange={(v) => vault.setAutoLock(Number(v))} />
        </View>
      </Group>
      {lockError ? (
        <Text variant="label" tone="danger" accessibilityLiveRegion="polite">
          {lockError}
        </Text>
      ) : null}
    </Section>
  );
}

function vaultSummary(accounts: number, devices: number, locked: boolean): string {
  if (!vaultFeatures.multiDevice) return locked ? 'Locked.' : `${plural(accounts, 'account')}.`;
  if (locked) return `Locked. ${plural(devices, 'trusted device')}.`;
  return `${plural(accounts, 'account')}, ${plural(devices, 'trusted device')}.`;
}

/** Where the encrypted backup lives (the vault folder on the paired computer), and when this device last synced it. */
export const PHRASE_NOT_ON_COMPUTER = "Your new phrase isn't on the computer yet. AuthDeck sends it when the computer is reachable; keep the paper with the new words.";

export function backupLine(storage: { computerName: string | null; syncedAt: number | null }, now = Date.now()): string {
  const where = `Backed up, encrypted, on ${storage.computerName ?? 'your computer'}.`;
  return storage.syncedAt === null ? `${where} Not synced since AuthDeck opened.` : `${where} Last synced ${whenPhrase(storage.syncedAt, now)}.`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
