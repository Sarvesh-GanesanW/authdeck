/**
 * Full-screen pairing. Finds the computer three ways (network scan, the agent's QR code,
 * a typed address), then takes its 6-digit PIN. Also re-pairs a computer whose token was refused.
 * A QR code or deep link is shown for checking first; it pairs only once the person confirms.
 */
import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PairLink } from '../../net/discovery';
import { KEY_IN_BROWSER_NOTICE, keyIsInBrowserStorage } from '../../net/linkIdentity';
import type { Computer } from '../../state/model';
import { needsRepair, useStore } from '../../state/store';
import { useUi } from '../../state/ui';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { Well } from '../../ui/Panel';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { Bands, outlineBands, VOXEL } from '../../ui/voxel';
import { ConfirmSheet, type ConfirmRequest } from '../settings/ConfirmSheet';
import { AddressSheet } from './AddressSheet';
import { BrandMark } from './ComputerTile';
import { LinkConfirmSheet } from './LinkConfirmSheet';
import { NetworkPanel } from './NetworkPanel';
import type { KeyChange } from './pairFlow';
import { AGENT_COMMAND, type PairTarget, targetFromComputer, unpairedNotice } from './pairing';
import { PhonePinStep } from './PinStep';
import { ScanSheet } from './ScanSheet';
import { usePairFlow } from './usePairFlow';
import { useNetworkScan } from './useNetworkScan';

const canScanQr = Platform.OS !== 'web';

type FinderSheet = 'qr' | 'address' | null;

