/** Trusted devices (with removal and the sites to reset afterwards) and the Backup facts. */
import { useState } from 'react';
import { View } from 'react-native';

import type { AccountView, DeviceView, VaultSnapshot } from '../../auth/contract';
import { useAuthUi } from '../../auth/ui';
import { useVault } from '../../auth/useVault';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { type ConfirmRequest, ConfirmSheet } from '../settings/ConfirmSheet';
import { showFailure } from './feedback';
import { accountGlyph, accountName, deviceGlyph, lastHeard, shortDate } from './format';
import { Hint, ItemRow, SectionHeading } from './parts';

interface RemovedDevice {
  name: string;
  accountsToReset: AccountView[];
  /** Whether the computer unpaired it too, or how to do that. */
  unpairNote: string;
}

export function DevicesSection({ devices }: { devices: DeviceView[] }) {
  const vault = useVault();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removed, setRemoved] = useState<RemovedDevice | null>(null);
  const canRemove = devices.some((d) => d.thisDevice && d.role === 'admin');

  const remove = async (device: DeviceView) => {
    setRemoving(device.id);
    try {
      const { accountsToReset, unpairNote } = await vault.removeDevice(device.id);
      setRemoved({ name: device.name, accountsToReset, unpairNote });
    } catch (e) {
      showFailure(`Could not remove ${device.name}`, e);
    } finally {
      setRemoving(null);
    }
  };

  const askRemove = (device: DeviceView) =>
    setConfirm({
      title: `Remove ${device.name}?`,
      message:
        `${device.name} stops getting changes, and anything it signs from now on is ignored. ` +
        'The vault gets a new key, so it cannot read accounts you add later. ' +
        'It still holds the accounts it has seen, so you will be shown which sites to reset.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => void remove(device),
    });

  return (
    <>
      <SectionHeading title="Trusted devices" />
      <Hint>Each device signs its own changes with a key that never leaves it. Compare the key words with what the device shows in its own settings.</Hint>
      {devices.map((device) => (
        <ItemRow
          key={device.id}
          icon={deviceGlyph(device)}
          title={device.thisDevice ? `${device.name} (this one)` : device.name}
          detail={deviceDetail(device)}
          warning={device.signedTwoHistories ? 'Signed two different histories. Remove it.' : undefined}
          trailing={
            canRemove && !device.thisDevice ? (
              <GhostButton small label={removing === device.id ? 'Removing…' : 'Remove'} disabled={removing !== null} onPress={() => askRemove(device)} />
            ) : null
          }
        />
      ))}
      {canRemove ? null : <Hint>Only an admin device can remove devices.</Hint>}
      <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />
      <ResetSitesSheet removed={removed} onClose={() => setRemoved(null)} />
    </>
  );
}

/** Key words, then when it was last heard from; this device is plainly alive, so it skips that. */
function deviceDetail(device: DeviceView): string {
  const keyWords = `Key words: ${device.keyWords}`;
  return device.thisDevice ? keyWords : `${keyWords}\n${lastHeard(device.lastHeardAt)}`;
}

/** After a removal: the accounts the removed device saw, to set up again at each site. */
function ResetSitesSheet({ removed, onClose }: { removed: RemovedDevice | null; onClose: () => void }) {
  const [shown, setShown] = useState(removed);
  if (removed && removed !== shown) setShown(removed);
  const accounts = shown?.accountsToReset ?? [];
  return (
    <Sheet
      visible={!!removed}
      onClose={onClose}
      title={shown ? `Removed ${shown.name}` : undefined}
      subtitle={accounts.length > 0 ? 'Reset 2FA on these sites' : undefined}
      maxWidth={600}
      footer={<PrimaryButton label="Done" onPress={onClose} />}
    >
      {shown ? <Text>{shown.unpairNote}</Text> : null}
      {accounts.length > 0 ? (
        <>
          <Text tone="dim">
            {`${shown?.name} saw the keys for these accounts. Anyone holding it could still make their codes, so at each site turn two-factor off and on again, then scan the new QR code here.`}
          </Text>
          <View style={{ gap: 12 }}>
            {accounts.map((account) => (
              <ItemRow key={account.id} icon={accountGlyph(account)} title={accountName(account)} detail={account.label} />
            ))}
          </View>
        </>
      ) : (
        <Text tone="dim">{`${shown?.name} never saw any accounts, so there is nothing to reset.`}</Text>
      )}
    </Sheet>
  );
}

export function BackupSection({ recovery, storage }: Pick<VaultSnapshot, 'recovery' | 'storage'>) {
  const cw = useColorway();
  const open = useAuthUi((s) => s.open);
  const saved = recovery.savedAt !== null;
  const finishing = recovery.finishing === true;
  const neverSet = !finishing && recovery.neverSet === true;
  const folder =
    storage.path && storage.computerName
      ? `${storage.path} on ${storage.computerName}. Safe to copy anywhere; it holds only encrypted data.`
      : storage.computerName
        ? `On ${storage.computerName}. The path shows when it is connected.`
        : 'Shown when the paired computer is connected.';
  return (
    <>
      <SectionHeading title="Backup" style={{ marginTop: 14 }} />
      <ItemRow
        icon={saved && !finishing ? 'check' : 'square-alert'}
        iconColor={saved && !finishing ? cw.ok : cw.run}
        title={finishing ? 'Finishing your new phrase…' : saved ? 'Recovery phrase saved' : neverSet ? 'Set up your recovery phrase' : 'Not saved yet'}
        titleColor={saved && !finishing ? undefined : cw.run}
        detail={
          finishing
            ? 'Your new vault and phrase are on this phone. AuthDeck finishes saving the vault to the computer when the computer is connected and the vault is open.'
            : recovery.savedAt !== null
              ? `Checked on ${shortDate(recovery.savedAt)}. Needed to restore the vault on a new device if all of these are lost.`
              : neverSet
                ? "This vault's recovery phrase was never shown and checked, so nothing can bring the vault back if this phone is lost. Set one up now."
                : 'Without the recovery phrase, losing every device here loses the vault.'
        }
      />
      <ItemRow icon="folder" title="Vault folder" detail={folder} />
      <View style={{ alignItems: 'flex-start' }}>
        {finishing ? null : (
          <GhostButton small icon={neverSet ? 'key' : 'reload'} label={neverSet ? 'Set up recovery phrase' : 'Make a new phrase'} onPress={() => open('recovery-setup')} />
        )}
      </View>
    </>
  );
}
