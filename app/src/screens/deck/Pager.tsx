/**
 * Horizontal pages that follow the finger, rubber-band at the ends and settle on a
 * spring that carries the release velocity, like the iOS home screen.
 * The pages within KEEP_AROUND of the one at rest stay mounted, so a switch to a nearby page only
 * slides views that already exist. Pages joining that range are built after the pages come to
 * rest, as a low-priority transition that a swipe or a tap interrupts.
 */
import { type ReactNode, startTransition, useEffect, useState } from 'react';
import { View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  type SharedValue,
  cancelAnimation,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { rubberBand, springs } from '../../theme/motion';

const PAGE_GAP = 48;
/**
 * Pages kept mounted on each side of the page at rest: a whole deck of up to seven pages, so a tap
 * on any tab only slides pages that already exist (building one takes a few hundred ms on a slow phone).
 */
const KEEP_AROUND = 3;

interface Props {
  count: number;
  index: number;
  /** Continuous position in pages; shared with the page tabs. */
  pos: SharedValue<number>;
  /** Page the pager is settling on (set by the pager and by goTo). */
  target: SharedValue<number>;
  width: number;
  height: number;
  onIndex: (i: number) => void;
  pageKey: (i: number) => string;
  /** Draws page `i`; `current` is false for the neighbours waiting off-screen. */
  renderPage: (i: number, current: boolean) => ReactNode;
}

export function Pager({ count, index, pos, target, width, height, onIndex, pageKey, renderPage }: Props) {
  const start = useSharedValue(0);
  const stride = width + PAGE_GAP;

  const pan = usePanGesture({
    enabled: count > 1,
    activeOffsetX: [-14, 14],
    failOffsetY: [-18, 18],
    onBegin: () => {
      'worklet';
      cancelAnimation(pos);
      start.value = pos.value;
    },
    onUpdate: (e) => {
      'worklet';
      const raw = start.value - e.translationX / stride;
      const last = count - 1;
      if (raw < 0) pos.value = -rubberBand(-raw * stride, stride) / stride;
      else if (raw > last) pos.value = last + rubberBand((raw - last) * stride, stride) / stride;
      else pos.value = raw;
    },
    onDeactivate: (e) => {
      'worklet';
      const v = -e.velocityX / stride;
      const from = Math.round(start.value);
      let to = Math.round(pos.value + v * 0.18);
      to = Math.max(from - 1, Math.min(from + 1, to));
      to = Math.max(0, Math.min(count - 1, to));
      target.value = to;
      pos.value = withSpring(to, { ...springs.smooth, velocity: v });
      if (to !== from) scheduleOnRN(onIndex, to);
    },
    onFinalize: (e) => {
      'worklet';
      // A cancelled swipe (e.g. a key drag took over) must still come to rest on a page.
      if (e.canceled && Math.abs(pos.value - Math.round(pos.value)) > 0.001) {
        pos.value = withSpring(Math.max(0, Math.min(count - 1, Math.round(pos.value))), springs.smooth);
      }
    },
  });

  // The page the pager last came to rest on; the pages around it are the ones kept mounted.
  const [rested, setRested] = useState(index);
  const comeToRest = (page: number) => startTransition(() => setRested(page));
  // How far around `rested` pages are mounted. It starts at 0, so the first screen builds only the
  // page shown, and grows a page per side at a time after that.
  const [reach, setReach] = useState(0);
  useEffect(() => {
    if (reach >= KEEP_AROUND) return;
    const frame = requestAnimationFrame(() => startTransition(() => setReach((r) => Math.min(KEEP_AROUND, r + 1))));
    return () => cancelAnimationFrame(frame);
  }, [reach]);
  useAnimatedReaction(
    () => (pos.value === target.value ? target.value : null),
    (now, before) => {
      if (now !== null && now !== before) scheduleOnRN(comeToRest, now);
    },
  );

  const mounted: number[] = [];
  for (let i = 0; i < count; i++) {
    if (i === index || Math.abs(i - rested) <= reach) mounted.push(i);
  }

  return (
    <GestureDetector gesture={pan}>
      <View style={{ width, height }}>
        {mounted.map((i) => (
          <PageSlot key={pageKey(i)} i={i} current={i === index} pos={pos} stride={stride} width={width} height={height}>
            {renderPage(i, i === index)}
          </PageSlot>
        ))}
      </View>
    </GestureDetector>
  );
}

function PageSlot({
  i,
  current,
  pos,
  stride,
  width,
  height,
  children,
}: {
  i: number;
  current: boolean;
  pos: SharedValue<number>;
  stride: number;
  width: number;
  height: number;
  children: ReactNode;
}) {
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: (i - pos.value) * stride }] }));
  return (
    <Animated.View
      style={[{ position: 'absolute', left: 0, top: 0, width, height }, style]}
      importantForAccessibility={current ? 'auto' : 'no-hide-descendants'}
      accessibilityElementsHidden={!current}
    >
      {children}
    </Animated.View>
  );
}
