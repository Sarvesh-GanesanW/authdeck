/**
 * A key drawn as a voxel block: a top face with a pixel icon and label, a front face
 * carrying the sublegend, a square status light, and a top that physically travels
 * into its socket when pressed.
 *
 * Motion: press sinks and springs back; running sends pixels marching round the edge;
 * done bumps the key and throws off a few cubes; failed shakes and flashes red;
 * offline powers the key down into its socket and `wave` staggers it popping back up.
 */
import { type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureDetector, useExclusiveGestures, useLongPressGesture, useTapGesture } from 'react-native-gesture-handler';
import Animated, {
  type SharedValue,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';

import { sounds } from '../lib/sounds';
import type { KeyRunState } from '../state/live';
import type { KeyIcon } from '../state/model';
import type { CapTone } from '../theme/colorways';
import { LONG_PRESS_MS, springs } from '../theme/motion';
import { fonts } from '../theme/type';
import { KeyIconView } from './Icon';
import { layoutKeyFace } from './keyLabel';
import { Text } from './Text';
import { useColorway } from './theme';
import { Ring, Shape, snap, steppedOutlinePath } from './voxel';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Plain functions rather than the sounds object, so the gesture worklets capture only these.
const playKeyDown = sounds.keyDown;
const playKeyUp = sounds.keyUp;

export interface KeycapProps {
  width: number;
  height: number;
  tone: CapTone;
  label: string;
  sublegend?: string;
  icon: KeyIcon;
  /** Drawn large in the middle of the top face instead of icon and label (keypad digits). */
  centerLegend?: React.ReactNode;
  /**
   * Custom top-face content in place of icon and label, laid out in the face's padding (2FA keys).
   * Pass an element that updates itself, so the key doesn't re-render when it changes.
   */
  face?: React.ReactNode;
  /** Custom front-face content in place of the sublegend, on keys big enough for one (see keyMetrics). */
  front?: React.ReactNode;
  state?: KeyRunState | null;
  /** Increment to shake the key once. */
  failTick?: number;
  /** Powered down: the computer is offline. */
  dimmed?: boolean;
  /** Delay before popping back up when power returns, for a wave across the deck. */
  wave?: number;
  selected?: boolean;
  /** Edit mode: lifted out of the socket. The deck wobbles the key together with its remove badge. */
  raised?: boolean;
  /** Picked up while being dragged. */
  lifted?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  /** No click sounds, for keys whose press means something other than typing (edit mode). */
  silent?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

/** Small keys are drawn in 2 dp voxels, the rest in 4 dp. */
export function keyVoxel(width: number, height: number): number {
  return Math.min(width, height) >= 112 ? 4 : 2;
}

/** Sizes for a key of the given box. */
export function keyMetrics(width: number, height: number, withSub: boolean) {
  const v = keyVoxel(width, height);
  const w = snap(width, v);
  const h = snap(height, v);
  const steps = 2;
  const sub = withSub && v === 4;
  /** Front face under the top. */
  const depth = v === 4 ? (sub ? 20 : 16) : 8;
  const capH = h - depth;
  const pad = v === 4 ? (w >= 150 ? 16 : 12) : 8;
  return {
    v,
    w,
    h,
    steps,
    sub,
    depth,
    capH,
    /** How far the top travels when pressed. Stops before the front face's stepped corners. */
    travel: depth - steps * v,
    pad,
    icon: capH >= 150 ? 48 : capH >= 96 ? 36 : 24,
    /** 13 px on the 136-px tablet key in the type design; Plex Mono is wider than a pixel face. */
    label: Math.round(clamp(w * 0.095, 11, 18)),
    led: v === 4 ? 8 : 6,
  };
}

/** The room on the top face, inside its padding, that the icon and the label share. */
function faceRoom(m: ReturnType<typeof keyMetrics>, icon: KeyIcon, fontScale: number) {
  const iconHeight = icon.kind === 'none' ? 0 : icon.kind === 'app' ? Math.round(m.icon * 1.17) : m.icon;
  // The label may run into the face's bottom padding, but never past the top's edge onto the front face.
  const height = m.capH - m.pad - m.v - LABEL_GAP;
  return { width: m.w - 2 * m.pad, height, iconHeight, gap: LABEL_GAP, fontSize: m.label, fontScale };
}

/** Least space kept between the icon and the label. */
const LABEL_GAP = 4;

export const Keycap = memo(function Keycap(props: KeycapProps) {
  const {
    width,
    height,
    tone,
    label,
    sublegend,
    icon,
    centerLegend,
    face,
    front,
    state,
    failTick = 0,
    dimmed,
    wave = 0,
    selected,
    raised,
    lifted,
    onPress,
    onLongPress,
    silent,
  } = props;
  const cw = useColorway();
  const reduce = useReducedMotion();
  const m = keyMetrics(width, height, !!sublegend || !!front);
  // Text grows with the system font size; the label is fitted in unscaled units, so its room shrinks to match.
  const { fontScale } = useWindowDimensions();
  const faceLayout = useMemo(
    () => layoutKeyFace(label, faceRoom(m, icon, fontScale)),
    [label, m.w, m.capH, m.pad, m.v, m.icon, m.label, icon.kind, fontScale],
  );
  const fitted = faceLayout.label;
  const { v, w, h, steps, depth, capH, travel } = m;

  const press = useSharedValue(0);
  const sink = useSharedValue(dimmed ? 1 : 0);
  const shake = useSharedValue(0);
  const bump = useSharedValue(0);
  const led = useSharedValue(0);
  const flash = useSharedValue(0);
  const ring = useSharedValue(selected ? 1 : 0);
  const lift = useSharedValue(raised ? 1 : 0);
  const drag = useSharedValue(lifted ? 1 : 0);

  const [bursts, setBursts] = useState(0);
  const prevState = useRef(state);
  // Layers that are invisible at rest exist only while they show, which keeps a deck light.
  const powerOff = useTransientLayer(!!dimmed);
  const lamp = useTransientLayer(!!state);
  const ringLayer = useTransientLayer(!!selected);
  const [flashing, setFlashing] = useState(false);
  const hideFlash = useCallback(() => setFlashing(false), []);

  // Shared values start at their props' values, so a first run with nothing to animate is skipped:
  // a page mounting dozens of keys shouldn't start animations that go nowhere.
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) return;
    lift.value = withSpring(raised ? 1 : 0, springs.snappy);
  }, [raised, lift]);

  useEffect(() => {
    if (failTick <= 0) return;
    setFlashing(true);
    flash.value = withSequence(
      withTiming(0.55, { duration: 60 }),
      withTiming(0, { duration: 640 }, (finished) => {
        if (finished) scheduleOnRN(hideFlash);
      }),
    );
    if (!reduce) {
      shake.value = withSequence(
        withTiming(-2.25 * v, { duration: 45 }),
        withRepeat(withTiming(2 * v, { duration: 75 }), 4, true),
        withSpring(0, springs.snappy),
      );
    }
  }, [failTick, reduce, v, shake, flash, hideFlash]);

  useEffect(() => {
    const was = prevState.current;
    prevState.current = state;
    if (state === 'run') {
      led.value = reduce ? 1 : withRepeat(withSequence(withTiming(1, { duration: 520 }), withTiming(0.35, { duration: 520 })), -1);
    } else if (state === 'ok' || state === 'fail') {
      led.value = withTiming(1, { duration: 80 });
      if (state === 'ok' && was !== 'ok') {
        if (!reduce) bump.value = withSequence(withTiming(1, { duration: 70 }), withSpring(0, springs.bouncy));
        setBursts((n) => n + 1);
      }
    } else if (!firstRun.current) {
      const hide = lamp.hide;
      led.value = withTiming(0, { duration: 380 }, (finished) => {
        if (finished) scheduleOnRN(hide);
      });
    }
  }, [state, reduce, led, bump, lamp.hide]);

  useEffect(() => {
    if (firstRun.current) return;
    const hide = ringLayer.hide;
    ring.value = withSpring(selected ? 1 : 0, springs.snappy, (finished) => {
      if (finished) scheduleOnRN(hide);
    });
  }, [selected, ring, ringLayer.hide]);
  useEffect(() => {
    if (firstRun.current) return;
    drag.value = withSpring(lifted ? 1 : 0, springs.bouncy);
  }, [lifted, drag]);
  useEffect(() => {
    if (firstRun.current) return;
    if (dimmed) {
      sink.value = withTiming(1, { duration: 260, easing: Easing.in(Easing.quad) });
      return;
    }
    const hide = powerOff.hide;
    const done = (finished?: boolean) => {
      'worklet';
      if (finished) scheduleOnRN(hide);
    };
    sink.value = reduce ? withTiming(0, { duration: 200 }, done) : withDelay(wave, withSpring(0, springs.bouncy, done));
    // `wave` only matters at the moment power returns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimmed, reduce, sink, powerOff.hide]);
  useEffect(() => {
    firstRun.current = false;
  }, []);

  const outerStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: shake.value },
      { translateY: bump.value * 1.5 * v - lift.value * v },
      { scale: 1 + drag.value * 0.08 },
    ],
  }));
  const capStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: Math.max(press.value, sink.value) * travel }],
  }));
  const baseShadowStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: lift.value * v * 0.5 + drag.value * v * 1.5 },
      { translateY: lift.value * v + drag.value * v * 2 },
    ],
  }));
  const capShadowStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: lift.value * v * 0.5 + drag.value * v * 1.5 },
      { translateY: lift.value * v + drag.value * v * 2 + Math.max(press.value, sink.value) * travel },
    ],
  }));

  const interactive = !!onPress || !!onLongPress;
  const tap = useTapGesture({
    enabled: !!onPress,
    maxDistance: 14,
    onBegin: () => {
      'worklet';
      press.value = withSpring(1, springs.pressIn);
      if (!silent) scheduleOnRN(playKeyDown);
    },
    onActivate: () => {
      'worklet';
      if (onPress) scheduleOnRN(onPress);
    },
    onFinalize: () => {
      'worklet';
      press.value = withSpring(0, springs.pressOut);
      if (!silent) scheduleOnRN(playKeyUp);
    },
  });
  const long = useLongPressGesture({
    enabled: !!onLongPress,
    minDuration: LONG_PRESS_MS,
    maxDistance: 14,
    onBegin: () => {
      'worklet';
      if (!onPress) press.value = withSpring(1, springs.pressIn);
    },
    onActivate: () => {
      'worklet';
      press.value = withSpring(0, springs.pressOut);
      if (onLongPress) scheduleOnRN(onLongPress);
    },
    onFinalize: () => {
      'worklet';
      if (!onPress) press.value = withSpring(0, springs.pressOut);
    },
  });
  const gesture = useExclusiveGestures(long, tap);

  const ledColor = state === 'fail' ? cw.danger : state === 'run' ? cw.run : cw.ok;
  const powerOffColor = cw.dark ? 'rgba(10,12,16,0.55)' : 'rgba(70,60,40,0.32)';
  const iconShadow = 'rgba(0,0,0,0.22)';

  const body = (
    <Animated.View
      style={[{ width: w, height: h }, outerStyle]}
      accessible={interactive}
      accessibilityRole={interactive ? 'button' : undefined}
      accessibilityLabel={props.accessibilityLabel ?? [label, sublegend].filter(Boolean).join(', ')}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ selected: !!selected, busy: state === 'run' }}
    >
      {/* Hard shadows: one under the front face, one that travels with the top. */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, baseShadowStyle]}>
        <Shape steps={steps} v={v} color={cw.shadow} top={false} inset={{ top: h - depth + v, left: v, right: -v, bottom: -v }} />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, capShadowStyle]}>
        <Shape steps={steps} v={v} color={cw.shadow} bottom={false} inset={{ top: v, left: v, right: -v, bottom: depth - v }} />
      </Animated.View>

      {/* Front face. It reaches up under the top so a pressed key never shows a gap. */}
      <Shape steps={steps} v={v} color={tone.front} top={false} inset={{ top: h - depth - travel }} />
      {powerOff.shown ? (
        <FadeLayer opacity={sink}>
          <Shape steps={steps} v={v} color={powerOffColor} top={false} inset={{ top: h - depth }} />
        </FadeLayer>
      ) : null}
      {m.sub && front ? (
        <View pointerEvents="none" style={[styles.sub, { top: h - depth, height: depth, left: 2 * v, right: 2 * v }]}>
          {front}
        </View>
      ) : m.sub && sublegend ? (
        <View pointerEvents="none" style={[styles.sub, { top: h - depth, height: depth, left: 2 * v, right: 2 * v }]}>
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{ fontFamily: fonts.plex.medium, fontSize: 12, lineHeight: 16, color: tone.sub }}
          >
            {sublegend}
          </Text>
        </View>
      ) : null}

      {/* Top face. */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: w, height: capH }, capStyle]}>
        <Shape steps={steps} v={v} color={tone.shade} bottom={false} />
        <Shape steps={steps} v={v} color={tone.hi} bottom={false} inset={{ right: v, bottom: v }} />
        <Shape steps={steps - 1} v={v} color={tone.top} bottom={false} inset={{ top: v, left: v, right: v, bottom: v }} />

        {centerLegend ? (
          <View style={[StyleSheet.absoluteFill, styles.center, { bottom: v }]}>{centerLegend}</View>
        ) : face ? (
          <View style={[StyleSheet.absoluteFill, { padding: m.pad, paddingBottom: Math.round(m.pad * 0.6) + v }]}>{face}</View>
        ) : (
          <View
            style={[
              StyleSheet.absoluteFill,
              { padding: m.pad, paddingBottom: Math.round(m.pad * 0.6) + v },
              // Too small for the icon and two lines: the label alone, in the middle of the face.
              faceLayout.showIcon ? { justifyContent: 'space-between' } : styles.center,
            ]}
          >
            {faceLayout.showIcon ? <KeyIconView icon={icon} size={m.icon} color={tone.legend} shadow={iconShadow} /> : null}
            {fitted ? (
              // One Text per line, laid out by fitLabel: lines break only at spaces, never inside a word.
              <View style={faceLayout.showIcon ? null : { alignItems: 'center' }}>
                {fitted.lines.map((line, i) => (
                  <Text
                    key={i}
                    numberOfLines={1}
                    ellipsizeMode="clip"
                    style={{
                      fontFamily: fonts.plex.semibold,
                      fontSize: fitted.fontSize,
                      lineHeight: fitted.lineHeight,
                      color: tone.legend,
                      textAlign: faceLayout.showIcon ? 'left' : 'center',
                    }}
                  >
                    {line}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        )}

        {/* Status light: a square lamp with a square halo. */}
        <View style={{ position: 'absolute', top: m.pad, right: m.pad, width: m.led, height: m.led, backgroundColor: 'rgba(0,0,0,0.34)' }}>
          {lamp.shown ? (
            <FadeLayer opacity={led}>
              <View style={{ position: 'absolute', left: -v, top: -v, right: -v, bottom: -v, backgroundColor: ledColor, opacity: 0.28 }} />
              <View style={[StyleSheet.absoluteFill, { backgroundColor: ledColor }]} />
            </FadeLayer>
          ) : null}
        </View>

        {state === 'run' ? <Chase w={w} h={capH} steps={steps} v={v} color={cw.run} still={reduce} /> : null}

        {flashing ? (
          <FadeLayer opacity={flash}>
            <Shape steps={steps} v={v} color={cw.danger} bottom={false} />
          </FadeLayer>
        ) : null}
        {powerOff.shown ? (
          <FadeLayer opacity={sink}>
            <Shape steps={steps} v={v} color={powerOffColor} bottom={false} />
          </FadeLayer>
        ) : null}
      </Animated.View>

      {ringLayer.shown ? (
        <FadeLayer opacity={ring}>
          <Ring steps={steps} v={v} color={cw.focus} gap={2 * v} />
        </FadeLayer>
      ) : null}

      {bursts > 0 && state === 'ok' && !reduce ? (
        <Burst key={bursts} v={v} x={w / 2} y={2 * v} colors={[cw.ok, cw.text, cw.ok]} />
      ) : null}
    </Animated.View>
  );

  if (!interactive) return body;
  return <GestureDetector gesture={gesture}>{body}</GestureDetector>;
});

/**
 * Mount state for a layer that shows while `on` and fades out after: it stays mounted until
 * its exit animation calls `hide`.
 */
function useTransientLayer(on: boolean) {
  const [lingering, setLingering] = useState(on);
  if (on && !lingering) setLingering(true);
  const onRef = useRef(on);
  onRef.current = on;
  const hide = useCallback(() => {
    if (!onRef.current) setLingering(false);
  }, []);
  return { shown: on || lingering, hide };
}

/** Fills its parent and fades with `opacity`; the animated style exists only while it's mounted. */
function FadeLayer({ opacity, children }: { opacity: SharedValue<number>; children: ReactNode }) {
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      {children}
    </Animated.View>
  );
}

/** Pixels marching round the edge of the top face while a key runs. */
function Chase({ w, h, steps, v, color, still }: { w: number; h: number; steps: number; v: number; color: string; still: boolean }) {
  const offset = useSharedValue(0);
  useEffect(() => {
    if (still) return;
    offset.value = withRepeat(withTiming(-4 * v, { duration: 500, easing: Easing.linear }), -1, false);
  }, [still, v, offset]);
  const animatedProps = useAnimatedProps(() => ({ strokeDashoffset: offset.value }));
  return (
    <Svg width={w} height={h} style={StyleSheet.absoluteFill} pointerEvents="none">
      <AnimatedPath
        d={steppedOutlinePath(w, h, steps, v, true, false)}
        stroke={color}
        strokeWidth={v}
        strokeDasharray={[2 * v, 2 * v]}
        fill="none"
        animatedProps={animatedProps}
      />
    </Svg>
  );
}

/** Where each cube flies, at the 4 dp voxel size: x, y, spin. */
const BITS: [number, number, number][] = [
  [-62, -58, 90],
  [-32, -88, -180],
  [-6, -104, 90],
  [20, -94, 180],
  [50, -74, -90],
  [74, -44, 90],
  [-80, -24, -90],
  [36, -112, 270],
];

/** How long a burst lasts, and the phases its cubes go through. */
const BURST_MS = 900;
const RISE_MS = 300;
const FALL_MS = 560;
const APPEAR_MS = 40;
const FADE_AT_MS = 600;
const FADE_MS = 240;
const easeOut = Easing.out(Easing.quad);
const easeIn = Easing.in(Easing.quad);
// withTiming's default curve.
const easeInOut = Easing.inOut(Easing.quad);

/**
 * A handful of cubes thrown off the top of a key when it finishes. One clock drives every
 * cube, so a burst starts a single animation instead of four per cube.
 */
function Burst({ v, x, y, colors }: { v: number; x: number; y: number; colors: string[] }) {
  const clock = useSharedValue(0);
  useEffect(() => {
    clock.value = withTiming(BURST_MS, { duration: BURST_MS, easing: Easing.linear });
  }, [clock]);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: x, top: y, width: 0, height: 0 }}>
      {BITS.map(([dx, dy, r], i) => (
        <Bit key={i} clock={clock} v={v} dx={(dx * v) / 4} dy={(dy * v) / 4} spin={r} color={colors[i % colors.length]!} />
      ))}
    </View>
  );
}

function Bit({ clock, v, dx, dy, spin, color }: { clock: SharedValue<number>; v: number; dx: number; dy: number; spin: number; color: string }) {
  const style = useAnimatedStyle(() => {
    const t = clock.value;
    const fall = 35 * v;
    const ty = t < RISE_MS ? dy * easeOut(t / RISE_MS) : dy + fall * easeIn(Math.min(1, (t - RISE_MS) / FALL_MS));
    let opacity = 1;
    if (t < APPEAR_MS) opacity = easeInOut(t / APPEAR_MS);
    else if (t > FADE_AT_MS) opacity = 1 - easeInOut(Math.min(1, (t - FADE_AT_MS) / FADE_MS));
    return {
      opacity,
      transform: [
        { translateX: dx * 1.4 * easeOut(t / BURST_MS) },
        { translateY: ty },
        { rotate: `${spin * 2 * easeInOut(t / BURST_MS)}deg` },
      ],
    };
  });
  const size = 2 * v;
  return (
    <Animated.View style={[{ position: 'absolute', left: -v, top: -v, width: size, height: size, backgroundColor: color }, style]}>
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: v, backgroundColor: 'rgba(0,0,0,0.24)' }} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sub: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
});
