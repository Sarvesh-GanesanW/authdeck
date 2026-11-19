/**
 * One key on the deck, positioned on a spring so it can shuffle aside while another
 * key is dragged. In edit mode it jiggles, shows a remove badge and can be dragged
 * after a short hold.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostInstance } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  type SharedValue,
  ZoomIn,
  ZoomOut,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { sublegend, summary } from '../../lib/describe';
import { haptics } from '../../lib/haptics';
import type { Platform } from '../../protocol';
import { useLive } from '../../state/live';
import type { DeckKey } from '../../state/model';
import { JIGGLE_DEG, JIGGLE_MS, springs } from '../../theme/motion';
import { Press } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { Keycap, keyVoxel } from '../../ui/Keycap';
import type { Rect } from '../../ui/ContextMenu';
import { useColorway } from '../../ui/theme';
import { Shape } from '../../ui/voxel';
import { type Geo, slotAt, slotOrigin } from './grid';
import { otpFaces } from './OtpFace';

const DRAG_HOLD_MS = 170;
/** Delay between neighbouring keys when the deck powers back up, for a diagonal wave. */
const WAVE_STEP_MS = 90;

export interface KeyHandlers {
  onPress: (index: number) => void;
  onMenu: (index: number, rect: Rect) => void;
  onRemove: (index: number) => void;
  onHover: (from: number, to: number) => void;
  onDrop: (from: number, to: number) => void;
}

interface Props extends KeyHandlers {
  data: DeckKey;
  index: number;
  /** Where the key sits right now (differs from index while another key is dragged). */
  slot: number;
  geo: Geo;
  geoSV: SharedValue<Geo>;
  editing: boolean;
  /** Jiggle in place; only keys on screen do, since nobody sees the others. */
  wobble: boolean;
  selected: boolean;
  dimmed: boolean;
  /** The key's page is on screen, so a 2FA key's code ticks. */
  ticking: boolean;
  platform: Platform;
  showSublegend: boolean;
}

