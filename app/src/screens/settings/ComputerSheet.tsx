/** Paired computers: switch, add, re-pair, forget, and each one's key words. */
import { useState } from 'react';
import { View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { haptics } from '../../lib/haptics';
import { connection } from '../../net/connection';
import { KEY_IN_BROWSER_NOTICE, keyIsInBrowserStorage } from '../../net/linkIdentity';
import { computerLink } from '../../net/linkState';
import { useShallow } from 'zustand/react/shallow';
import { connectCanary, useConnectCanary } from '../../state/connectCanary';
import { useIconCanary } from '../../state/iconCanary';
import { type ConnStatus, useLive } from '../../state/live';
import type { Computer } from '../../state/model';
import { useStore } from '../../state/store';
import { useUi } from '../../state/ui';
import { GhostButton, IconButton, Press, PrimaryButton } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { KeyWords } from '../../ui/KeyWords';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { Bands, outlineBands, Shape, VOXEL } from '../../ui/voxel';
import { computerDetail, Lamp, OsTile } from '../pair/ComputerTile';
import { AGENT_COMMAND } from '../pair/pairing';
import { type ConfirmRequest, ConfirmSheet } from './ConfirmSheet';

/**
 * Opened from the computer pill in the deck header, and stacked on settings. `onLeave` closes
 * the sheet underneath too, because adding or re-pairing a computer replaces the deck with the
 * pairing screen.
 */
export function ComputerSheet({ visible, onClose, onLeave }: { visible: boolean; onClose: () => void; onLeave?: () => void }) {
  const computers = useStore((s) => s.computers);
  const activeId = useStore((s) => s.activeId);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const pair = (repairAgentId: string | null) => {
    onClose();
    onLeave?.();
    useUi.getState().startPairing(null, repairAgentId);
  };

  const askForget = (c: Computer) => {
    const deck = useStore.getState().decks[c.agentId];
    const pages = deck?.pages.length ?? 0;
    const keys = deck?.pages.reduce((n, p) => n + p.slots.filter(Boolean).length, 0) ?? 0;
    const last = computers.length === 1;
    setConfirm({
      title: `Forget ${c.name}?`,
      message:
        `Its deck (${plural(pages, 'page')}, ${plural(keys, 'key')}) is deleted from this device. ` +
        'Export it from Settings first if you want to keep it. ' +
        `To stop ${c.name} trusting this device as well, run "${AGENT_COMMAND} devices --revoke-all" on it.` +
        (last ? ' This is your only computer, so AuthDeck goes back to pairing.' : ''),
      confirmLabel: 'Forget',
      danger: true,
      onConfirm: () => void connection.forgetComputer(c.agentId),
    });
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Computers"
      subtitle="Tap a computer to use its deck."
      maxWidth={620}
      footer={<PrimaryButton label="Add a computer" icon="plus" onPress={() => pair(null)} />}
    >
      <View style={{ gap: 10 }} accessibilityRole="radiogroup" accessibilityLabel="Paired computers">
        {computers.map((c) => (
          <Animated.View key={c.agentId} layout={LinearTransition.springify().dampingRatio(1)}>
            <ComputerRow
              computer={c}
              active={c.agentId === activeId}
              onSelect={() => {
                if (c.agentId === activeId) return;
                haptics.tick();
                useStore.getState().setActive(c.agentId);
              }}
              onRepair={() => pair(c.agentId)}
              onForget={() => askForget(c)}
            />
          </Animated.View>
        ))}
      </View>
      {keyIsInBrowserStorage ? (
        <Text variant="caption" tone="dim" style={{ marginTop: 14 }}>
          {KEY_IN_BROWSER_NOTICE}
        </Text>
      ) : null}
      <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />
    </Sheet>
  );
}

/**
 * Shown while the computer's icons are hidden because AuthDeck closed while drawing them
 * (state/iconCanary.ts): clearing them loads them from the computer again.
 */
function HiddenIcons({ computer }: { computer: Computer }) {
  const hidden = useIconCanary((s) => s.hidden.includes(computer.agentId));
  const [clearing, setClearing] = useState(false);
  if (!hidden) return null;
  const clear = () => {
    setClearing(true);
    connection.clearIcons(computer.agentId).finally(() => setClearing(false));
  };
  return (
    <View style={{ gap: 8, paddingHorizontal: 14, paddingBottom: 14, alignItems: 'flex-start' }}>
      <Text variant="caption" tone="danger">
        Its app icons are hidden: AuthDeck closed while drawing them last time.
      </Text>
      <GhostButton small label="Clear this computer's icons" disabled={clearing} onPress={clear} />
    </View>
  );
}

/**
 * Shown while one of the computer's addresses is held because AuthDeck closed while connecting to
 * it on two launches in a row (state/connectCanary.ts): Connect tries it again. A hold ends on its
 * own after a week.
 */
function HeldConnection({ computer }: { computer: Computer }) {
  const held = useConnectCanary(useShallow((s) => s.held.filter((host) => computer.hosts.includes(host))));
  const [connecting, setConnecting] = useState(false);
  if (held.length === 0) return null;
  const connect = async () => {
    setConnecting(true);
    try {
      await Promise.all(held.map((host) => connectCanary.release(host)));
    } finally {
      setConnecting(false);
    }
    connection.wake();
  };
  return (
    <View style={{ gap: 8, paddingHorizontal: 14, paddingBottom: 14, alignItems: 'flex-start' }}>
      <Text variant="caption" tone="danger">
        {`AuthDeck closed twice while connecting to ${held.join(', ')}, so it is not connecting there for now.`}
      </Text>
      <GhostButton small label="Connect" disabled={connecting} onPress={() => void connect()} />
    </View>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const STATUS_TEXT: Record<ConnStatus, string> = {
  online: 'Online',
  connecting: 'Connecting',
  idle: 'Connecting',
  offline: 'Offline, reconnecting',
  unauthorized: 'Needs re-pairing',
};

function useStatusColor(status: ConnStatus): string {
  const cw = useColorway();
  if (status === 'online') return cw.ok;
  if (status === 'unauthorized') return cw.danger;
  if (status === 'offline') return cw.textFaint;
  return cw.run;
}

/** Window width (dp) below which a computer's Re-pair and Forget buttons sit under its details. */
const NARROW_ROW = 420;

function ComputerRow({
  computer,
  active,
  onSelect,
  onRepair,
  onForget,
}: {
  computer: Computer;
  active: boolean;
  onSelect: () => void;
  onRepair: () => void;
  onForget: () => void;
}) {
  const cw = useColorway();
  const { compact, width } = useScreen();
  // On a narrow window the buttons get their own row, so the name and key words keep the width.
  const buttonsBelow = width < NARROW_ROW;
  const liveStatus = useLive((s) => s.status);
  const liveHost = useLive((s) => s.host);
  const status = active ? liveStatus : null;
  const dot = useStatusColor(liveStatus);
  const host = active ? (liveHost ?? computer.hosts[0] ?? null) : (computer.hosts[0] ?? null);
  const link = computerLink(computer);
  const mustRepair = link.kind === 'repair' || status === 'unauthorized';
  // A computer whose key changed can't say so in a way the app may trust, so it only shows as
  // offline: offer re-pairing there too, without the alarm colour.
  const canRepair = mustRepair || status === 'offline';
  // An address held after a crash while connecting is not being tried, whatever the last status was.
  const held = useConnectCanary((s) => s.held.some((host) => computer.hosts.includes(host)));
  const statusText = link.kind === 'repair' ? link.title : held ? 'Not connecting' : status ? STATUS_TEXT[status] : 'Not connected';

  const buttons = (
    <>
      {canRepair ? <GhostButton small label={link.kind === 'repair' ? 'Pair again' : 'Re-pair'} icon="key" onPress={onRepair} /> : null}
      <IconButton icon="trash" label={`Forget ${computer.name}`} onPress={onForget} tint={cw.dangerText} />
    </>
  );

  return (
    <View>
      {active ? <Shape steps={2} color={cw.surfaceAlt} /> : null}
      <Bands bands={outlineBands(2, VOXEL)} color={active ? cw.focus : cw.line} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingRight: 10 }}>
        <Press
          onPress={onSelect}
          accessibilityRole="radio"
          accessibilityState={{ selected: active }}
          accessibilityLabel={`${computer.name}, ${link.kind === 'linked' ? `key words ${link.keyWords}, ` : ''}${computerDetail(computer.platform, null)}, ${statusText}${active ? ', in use' : ''}`}
          scaleTo={0.98}
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14, padding: compact ? 12 : 14 }}
        >
          <OsTile platform={computer.platform} size={compact ? 42 : 48} />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text weight="semibold" style={{ flexShrink: 1 }}>
                {computer.name}
              </Text>
              {active ? <Glyph name="check" size={24} color={cw.focus} /> : null}
            </View>
            <Text variant="label" tone="dim" numberOfLines={1}>
              {computerDetail(computer.platform, host)}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {status && link.kind !== 'repair' ? <Lamp color={dot} /> : null}
              <Text variant="caption" tone={mustRepair ? 'danger' : 'faint'} style={{ flexShrink: 1 }}>
                {statusText}
              </Text>
            </View>
            {link.kind === 'repair' ? (
              <Text variant="caption" tone="dim">
                {link.detail}
              </Text>
            ) : (
              <KeyWords keyWords={link.keyWords} />
            )}
          </View>
        </Press>
        {buttonsBelow ? null : buttons}
      </View>
      {buttonsBelow ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 12, paddingHorizontal: 10, paddingBottom: 10 }}>
          {buttons}
        </View>
      ) : null}
      <HiddenIcons computer={computer} />
      <HeldConnection computer={computer} />
    </View>
  );
}
