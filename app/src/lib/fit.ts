/**
 * Picks the column count that gives the biggest keys for `count` slots in a box.
 * Keys are a little taller than wide (the front skirt), so `aspect` is height / width.
 */
export interface GridFit {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  /** Total grid size, for centring. */
  width: number;
  height: number;
}

export function fitGrid(count: number, boxW: number, boxH: number, gap: number, aspect = 1.06): GridFit {
  const n = Math.max(1, count);
  let best: GridFit | null = null;
  let bestScore = -1;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = (boxW - gap * (cols - 1)) / cols;
    const h = (boxH - gap * (rows - 1)) / rows;
    if (w <= 0 || h <= 0) continue;
    // Size of a key with the ideal aspect that fits in the cell.
    const size = Math.min(w, h / aspect);
    // Prefer fuller last rows when sizes tie closely.
    const fill = n / (cols * rows);
    const score = size * (0.97 + 0.03 * fill);
    if (score > bestScore) {
      bestScore = score;
      // Let cells stretch a little beyond the ideal shape, but not into slabs.
      const cellW = Math.min(w, (h / aspect) * 1.35);
      const cellH = Math.min(h, w * aspect * 1.18);
      best = {
        cols,
        rows,
        cellW,
        cellH,
        width: cellW * cols + gap * (cols - 1),
        height: cellH * rows + gap * (rows - 1),
      };
    }
  }
  return best ?? { cols: 1, rows: n, cellW: boxW, cellH: boxH / n, width: boxW, height: boxH };
}

/** Gap between keys for a given box, so phones get tighter spacing. */
export function gridGap(boxW: number, boxH: number): number {
  const short = Math.min(boxW, boxH);
  return short < 420 ? 9 : short < 700 ? 13 : 18;
}