export const DeckKeyView = memo(function DeckKeyView(props: Props) {
  const { data, index, slot, geo, geoSV, editing, wobble, selected, dimmed, ticking, platform, showSublegend } = props;
  const cw = useColorway();
  const runState = useLive((s) => s.keyStates[data.id] ?? null);
  const failTick = useLive((s) => s.failTicks[data.id] ?? 0);

  const origin = slotOrigin(geo, slot);
  const x = useSharedValue(origin.x);
  const y = useSharedValue(origin.y);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const dragging = useSharedValue(0);
  const hover = useSharedValue(index);
  const rot = useSharedValue(0);
  const raise = useSharedValue(0);
  const [held, setHeld] = useState(false);
  const ref = useRef<HostInstance>(null);
  const handlers = useRef<KeyHandlers>(props);
  handlers.current = props;

  // Spring to a new slot (shuffle while dragging, a key moved). A new grid (rotation, a resized
  // window) jumps there at once: the keys are already drawn at the new size, and springing from the
  // old places would leave them outside the plate until they settle.
  const placedGeo = useRef(geo);
  useEffect(() => {
    if (dragging.value) return;
    if (placedGeo.current !== geo) {
      placedGeo.current = geo;
      x.value = origin.x;
      y.value = origin.y;
      return;
    }
    x.value = withSpring(origin.x, springs.settle);
    y.value = withSpring(origin.y, springs.settle);
  }, [origin.x, origin.y, x, y, dragging, geo]);

  useEffect(() => {
    if (wobble) {
      const dir = Math.random() > 0.5 ? 1 : -1;
      const ms = JIGGLE_MS + Math.random() * 30;
      rot.value = withDelay(
        Math.random() * 140,
        withRepeat(withSequence(withTiming(dir * JIGGLE_DEG, { duration: ms }), withTiming(-dir * JIGGLE_DEG, { duration: ms })), -1, true),
      );
    } else {
      cancelAnimation(rot);
      rot.value = withSpring(0, springs.snappy);
    }
  }, [wobble, rot]);

  const hoverJS = (from: number, to: number) => {
    haptics.tick();
    handlers.current.onHover(from, to);
  };
  const dropJS = (from: number, to: number) => handlers.current.onDrop(from, to);
  const liftJS = () => {
    haptics.lift();
    setHeld(true);
  };
  const settleJS = () => setHeld(false);

  // A finished key throws cubes over its neighbours, so it draws above them for a moment.
  useEffect(() => {
    raise.value = runState === 'ok' ? 50 : 1;
  }, [runState, raise]);

  const drag = usePanGesture({
    enabled: editing,
    activateAfterLongPress: DRAG_HOLD_MS,
    onActivate: () => {
      'worklet';
      dragging.value = 1;
      startX.value = x.value;
      startY.value = y.value;
      hover.value = index;
      scheduleOnRN(liftJS);
    },
    onUpdate: (e) => {
      'worklet';
      x.value = startX.value + e.translationX;
      y.value = startY.value + e.translationY;
      const to = slotAt(geoSV.value, x.value, y.value);
      if (to !== hover.value) {
        hover.value = to;
        scheduleOnRN(hoverJS, index, to);
      }
    },
    onDeactivate: () => {
      'worklet';
      const g = geoSV.value;
      const o = slotOrigin(g, hover.value);
      x.value = withSpring(o.x, springs.settle);
      y.value = withSpring(o.y, springs.settle);
      scheduleOnRN(dropJS, index, hover.value);
    },
    onFinalize: () => {
      'worklet';
      dragging.value = 0;
      scheduleOnRN(settleJS);
    },
  });

  const place = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
    zIndex: dragging.value ? 100 : raise.value,
    elevation: dragging.value ? 12 : 0,
  }));
  const wobbleStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${dragging.value ? 0 : rot.value}deg` }],
  }));

  const sub = showSublegend ? sublegend(data.action, platform) : '';
  const tone = cw.caps[data.color] ?? cw.caps.alpha;
  const label = data.label || (data.action || data.otp ? '' : 'New key');
  // Memoised so the keycap keeps skipping re-renders while other keys shuffle during a drag.
  const otp = useMemo(() => (data.otp ? otpFaces(data, tone, geo.cellW, geo.cellH, ticking) : null), [data, tone, geo.cellW, geo.cellH, ticking]);

  // Stable, so the memoised Keycap skips re-rendering while other keys shuffle during a drag.
  const press = useCallback(() => handlers.current.onPress(index), [index]);
  const openMenu = useCallback(() => {
    ref.current?.measureInWindow((mx: number, my: number, width: number, height: number) => {
      handlers.current.onMenu(index, { x: mx, y: my, width, height });
    });
  }, [index]);

  const badge = 20;
  const slotCol = slot % geo.cols;
  const slotRow = Math.floor(slot / geo.cols);
  const v = keyVoxel(geo.cellW, geo.cellH);
  return (
    <GestureDetector gesture={drag}>
      <Animated.View ref={ref} style={[{ position: 'absolute', left: 0, top: 0, width: geo.cellW, height: geo.cellH }, place]}>
        <Animated.View entering={ZoomIn.springify().damping(14)} exiting={ZoomOut.duration(160)} style={{ flex: 1 }}>
          <Animated.View style={[{ flex: 1 }, wobbleStyle]}>
            <Keycap
              width={geo.cellW}
              height={geo.cellH}
              tone={tone}
              label={label}
              sublegend={sub || undefined}
              icon={data.icon}
              face={otp?.face}
              front={otp?.front}
              state={runState}
              failTick={failTick}
              // A 2FA key stays lit offline: its code can still be read and typed by hand.
              dimmed={dimmed && !editing && !data.otp}
              wave={(slotCol + slotRow) * WAVE_STEP_MS}
              raised={editing}
              lifted={held}
              selected={selected}
              silent={editing}
              onPress={press}
              onLongPress={editing ? undefined : openMenu}
              accessibilityLabel={
                data.otp
                  ? `${data.label || '2FA code'}, 2FA code. Types the code on the computer`
                  : [data.label || 'Unnamed key', summary(data.action, platform)].join(', ')
              }
              accessibilityHint={editing ? 'Opens the key editor. Hold and drag to move it.' : 'Hold for more options'}
            />
            {editing ? (
              <Press
                onPress={() => handlers.current.onRemove(index)}
                accessibilityLabel={`Remove ${data.label || 'key'}`}
                hitSlop={10}
                scaleTo={0.85}
                style={{
                  position: 'absolute',
                  left: -2 * v,
                  top: -3 * v,
                  width: badge,
                  height: badge,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Shape steps={1} color={cw.shadow} inset={{ top: 4, left: 4, right: -4, bottom: -4 }} />
                <Shape steps={1} color={cw.dark ? '#5B6170' : '#8E877A'} />
                <Shape steps={1} color={cw.dark ? '#454A56' : '#756F63'} inset={{ height: 4 }} />
                <Glyph name="minus" size={12} color="#FFFFFF" />
              </Press>
            ) : null}
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
});
