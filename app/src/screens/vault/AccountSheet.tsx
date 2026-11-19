/** One account up close: its live code, typing it on the computer, renaming and deleting. */
import { useState } from 'react';
import { View } from 'react-native';

import type { AccountView } from '../../auth/contract';
import { useCode, useVault } from '../../auth/useVault';
import { Field, GhostButton, PrimaryButton } from '../../ui/controls';
import { Well } from '../../ui/Panel';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { VOXEL } from '../../ui/voxel';
import { type ConfirmRequest, ConfirmSheet } from '../settings/ConfirmSheet';
import { unheardNote } from './addFlow';
import { showDone, showFailure } from './feedback';
import { accountName, spacedCode } from './format';

/** Codes this close to changing are drawn in the warning colour, so nobody types a stale one. */
const SECONDS_RUNNING_OUT = 5;

export function AccountSheet({ account, onClose }: { account: AccountView | null; onClose: () => void }) {
  // Keep showing the last account while the sheet animates away.
  const [shown, setShown] = useState(account);
  if (account && account !== shown) setShown(account);
  return (
    <Sheet visible={!!account} onClose={onClose} title={shown ? accountName(shown) : undefined} subtitle={shown?.label} maxWidth={560}>
      {shown ? <AccountDetail key={shown.id} account={shown} onDeleted={onClose} /> : null}
    </Sheet>
  );
}

function AccountDetail({ account, onDeleted }: { account: AccountView; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const vault = useVault();
  const name = accountName(account);

  const askDelete = () =>
    setConfirm({
      title: `Delete ${name}?`,
      message:
        `Codes for ${account.label || name} stop working here and on your other devices. ` +
        `Turn off two-factor at ${name} first, or you may not be able to sign in there.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        vault
          .deleteAccount(account.id)
          .then(() => {
            onDeleted();
            showDone(`Deleted ${name}`);
          })
          .catch((e: unknown) => showFailure(`Could not delete ${name}`, e));
      },
    });

  return (
    <>
      <LiveCode account={account} />
      <TypeOnComputer account={account} />
      <RenameForm account={account} />
      <View style={{ gap: 8 }}>
        <Text variant="label" tone="dim">
          Remove
        </Text>
        <View style={{ alignItems: 'flex-start' }}>
          <GhostButton danger icon="trash" label="Delete account" onPress={askDelete} />
        </View>
      </View>
      <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

function LiveCode({ account }: { account: AccountView }) {
  const cw = useColorway();
  const { compact } = useScreen();
  const code = useCode(account.id);
  const runningOut = !!code && code.period > 0 && code.secondsLeft <= SECONDS_RUNNING_OUT;
  const countdown = !code ? 'Unlock the vault to see the code.' : code.period === 0 ? 'Stays until you use it.' : `New code in ${code.secondsLeft} s`;
  return (
    <Well steps={2} style={{ paddingTop: 18 + VOXEL, paddingBottom: 18, paddingHorizontal: 20, gap: 10 }}>
      <Text
        selectable
        accessibilityLabel={code ? `Code ${code.code.split('').join(' ')}` : 'No code'}
        style={{ fontSize: compact ? 40 : 48, lineHeight: compact ? 48 : 56, letterSpacing: 2, color: runningOut ? cw.run : cw.text }}
        weight="semibold"
        variant="mono"
      >
        {code ? spacedCode(code.code) : '– – –'}
      </Text>
      {code && code.period > 0 ? <CountdownBar fraction={code.secondsLeft / code.period} color={runningOut ? cw.run : cw.ok} /> : null}
      <Text variant="caption" tone="dim" accessibilityLiveRegion="polite">
        {countdown}
      </Text>
    </Well>
  );
}

/** Time left on the code, drawn in voxel-wide steps. */
function CountdownBar({ fraction, color }: { fraction: number; color: string }) {
  const cw = useColorway();
  return (
    <View style={{ height: VOXEL * 2, backgroundColor: cw.surfaceAlt }}>
      <View style={{ width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`, height: '100%', backgroundColor: color }} />
    </View>
  );
}

function TypeOnComputer({ account }: { account: AccountView }) {
  const vault = useVault();
  const [busy, setBusy] = useState(false);
  const computer = vault.storage.computerName ?? 'the computer';
  const typeCode = async () => {
    setBusy(true);
    try {
      await vault.typeCode(account.id);
      showDone(`Typed the ${accountName(account)} code on ${computer}`);
    } catch (e) {
      showFailure(`Could not type the code on ${computer}`, e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 8 }}>
      <PrimaryButton label={`Type on ${computer}`} icon="keyboard" disabled={!vault.computerOnline} busy={busy} onPress={() => void typeCode()} />
      <Text variant="caption" tone="dim">
        {vault.computerOnline
          ? 'Types only the digits where the cursor is on the computer.'
          : `${computer} is offline. Read the code from here, or connect it to type the code.`}
      </Text>
    </View>
  );
}

function RenameForm({ account }: { account: AccountView }) {
  const vault = useVault();
  const [issuer, setIssuer] = useState(account.issuer);
  const [label, setLabel] = useState(account.label);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const changed = issuer.trim() !== account.issuer || label.trim() !== account.label;
  const named = !!(issuer.trim() || label.trim());
  // A rename writes the whole record, secret included, under the current key.
  const askThenSave = () => {
    const unheard = unheardNote(vault.warnings);
    if (!unheard) return void save();
    setConfirm({ title: 'Save anyway?', message: unheard, confirmLabel: 'Save anyway', onConfirm: () => void save() });
  };
  const save = async () => {
    setBusy(true);
    try {
      await vault.renameAccount(account.id, issuer.trim(), label.trim());
      showDone('Saved the new name');
    } catch (e) {
      showFailure('Could not rename the account', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 14 }}>
      <Field label="Name on the key" value={issuer} onChangeText={setIssuer} placeholder="GitHub" />
      <Field label="Account" value={label} onChangeText={setLabel} placeholder="you@example.com" autoCapitalize="none" />
      {named ? null : (
        <Text variant="caption" tone="danger">
          Give the account a name so you can tell it apart.
        </Text>
      )}
      <View style={{ alignItems: 'flex-start' }}>
        <GhostButton icon="pencil" label={busy ? 'Saving…' : 'Save name'} disabled={!changed || !named || busy} onPress={askThenSave} />
      </View>
      <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />
    </View>
  );
}
