import { createContext, useContext, useMemo } from 'react';
import { useColorScheme, useWindowDimensions } from 'react-native';
import { type SharedValue, useSharedValue } from 'react-native-reanimated';

import { COLORWAYS, type Colorway } from '../theme/colorways';
import { useStore } from '../state/store';

export function useColorway(): Colorway {
  const setting = useStore((s) => s.settings.colorway);
  const scheme = useColorScheme();
  if (setting === 'system') return scheme === 'light' ? COLORWAYS.paper : COLORWAYS.graphite;
  return COLORWAYS[setting];
}

export interface Screen {
  width: number;
  height: number;
  landscape: boolean;
  /** Phone-sized: shorter side under 600 dp. */
  compact: boolean;
  /** Wide enough for side panes (tablets, desktops, phones in landscape stay compact). */
  wide: boolean;
}

export function useScreen(): Screen {
  const { width, height } = useWindowDimensions();
  return useMemo(() => {
    const short = Math.min(width, height);
    const compact = short < 600;
    return { width, height, landscape: width > height, compact, wide: !compact && width >= 900 };
  }, [width, height]);
}

/**
 * How far the app is "pushed back" by open sheets (0 = not at all, 1 = one sheet).
 * The root view reads it to shrink like an iOS card stack.
 */
const DepthContext = createContext<SharedValue<number> | null>(null);

export function DepthProvider({ children }: { children: React.ReactNode }) {
  const depth = useSharedValue(0);
  return <DepthContext.Provider value={depth}>{children}</DepthContext.Provider>;
}

export function useDepth(): SharedValue<number> {
  const d = useContext(DepthContext);
  if (!d) throw new Error('useDepth outside DepthProvider');
  return d;
}
