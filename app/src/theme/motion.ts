/**
 * Motion tokens. Everything moves on springs described the way UIKit does:
 * a perceptual duration plus a damping ratio (1 = no bounce).
 * Use these instead of ad-hoc timings so the whole app feels like one system.
 */
import type { WithSpringConfig } from 'react-native-reanimated';

export const springs = {
  /** Finger down on a key or button: quick, no bounce. */
  pressIn: { duration: 160, dampingRatio: 1 },
  /** Finger up: pops back with a small overshoot. */
  pressOut: { duration: 420, dampingRatio: 0.6 },
  /** Toggles, tab indicator, selection rings. */
  snappy: { duration: 340, dampingRatio: 0.82 },
  /** Sheets, pages, panes: iOS default, critically damped. */
  smooth: { duration: 480, dampingRatio: 1 },
  /** Things arriving: toasts, new keys, context menus. */
  bouncy: { duration: 520, dampingRatio: 0.7 },
  /** Dragged key settling into a slot. */
  settle: { duration: 420, dampingRatio: 0.78 },
} satisfies Record<string, WithSpringConfig>;

/** Rubber-band resistance used when dragging past an edge (UIScrollView constant). */
export function rubberBand(offset: number, dimension: number, coefficient = 0.55): number {
  'worklet';
  const sign = offset < 0 ? -1 : 1;
  const x = Math.abs(offset);
  return sign * (1 - 1 / ((x * coefficient) / dimension + 1)) * dimension;
}

export const JIGGLE_DEG = 1.3;
export const JIGGLE_MS = 130;
export const LONG_PRESS_MS = 420;
