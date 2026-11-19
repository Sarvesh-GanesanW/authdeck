/**
 * Moving accounts over from Google Authenticator: it exports them as one or more QR codes
 * (batches). Scan each, then review the list and add the ones you want.
 */
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import type { NewAccount } from '../../auth/contract';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { GhostButton, Press, PrimaryButton } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { Well } from '../../ui/Panel';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { VOXEL } from '../../ui/voxel';
import { accountKey, announceAdded, isInVault } from './addFlow';
import { accountName, codeShape, plural } from './format';
import { Problems } from './Problems';
import { QrScanner } from './QrScanner';
import type { AddStep } from './ScanStep';

interface Found {
  key: string;
  account: NewAccount;
  inVault: boolean;
}

interface Batches {
  /** QR codes of the current export read so far, as the engine counts them (a repeat counts once). */
  scanned: number;
  total: number;
}

const NO_BATCHES: Batches = { scanned: 0, total: 0 };

export function useImportStep({
  onDone,
  onTypeKey,
  firstCode,
}: {
  onDone: () => void;
  onTypeKey: () => void;
  /** An export already scanned on the scan step, read on arrival. */
  firstCode: string | null;
}): AddStep {
  const vault = useVault();
  const [found, setFound] = useState<Found[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batches, setBatches] = useState<Batches>(NO_BATCHES);
  const [problems, setProblems] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);

  const onCode = (text: string) => {
    const preview = vault.parseQr(text);
    setProblems(preview.problems);
    if (preview.accounts.length === 0) {
      haptics.warning();
      return;
    }
    haptics.success();
    const known = new Set(found.map((f) => f.key));
    const fresh = preview.accounts
      .map((account) => ({ key: `${accountKey(account)}\n${account.secret}`, account, inVault: isInVault(account, vault.accounts) }))
      .filter((f) => !known.has(f.key));
    setFound((all) => [...all, ...fresh]);
    setSelected((all) => new Set([...all, ...fresh.filter((f) => !f.inVault).map((f) => f.key)]));
    const next = preview.batches ? { scanned: preview.batches.scanned, total: preview.batches.total } : { scanned: 1, total: 1 };
    setBatches(next);
    if (next.scanned >= next.total) setReviewing(true);
  };

  // Read the export the scan step handed over, once.
  const handedOver = useRef(false);
  useEffect(() => {
    if (!firstCode || handedOver.current) return;
    handedOver.current = true;
    onCode(firstCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstCode]);

  const toggle = (key: string) =>
    setSelected((all) => {
      const next = new Set(all);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const chosen = found.filter((f) => selected.has(f.key)).map((f) => f.account);
  const add = async () => {
    setBusy(true);
    try {
      await vault.addAccounts(chosen);
      announceAdded(chosen);
      onDone();
    } catch (e) {
      haptics.error();
      setProblems([e instanceof Error ? e.message : 'The accounts were not added. Try again.']);
    } finally {
      setBusy(false);
    }
  };

  if (reviewing) {
    const missing = batches.total - batches.scanned;
    return {
      body: (
        <>
          <Text tone="dim">
            {missing > 0
              ? `${plural(missing, 'QR code')} from the export ${missing === 1 ? 'was' : 'were'} not scanned, so some accounts may be missing. Pick the ones to add.`
              : 'Pick the accounts to add. Ones already in the vault are left unticked.'}
          </Text>
          <View style={{ gap: 10 }}>
            {found.map((f) => (
              <ReviewRow key={f.key} found={f} checked={selected.has(f.key)} onToggle={() => toggle(f.key)} />
            ))}
          </View>
          <Problems problems={problems} />
          {missing > 0 ? (
            <View style={{ alignItems: 'flex-start' }}>
              <GhostButton small icon="qr-code" label="Scan the rest" onPress={() => setReviewing(false)} />
            </View>
          ) : null}
        </>
      ),
      action: (
        <PrimaryButton
          label={chosen.length === 1 ? 'Add 1 account' : `Add ${chosen.length} accounts`}
          disabled={chosen.length === 0}
          busy={busy}
          onPress={() => void add()}
        />
      ),
    };
  }

  const progress = batches.total > 1 ? `${batches.scanned} of ${batches.total} scanned, scan the next one` : 'Scan the QR code Google Authenticator shows.';
  return {
    body: (
      <>
        <TransferHelp />
        <Text weight="semibold" accessibilityLiveRegion="polite">
          {progress}
        </Text>
        <QrScanner onCode={onCode} onTypeKey={onTypeKey} label="Camera view for the Google Authenticator export" />
        <Problems problems={problems} />
      </>
    ),
    action:
      found.length > 0 ? <GhostButton grow icon="check" label={`Review ${plural(found.length, 'account')} so far`} onPress={() => setReviewing(true)} /> : null,
  };
}

function TransferHelp() {
  const steps = [
    'On the phone with Google Authenticator, open the menu and tap Transfer accounts, then Export accounts.',
    'Pick the accounts to move and tap Next.',
    'Scan each QR code it shows. Big exports come as several codes; scan them all.',
    'The accounts are copied, so they keep working in Google Authenticator until you remove them there.',
  ];
  return (
    <Well steps={2} style={{ padding: 16, paddingTop: 16 + VOXEL, gap: 10 }}>
      {steps.map((step, i) => (
        <View key={step} style={{ flexDirection: 'row', gap: 10 }}>
          <Text variant="caption" weight="semibold" tone="focus">
            {`${i + 1}.`}
          </Text>
          <Text variant="caption" tone="dim" style={{ flex: 1 }}>
            {step}
          </Text>
        </View>
      ))}
    </Well>
  );
}

function ReviewRow({ found, checked, onToggle }: { found: Found; checked: boolean; onToggle: () => void }) {
  const cw = useColorway();
  const { account } = found;
  const detail = [account.label, found.inVault ? 'already in the vault' : codeShape(account)].filter(Boolean).join(', ');
  return (
    <Press
      onPress={onToggle}
      scaleTo={0.98}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={`${accountName(account)}, ${account.label}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingTop: 12 + VOXEL, paddingBottom: 12 }}
    >
      <Well color={cw.surfaceAlt} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      <Glyph name={checked ? 'checkbox-on' : 'checkbox'} size={24} color={checked ? cw.focus : cw.textFaint} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text weight="semibold" numberOfLines={1}>
          {accountName(account)}
        </Text>
        <Text variant="caption" tone="dim">
          {detail}
        </Text>
      </View>
    </Press>
  );
}
