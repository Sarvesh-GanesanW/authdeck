/**
 * Shared controls, built from voxel blocks. A pressable block's top travels down into
 * its front face under the finger and springs back with a little overshoot.
 */
import { type ReactNode, useEffect } from 'react';
import { Pressable, type StyleProp, StyleSheet, TextInput, type TextInputProps, View, type ViewStyle } from 'react-native';
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { haptics } from '../lib/haptics';
import { sounds } from '../lib/sounds';
import { type BlockTone, CAP_COLORS, type CapColor } from '../theme/colorways';
import { springs } from '../theme/motion';
import { fonts } from '../theme/type';
import { Glyph, type GlyphName } from './Icon';
import { Text } from './Text';
import { useColorway, useScreen } from './theme';
import { RaisedFace, Ring, Shape, SunkenFace, VOXEL } from './voxel';

const APressable = Animated.createAnimatedComponent(Pressable);

type Role = 'button' | 'radio' | 'switch' | 'link' | 'tab' | 'checkbox';

/** Pressable with spring feedback, for things that are not blocks (rows, links, tiles). */
export function Press({
  onPress,
  disabled,
  style,
  children,
  scaleTo = 0.96,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  hitSlop,
}: {
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  scaleTo?: number;
  accessibilityLabel?: string;
  accessibilityRole?: Role;
  accessibilityState?: { selected?: boolean; checked?: boolean; disabled?: boolean };
  hitSlop?: number;
}) {
  const p = useSharedValue(0);
  const anim = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(p.value, [0, 1], [1, scaleTo]) }],
    opacity: interpolate(p.value, [0, 1], [1, 0.82]),
  }));
  return (
    <APressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      onPressIn={() => {
        p.value = withSpring(1, springs.pressIn);
      }}
      onPressOut={() => {
        p.value = withSpring(0, springs.pressOut);
      }}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, ...accessibilityState }}
      style={[style, anim, disabled ? { opacity: 0.4 } : null]}
    >
      {children}
    </APressable>
  );
}

/**
 * A raised voxel block you can press. `style` sizes the whole block (front face included);
 * `contentStyle` lays out what sits on the top face.
 */
export function PressBlock({
  tone,
  onPress,
  disabled,
  steps = 1,
  depth = VOXEL,
  style,
  contentStyle,
  children,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  hitSlop,
}: {
  tone: BlockTone;
  onPress?: () => void;
  disabled?: boolean;
  steps?: number;
  /** Height of the front face; the top travels this far when pressed. */
  depth?: number;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: Role;
  accessibilityState?: { selected?: boolean; checked?: boolean; disabled?: boolean };
  hitSlop?: number;
}) {
  const cw = useColorway();
  const v = VOXEL;
  const p = useSharedValue(0);
  const travel = useAnimatedStyle(() => ({ transform: [{ translateY: p.value * depth }] }));
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      onPressIn={() => {
        p.value = withSpring(1, springs.pressIn);
        sounds.tick();
      }}
      onPressOut={() => {
        p.value = withSpring(0, springs.pressOut);
      }}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, ...accessibilityState }}
      style={[{ paddingBottom: depth }, style, disabled ? { opacity: 0.42 } : null]}
    >
      <Shape steps={steps} v={v} color={cw.shadow} top={false} inset={{ left: v, right: -v, bottom: -v, height: depth }} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, travel]}>
        <Shape steps={steps} v={v} color={cw.shadow} inset={{ top: v, left: v, right: -v, bottom: depth - v }} />
      </Animated.View>
      {/* The front face reaches up under the top so the top can sink all the way down. */}
      <Shape steps={steps} v={v} color={tone.front} top={false} inset={{ height: depth * 2 }} />
      <Animated.View style={[{ flexGrow: 1 }, travel]}>
        <Shape steps={steps} v={v} color={tone.shade} />
        <Shape steps={steps} v={v} color={tone.hi} inset={{ right: v, bottom: v }} />
        <Shape steps={steps - 1} v={v} color={tone.top} inset={{ top: v, left: v, right: v, bottom: v }} />
        <View style={[{ flexGrow: 1 }, contentStyle]}>{children}</View>
      </Animated.View>
    </Pressable>
  );
}

/** Main action: an accent block. */
export function PrimaryButton({
  label,
  onPress,
  icon,
  disabled,
  busy,
  grow,
}: {
  label: string;
  onPress: () => void;
  icon?: GlyphName;
  disabled?: boolean;
  busy?: boolean;
  grow?: boolean;
}) {
  const cw = useColorway();
  const { compact } = useScreen();
  const tone = cw.caps.a;
  return (
    <PressBlock
      tone={tone}
      onPress={onPress}
      disabled={disabled || busy}
      depth={2 * VOXEL}
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy }}
      style={{ height: compact ? 52 : 56, flexGrow: grow ? 1 : 0 }}
      contentStyle={[styles.row, { paddingHorizontal: compact ? 18 : 22, paddingBottom: VOXEL, gap: 10 }]}
    >
      {icon ? <Glyph name={icon} size={24} color={tone.legend} /> : null}
      <Text weight="semibold" color={tone.legend}>
        {busy ? `${label}…` : label}
      </Text>
    </PressBlock>
  );
}

/** Secondary action: a neutral block. */
export function GhostButton({
  label,
  onPress,
  icon,
  danger,
  disabled,
  grow,
  small,
}: {
  label: string;
  onPress: () => void;
  icon?: GlyphName;
  danger?: boolean;
  disabled?: boolean;
  grow?: boolean;
  small?: boolean;
}) {
  const cw = useColorway();
  const color = danger ? cw.dangerText : cw.text;
  return (
    <PressBlock
      tone={cw.control}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      style={{ height: small ? 44 : 52, flexGrow: grow ? 1 : 0 }}
      contentStyle={[styles.row, { paddingHorizontal: small ? 14 : 18, paddingBottom: VOXEL, gap: 8 }]}
    >
      {icon ? <Glyph name={icon} size={24} color={color} /> : null}
      <Text weight="medium" color={color} variant={small ? 'label' : 'body'}>
        {label}
      </Text>
    </PressBlock>
  );
}

