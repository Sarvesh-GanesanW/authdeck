/**
 * First run of the authenticator: what it does, then make a vault or restore one with the
 * recovery phrase (and, with multi-device vaults on, join one from another device). Making a
 * vault goes straight on to the phrase.
 */
import { useState } from 'react';
import { View } from 'react-native';

import type { SurfaceProps } from '../../auth/contract';
import { useAuthUi } from '../../auth/ui';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { Glyph, type GlyphName } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { vaultFeatures } from '../../vault/features';
import { FlowSheet, type FlowView, Notice, plainError } from './parts';
import { type StepNumbers, usePhraseSteps } from './RecoverySetup';

const SETUP_STEPS: StepNumbers = { show: 2, check: 3, total: 3 };

const POINTS: { icon: GlyphName; text: string }[] = [
  { icon: 'smartphone', text: 'Two-factor codes are made on this device. They work with no network and no computer.' },
  { icon: 'keyboard', text: 'Tap a code key on the deck and only its digits are typed on your computer.' },
  vaultFeatures.multiDevice
    ? { icon: 'lock', text: 'Accounts are kept in an encrypted vault folder on your computer that only your own devices can open.' }
    : { icon: 'lock', text: 'Your computer keeps an encrypted backup of the vault that only this device and your recovery phrase can open.' },
  vaultFeatures.multiDevice
    ? { icon: 'key', text: 'A 12-word recovery phrase brings everything back if every device is lost.' }
    : { icon: 'key', text: 'A 12-word recovery phrase brings everything back on a new phone if this one is lost.' },
];

export function VaultIntro({ onClose }: SurfaceProps) {
  const vault = useVault();
  const open = useAuthUi((s) => s.open);
  const [made, setMade] = useState<{ phrase: string[]; flow: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const steps = usePhraseSteps({ made, steps: SETUP_STEPS, onClose, onDone: () => open('vault') });

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await vault.createVault();
      haptics.success();
      setMade(created);
    } catch (e) {
      haptics.error();
      setError(plainError(e, "Couldn't make the vault. Check that the computer is online, then try again."));
    } finally {
      setBusy(false);
    }
  };

  const introView: FlowView = {
    title: 'Two-factor codes on your deck',
    onClose,
    footer: (
      <View style={{ gap: 12 }}>
        <PrimaryButton label="Set up a new vault" icon="plus" busy={busy} onPress={() => void create()} />
        {vaultFeatures.multiDevice ? <GhostButton label="Join a vault from another device" onPress={() => open('join')} /> : null}
        <GhostButton label="Restore with recovery phrase" onPress={() => open('restore')} />
      </View>
    ),
    body: (
      <>
        <View style={{ gap: 14 }}>
          {POINTS.map((p) => (
            <Point key={p.icon} icon={p.icon} text={p.text} />
          ))}
        </View>
        {vault.computerOnline ? null : (
          <Notice tone="warn">
            Your computer isn't connected right now. Codes still work on this device, but typing them and syncing the vault wait until it is back.
            {vaultFeatures.multiDevice ? 'Joining and restoring need it online.' : 'Restoring needs it online.'}
          </Notice>
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </>
    ),
  };

  return (
    <>
      {/* Goes on to the recovery phrase steps in the same sheet. */}
      <FlowSheet view={steps.view ?? introView} maxWidth={640} secure />
      {steps.overlay}
    </>
  );
}

function Point({ icon, text }: { icon: GlyphName; text: string }) {
  const cw = useColorway();
  return (
    <View style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}>
      <Glyph name={icon} size={24} color={cw.focus} />
      <Text style={{ flex: 1 }}>{text}</Text>
    </View>
  );
}
