/**
 * Large voxel surfaces: panels (sheets, side panes, menus) and sunken wells.
 * Panels have stepped corners, a lit top edge, a darker front face and a solid shadow.
 */
import type { ReactNode } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';

import { useColorway } from './theme';
import { Bands, lipBands, Shape, SunkenFace, VOXEL } from './voxel';

/** Height of a panel's front face; add it to the panel's bottom padding. */
export const PANEL_FRONT = 2 * VOXEL;

/**
 * Draws a panel behind its siblings, filling the parent.
 * `attached`: the panel sits on the bottom edge of the screen (bottom sheet): square
 * bottom corners, no front face, no shadow.
 */
export function PanelFace({ attached }: { attached?: boolean }) {
  const cw = useColorway();
  const v = VOXEL;
  const hi = cw.dark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.75)';
  const front = cw.dark ? 'rgba(0,0,0,0.28)' : 'rgba(70,58,36,0.16)';
  return (
    <>
      {attached ? null : <Shape steps={2} color={cw.shadow} inset={{ top: 2 * v, left: 2 * v, right: -2 * v, bottom: -2 * v }} />}
      <Shape steps={2} color={cw.surface} bottom={!attached} />
      <Bands bands={lipBands(2, v, v)} color={hi} />
      {attached ? null : <Shape steps={2} color={front} top={false} inset={{ height: PANEL_FRONT }} />}
    </>
  );
}

/** A raised panel with content on top. Pad the content yourself; leave PANEL_FRONT at the bottom. */
export function Panel({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style}>
      <PanelFace />
      {children}
    </View>
  );
}

/** A sunken area with a dark lip along the top: groups of rows, output, lists. */
export function Well({
  children,
  style,
  color,
  steps = 1,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  color?: string;
  steps?: number;
}) {
  const cw = useColorway();
  return (
    <View style={style}>
      <SunkenFace color={color ?? cw.plate} lip={cw.lip} steps={steps} />
      {children}
    </View>
  );
}
