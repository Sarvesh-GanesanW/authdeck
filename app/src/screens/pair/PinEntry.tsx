/**
 * Six PIN slots over a numeric keypad of keycaps. The slots shake on a wrong PIN and
 * turn green when pairing works. On the web, the computer's keyboard and paste work too.
 */
import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';

import type { KeyIcon } from '../../state/model';
import { springs } from '../../theme/motion';
import { fonts } from '../../theme/type';
import { Glyph, type GlyphName } from '../../ui/Icon';
import { Keycap, keyMetrics } from '../../ui/Keycap';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { RaisedFace, Ring, snap, SunkenFace, VOXEL } from '../../ui/voxel';
import { PIN_LENGTH } from './pairing';

const SLOT = {
  /** Gap between the socket's edge and the digit block in it. */
  inset: VOXEL,
  /** Front face of the digit block. */
  blockDepth: VOXEL,
  /** The "next digit" and "paired" rings sit one voxel outside the socket. */
  ringGap: VOXEL,
};

/** Keys at least this tall get the larger glyph on delete and paste. */
const LARGE_GLYPH_KEY = 96;

const NO_ICON: KeyIcon = { kind: 'none' };

/** A loose, low spring: the slots swing a few times and settle, like a refused iOS passcode. */
const SHAKE_SPRING = { stiffness: 900, damping: 11, mass: 1, velocity: 900 };

const DIGIT_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
] as const;

export interface PinSizes {
  slotWidth: number;
  slotHeight: number;
  keyWidth: number;
  keyHeight: number;
  gap: number;
}

export function PinEntry({
  pin,
  shakeTick,
  busy,
  paired,
  sizes,
  onDigit,
  onBackspace,
  onPaste,
  onPasteText,
  label,
}: {
  pin: string;
  shakeTick: number;
  busy: boolean;
  paired: boolean;
  sizes: PinSizes;
  onDigit: (d: string) => void;
  onBackspace: () => void;
  /** Shows a paste key (wide screens) that reads the clipboard. */
  onPaste?: () => void;
  /** Text pasted with the keyboard (web). */
  onPasteText: (text: string) => void;
  /** Read out with the slots, e.g. "PIN for MacBook Pro". */
  label: string;
}) {
  useComputerKeyboard(onDigit, onBackspace, onPasteText);
  return (
    <View style={{ gap: sizes.gap * 2.2, alignItems: 'center' }}>
      <PinSlots pin={pin} shakeTick={shakeTick} busy={busy} paired={paired} sizes={sizes} label={label} />
      <View style={{ gap: sizes.gap }} accessibilityLabel="Number keys">
        {DIGIT_ROWS.map((row) => (
          <View key={row.join('')} style={{ flexDirection: 'row', gap: sizes.gap }}>
            {row.map((d) => (
              <DigitKey key={d} digit={d} sizes={sizes} onPress={() => onDigit(d)} />
            ))}
          </View>
        ))}
        <View style={{ flexDirection: 'row', gap: sizes.gap }}>
          {onPaste ? (
            <GlyphKey glyph="clipboard" label="Paste PIN" sizes={sizes} onPress={onPaste} />
          ) : (
            <KeySpacer sizes={sizes} />
          )}
          <DigitKey digit="0" sizes={sizes} onPress={() => onDigit('0')} />
          <GlyphKey glyph="delete" label="Delete last digit" sizes={sizes} onPress={onBackspace} />
        </View>
      </View>
    </View>
  );
}

/** Fills a key's place in the grid; keys snap to whole voxels, so the spacer does too. */
function KeySpacer({ sizes }: { sizes: PinSizes }) {
  const { w, h } = keyMetrics(sizes.keyWidth, sizes.keyHeight, false);
  return <View style={{ width: w, height: h }} />;
}

