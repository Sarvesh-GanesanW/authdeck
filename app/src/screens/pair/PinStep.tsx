/**
 * The PIN step for the picked computer: inline in the network panel on tablets,
 * a page of its own on phones.
 */
import * as Clipboard from 'expo-clipboard';
import { useCallback, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { haptics } from '../../lib/haptics';
import { GhostButton, IconButton } from '../../ui/controls';
import { PANEL_FRONT, PanelFace } from '../../ui/Panel';
import { Text } from '../../ui/Text';
import { useScreen } from '../../ui/theme';
import { VOXEL } from '../../ui/voxel';
import { computerDetail, OsTile } from './ComputerTile';
import type { PairProblem, PairTarget } from './pairing';
import { PinEntry, type PinSizes } from './PinEntry';
import type { PairFlow } from './usePairFlow';

/** Whole voxels, so nothing snaps. */
const TABLET_PIN: PinSizes = { slotWidth: 60, slotHeight: 68, keyWidth: 88, keyHeight: 72, gap: 12 };
const PHONE_GUTTER = 22;
/** Room for the card's solid shadow, so a scrolling list doesn't clip it. */
const PANEL_SHADOW = 2 * VOXEL;
/** Room the phone step needs above the keypad (header, title, slots, message). */
const PHONE_CHROME_HEIGHT = 340;

/** Shrinks the tablet sizes, in whole voxels, until six slots and three keys fit `width`. */
function fitPinSizes(base: PinSizes, width: number): PinSizes {
  if (width <= 0) return base;
  const fitSlot = Math.floor((width - base.gap * 5) / 6 / VOXEL) * VOXEL;
  const fitKey = Math.floor((width - base.gap * 2) / 3 / VOXEL) * VOXEL;
  const slotWidth = Math.min(base.slotWidth, fitSlot);
  const keyWidth = Math.min(base.keyWidth, fitKey);
  return {
    ...base,
    slotWidth,
    slotHeight: Math.round((slotWidth * base.slotHeight) / base.slotWidth / VOXEL) * VOXEL,
    keyWidth,
    keyHeight: Math.round((keyWidth * base.keyHeight) / base.keyWidth / VOXEL) * VOXEL,
  };
}

function phonePinSizes(width: number, height: number): PinSizes {
  const avail = width - PHONE_GUTTER * 2;
  const gap = avail < 340 ? 8 : 10;
  const slotWidth = Math.min(56, Math.floor((avail - gap * 5) / 6));
  const keyWidth = Math.min(112, Math.floor((avail - gap * 2) / 3));
  const keyHeight = Math.max(50, Math.min(Math.round(keyWidth * 0.78), Math.floor((height - PHONE_CHROME_HEIGHT) / 4 - gap)));
  return { slotWidth, slotHeight: Math.round(slotWidth * 1.18), keyWidth, keyHeight, gap };
}

/** Reads the clipboard for a PIN (paste key on wide screens and the web). */
function usePaste(pastePin: PairFlow['pastePin'], setNote: (n: string | null) => void) {
  return useCallback(async () => {
    const text = await Clipboard.getStringAsync().catch(() => '');
    if (!pastePin(text)) {
      haptics.warning();
      setNote('The clipboard has no 6-digit PIN. Copy it from the agent window, or type it.');
    }
  }, [pastePin, setNote]);
}

function ProblemText({ problem, note, busy, paired, target }: { problem: PairProblem | null; note: string | null; busy: boolean; paired: boolean; target: PairTarget }) {
  if (paired) {
    return (
      <Text tone="focus" weight="semibold" accessibilityLiveRegion="polite">
        {`Paired with ${target.name}`}
      </Text>
    );
  }
  if (busy) {
    return (
      <Text tone="dim" accessibilityLiveRegion="polite">
        {`Pairing with ${target.name}…`}
      </Text>
    );
  }
  if (problem) {
    return (
      <View style={{ gap: 4 }} accessibilityLiveRegion="assertive">
        <Text tone="danger" weight="semibold">
          {problem.title}
        </Text>
        {problem.detail ? <Text tone="dim">{problem.detail}</Text> : null}
      </View>
    );
  }
  if (note) return <Text tone="dim">{note}</Text>;
  return <Text tone="dim">{`Type the PIN shown on ${target.name}`}</Text>;
}

function RetryButton({ flow }: { flow: PairFlow }) {
  if (flow.problem?.kind !== 'unreachable' || flow.busy) return null;
  return <GhostButton small label="Try again" icon="reload" onPress={flow.retry} />;
}

/** Tablet: the picked computer, expanded in the list with its PIN pad. */
export function InlinePinCard({ flow, target, onCancel }: { flow: PairFlow; target: PairTarget; onCancel: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const paste = usePaste(flow.pastePin, setNote);
  return (
    <Animated.View
      entering={FadeInDown.springify().dampingRatio(0.85)}
      style={{ padding: 22, paddingBottom: 26 + PANEL_FRONT, marginRight: PANEL_SHADOW, marginBottom: PANEL_SHADOW, gap: 20 }}
    >
      <PanelFace />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
        <OsTile platform={target.platform} />
        <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
          <Text variant="heading">{target.name}</Text>
          <Text variant="label" tone="dim" numberOfLines={1}>
            {computerDetail(target.platform, target.hosts[0] ?? null)}
          </Text>
        </View>
        <GhostButton small label="Cancel" onPress={onCancel} disabled={flow.paired} />
      </View>
      <View style={{ gap: 16, alignItems: 'center' }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <ProblemText problem={flow.problem} note={note} busy={flow.busy} paired={flow.paired} target={target} />
        <RetryButton flow={flow} />
        <PinEntry
          pin={flow.pin}
          shakeTick={flow.shakeTick}
          busy={flow.busy}
          paired={flow.paired}
          sizes={fitPinSizes(TABLET_PIN, width)}
          onDigit={flow.typeDigit}
          onBackspace={flow.backspace}
          onPaste={() => void paste()}
          onPasteText={flow.pastePin}
          label={`PIN for ${target.name}`}
        />
      </View>
    </Animated.View>
  );
}

/** Phone: a page of its own with a back button. */
export function PhonePinStep({ flow, target, onBack }: { flow: PairFlow; target: PairTarget; onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useScreen();
  const [note, setNote] = useState<string | null>(null);
  const paste = usePaste(flow.pastePin, setNote);
  // Sized to the room the step has, not the whole screen, so the keypad fits whatever is around it.
  const [room, setRoom] = useState<number | null>(null);
  const sizes = phonePinSizes(width - insets.left - insets.right, (room ?? height) - insets.top - insets.bottom);
  return (
    <Animated.View entering={FadeIn.duration(220)} style={{ flex: 1 }} onLayout={(e) => setRoom(Math.round(e.nativeEvent.layout.height))}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 24,
          paddingLeft: insets.left + PHONE_GUTTER,
          paddingRight: insets.right + PHONE_GUTTER,
          gap: 22,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <IconButton icon="chevron-left" label="Back to computers" onPress={onBack} />
          <OsTile platform={target.platform} size={42} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text weight="semibold">{target.name}</Text>
            <Text variant="label" tone="dim" numberOfLines={1}>
              {computerDetail(target.platform, target.hosts[0] ?? null)}
            </Text>
          </View>
        </View>
        <View style={{ gap: 8, minHeight: 64 }}>
          <ProblemText problem={flow.problem} note={note} busy={flow.busy} paired={flow.paired} target={target} />
          <RetryButton flow={flow} />
        </View>
        <View style={{ alignItems: 'center', marginTop: 'auto' }}>
          <PinEntry
            pin={flow.pin}
            shakeTick={flow.shakeTick}
            busy={flow.busy}
            paired={flow.paired}
            sizes={sizes}
            onDigit={flow.typeDigit}
            onBackspace={flow.backspace}
            onPaste={Platform.OS === 'web' ? () => void paste() : undefined}
            onPasteText={flow.pastePin}
            label={`PIN for ${target.name}`}
          />
        </View>
      </ScrollView>
    </Animated.View>
  );
}
