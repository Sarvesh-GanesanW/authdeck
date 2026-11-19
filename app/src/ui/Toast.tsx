/**
 * Result banner: a voxel slab that drops in from the top like an iOS notification.
 * Close it with its × button, or swipe it up or sideways; tap "Show output" for command results.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { type Toast, useLive } from '../state/live';
import { rubberBand, springs } from '../theme/motion';
import { PressBlock } from './controls';
import { useInWindowSheets } from './Sheet';
import { Glyph } from './Icon';
import { Text } from './Text';
import { useColorway, useScreen } from './theme';
import { RaisedFace, VOXEL } from './voxel';

/** Where the banner sits while hidden, above the top edge. */
const HIDDEN_Y = -160;
/** Height of the banner's buttons; also the close button's touch target. */
const BUTTON_SIZE = 44;
/** A swipe dismisses once it passes this distance or is flung faster than SWIPE_VELOCITY. */
const SWIPE_UP_DISTANCE = 30;
const SWIPE_SIDE_DISTANCE = 80;
const SWIPE_VELOCITY = 500;
/** Reduced motion: the banner fades instead of sliding. */
const FADE = { duration: 180 };
const FLING = { duration: 200 };

/**
 * Toast text often comes from the computer. Results are checked on arrival (net/messages.ts); this
 * keeps anything that slipped past from reaching <Text> as a React child, which would crash.
 */
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

function autoDismissMs(toast: Toast): number {
  if (toast.tone === 'fail') return 8000;
  return toast.output ? 6000 : 4200;
}

export function ToastHost() {
  // Held while a SecureSheet is open: nothing, computer text included, draws over a secret. The
  // toast stays in the store and shows, with its full time, once the sheet closes.
  const secureSheetOpen = useInWindowSheets((s) => s.open > 0);
  const latest = useLive((s) => s.toast);
  const toast = secureSheetOpen ? null : latest;
  const dismiss = useLive((s) => s.dismissToast);
  const showOutput = useLive((s) => s.showOutput);
  const cw = useColorway();
  const { compact, width } = useScreen();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  // The banner on screen. It outlives the store's toast until its exit animation ends.
  const [shown, setShown] = useState<Toast | null>(toast);
  /** 0 = hidden above the screen, 1 = in place. */
  const presence = useSharedValue(0);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);

  useEffect(() => {
    if (!toast) {
      // Reassigning presence (a new toast) cancels this, so `finished` is false and the new one stays.
      const done = (finished?: boolean) => {
        'worklet';
        if (finished) scheduleOnRN(setShown, null);
      };
      presence.value = reduce ? withTiming(0, FADE, done) : withSpring(0, { ...springs.smooth, overshootClamping: true }, done);
      return;
    }
    setShown(toast);
    dragX.value = 0;
    dragY.value = 0;
    presence.value = 0;
    presence.value = reduce ? withTiming(1, FADE) : withSpring(1, springs.bouncy);
    const t = setTimeout(() => dismiss(toast.id), autoDismissMs(toast));
    return () => clearTimeout(t);
  }, [toast, dismiss, reduce, presence, dragX, dragY]);

  const id = shown?.id ?? 0;
  const pan = usePanGesture({
    activeOffsetX: [-10, 10],
    activeOffsetY: [-6, 6],
    onUpdate: (e) => {
      'worklet';
      dragX.value = e.translationX;
      dragY.value = e.translationY < 0 ? e.translationY : rubberBand(e.translationY, 120, 0.5);
    },
    onDeactivate: (e) => {
      'worklet';
      const sideways = Math.abs(e.translationX) > Math.abs(e.translationY);
      if (sideways && (Math.abs(e.translationX) > SWIPE_SIDE_DISTANCE || Math.abs(e.velocityX) > SWIPE_VELOCITY)) {
        if (!reduce) dragX.value = withTiming(Math.sign(e.translationX || e.velocityX) * width, FLING);
        scheduleOnRN(dismiss, id);
        return;
      }
      if (!sideways && (e.translationY < -SWIPE_UP_DISTANCE || e.velocityY < -SWIPE_VELOCITY)) {
        scheduleOnRN(dismiss, id);
        return;
      }
      dragX.value = withSpring(0, springs.bouncy);
      dragY.value = withSpring(0, springs.bouncy);
    },
  });

  const style = useAnimatedStyle(() => {
    const sideFade = 1 - Math.min(1, Math.abs(dragX.value) / width);
    if (reduce) {
      return { opacity: presence.value * sideFade, transform: [{ translateX: dragX.value }, { translateY: dragY.value }] };
    }
    return {
      opacity: interpolate(presence.value, [0, 0.6, 1], [0, 1, 1]) * sideFade,
      transform: [
        { translateX: dragX.value },
        { translateY: interpolate(presence.value, [0, 1], [HIDDEN_Y, 0]) + dragY.value },
        { scale: interpolate(presence.value, [0, 1], [0.9, 1]) },
      ],
    };
  });

  if (!shown) return null;
  const led = shown.tone === 'ok' ? cw.ok : shown.tone === 'fail' ? cw.danger : cw.run;
  const { output } = shown;
  const button = output ? { label: 'Show output', run: () => showOutput(output) } : shown.action;

  return (
    <View
      pointerEvents={toast ? 'box-none' : 'none'}
      style={{ position: 'absolute', top: insets.top + (compact ? 6 : 104), left: 0, right: 0, alignItems: 'center', paddingHorizontal: 12 }}
    >
      <GestureDetector gesture={pan}>
        <Animated.View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={[
            {
              maxWidth: 640,
              width: compact ? '100%' : undefined,
              minWidth: compact ? undefined : 420,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingTop: 12,
              paddingBottom: 12 + 2 * VOXEL,
              paddingLeft: 20,
              paddingRight: 12,
            },
            style,
          ]}
        >
          <RaisedFace tone={cw.float} steps={2} depth={2 * VOXEL} shadow={cw.shadow} />
          <View style={{ width: 8, height: 8, backgroundColor: led }}>
            <View style={{ position: 'absolute', left: -4, top: -4, right: -4, bottom: -4, backgroundColor: led, opacity: 0.25 }} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="subhead" numberOfLines={2}>
              {textOf(shown.title)}
            </Text>
            {textOf(shown.detail) ? (
              <Text variant="label" tone="dim" numberOfLines={3}>
                {textOf(shown.detail)}
              </Text>
            ) : null}
          </View>
          {button ? (
            <PressBlock
              tone={cw.caps.a}
              onPress={() => {
                button.run();
                dismiss(shown.id);
              }}
              style={{ height: BUTTON_SIZE }}
              contentStyle={{ paddingHorizontal: 14, paddingBottom: VOXEL, justifyContent: 'center' }}
              accessibilityLabel={button.label}
            >
              <Text variant="label" weight="semibold" color={cw.caps.a.legend}>
                {button.label}
              </Text>
            </PressBlock>
          ) : null}
          <PressBlock
            tone={cw.control}
            onPress={() => dismiss(shown.id)}
            accessibilityLabel="Dismiss"
            style={{ width: BUTTON_SIZE, height: BUTTON_SIZE }}
            contentStyle={{ alignItems: 'center', justifyContent: 'center', paddingBottom: VOXEL }}
          >
            <Glyph name="close" size={24} color={cw.textDim} />
          </PressBlock>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