function PinSlots({
  pin,
  shakeTick,
  busy,
  paired,
  sizes,
  label,
}: {
  pin: string;
  shakeTick: number;
  busy: boolean;
  paired: boolean;
  sizes: PinSizes;
  label: string;
}) {
  const shake = useSharedValue(0);
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (shakeTick > 0) shake.value = withSequence(withTiming(-2, { duration: 0 }), withSpring(0, SHAKE_SPRING));
  }, [shakeTick, shake]);

  useEffect(() => {
    pulse.value = busy ? withSequence(withTiming(0.55, { duration: 380 }), withSpring(1, springs.smooth)) : withSpring(1, springs.smooth);
  }, [busy, pulse]);

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }], opacity: pulse.value }));
  const spoken = `${label}: ${pin.length} of ${PIN_LENGTH} digits typed`;

  return (
    <Animated.View
      accessible
      accessibilityRole="text"
      accessibilityLabel={spoken}
      accessibilityLiveRegion="polite"
      style={[{ flexDirection: 'row', gap: sizes.gap }, style]}
    >
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <PinSlot key={i} digit={pin[i] ?? null} next={!busy && !paired && i === pin.length} paired={paired} sizes={sizes} />
      ))}
    </Animated.View>
  );
}

function PinSlot({ digit, next, paired, sizes }: { digit: string | null; next: boolean; paired: boolean; sizes: PinSizes }) {
  const cw = useColorway();
  const tone = cw.caps.alpha;
  const pop = useSharedValue(1);
  const filled = digit !== null;

  useEffect(() => {
    if (filled) pop.value = withSequence(withTiming(0.84, { duration: 0 }), withSpring(1, springs.bouncy));
  }, [filled, pop]);
  useEffect(() => {
    if (paired) pop.value = withSequence(withTiming(1.1, { duration: 120 }), withSpring(1, springs.bouncy));
  }, [paired, pop]);

  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  const ringColor = paired ? cw.ok : next ? cw.focus : null;

  return (
    <View style={{ width: snap(sizes.slotWidth), height: snap(sizes.slotHeight), padding: SLOT.inset, paddingTop: SLOT.inset + VOXEL }}>
      <SunkenFace color={cw.socket} lip={cw.lip} />
      {ringColor ? <Ring steps={1} color={ringColor} gap={SLOT.ringGap} /> : null}
      {filled ? (
        <Animated.View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: SLOT.blockDepth }, popStyle]}>
          <RaisedFace tone={tone} depth={SLOT.blockDepth} />
          <Text style={{ fontFamily: fonts.plex.semibold, fontSize: sizes.slotHeight * 0.38, lineHeight: sizes.slotHeight * 0.46, color: tone.legend }}>
            {digit}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

function DigitKey({ digit, sizes, onPress }: { digit: string; sizes: PinSizes; onPress: () => void }) {
  const cw = useColorway();
  const tone = cw.caps.alpha;
  return (
    <Keycap
      width={sizes.keyWidth}
      height={sizes.keyHeight}
      tone={tone}
      label=""
      icon={NO_ICON}
      onPress={onPress}
      accessibilityLabel={digit}
      centerLegend={
        <Text style={{ fontFamily: fonts.plex.semibold, fontSize: sizes.keyHeight * 0.36, lineHeight: sizes.keyHeight * 0.44, color: tone.legend }}>
          {digit}
        </Text>
      }
    />
  );
}

function GlyphKey({ glyph, label, sizes, onPress }: { glyph: GlyphName; label: string; sizes: PinSizes; onPress: () => void }) {
  const cw = useColorway();
  const tone = cw.caps.mod;
  return (
    <Keycap
      width={sizes.keyWidth}
      height={sizes.keyHeight}
      tone={tone}
      label=""
      icon={NO_ICON}
      onPress={onPress}
      accessibilityLabel={label}
      centerLegend={<Glyph name={glyph} size={sizes.keyHeight >= LARGE_GLYPH_KEY ? 36 : 24} color={tone.legend} />}
    />
  );
}

/** In a browser, typing digits, Backspace and pasting fill the PIN as well. */
function useComputerKeyboard(onDigit: (d: string) => void, onBackspace: () => void, onPasteText: (t: string) => void) {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (/^\d$/.test(e.key)) onDigit(e.key);
      else if (e.key === 'Backspace') onBackspace();
      else return;
      e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const text = e.clipboardData?.getData('text') ?? '';
      if (text) onPasteText(text);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('paste', onPaste);
    };
  }, [onDigit, onBackspace, onPasteText]);
}
