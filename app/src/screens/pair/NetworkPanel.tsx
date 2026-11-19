/**
 * "Computers on this network": the live scan, one row per agent that answered, and
 * (on tablets) the picked computer expanded with its PIN pad.
 */
import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, {
  FadeInDown,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import type { Found } from '../../net/discovery';
import { defaultPort, testOverrides } from '../../net/testOverrides';
import { GhostButton, IconButton } from '../../ui/controls';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { SunkenFace, VOXEL } from '../../ui/voxel';
import { computerDetail, Lamp, OsTile } from './ComputerTile';
import type { PairTarget } from './pairing';
import { InlinePinCard } from './PinStep';
import type { PairFlow } from './usePairFlow';
import type { NetworkScan } from './useNetworkScan';

/** The plate is recessed: a hard dark lip along its top edge. */
const PLATE_LIP = 2 * VOXEL;

function targetFromFound(f: Found): PairTarget {
  return {
    name: f.hello.name,
    platform: f.hello.platform,
    hosts: [f.host],
    port: f.hello.port ?? defaultPort(),
    agentId: f.hello.agentId,
    startedFrom: 'network',
  };
}

/**
 * The row the picked computer came from. Matched by address, not id: several addresses may claim
 * one id, and the others stay listed so the person can try them.
 */
function isPickedRow(row: PairTarget, picked: PairTarget): boolean {
  return row.port === picked.port && picked.hosts.includes(row.hosts[0]!);
}

export function NetworkPanel({
  scan,
  flow,
  inlinePin,
  onEnterAddress,
  fill,
}: {
  scan: NetworkScan;
  flow: PairFlow;
  /** Expand the picked computer here (tablets). Phones open a PIN page instead. */
  inlinePin: boolean;
  onEnterAddress: () => void;
  /** Stretch to the column's height (two-column layout). */
  fill: boolean;
}) {
  const cw = useColorway();
  const { compact } = useScreen();
  const picked = inlinePin ? flow.target : null;
  const rows = scan.found.map(targetFromFound).filter((t) => !picked || !isPickedRow(t, picked));
  const body = (
    <>
      {picked ? <InlinePinCard key={`${picked.hosts[0]}:${picked.port}`} flow={flow} target={picked} onCancel={() => flow.choose(null)} /> : null}
      {rows.map((t) => (
        <Animated.View
          key={`${t.agentId}@${t.hosts[0]}`}
          entering={FadeInDown.springify().dampingRatio(0.8)}
          layout={LinearTransition.springify().dampingRatio(1)}
        >
          <ComputerRow target={t} onPair={() => flow.choose(t)} />
        </Animated.View>
      ))}
      <EmptyState scan={scan} hasRows={rows.length > 0 || !!picked} onEnterAddress={onEnterAddress} />
    </>
  );

  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel="Computers on this network"
      style={{
        flex: fill ? 1 : undefined,
        minWidth: 0,
        padding: compact ? 10 : 30,
        paddingTop: compact ? 14 + PLATE_LIP : 30,
        gap: compact ? 4 : 12,
      }}
    >
      <SunkenFace color={cw.plate} lip={cw.lip} steps={2} lipDepth={PLATE_LIP} />
      <PanelHeader scan={scan} />
      {fill ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }} showsVerticalScrollIndicator={false}>
          {body}
        </ScrollView>
      ) : (
        body
      )}
      {scan.status !== 'unsupported' ? (
        <Text tone="dim" style={{ paddingHorizontal: compact ? 8 : 10, paddingBottom: compact ? 6 : 0 }}>
          Not listed? Check that the agent is running and both devices are on the same Wi-Fi, then use Enter address.
        </Text>
      ) : null}
    </View>
  );
}