export function PairScreen() {
  const screen = useScreen();
  const insets = useSafeAreaInsets();
  const cw = useColorway();
  const pairLink = useUi((s) => s.pairLink);
  const repairAgentId = useUi((s) => s.repairAgentId);
  const repairing = useStore((s) => s.computers.find((c) => c.agentId === repairAgentId) ?? null);
  const unpaired = useUi((s) => s.repairReason === 'unpaired') && repairing !== null;
  const canCancel = useStore((s) => s.computers.some((c) => c.agentId === s.activeId));
  const flow = usePairFlow(repairing && !pairLink ? targetFromComputer(repairing) : null, unpaired ? unpairedNotice(repairing.name) : null);
  const scan = useNetworkScan();
  const [sheet, setSheet] = useState<FinderSheet>(null);
  const { offerLink, choose, keyChange, pairAnyway } = flow;
  // Memoized: ConfirmSheet treats a new request object as a new question.
  const keyQuestion = useMemo(() => keyChangeQuestion(keyChange, pairAnyway), [keyChange, pairAnyway]);

  // A link from the system camera or a deep link: show the computer it names and wait for a yes.
  useEffect(() => {
    if (!pairLink) return;
    setSheet(null);
    offerLink(pairLink);
  }, [pairLink, offerLink]);

  // The scanner stays open under the question, so one sheet never replaces another mid-animation.
  const onQrLink = (link: PairLink) => offerLink(link);
  const closeLinkQuestion = (confirmed: boolean) => {
    if (confirmed) flow.confirmLink();
    else flow.dismissLink();
    setSheet(null);
    // Answered: the same deep link must not ask again when this screen mounts next.
    if (useUi.getState().pairLink) useUi.setState({ pairLink: null });
  };
  const onAddressFound = (target: PairTarget) => {
    setSheet(null);
    choose(target);
  };

  const copy = pairingCopy(repairing, unpaired);
  const phonePin = screen.compact && flow.target;
  const twoColumns = screen.wide;

  const linkQuestion = <LinkConfirmSheet link={flow.offeredLink} onConfirm={() => closeLinkQuestion(true)} onCancel={() => closeLinkQuestion(false)} />;
  const scanning = canScanQr && sheet === 'qr';
  const sheets = (
    <>
      {canScanQr ? (
        <ScanSheet visible={sheet === 'qr'} onClose={() => setSheet(null)} onLink={onQrLink}>
          {scanning ? linkQuestion : null}
        </ScanSheet>
      ) : null}
      {scanning ? null : linkQuestion}
      <AddressSheet visible={sheet === 'address'} onClose={() => setSheet(null)} onFound={onAddressFound} />
      <ConfirmSheet request={keyQuestion} onClose={flow.keepSaved} />
    </>
  );

  if (phonePin) {
    return (
      <View style={{ flex: 1, backgroundColor: cw.case }}>
        <PhonePinStep flow={flow} target={flow.target!} onBack={() => choose(null)} />
        {sheets}
      </View>
    );
  }

  const intro = (
    <Intro
      title={copy.title}
      lead={copy.lead}
      large={!screen.compact}
      canCancel={canCancel}
      onCancel={() => useUi.getState().finishPairing()}
    />
  );
  const panel = (
    <NetworkPanel scan={scan} flow={flow} inlinePin={!screen.compact} onEnterAddress={() => setSheet('address')} fill={twoColumns} />
  );

  const pad = {
    paddingTop: insets.top + (screen.compact ? 24 : 56),
    paddingBottom: insets.bottom + (screen.compact ? 24 : 48),
    paddingLeft: insets.left + (screen.compact ? 22 : 64),
    paddingRight: insets.right + (screen.compact ? 22 : 64),
  };

  // Where the network can't be searched (browsers), the panel's own Enter address
  // button is the way in; a second one below would repeat it.
  const panelOffersAddress = scan.status === 'unsupported';

  if (twoColumns) {
    return (
      <Animated.View entering={FadeIn.duration(260)} style={[{ flex: 1, flexDirection: 'row', gap: 56, backgroundColor: cw.case }, pad]}>
        <ScrollView
          style={{ width: Math.min(620, screen.width * 0.4), flexGrow: 0, flexShrink: 0 }}
          contentContainerStyle={{ flexGrow: 1, gap: 40 }}
          showsVerticalScrollIndicator={false}
        >
          {intro}
          <View style={{ flex: 1 }} />
          {canScanQr || !panelOffersAddress ? (
            <Finders
              grow={false}
              onScanQr={canScanQr ? () => setSheet('qr') : null}
              onEnterAddress={panelOffersAddress ? null : () => setSheet('address')}
            />
          ) : null}
        </ScrollView>
        {panel}
        {sheets}
      </Animated.View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(260)} style={{ flex: 1, backgroundColor: cw.case }}>
      <ScrollView contentContainerStyle={[{ flexGrow: 1, gap: screen.compact ? 24 : 32 }, pad]} showsVerticalScrollIndicator={false}>
        {intro}
        {canScanQr ? <Finders grow onScanQr={() => setSheet('qr')} onEnterAddress={null} /> : null}
        {panel}
        <View style={{ flex: 1 }} />
        {panelOffersAddress ? null : <Finders grow={screen.compact} onScanQr={null} onEnterAddress={() => setSheet('address')} />}
      </ScrollView>
      {sheets}
    </Animated.View>
  );
}

/**
 * Asked when a pairing could be mistaken for a saved computer: it answered with that computer's id
 * but a different key, it is a computer saved before link keys reached by QR code or link, or it
 * is another computer using that name.
 */
function keyChangeQuestion(change: KeyChange | null, pairAnyway: () => void): ConfirmRequest | null {
  if (!change) return null;
  if (change.conflict === 'legacy') {
    return {
      title: `Is this ${change.name}?`,
      message: `${change.message}\n\nThis computer's key words: ${change.newWords}`,
      confirmLabel: 'They match',
      onConfirm: pairAnyway,
    };
  }
  return {
    title: change.conflict === 'key' ? `${change.name} has a different key` : `Another computer called ${change.name}`,
    message: `${change.message}\n\nSaved key words: ${change.savedWords}\nThis computer's key words: ${change.newWords}`,
    confirmLabel: 'Pair anyway',
    danger: true,
    onConfirm: pairAnyway,
  };
}

