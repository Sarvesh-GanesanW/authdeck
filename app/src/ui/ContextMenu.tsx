/**
 * iOS-style context menu: the pressed item lifts in place over a dimmed backdrop
 * and a voxel menu springs out next to it.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { haptics } from '../lib/haptics';
import { springs } from '../theme/motion';
import { Press } from './controls';
import { Glyph, type GlyphName } from './Icon';
import { Text } from './Text';
import { useColorway, useScreen } from './theme';
import { RaisedFace, VOXEL } from './voxel';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MenuItem {
  label: string;
  icon: GlyphName;
  destructive?: boolean;
  onSelect: () => void;
}

const MENU_W = 260;
const ROW_H = 50;

export function ContextMenu({
  anchor,
  preview,
  items,
  onClose,
}: {
  /** Where the item sits on screen (from measureInWindow). Null hides the menu. */
  anchor: Rect | null;
  /** The item drawn again on top, same size as anchor. */
  preview: ReactNode;
  items: MenuItem[];
  onClose: () => void;
}) {
  const cw = useColorway();
  const screen = useScreen();
  const [shown, setShown] = useState<Rect | null>(anchor);
  const p = useSharedValue(0);

  useEffect(() => {
    if (anchor) {
      setShown(anchor);
      haptics.lift();
      p.value = 0;
      p.value = withSpring(1, springs.bouncy);
    } else if (shown) {
      p.value = withSpring(0, { ...springs.snappy, overshootClamping: true }, (done) => {
        if (done) scheduleOnRN(setShown, null);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  const backdrop = useAnimatedStyle(() => ({ opacity: p.value }));
  const lift = useAnimatedStyle(() => ({ transform: [{ scale: interpolate(p.value, [0, 1], [1, 1.07]) }] }));
  const menu = useAnimatedStyle(() => ({
    opacity: Math.min(1, p.value * 1.5),
    transform: [{ scale: interpolate(p.value, [0, 1], [0.6, 1]) }],
  }));

  if (!shown) return null;

  const menuH = items.length * ROW_H + 16 + 2 * VOXEL;
  const below = shown.y + shown.height + 14 + menuH < screen.height - 16;
  const top = below ? shown.y + shown.height + 14 : Math.max(16, shown.y - 14 - menuH);
  const left = Math.min(Math.max(12, shown.x + shown.width / 2 - MENU_W / 2), screen.width - MENU_W - 12);

  const choose = (item: MenuItem) => {
    onClose();
    // Let the menu start closing before the action changes the screen underneath.
    setTimeout(item.onSelect, 120);
  };

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <Animated.View style={[StyleSheet.absoluteFill, backdrop]}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: cw.scrim }]} onPress={onClose} accessibilityLabel="Close menu" />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: shown.x, top: shown.y, width: shown.width, height: shown.height }, lift]}>
        {preview}
      </Animated.View>
      <Animated.View
        accessibilityRole="menu"
        style={[
          {
            position: 'absolute',
            left,
            top,
            width: MENU_W,
            paddingTop: 8,
            paddingBottom: 8 + 2 * VOXEL,
            transformOrigin: below ? 'top center' : 'bottom center',
          },
          menu,
        ]}
      >
        <RaisedFace tone={cw.float} steps={2} depth={2 * VOXEL} shadow={cw.shadow} />
        {items.map((item, i) => (
          <View key={item.label}>
            {i > 0 ? <View style={{ height: 2, backgroundColor: cw.line, marginHorizontal: 16 }} /> : null}
            <Press
              onPress={() => choose(item)}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              scaleTo={0.98}
              style={{ height: ROW_H - 2, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}
            >
              <Text style={{ flex: 1 }} weight="medium" color={item.destructive ? cw.dangerText : cw.text}>
                {item.label}
              </Text>
              <Glyph name={item.icon} size={24} color={item.destructive ? cw.dangerText : cw.text} />
            </Press>
          </View>
        ))}
      </Animated.View>
    </Modal>
  );
}