function PanelHeader({ scan }: { scan: NetworkScan }) {
  const { compact } = useScreen();
  const scanning = scan.status === 'scanning';
  const status =
    scan.status === 'unsupported'
      ? null
      : scanning
        ? 'Still looking'
        : scan.status === 'failed'
          ? 'Could not scan'
          : scan.found.length === 1
            ? 'Found 1'
            : `Found ${scan.found.length}`;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 10 : 14, paddingHorizontal: compact ? 8 : 10, paddingBottom: compact ? 8 : 4 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="heading" accessibilityRole="header">
          {compact ? 'On this network' : 'Computers on this network'}
        </Text>
        {testOverrides && !compact ? (
          <Text variant="caption" tone="faint">
            {`Test switch: probing ${testOverrides.hosts.join(', ')} on port ${testOverrides.port}`}
          </Text>
        ) : scan.subnet && !compact ? (
          <Text variant="caption" tone="faint">
            {`Searching ${scan.subnet}`}
          </Text>
        ) : null}
      </View>
      <StatusDot status={scan.status} found={scan.found.length > 0} />
      {status ? (
        <Text variant="label" tone="dim" accessibilityLiveRegion="polite">
          {status}
        </Text>
      ) : null}
      {scan.status === 'done' || scan.status === 'failed' ? <IconButton icon="refresh" label="Scan again" onPress={scan.rescan} /> : null}
    </View>
  );
}

function StatusDot({ status, found }: { status: NetworkScan['status']; found: boolean }) {
  const cw = useColorway();
  const { compact } = useScreen();
  const glow = useSharedValue(1);
  const scanning = status === 'scanning';
  useEffect(() => {
    glow.value = scanning ? withRepeat(withSequence(withTiming(0.35, { duration: 650 }), withTiming(1, { duration: 650 })), -1) : withTiming(1, { duration: 200 });
  }, [scanning, glow]);
  const style = useAnimatedStyle(() => ({ opacity: glow.value }));
  const color = scanning ? cw.run : status === 'failed' ? cw.danger : found ? cw.ok : cw.textFaint;
  if (status === 'unsupported') return null;
  return (
    <Animated.View style={style}>
      <Lamp color={color} size={compact ? 6 : 2 * VOXEL} />
    </Animated.View>
  );
}

function ComputerRow({ target, onPair }: { target: PairTarget; onPair: () => void }) {
  const { compact } = useScreen();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 14 : 18, padding: compact ? 12 : 18, paddingHorizontal: compact ? 12 : 22 }}>
      <OsTile platform={target.platform} size={compact ? 42 : 52} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text variant={compact ? 'body' : 'lead'} weight="semibold">
          {target.name}
        </Text>
        <Text variant="label" tone="dim" numberOfLines={1}>
          {computerDetail(target.platform, target.hosts[0] ?? null)}
        </Text>
      </View>
      <GhostButton small label="Pair" onPress={onPair} />
    </View>
  );
}

function EmptyState({ scan, hasRows, onEnterAddress }: { scan: NetworkScan; hasRows: boolean; onEnterAddress: () => void }) {
  const { compact } = useScreen();
  const pad = { paddingHorizontal: compact ? 8 : 10, paddingVertical: compact ? 8 : 12, gap: 12, alignItems: 'flex-start' as const };
  if (scan.status === 'unsupported') {
    return (
      <View style={pad}>
        <Text tone="dim">Browsers can't search the network. Type the address the agent printed when it started.</Text>
        <GhostButton small label="Enter address" icon="keyboard" onPress={onEnterAddress} />
      </View>
    );
  }
  if (scan.status === 'failed') {
    return (
      <View style={pad}>
        <Text tone="danger">{scan.problem}</Text>
      </View>
    );
  }
  if (hasRows) return null;
  return (
    <View style={pad}>
      <Text tone="dim">
        {scan.status === 'scanning'
          ? 'Looking for computers running the AuthDeck agent. This takes a few seconds.'
          : 'No computers found yet. Start the agent, then scan again.'}
      </Text>
    </View>
  );
}
