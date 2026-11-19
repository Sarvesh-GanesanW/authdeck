/**
 * The vault, full screen: accounts, trusted devices, backup and the signed history.
 * Three columns on wide screens, stacked sections on phones and portrait tablets.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { BackHandler, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SurfaceProps, VaultApi, VaultWarning } from '../../auth/contract';
import { useAuthUi } from '../../auth/ui';
import { useVault } from '../../auth/useVault';
import { useStore } from '../../state/store';
import { useUi } from '../../state/ui';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { type ConfirmRequest, ConfirmSheet } from '../settings/ConfirmSheet';
import { showFailure } from './feedback';
import { Glyph, type GlyphName } from '../../ui/Icon';
import { Panel, PANEL_FRONT } from '../../ui/Panel';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { Fill, HeaderButton, headerMetrics } from '../deck/HeaderButton';
import { AccountsSection } from './AccountsSection';
import { CaughtChangesNotice } from './CaughtChanges';
import { VoidedChangesNotice } from './VoidedChanges';
import { BackupSection, DevicesSection } from './DevicesSection';
import { vaultSummary } from './format';
import { ChainStatus, HistoryBody } from './HistorySection';
import { Alert, HeaderAccentIconButton, SECTION_GAP, SectionHeading, SectionWell } from './parts';
import { vaultFeatures } from '../../vault/features';
import { deviceUnlockWords } from '../../auth/engine/lockWords';
import { EnvSetsSection } from '../env/EnvSetsSection';
import { EnvSheets } from '../env/EnvSheets';

/** The locked panel's line about env sets: requests still arrive (EnvHostSheets). */
const REQUESTS_WHILE_LOCKED = 'Requests from your computer still reach you and ask you to unlock first.';

/** Gap between the three columns, and between stacked sections. */
const COLUMN_GAP = 20;

const WARNING_LOOK: Record<VaultWarning['kind'], { title: string; tone: 'danger' | 'warning' }> = {
  withheld: { title: 'Changes are missing here', tone: 'danger' },
  'fresh-key': { title: 'The vault needs a fresh key', tone: 'danger' },
  fork: { title: 'A device signed two different histories', tone: 'danger' },
  implausible: { title: 'A device sent a status note that makes no sense', tone: 'warning' },
  unheard: { title: 'A device has been quiet', tone: 'warning' },
  joins: { title: 'Join attempts were stopped', tone: 'warning' },
  waiting: { title: 'Some changes are waiting', tone: 'warning' },
  key: { title: 'Some old accounts may be unreadable', tone: 'warning' },
  'no-recovery': { title: 'No recovery phrase', tone: 'warning' },
  'prev-key': { title: 'A key change hides older accounts', tone: 'danger' },
  'bad-seal': { title: 'A device gave out a vault key that does not open', tone: 'danger' },
  'lost-own-line': { title: 'This device can no longer change the vault', tone: 'danger' },
};

export function VaultScreen({ onClose }: SurfaceProps) {
  const vault = useVault();
  const cw = useColorway();
  const insets = useSafeAreaInsets();
  const { compact } = useScreen();
  const m = headerMetrics(compact);
  const open = vault.status === 'open';

  // It covers the deck, so the back button leaves it as "Deck" does.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  // The vault covers the whole app, deck included: sharing the height with the deck left neither
  // room for its keys nor for the vault. The deck stays mounted underneath; "Deck" returns to it.
  const frame = {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: cw.case,
    paddingTop: insets.top + (compact ? 12 : m.margin),
    paddingLeft: insets.left + m.margin,
    paddingRight: insets.right + m.margin,
  };

  return (
    <View style={frame} accessibilityViewIsModal>
      <Header vault={vault} onClose={onClose} />
      {open ? <OpenVault vault={vault} onLeave={onClose} /> : <ClosedVault vault={vault} onLeave={onClose} />}
      {/* At the frame's root, not in a scroll view: the set sheets are SecureSheets covering the screen. */}
      {open ? <EnvSheets /> : null}
    </View>
  );
}

