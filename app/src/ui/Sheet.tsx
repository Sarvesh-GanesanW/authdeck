/**
 * Adaptive sheet. Phones: a voxel slab rising from the bottom that pushes the app back like
 * an iOS page sheet and swipes down to dismiss. Tablets and desktops: a centred panel.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { create } from 'zustand';
import { GestureDetector, GestureHandlerRootView, usePanGesture } from 'react-native-gesture-handler';
import Animated, { interpolate, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { rubberBand, springs } from '../theme/motion';
import { IconButton } from './controls';
import { KeyboardScrollMemory } from './keyboardScroll';
import { PANEL_FRONT, PanelFace } from './Panel';
import { Text } from './Text';
import { useColorway, useDepth, useScreen } from './theme';

interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  /** Shown under the title. */
  subtitle?: string;
  children: ReactNode;
  /** Pinned under the scrolling body. */
  footer?: ReactNode;
  /** Max width of the centred sheet on large screens. */
  maxWidth?: number;
  /** Fill most of the screen height (lists, pickers). */
  tall?: boolean;
  /** Body handles its own scrolling (e.g. a FlatList). */
  noScroll?: boolean;
  /**
   * Draw in the app's own window instead of a separate Modal window (SecureSheet sets this). Only
   * for sheets rendered at the app root, as AuthHost's are, so the overlay covers the whole app.
   */
  inWindow?: boolean;
}

export type { SheetProps };

/** True inside a sheet drawn in its own Modal window, which the app window's capture block doesn't cover. */
export const InModalWindowContext = createContext(false);

/** Something on screen that can say where it is, such as a View. */
interface Measurable {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
}

const RevealContext = createContext<(target: Measurable | null) => void>(() => undefined);

/**
 * Scrolls the sheet's body so `target` is in view: for content that appears below the fold, like
 * an "are you sure?" under a delete button. Does nothing outside a scrolling sheet.
 */
export function useRevealInSheet(): (target: Measurable | null) => void {
  return useContext(RevealContext);
}

/**
 * How many in-window (secure) sheets are open. While any is, Modal sheets are not drawn: a Modal
 * window would sit above the app window and hide the secure sheet. They come back when it closes.
 */
export const useInWindowSheets = create<{ open: number }>(() => ({ open: 0 }));

/** Below this window height (a phone on its side) sheets and the pickers in them keep their chrome tight. */
export const SHORT_WINDOW = 480;

/** Open phone sheets; the app stays pushed back until the last one closes. */
let openBottomSheets = 0;