function pairingCopy(repairing: Computer | null, unpaired: boolean) {
  if (repairing && unpaired) {
    return {
      title: `${repairing.name} unpaired this device`,
      lead: `Open pairing in AuthDeck Agent on ${repairing.name}, then scan its QR code or pick it and type its PIN. Its pages stay as they are and come back once it is paired again.`,
    };
  }
  if (repairing && needsRepair(repairing)) {
    return {
      title: `Pair ${repairing.name} again`,
      lead:
        `AuthDeck now encrypts the connection to ${repairing.name}, so pair it once more: scan its new QR code, ` +
        'or pick it and type its PIN. Its keys and pages stay as they are.',
    };
  }
  if (repairing) {
    return {
      title: `Re-pair ${repairing.name}`,
      lead: `If ${repairing.name} stopped accepting this device, or AuthDeck Agent was reset on it, pair it again. Its keys and pages stay as they are.`,
    };
  }
  return {
    title: 'Pair with the computer you code on',
    lead: canScanQr
      ? 'Scan the QR code the agent shows, or pick the computer and type its PIN.'
      : 'Type the address the agent shows, then its PIN.',
  };
}

function Intro({
  title,
  lead,
  large,
  canCancel,
  onCancel,
}: {
  title: string;
  lead: string;
  large: boolean;
  canCancel: boolean;
  onCancel: () => void;
}) {
  const cw = useColorway();
  return (
    <View style={{ gap: large ? 40 : 22 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 46 }}>
        <BrandMark large={large} />
        {canCancel ? <GhostButton small label="Cancel" icon="close" onPress={onCancel} /> : null}
      </View>
      <Text
        variant="display"
        accessibilityRole="header"
        style={large ? { fontSize: 56, lineHeight: 58, letterSpacing: -0.5 } : { fontSize: 34, lineHeight: 37 }}
      >
        {title}
      </Text>
      <View style={{ gap: large ? 28 : 16 }}>
        <Step number={1} large={large}>
          <Text variant={large ? 'lead' : 'body'} style={{ color: cw.text }}>
            Start the AuthDeck agent on your Mac, Windows or Linux computer.
          </Text>
          <Well style={{ alignSelf: 'flex-start', paddingHorizontal: 16, paddingTop: 11 + VOXEL, paddingBottom: 11 }}>
            <Text variant="mono" weight="medium" selectable accessibilityLabel={`Command: ${AGENT_COMMAND}`}>
              {AGENT_COMMAND}
            </Text>
          </Well>
        </Step>
        <Step number={2} large={large}>
          <Text variant={large ? 'lead' : 'body'}>
            {lead}
          </Text>
        </Step>
        {keyIsInBrowserStorage ? (
          <Text variant="caption" tone="dim">
            {KEY_IN_BROWSER_NOTICE}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Step({ number, large, children }: { number: number; large: boolean; children: React.ReactNode }) {
  const cw = useColorway();
  const size = large ? 9 * VOXEL : 7 * VOXEL;
  return (
    <View style={{ flexDirection: 'row', gap: large ? 18 : 14 }}>
      <View importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <Bands bands={outlineBands(1, VOXEL)} color={cw.textFaint} />
        <Text variant="label" weight="semibold" tone="dim">
          {number}
        </Text>
      </View>
      <View style={{ flex: 1, gap: 12, paddingTop: 2 }}>{children}</View>
    </View>
  );
}

function Finders({
  grow,
  onScanQr,
  onEnterAddress,
}: {
  grow: boolean;
  onScanQr: (() => void) | null;
  onEnterAddress: (() => void) | null;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
      {onScanQr ? <PrimaryButton label="Scan QR code" icon="qr-code" grow={grow} onPress={onScanQr} /> : null}
      {onEnterAddress ? <GhostButton label="Enter address" icon="keyboard" grow={grow} onPress={onEnterAddress} /> : null}
    </View>
  );
}
