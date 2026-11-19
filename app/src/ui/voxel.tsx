/**
 * Voxel drawing primitives. Everything in the app is built from blocks whose corners
 * step in whole voxels (4 dp on tablets, 2 dp for small keys) and whose shadows are
 * solid offsets, never blurred.
 *
 * Shapes are drawn with plain absolutely positioned Views, so they size themselves
 * from their parent and need no measuring. The bands never overlap, which keeps
 * translucent colours (shadows, lips, overlays) even.
 */
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import type { BlockTone } from '../theme/colorways';

/** The voxel unit on regular screens. */
export const VOXEL = 4;

/** A box positioned inside its parent, in dp. */
export interface Box {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  width?: number;
  height?: number;
}

/**
 * Offsets from the parent's edges (negative values reach outside it).
 * With `height`, the area is anchored to the bottom edge and `top` is ignored.
 */
export interface Insets {
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  height?: number;
}

/** Horizontal bands that together fill a rectangle with stepped corners. */
function stepBands(steps: number, v: number, top = true, bottom = true): Box[] {
  const t = top ? steps : 0;
  const b = bottom ? steps : 0;
  const bands: Box[] = [];
  for (let k = 0; k < t; k++) bands.push({ top: k * v, height: v, left: (steps - k) * v, right: (steps - k) * v });
  bands.push({ top: t * v, bottom: b * v, left: 0, right: 0 });
  for (let k = 0; k < b; k++) bands.push({ bottom: k * v, height: v, left: (steps - k) * v, right: (steps - k) * v });
  return bands;
}

/** The top `depth` dp of a stepped shape: the dark lip of a sunken area. */
export function lipBands(steps: number, v: number, depth: number): Box[] {
  const bands: Box[] = [];
  for (let k = 0; k < steps && k * v < depth; k++) {
    bands.push({ top: k * v, height: Math.min(v, depth - k * v), left: (steps - k) * v, right: (steps - k) * v });
  }
  if (depth > steps * v) bands.push({ top: steps * v, height: depth - steps * v, left: 0, right: 0 });
  return bands;
}

/** A one-voxel outline that follows a stepped shape. */
export function outlineBands(steps: number, v: number): Box[] {
  const s = steps * v;
  const bands: Box[] = [
    { top: 0, height: v, left: s, right: s },
    { bottom: 0, height: v, left: s, right: s },
    { top: s, bottom: s, left: 0, width: v },
    { top: s, bottom: s, right: 0, width: v },
  ];
  for (let k = 1; k < steps; k++) {
    const x = (steps - k) * v;
    bands.push({ top: k * v, height: v, left: x, width: v }, { top: k * v, height: v, right: x, width: v });
    bands.push({ bottom: k * v, height: v, left: x, width: v }, { bottom: k * v, height: v, right: x, width: v });
  }
  return bands;
}

/**
 * Moves a band from an inset area into its parent's coordinates, so shapes need no wrapper
 * View of their own. Returns null for a band the area is too short to show.
 */
function place(band: Box, area: Insets | undefined): Box | null {
  const left = area?.left ?? 0;
  const right = area?.right ?? 0;
  const bottom = area?.bottom ?? 0;
  const out: Box = {};
  if (band.left !== undefined) out.left = left + band.left;
  if (band.right !== undefined) out.right = right + band.right;
  if (band.width !== undefined) out.width = band.width;

  const areaHeight = area?.height;
  if (areaHeight === undefined) {
    const top = area?.top ?? 0;
    if (band.top !== undefined) out.top = top + band.top;
    if (band.bottom !== undefined) out.bottom = bottom + band.bottom;
    if (band.height !== undefined) out.height = band.height;
    return out;
  }
  // A bottom-anchored area has a known height, so every band can be pinned to the bottom edge.
  const height = band.height ?? areaHeight - (band.top ?? 0) - (band.bottom ?? 0);
  if (height <= 0) return null;
  out.bottom = bottom + (band.bottom ?? areaHeight - (band.top ?? 0) - height);
  out.height = height;
  return out;
}

/** Paints bands in one colour, filling the parent (moved by `inset`). */
export const Bands = memo(function Bands({ bands, color, inset }: { bands: Box[]; color: string; inset?: Insets }) {
  return (
    <>
      {bands.map((b, i) => {
        const box = place(b, inset);
        return box ? <View key={i} pointerEvents="none" style={[styles.abs, box, { backgroundColor: color }]} /> : null;
      })}
    </>
  );
});