function Header({ vault, onClose }: { vault: VaultApi; onClose: () => void }) {
  const { compact } = useScreen();
  const openSurface = useAuthUi((s) => s.open);
  const m = headerMetrics(compact);
  const isOpen = vault.status === 'open';
  const summary = isOpen ? vaultSummary(vault) : null;
  const back = <HeaderButton label="Deck" icon="arrow-left" accessibilityLabel="Back to the deck" compact={compact} onPress={onClose} />;
  const lock = isOpen ? <HeaderButton label="Lock now" icon="lock" iconOnly={compact} compact={compact} onPress={() => vault.lock()} /> : null;
  const add =
    isOpen && !vault.removed ? <HeaderAccentIconButton label="Add account" icon="plus" compact={compact} onPress={() => openSurface('add-account')} /> : null;
  const title = (
    <Text variant="title" accessibilityRole="header" numberOfLines={1}>
      Vault
    </Text>
  );

  if (compact) {
    return (
      <View style={{ gap: m.gap }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: m.gap, height: m.control + 4 }}>
          {back}
          <Fill />
          {lock}
          {add}
        </View>
        <View style={{ gap: 2 }}>
          {title}
          {summary ? (
            <Text variant="caption" tone="dim">
              {summary}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: m.gap, height: m.control + 4 }}>
      {back}
      <View style={{ marginLeft: 8, flexShrink: 0 }}>{title}</View>
      {summary ? (
        <Text variant="label" tone="dim" numberOfLines={1} style={{ flexShrink: 1, marginLeft: 4 }}>
          {summary}
        </Text>
      ) : null}
      <Fill />
      {lock}
      {add}
    </View>
  );
}

function OpenVault({ vault, onLeave }: { vault: VaultApi; onLeave: () => void }) {
  const insets = useSafeAreaInsets();
  const { wide, compact } = useScreen();
  const m = headerMetrics(compact);
  const bottom = insets.bottom + m.margin;
  const accounts = <AccountsSection accounts={vault.accounts} fill={wide} />;
  const devices = (
    <>
      {vaultFeatures.multiDevice ? <DevicesSection devices={vault.devices} /> : null}
      <BackupSection recovery={vault.recovery} storage={vault.storage} />
    </>
  );
  const historyHeading = <SectionHeading title="History" accessory={<ChainStatus chainOk={vault.chainOk} />} />;
  const history = <HistoryBody history={vault.history} rollbackWarning={vault.rollbackWarning} />;
  const caught = vault.caughtChanges.length > 0;
  const voided = vault.voidedChanges.length > 0;
  const warnings =
    vault.removed || vault.warnings.length > 0 || caught || voided ? (
      <View style={{ gap: SECTION_GAP }}>
        {vault.removed ? <RemovedNotice vault={vault} onLeave={onLeave} /> : null}
        {vault.warnings.length > 0 ? <WarningBanners warnings={vault.warnings} /> : null}
        {voided ? <VoidedChangesNotice changes={vault.voidedChanges} /> : null}
        {caught ? <CaughtChangesNotice changes={vault.caughtChanges} /> : null}
      </View>
    ) : null;

  if (wide) {
    return (
      <View style={{ flex: 1, gap: COLUMN_GAP, marginTop: 18, paddingBottom: bottom }}>
        {warnings}
        <View style={{ flex: 1, flexDirection: 'row', gap: COLUMN_GAP, minHeight: 0 }}>
          <View style={{ flex: 1, minWidth: 0 }}>{accounts}</View>
          <ScrollingColumn>
            <EnvSetsSection inColumn />
            {devices}
          </ScrollingColumn>
          <ScrollingColumn heading={historyHeading}>{history}</ScrollingColumn>
        </View>
      </View>
    );
  }
  return (
    <ScrollView
      style={{ flex: 1, marginTop: compact ? 16 : 18, marginHorizontal: -m.margin }}
      contentContainerStyle={{ gap: compact ? 16 : COLUMN_GAP, paddingHorizontal: m.margin, paddingBottom: bottom }}
      showsVerticalScrollIndicator={false}
    >
      {warnings}
      {accounts}
      <EnvSetsSection />
      <SectionWell>{devices}</SectionWell>
      <SectionWell>
        {historyHeading}
        {history}
      </SectionWell>
    </ScrollView>
  );
}