export function Sheet({ visible, onClose, title, subtitle, children, footer, maxWidth = 680, tall, noScroll, inWindow: inWindowProp = false }: SheetProps) {
  // A sheet opened while a secure sheet is open (its "are you sure?" question, say) belongs to that
  // flow: it is drawn in the app window too, above the secure sheet, so it can't be hidden under
  // it. Sheets that were already open before stay hidden until the secure sheet closes.
  const secureOpen = useInWindowSheets((st) => st.open > 0);
  const openedOverSecure = useRef(false);
  const wasVisible = useRef(false);
  if (visible && !wasVisible.current) openedOverSecure.current = secureOpen && !inWindowProp;
  wasVisible.current = visible;
  const inWindow = inWindowProp || openedOverSecure.current;
  const cw = useColorway();
  const screen = useScreen();
  const insets = useSafeAreaInsets();
  const depth = useDepth();
  const [mounted, setMounted] = useState(visible);
  const progress = useSharedValue(0);
  const drag = useSharedValue(0);
  const bottomSheet = screen.compact;

  // Whether this sheet is counted in openBottomSheets. A sheet can unmount while open
  // (its screen swapped for another), so the count is released on unmount too;
  // otherwise the app would stay pushed back.
  const pushedBack = useRef(false);
  const releasePushBack = useCallback(() => {
    if (!pushedBack.current) return;
    pushedBack.current = false;
    openBottomSheets = Math.max(0, openBottomSheets - 1);
    depth.value = withSpring(openBottomSheets > 0 ? 1 : 0, springs.smooth);
  }, [depth]);
  useEffect(() => releasePushBack, [releasePushBack]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      drag.value = 0;
    } else if (mounted) {
      releasePushBack();
      progress.value = withSpring(0, { ...springs.smooth, overshootClamping: true }, (done) => {
        if (done) scheduleOnRN(setMounted, false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Opening starts once the sheet is mounted, so the time spent building its content
  // isn't taken out of the animation.
  useEffect(() => {
    if (!visible || !mounted) return;
    progress.value = withSpring(1, springs.smooth);
    if (bottomSheet && !pushedBack.current) {
      pushedBack.current = true;
      openBottomSheets++;
      depth.value = withSpring(1, springs.smooth);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mounted]);

  // While the sheet moves it is drawn from a cached texture instead of re-rendering every frame.
  const [moving, setMoving] = useState(false);
  useAnimatedReaction(
    () => progress.value > 0 && progress.value < 1,
    (now, before) => {
      if (now !== before) scheduleOnRN(setMoving, now);
    },
  );

  const sheetH = screen.height;
  // A swipe asks to close; the owner may ask "are you sure?" first and keep the sheet open. Then
  // the sheet settles back instead of staying where the finger left it.
  const visibleNow = useRef(visible);
  visibleNow.current = visible;
  const closeFromSwipe = useCallback(() => {
    onClose();
    setTimeout(() => {
      if (!visibleNow.current) return;
      drag.value = withSpring(0, springs.smooth);
      if (bottomSheet) depth.value = withSpring(1, springs.smooth);
    }, 50);
  }, [onClose, drag, depth, bottomSheet]);
  const pan = usePanGesture({
    activeOffsetY: [-8, 8],
    onUpdate: (e) => {
      'worklet';
      const dy = e.translationY;
      drag.value = dy > 0 ? dy : rubberBand(dy, 300, 0.4);
      if (bottomSheet) depth.value = 1 - Math.min(1, Math.max(0, dy) / (sheetH * 0.8));
    },
    onDeactivate: (e) => {
      'worklet';
      if (e.translationY > 140 || e.velocityY > 900) {
        scheduleOnRN(closeFromSwipe);
      } else {
        drag.value = withSpring(0, { ...springs.smooth, velocity: e.velocityY });
        if (bottomSheet) depth.value = withSpring(1, springs.smooth);
      }
    },
  });

  const backdrop = useAnimatedStyle(() => ({ opacity: progress.value }));
  const card = useAnimatedStyle(() => {
    if (bottomSheet) {
      return { transform: [{ translateY: (1 - progress.value) * sheetH + drag.value }] };
    }
    return {
      opacity: Math.min(1, progress.value * 1.6),
      transform: [
        { translateY: interpolate(progress.value, [0, 1], [36, 0]) + drag.value },
        { scale: interpolate(progress.value, [0, 1], [0.94, 1]) },
      ],
    };
  });

  const coveredBySecureSheet = secureOpen && !inWindow;

  // In the app window there is no Modal to take the back button: the sheet takes it while open.
  useEffect(() => {
    if (!inWindow || !mounted) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [inWindow, mounted, onClose]);

  // In the app window there is no Modal for the keyboard to resize, and with edge-to-edge Android
  // doesn't resize the app window either: the sheet makes room for the keyboard itself. In a Modal
  // the KeyboardAvoidingView lifts the sheet; the overlap is still measured so its height fits.
  const keyboard = useKeyboardOverlap(true);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollY = useRef(0);
  const scrollMemory = useRef(new KeyboardScrollMemory());
  useEffect(() => {
    if (!inWindow) return;
    const back = scrollMemory.current.overlapChanged(keyboard.overlap, scrollY.current);
    // The keyboard hid: put the body back where it was before it came up (usually the top).
    if (back) {
      const timer = setTimeout(() => scrollRef.current?.scrollTo({ y: back.restoreTo, animated: true }), 80);
      return () => clearTimeout(timer);
    }
    if (keyboard.overlap === 0) return;
    // After the sheet has shrunk above the keyboard, bring the focused field into view.
    const timer = setTimeout(() => scrollFocusedIntoView(scrollRef.current, scrollY.current), 80);
    return () => clearTimeout(timer);
  }, [inWindow, keyboard.overlap]);
  // The height the sheet may use: its layer (the window, or what the system left of it) above the keyboard.
  const room = (keyboard.layerHeight || screen.height) - keyboard.overlap;
  const reveal = useCallback((target: Measurable | null) => scrollIntoSight(scrollRef.current, target, scrollY.current), []);
  // A phone on its side: less space kept above the sheet and in its header.
  const short = screen.height < SHORT_WINDOW;
  const topGap = short ? 8 : 24;
  // Bottom sheets span the window, so in landscape they keep clear of a notch or camera cutout.
  const sidePad = bottomSheet ? 20 : 28;
  const sides = bottomSheet ? { paddingLeft: sidePad + insets.left, paddingRight: sidePad + insets.right } : { paddingHorizontal: sidePad };

  if (!mounted || coveredBySecureSheet) return null;

  const header = (
    <GestureDetector gesture={pan}>
      <View style={[{ paddingTop: bottomSheet ? (short ? 6 : 10) : 22, paddingBottom: 12 }, sides]}>
        {bottomSheet ? (
          <View style={{ alignSelf: 'center', width: 36, height: 4, backgroundColor: cw.textFaint, opacity: 0.7, marginBottom: short ? 8 : 14 }} />
        ) : null}
        {title ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ flex: 1, gap: 3 }}>
              <Text variant="title" accessibilityRole="header">
                {title}
              </Text>
              {subtitle ? <Text tone="dim">{subtitle}</Text> : null}
            </View>
            <IconButton icon="close" label="Close" onPress={onClose} />
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );

  const bodyPad = sides;

  const layer = (
    <GestureHandlerRootView style={inWindow ? [StyleSheet.absoluteFill, styles.inWindow] : { flex: 1 }} onLayout={keyboard.onLayout}>
      <Animated.View style={[StyleSheet.absoluteFill, backdrop]}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: cw.scrim }]} onPress={onClose} accessibilityLabel="Close" />
      </Animated.View>
      <KeyboardAvoidingView
        // In the app window the sheet makes room for the keyboard itself (useKeyboardOverlap).
        enabled={!inWindow}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[
          StyleSheet.absoluteFill,
          bottomSheet ? { justifyContent: 'flex-end' } : { alignItems: 'center', justifyContent: 'center', padding: 24 },
          inWindow && keyboard.overlap > 0 ? { paddingBottom: keyboard.overlap + (bottomSheet ? 0 : 24) } : null,
        ]}
        pointerEvents="box-none"
      >
        <Animated.View
          accessibilityViewIsModal
          renderToHardwareTextureAndroid={moving}
          shouldRasterizeIOS={moving}
          style={[
            bottomSheet
              ? {
                  maxHeight: room - insets.top - topGap,
                  height: tall ? room - insets.top - topGap : undefined,
                  paddingBottom: keyboard.overlap > 0 ? 12 : insets.bottom + 12,
                }
              : {
                  width: '100%',
                  maxWidth,
                  maxHeight: Math.min(screen.height * 0.88, room - 48),
                  height: tall ? Math.min(screen.height * 0.84, room - 48) : undefined,
                  paddingBottom: 24 + PANEL_FRONT,
                },
            card,
          ]}
        >
          <PanelFace attached={bottomSheet} />
          {header}
          {noScroll ? (
            <View style={[{ flex: 1 }, bodyPad]}>{children}</View>
          ) : (
            <ScrollView
              ref={scrollRef}
              onScroll={(e) => {
                scrollY.current = e.nativeEvent.contentOffset.y;
              }}
              scrollEventThrottle={32}
              style={{ flexGrow: tall ? 1 : 0, flexShrink: 1 }}
              contentContainerStyle={[bodyPad, { paddingBottom: 8, gap: 22 }]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <RevealContext.Provider value={reveal}>{children}</RevealContext.Provider>
            </ScrollView>
          )}
          {footer ? <View style={[bodyPad, { paddingTop: 16 }]}>{footer}</View> : null}
        </Animated.View>
      </KeyboardAvoidingView>
    </GestureHandlerRootView>
  );
  if (inWindow) return layer;
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <InModalWindowContext.Provider value={true}>{layer}</InModalWindowContext.Provider>
    </Modal>
  );
}

/**
 * How much of the sheet's layer the keyboard covers, from the keyboard's top edge on screen and
 * the layer's height (the layer fills the app window from its top). Measured rather than assumed,
 * so it is right whether or not the system also resized the window.
 */
function useKeyboardOverlap(active: boolean): { overlap: number; layerHeight: number; onLayout: (e: LayoutChangeEvent) => void } {
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [layerHeight, setLayerHeight] = useState(0);
  useEffect(() => {
    if (!active) return;
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (e) => setKeyboardTop(e.endCoordinates.screenY));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardTop(null));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [active]);
  const onLayout = useCallback((e: LayoutChangeEvent) => setLayerHeight(e.nativeEvent.layout.height), []);
  const overlap = active && keyboardTop !== null && layerHeight > 0 ? Math.max(0, Math.round(layerHeight - keyboardTop)) : 0;
  return { overlap, layerHeight, onLayout };
}

/** Scrolls so the focused text field sits inside the scroll view, with a little room around it. */
function scrollFocusedIntoView(scroll: ScrollViewInstance | null, offset: number): void {
  scrollIntoSight(scroll, TextInput.State.currentlyFocusedInput() ?? null, offset);
}

/** Scrolls so `input` sits inside the scroll view, with a little room around it. */
function scrollIntoSight(scroll: ScrollViewInstance | null, input: Measurable | null, offset: number): void {
  if (!scroll || !input) return;
  const margin = 16;
  scroll.measureInWindow((_sx, sy, _sw, sh) => {
    input.measureInWindow((_ix, iy, _iw, ih) => {
      if (sh <= 0) return;
      if (iy + ih + margin > sy + sh) scroll.scrollTo({ y: offset + iy + ih + margin - (sy + sh), animated: true });
      else if (iy - margin < sy) scroll.scrollTo({ y: Math.max(0, offset - (sy - iy) - margin), animated: true });
    });
  });
}

const styles = StyleSheet.create({
  // Above the app's other root views; toasts and notices are drawn after AuthHost and stay on top.
  inWindow: { zIndex: 1000, elevation: 1000 },
});