/** Square block with a symbol: close, delete, settings. */
export function IconButton({
  icon,
  label,
  onPress,
  tint,
  disabled,
}: {
  icon: GlyphName;
  label: string;
  onPress: () => void;
  tint?: string;
  disabled?: boolean;
}) {
  const cw = useColorway();
  const { compact } = useScreen();
  const size = compact ? 44 : 48;
  return (
    <PressBlock
      tone={cw.control}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      hitSlop={6}
      style={{ width: size, height: size }}
      contentStyle={[styles.center, { paddingBottom: VOXEL }]}
    >
      <Glyph name={icon} size={24} color={tint ?? cw.text} />
    </PressBlock>
  );
}

export function LinkButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Press onPress={onPress} accessibilityRole="link" accessibilityLabel={label} hitSlop={8} style={{ alignSelf: 'flex-start' }}>
      <Text weight="semibold" tone="focus">
        {label}
      </Text>
    </Press>
  );
}

/** A sunken track with a block that slides across it. */
export function Switch({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  const cw = useColorway();
  const v = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    v.value = withSpring(value ? 1 : 0, springs.snappy);
  }, [value, v]);
  const fill = useAnimatedStyle(() => ({ opacity: v.value }));
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: interpolate(v.value, [0, 1], [0, 24]) }] }));
  const knobTone = {
    hi: '#FFFFFF',
    top: cw.dark ? '#F0EADC' : '#FFFDF7',
    shade: cw.dark ? '#D9D2C3' : '#E2DCCF',
    front: cw.dark ? '#B9B2A3' : '#BDB5A3',
  };
  return (
    <Pressable
      onPress={() => {
        haptics.tick();
        onChange(!value);
        // After the change, so turning sounds on answers with a click and turning them off is silent.
        sounds.tick();
      }}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      hitSlop={8}
    >
      <View style={{ width: 60, height: 36, padding: 4 }}>
        <SunkenFace color={cw.plate} lip={cw.lip} />
        <Animated.View style={[StyleSheet.absoluteFill, fill]}>
          <Shape steps={1} color={cw.caps.a.top} />
          <Shape steps={1} color={cw.caps.a.shade} inset={{ height: VOXEL }} />
        </Animated.View>
        <Animated.View style={[{ width: 28, height: 28 }, knob]}>
          <RaisedFace tone={knobTone} depth={VOXEL} />
        </Animated.View>
      </View>
    </Pressable>
  );
}

/** A row of choices; the chosen one is an accent block. */
export function Choice<T extends string>({
  options,
  value,
  onChange,
  label,
  wrap = true,
}: {
  options: { value: T; label: string; icon?: GlyphName }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  wrap?: boolean;
}) {
  const cw = useColorway();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: wrap ? 'wrap' : 'nowrap', gap: 10 }}>
      {options.map((o) => {
        const on = o.value === value;
        const tone = on ? cw.caps.a : cw.control;
        const color = on ? cw.caps.a.legend : cw.text;
        return (
          <PressBlock
            key={o.value}
            tone={tone}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            onPress={() => {
              if (!on) haptics.tick();
              onChange(o.value);
            }}
            style={{ height: 44 }}
            contentStyle={[styles.row, { paddingHorizontal: 14, paddingBottom: VOXEL, gap: 8 }]}
          >
            {o.icon ? <Glyph name={o.icon} size={24} color={color} /> : null}
            <Text variant="label" weight="medium" color={color}>
              {o.label}
            </Text>
          </PressBlock>
        );
      })}
    </View>
  );
}

/** A sunken text field. */
export function Field({ label, ...input }: TextInputProps & { label: string }) {
  const cw = useColorway();
  const { compact } = useScreen();
  return (
    <View style={{ gap: 8 }}>
      <Text variant="label" tone="dim">
        {label}
      </Text>
      <View>
        <SunkenFace color={cw.field} lip={cw.lip} />
        <TextInput
          placeholderTextColor={cw.textFaint}
          selectionColor={cw.focus}
          accessibilityLabel={label}
          autoCorrect={false}
          {...input}
          style={[
            {
              position: 'relative',
              minHeight: compact ? 48 : 52,
              color: cw.text,
              paddingHorizontal: 16,
              paddingTop: 12,
              paddingBottom: 8,
              fontFamily: fonts.plex.regular,
              fontSize: compact ? 15 : 16,
            },
            input.style,
          ]}
        />
      </View>
    </View>
  );
}

/** Key colour picker: five little blocks. */
export function CapSwatches({ value, onChange }: { value: CapColor; onChange: (c: CapColor) => void }) {
  const cw = useColorway();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Key colour" style={{ flexDirection: 'row', gap: 14, paddingVertical: 4 }}>
      {CAP_COLORS.map((c) => {
        const t = cw.caps[c];
        const on = c === value;
        return (
          <View key={c}>
            {on ? <Ring steps={1} color={cw.focus} gap={2 * VOXEL} /> : null}
            <PressBlock
              tone={t}
              accessibilityRole="radio"
              accessibilityLabel={t.name}
              accessibilityState={{ selected: on }}
              onPress={() => {
                if (!on) haptics.tick();
                onChange(c);
              }}
              depth={2 * VOXEL}
              style={{ width: 44, height: 48 }}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
});