/** The engine's warnings, most serious first, above everything else on the open vault. */
function WarningBanners({ warnings }: { warnings: VaultWarning[] }) {
  const cw = useColorway();
  const openSurface = useAuthUi((s) => s.open);
  return (
    <View style={{ gap: SECTION_GAP }}>
      {warnings.map((warning) => (
        <Alert key={warning.id} title={WARNING_LOOK[warning.kind].title} tone={WARNING_LOOK[warning.kind].tone}>
          {warning.kind === 'lost-own-line' ? (
            <LostOwnLine text={warning.text} />
          ) : warning.kind === 'no-recovery' ? (
            <View style={{ gap: 12 }}>
              <Text variant="caption" color={cw.run} style={{ opacity: 0.85 }}>
                {warning.text}
              </Text>
              <View style={{ alignItems: 'flex-start' }}>
                <GhostButton small icon="key" label="Set a recovery phrase" onPress={() => openSurface('recovery-setup')} />
              </View>
            </View>
          ) : (
            warning.text
          )}
        </Alert>
      ))}
    </View>
  );
}

/** A line of its own lost for good (lostOwnLine.ts): the text, and the one way on, deleting the vault here. */
function LostOwnLine({ text }: { text: string }) {
  const cw = useColorway();
  const vault = useVault();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const askDelete = () =>
    setConfirm({
      title: 'Delete the vault from this device?',
      message: "Its codes and keys are deleted here. The vault folder on the computer doesn't change. Then restore the vault with your recovery phrase.",
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        vault.deleteRemovedVault().catch((e: unknown) => showFailure('Could not delete the vault from this device', e));
      },
    });
  return (
    <View style={{ gap: 12 }}>
      <Text variant="caption" color={cw.dangerText} style={{ opacity: 0.85 }}>
        {text}
      </Text>
      <View style={{ alignItems: 'flex-start' }}>
        <GhostButton small danger icon="trash" label="Delete the vault from this device" onPress={askDelete} />
      </View>
      <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />
    </View>
  );
}

/**
 * This device was removed: who did it, and the one way to delete its copy. Nothing is deleted
 * until the person confirms, so a removal made by mistake or by an attacker can still be undone
 * with the recovery phrase while the codes stay readable.
 */
function RemovedNotice({ vault, onLeave }: { vault: VaultApi; onLeave: () => void }) {
  const cw = useColorway();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const askDelete = () =>
    setConfirm({
      title: 'Delete the vault from this device?',
      message: vaultFeatures.multiDevice
        ? "Its codes and keys are deleted here. The vault on your other devices doesn't change. To use the vault on this device again, join it from a device that is still in it."
        : "Its codes and keys are deleted here. The vault folder on the computer doesn't change. To use the vault on this device again, restore it with your recovery phrase.",
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        vault.deleteRemovedVault().catch((e: unknown) => showFailure('Could not delete the vault from this device', e));
      },
    });
  return (
    <>
      <Alert title="This device was removed from the vault">
        <View style={{ gap: 12 }}>
          <Text variant="caption" color={cw.dangerText} style={{ opacity: 0.85 }}>
            {vault.removed}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {vault.heldRemoval ? <RePairButton onLeave={onLeave} /> : null}
            <GhostButton small danger icon="trash" label="Delete from this device" onPress={askDelete} />
          </View>
        </View>
      </Alert>
      <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

/**
 * Re-pairs the computer this device uses, the way Computers' Re-pair does, so a removal this
 * device signed of the device that removed it goes out with the next sync. The vault closes,
 * since the pairing screen replaces the deck.
 */
function RePairButton({ onLeave }: { onLeave: () => void }) {
  const activeId = useStore((s) => s.activeId);
  const rePair = () => {
    onLeave();
    useUi.getState().startPairing(null, activeId);
  };
  return <GhostButton small icon="key" label="Re-pair" onPress={rePair} />;
}

/** A column on wide screens: a sunken section whose contents scroll, with an optional fixed heading. */
function ScrollingColumn({ heading, children }: { heading?: ReactNode; children: ReactNode }) {
  return (
    <SectionWell style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      {heading}
      <ScrollView
        style={{ flex: 1, marginHorizontal: -6 }}
        contentContainerStyle={{ gap: SECTION_GAP, paddingHorizontal: 6, paddingBottom: 4 }}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </SectionWell>
  );
}

/** Locked, not set up yet, or still loading: one panel in the middle of the screen. */
function ClosedVault({ vault, onLeave }: { vault: VaultApi; onLeave: () => void }) {
  const insets = useSafeAreaInsets();
  const { compact } = useScreen();
  const content = vault.status === 'locked' ? <Locked vault={vault} onLeave={onLeave} /> : vault.status === 'none' ? <NoVault /> : <Loading />;
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: compact ? 24 : 40,
        paddingBottom: insets.bottom + 24,
      }}
      showsVerticalScrollIndicator={false}
    >
      {content}
    </ScrollView>
  );
}