/** A filled rectangle with stepped corners. */
export const Shape = memo(function Shape({
  steps,
  v = VOXEL,
  color,
  top = true,
  bottom = true,
  inset,
}: {
  steps: number;
  v?: number;
  color: string;
  /** Step the top corners. */
  top?: boolean;
  /** Step the bottom corners. */
  bottom?: boolean;
  inset?: Insets;
}) {
  return <Bands bands={stepBands(steps, v, top, bottom)} color={color} inset={inset} />;
});

/**
 * A raised block filling its parent: hard shadow, lit top-left edge, shaded right edge,
 * and a front face `depth` dp tall along the bottom. Put content on top with padding.
 */
export const RaisedFace = memo(function RaisedFace({
  tone,
  steps = 1,
  v = VOXEL,
  depth = VOXEL,
  shadow,
}: {
  tone: BlockTone;
  steps?: number;
  v?: number;
  /** Height of the front face under the top. */
  depth?: number;
  /** Shadow colour; omit for none. */
  shadow?: string;
}) {
  // The top face keeps square bottom corners only when the front face is tall enough to hide them.
  const capSquare = depth >= steps * v;
  return (
    <>
      {shadow ? <Shape steps={steps} v={v} color={shadow} inset={{ top: v, left: v, right: -v, bottom: -v }} /> : null}
      <Shape steps={steps} v={v} color={tone.front} />
      <Shape steps={steps} v={v} color={tone.shade} bottom={!capSquare} inset={{ bottom: depth }} />
      <Shape steps={steps} v={v} color={tone.hi} bottom={!capSquare} inset={{ right: v, bottom: depth + v }} />
      <Shape steps={steps - 1} v={v} color={tone.top} bottom={!capSquare} inset={{ top: v, left: v, right: v, bottom: depth + v }} />
    </>
  );
});

/** A sunken area filling its parent: flat fill with a dark lip along the top edge. */
export const SunkenFace = memo(function SunkenFace({
  color,
  lip,
  steps = 1,
  v = VOXEL,
  lipDepth = VOXEL,
}: {
  color: string;
  lip: string;
  steps?: number;
  v?: number;
  lipDepth?: number;
}) {
  return (
    <>
      <Shape steps={steps} v={v} color={color} />
      <Bands bands={lipBands(steps, v, lipDepth)} color={lip} />
    </>
  );
});

/** A one-voxel stepped ring, e.g. the selection outline, drawn `gap` dp outside the parent. */
export const Ring = memo(function Ring({ steps, v = VOXEL, color, gap }: { steps: number; v?: number; color: string; gap: number }) {
  return <Bands bands={outlineBands(steps, v)} color={color} inset={{ top: -gap, left: -gap, right: -gap, bottom: -gap }} />;
});

/**
 * SVG path tracing a stepped outline through the middle of its border voxels.
 * Used for the marching pixels around a running key.
 */
export function steppedOutlinePath(w: number, h: number, steps: number, v: number, top = true, bottom = true): string {
  const T = top ? steps : 0;
  const B = bottom ? steps : 0;
  const pts: [number, number][] = [];
  pts.push([T * v, 0], [w - T * v, 0]);
  for (let k = 1; k <= T; k++) pts.push([w - (T - k + 1) * v, k * v], [w - (T - k) * v, k * v]);
  pts.push([w, h - B * v]);
  for (let k = 1; k <= B; k++) pts.push([w - k * v, h - (B - k + 1) * v], [w - k * v, h - (B - k) * v]);
  pts.push([B * v, h]);
  for (let k = 1; k <= B; k++) pts.push([(B - k + 1) * v, h - k * v], [(B - k) * v, h - k * v]);
  pts.push([0, T * v]);
  for (let k = 1; k <= T; k++) pts.push([k * v, (T - k + 1) * v], [k * v, (T - k) * v]);

  // Drop repeated points, then move every corner inward by half a voxel.
  const poly = pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length]!;
    return p[0] !== q[0] || p[1] !== q[1];
  });
  const d = v / 2;
  const n = poly.length;
  const inward = (a: [number, number], b: [number, number]): [number, number] => {
    const dx = Math.sign(b[0] - a[0]);
    const dy = Math.sign(b[1] - a[1]);
    return [-dy, dx];
  };
  const out = poly.map((p, i) => {
    const prev = poly[(i + n - 1) % n]!;
    const next = poly[(i + 1) % n]!;
    const a = inward(prev, p);
    const b = inward(p, next);
    return [p[0] + d * (a[0] + b[0]), p[1] + d * (a[1] + b[1])];
  });
  return `M${out.map(([x, y]) => `${x} ${y}`).join('L')}Z`;
}

/** Rounds a size down to whole voxels. */
export function snap(size: number, v = VOXEL): number {
  return Math.max(v, Math.floor(size / v) * v);
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
});
