/**
 * Pages as a segmented control: a sunken groove with a raised block that follows the
 * pager continuously, so it slides while the user swipes between pages.
 */
import { useEffect, useRef } from 'react';
import { type LayoutChangeEvent, Pressable, ScrollView, type ScrollViewInstance, StyleSheet, View } from 'react-native';
import Animated, { type SharedValue, interpolate, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { haptics } from '../../lib/haptics';
import { sounds } from '../../lib/sounds';
import type { Page } from '../../state/model';
import { LONG_PRESS_MS } from '../../theme/motion';
import { Glyph } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { RaisedFace, SunkenFace, VOXEL } from '../../ui/voxel';
import { headerMetrics } from './HeaderButton';

/** How long after a size change the scroll is asked for again, once the native scroller has the new size. */
const SETTLE_MS = 120;

interface Props {
  pages: Page[];
  index: number;
  /** Continuous page position from the pager. */
  pos: SharedValue<number>;
  onSelect: (i: number) => void;
  /** Tapping the current page while editing (or long-pressing any page) opens its settings. */
  onOptions: (i: number) => void;
  editing: boolean;
  compact: boolean;
  /** Fill the available width with equal segments (phones held upright). */
  stretch: boolean;
  /** Take the row's free width with the bar, keeping the segments at their own widths (phones on their side). */
  grow?: boolean;
  /** App currently in front on the computer. */
  frontAppId: string | null;
  /**
   * A raised block follows right after the bar. Blocks cast a VOXEL shadow to their right that
   * reads as part of the gap after them; the sunken bar casts none, so it gives that much back and
   * every gap in the row looks the same.
   */
  beforeBlock?: boolean;
  /**
   * Reports the bar's width and the least it needs: the current page's segment in full and a
   * glimpse of the next. The header gives the bar more room (the computer's name goes) when it
   * has less.
   */
  onRoom?: (width: number, need: number) => void;
}

export function PageTabs({ pages, index, pos, onSelect, onOptions, editing, compact, stretch, grow, frontAppId, beforeBlock, onRoom }: Props) {
  const cw = useColorway();
  const m = headerMetrics(compact);
  const tone = cw.caps.alpha;
  const layouts = useSharedValue<{ x: number[]; w: number[] }>({ x: [], w: [] });
  const xs = useRef<number[]>([]);
  const ws = useRef<number[]>([]);
  const scroller = useRef<ScrollViewInstance>(null);
  const viewW = useRef(0);
  const barW = useRef(0);
  const contentW = useRef(0);

  const n = pages.length;
  const equal = stretch && n <= 4;
  const segH = m.control - 2 * VOXEL;

  useEffect(() => {
    xs.current = xs.current.slice(0, n);
    ws.current = ws.current.slice(0, n);
  }, [n]);

  // Keep the current page's segment in view when there are more pages than fit: centred where the
  // row allows, and at the row's end otherwise, so the segment is never cut at either edge.
  const scrollToCurrent = (animated: boolean) => {
    const x = xs.current[index];
    const w = ws.current[index];
    if (x === undefined || w === undefined || !scroller.current || viewW.current === 0) return;
    const end = Math.max(0, contentW.current - viewW.current);
    scroller.current.scrollTo({ x: Math.min(end, Math.max(0, x - (viewW.current - w) / 2)), animated });
  };
  // A scroll asked for as the size changes is clamped to the old sizes by the native scroller (the
  // bar narrowing as the vault chip appears or widens), and so is one a frame later: ask again
  // once the new size has reached it.
  const later = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settle = () => {
    scrollToCurrent(false);
    if (later.current !== null) clearTimeout(later.current);
    later.current = setTimeout(() => {
      later.current = null;
      scrollToCurrent(false);
    }, SETTLE_MS);
  };
  useEffect(
    () => () => {
      if (later.current !== null) clearTimeout(later.current);
    },
    [],
  );

  // The least the bar should get: every segment where they are few, else the current one and a
  // glimpse of the next, so the row reads as tabs that scroll.
  const report = () => {
    const w = ws.current[index];
    if (!onRoom || barW.current <= 0 || w === undefined) return;
    const all = contentW.current > 0 ? contentW.current : Infinity;
    onRoom(barW.current, Math.min(all, w + 2 * m.control) + 2 * VOXEL);
  };
  useEffect(() => {
    report();
    scrollToCurrent(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const measure = (i: number) => (e: LayoutChangeEvent) => {
    xs.current[i] = e.nativeEvent.layout.x;
    ws.current[i] = e.nativeEvent.layout.width;
    let complete = true;
    for (let k = 0; k < n; k++) if (xs.current[k] === undefined || ws.current[k] === undefined) complete = false;
    if (!complete) return;
    layouts.value = { x: xs.current.slice(0, n), w: ws.current.slice(0, n) };
    // On first layout the effect above ran before the segments and the row were measured.
    settle();
    report();
  };

  const indicator = useAnimatedStyle(() => {
    const { x, w } = layouts.value;
    const count = x.length;
    if (count === 0) return { opacity: 0, width: 0 };
    const p = Math.max(0, Math.min(count - 1, pos.value));
    if (count === 1) return { opacity: 1, width: w[0]!, transform: [{ translateX: x[0]! }] };
    const idx = x.map((_, i) => i);
    return { opacity: 1, width: interpolate(p, idx, w), transform: [{ translateX: interpolate(p, idx, x) }] };
  });

  const row = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexGrow: equal ? 1 : 0 }}>
      <Animated.View pointerEvents="none" style={[styles.indicator, { height: segH }, indicator]}>
        <RaisedFace tone={tone} depth={VOXEL} />
      </Animated.View>
      {pages.map((page, i) => (
        <Segment
          key={page.id}
          page={page}
          i={i}
          pos={pos}
          height={segH}
          equal={equal}
          compact={compact}
          selected={i === index}
          showChevron={editing && i === index}
          linkLit={!!page.focusApp && page.focusApp.appId === frontAppId}
          onLayout={measure(i)}
          onPress={() => {
            if (i === index) {
              if (editing) onOptions(i);
              return;
            }
            haptics.tick();
            sounds.tick();
            onSelect(i);
          }}
          onLongPress={() => {
            if (i !== index) onSelect(i);
            onOptions(i);
          }}
          legend={tone.legend}
        />
      ))}
    </View>
  );

  return (
    <View
      accessibilityRole="tablist"
      onLayout={(e) => {
        barW.current = e.nativeEvent.layout.width;
        report();
      }}
      style={{
        height: m.control,
        padding: VOXEL,
        flexShrink: 1,
        flexGrow: stretch || grow ? 1 : 0,
        marginRight: beforeBlock ? -VOXEL : 0,
      }}
    >
      <SunkenFace color={cw.plate} lip={cw.lip} />
      {equal ? (
        row
      ) : (
        <ScrollView
          ref={scroller}
          horizontal
          showsHorizontalScrollIndicator={false}
          // The bar's width changes with the window and with the controls beside it (the vault chip
          // appears, goes, or changes its words): keep the current segment in view each time.
          onLayout={(e) => {
            viewW.current = e.nativeEvent.layout.width;
            settle();
          }}
          onContentSizeChange={(w) => {
            contentW.current = w;
            settle();
            report();
          }}
          contentContainerStyle={{ flexGrow: stretch ? 1 : 0 }}
        >
          {row}
        </ScrollView>
      )}
    </View>
  );
}

function Segment({
  page,
  i,
  pos,
  height,
  equal,
  compact,
  selected,
  showChevron,
  linkLit,
  onLayout,
  onPress,
  onLongPress,
  legend,
}: {
  page: Page;
  i: number;
  pos: SharedValue<number>;
  height: number;
  equal: boolean;
  compact: boolean;
  selected: boolean;
  showChevron: boolean;
  linkLit: boolean;
  onLayout: (e: LayoutChangeEvent) => void;
  onPress: () => void;
  onLongPress: () => void;
  legend: string;
}) {
  const cw = useColorway();
  // Two copies of the label cross-fade as the raised segment slides over them: only one shows at
  // rest, so a long name that the two copies lay out differently never draws twice.
  const lit = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - Math.abs(pos.value - i)) }));
  const unlit = useAnimatedStyle(() => ({ opacity: Math.min(1, Math.abs(pos.value - i)) }));
  const pad = compact ? 12 : 22;
  const glyph = 12;

  const content = (color: string, linkColor: string) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 6 : 8 }}>
      {page.otp ? <Glyph name="lock" size={compact ? 12 : 24} color={color} /> : null}
      <Text variant="subhead" weight="medium" numberOfLines={1} color={color}>
        {page.name || 'Untitled'}
      </Text>
      {page.focusApp ? <Glyph name="link" size={glyph} color={linkColor} /> : null}
      {showChevron ? <Glyph name="chevron-down" size={glyph} color={color} /> : null}
    </View>
  );

  const followed = (page.otp ? ', 2FA page' : '') + (page.focusApp ? `, follows ${page.focusApp.appName}` : '');
  return (
    <Pressable
      onLayout={onLayout}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={LONG_PRESS_MS}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={`${page.name || 'Untitled'}${followed}`}
      accessibilityHint={showChevron ? 'Opens page settings' : undefined}
      style={{
        height,
        flex: equal ? 1 : undefined,
        paddingHorizontal: pad,
        paddingBottom: VOXEL,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Animated.View style={unlit}>{content(cw.textDim, linkLit ? cw.focus : cw.textFaint)}</Animated.View>
      {/* Drawn only: the tab's label is read once, from the Pressable. */}
      <Animated.View
        pointerEvents="none"
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        // One dp less padding than the segment it lies over: fractional widths otherwise end the
        // label in an ellipsis ("R…") though it is the same text in the same font.
        style={[StyleSheet.absoluteFill, styles.center, { paddingBottom: VOXEL, paddingHorizontal: pad - 1 }, lit]}
      >
        {content(legend, linkLit ? cw.focus : legend + '99')}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  indicator: { position: 'absolute', left: 0, top: 0 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