function StatePanel({ icon, iconColor, title, children }: { icon: GlyphName; iconColor?: string; title: string; children: ReactNode }) {
  const cw = useColorway();
  const { compact } = useScreen();
  return (
    <Panel
      style={{
        width: '100%',
        maxWidth: 520,
        paddingTop: compact ? 24 : 32,
        paddingHorizontal: compact ? 20 : 32,
        paddingBottom: (compact ? 24 : 32) + PANEL_FRONT,
      }}
    >
      <View style={{ gap: 16 }}>
        <Glyph name={icon} size={48} color={iconColor ?? cw.focus} />
        <Text variant="heading" accessibilityRole="header">
          {title}
        </Text>
        {children}
      </View>
    </Panel>
  );
}

function Locked({ vault, onLeave }: { vault: VaultApi; onLeave: () => void }) {
  const openSurface = useAuthUi((s) => s.open);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const unlock = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await vault.unlock();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'The vault did not open. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <StatePanel icon="lock" title="Vault locked">
      {vault.removed ? <Text tone="danger">{vault.removed}</Text> : null}
      {vault.appLockBlocked ? (
        <Text tone="danger">{`${vault.appLockBlocked} Or unlock with your recovery phrase.`}</Text>
      ) : (
        <Text tone="dim">
          {vault.appLock
            ? `Unlock with ${deviceUnlockWords(Platform.OS)} to see your codes and env sets. ${REQUESTS_WHILE_LOCKED}`
            : `Open the vault to see your codes and env sets. ${REQUESTS_WHILE_LOCKED} Turn on app lock in Settings to ask for ${deviceUnlockWords(Platform.OS)} first.`}
        </Text>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {vault.appLockBlocked ? (
          <PrimaryButton label="Unlock with recovery phrase" icon="key" onPress={() => openSurface('restore')} />
        ) : (
          <PrimaryButton label="Unlock" icon="unlock" busy={busy} onPress={() => void unlock()} />
        )}
        {vault.appLock && !vault.appLockBlocked ? <GhostButton label="Use recovery phrase" icon="key" onPress={() => openSurface('restore')} /> : null}
        {vault.heldRemoval ? <RePairButton onLeave={onLeave} /> : null}
      </View>
      {problem && problem !== vault.appLockBlocked ? (
        <Text tone="danger" accessibilityLiveRegion="polite">
          {problem}
        </Text>
      ) : null}
    </StatePanel>
  );
}

function NoVault() {
  const open = useAuthUi((s) => s.open);
  return (
    <StatePanel icon="shield" title="No vault yet">
      <Text tone="dim">
        Keep your two-factor codes on this device and type them on your computer with a key. The vault is encrypted here and synced through a folder on your
        computer.
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <PrimaryButton label="Set up" icon="plus" onPress={() => open('intro')} />
        {vaultFeatures.multiDevice ? <GhostButton label="Join from another device" icon="phone" onPress={() => open('join')} /> : null}
      </View>
      <View style={{ alignItems: 'flex-start' }}>
        <GhostButton small label="Restore with a recovery phrase" icon="key" onPress={() => open('restore')} />
      </View>
    </StatePanel>
  );
}

function Loading() {
  return (
    <Text tone="dim" accessibilityLiveRegion="polite">
      Opening the vault…
    </Text>
  );
}
