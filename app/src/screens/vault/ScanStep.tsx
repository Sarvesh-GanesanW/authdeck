/** Adding one account from a site's QR code: scan, check the names, add. */
import { type ReactNode, useState } from 'react';
import { View } from 'react-native';

import type { NewAccount } from '../../auth/contract';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { Field, LinkButton, PrimaryButton } from '../../ui/controls';
import { Well } from '../../ui/Panel';
import { Text } from '../../ui/Text';
import { VOXEL } from '../../ui/voxel';
import { announceAdded } from './addFlow';
import { accountName, codeShape } from './format';
import { Problems } from './Problems';
import { FoundFrame, QrScanner } from './QrScanner';

export interface AddStep {
  body: ReactNode;
  /** The main button, pinned at the bottom; null when there is nothing to confirm yet. */
  action: ReactNode;
}

export function useScanStep({
  onDone,
  onTypeKey,
  onMigration,
}: {
  onDone: () => void;
  onTypeKey: () => void;
  /** A Google Authenticator export was scanned here; hand its text to the import step. */
  onMigration: (text: string) => void;
}): AddStep {
  const vault = useVault();
  const [found, setFound] = useState<NewAccount | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const onCode = (text: string) => {
    const preview = vault.parseQr(text);
    if (preview.batches || preview.accounts.length > 1) {
      onMigration(text);
      return;
    }
    const [account] = preview.accounts;
    setProblems(preview.problems);
    if (!account) {
      haptics.warning();
      return;
    }
    haptics.success();
    setFound(account);
  };

  const add = async () => {
    if (!found) return;
    const account = { ...found, issuer: found.issuer.trim(), label: found.label.trim() };
    const invalid = vault.checkAccount(account);
    setProblems(invalid);
    if (invalid.length > 0) return;
    setBusy(true);
    try {
      await vault.addAccounts([account]);
      announceAdded([account]);
      onDone();
    } catch (e) {
      haptics.error();
      setProblems([e instanceof Error ? e.message : 'The account was not added. Try again.']);
    } finally {
      setBusy(false);
    }
  };

  const scanAgain = () => {
    setFound(null);
    setProblems([]);
  };

  const body = found ? (
    <>
      <FoundFrame label={`Found ${accountName(found)}`} />
      <FoundCard account={found} onChange={setFound} />
      <Problems problems={problems} />
    </>
  ) : (
    <>
      <QrScanner onCode={onCode} onTypeKey={onTypeKey} label="Camera view for the two-factor QR code" />
      <Text variant="caption" tone="dim">
        Point the camera at the QR code on the site's two-factor setup page.
      </Text>
      <Problems problems={problems} />
    </>
  );

  const action = found ? (
    <View style={{ gap: 14 }}>
      <PrimaryButton label="Add account" busy={busy} onPress={() => void add()} />
      <LinkButton label="Scan a different code" onPress={scanAgain} />
    </View>
  ) : null;

  return { body, action };
}

/** The account a QR code described, with its names editable before it is added. */
function FoundCard({ account, onChange }: { account: NewAccount; onChange: (account: NewAccount) => void }) {
  return (
    <Well steps={2} style={{ padding: 16, paddingTop: 16 + VOXEL, gap: 14 }}>
      <Field label="Name on the key" value={account.issuer} onChangeText={(issuer) => onChange({ ...account, issuer })} placeholder="GitHub" />
      <Field
        label="Account"
        value={account.label}
        onChangeText={(label) => onChange({ ...account, label })}
        placeholder="you@example.com"
        autoCapitalize="none"
      />
      <Text variant="caption" tone="dim">
        {codeShape(account)}
      </Text>
    </Well>
  );
}
