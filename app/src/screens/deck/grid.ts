/** Grid geometry shared by sockets, keys and the drag hit test. */
import { fitGrid, gridGap } from '../../lib/fit';
import { keyVoxel } from '../../ui/Keycap';
import { snap } from '../../ui/voxel';

export interface Geo {
  count: number;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  gap: number;
  /** Top-left of the grid inside its box (the grid is centred). */
  offX: number;
  offY: number;
}

export function gridGeometry(count: number, width: number, height: number): Geo {
  const gap = gridGap(width, height);
  const fit = fitGrid(count, width, height, gap);
  // Cells snap to the key's voxel so every step lands on a pixel.
  const v = keyVoxel(fit.cellW, fit.cellH);
  const cellW = snap(fit.cellW, v);
  const cellH = snap(fit.cellH, v);
  return {
    count,
    cols: fit.cols,
    rows: fit.rows,
    cellW,
    cellH,
    gap,
    offX: Math.round((width - (cellW * fit.cols + gap * (fit.cols - 1))) / 2),
    offY: Math.round((height - (cellH * fit.rows + gap * (fit.rows - 1))) / 2),
  };
}

export function slotOrigin(g: Geo, slot: number): { x: number; y: number } {
  'worklet';
  const col = slot % g.cols;
  const row = Math.floor(slot / g.cols);
  return { x: g.offX + col * (g.cellW + g.gap), y: g.offY + row * (g.cellH + g.gap) };
}

/** Slot under a key whose top-left corner is at (x, y). */
export function slotAt(g: Geo, x: number, y: number): number {
  'worklet';
  const cx = x + g.cellW / 2 - g.offX;
  const cy = y + g.cellH / 2 - g.offY;
  const col = Math.max(0, Math.min(g.cols - 1, Math.floor((cx + g.gap / 2) / (g.cellW + g.gap))));
  const row = Math.max(0, Math.min(g.rows - 1, Math.floor((cy + g.gap / 2) / (g.cellH + g.gap))));
  return Math.min(g.count - 1, row * g.cols + col);
}

/** Where slot `i` shows while a key is being dragged from `from` to `to` (iOS-style shuffle). */
export function previewSlot(i: number, from: number, to: number): number {
  if (i === from) return to;
  if (from < to && i > from && i <= to) return i - 1;
  if (from > to && i >= to && i < from) return i + 1;
  return i;
}
