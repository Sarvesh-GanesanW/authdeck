// Draws AuthDeck's app icons, splash image and Play listing icon as pixel art (into assets/ and store/).
// The keycap matches desktop/scripts/icons.mjs (same palette and cell geometry), so the
// phone app and the desktop agent share one icon. Run: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const AMBER = '#E8AD44';
const AMBER_LIGHT = '#F6C976';
const AMBER_DARK = '#A87425';
const LEGEND = '#5C3B0C';
const LAMP = '#62E3A0';
const GRAPHITE = '#22262E';
const GRAPHITE_DARK = '#191C22';
const SHADOW = '#121418';
const BLACK = '#000000';
const WHITE = '#FFFFFF';

// The keycap with its hard shadow spans 17 × 18 cells.
const KEY_COLUMNS = 17;
const KEY_ROWS = 18;

function rgba(hex, alpha = 255) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
}

const TRANSPARENT = [0, 0, 0, 0];

class Canvas {
  constructor(size) {
    this.size = size;
    this.pixels = new Uint8Array(size * size * 4);
  }

  set(x, y, color) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.pixels.set(color, (y * this.size + x) * 4);
  }

  fill(x, y, w, h, color) {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) this.set(col, row, color);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

const COLOR_TYPE_RGB = 2;
const COLOR_TYPE_RGBA = 6;

/** Encodes the canvas as a PNG; `opaque` drops the alpha channel (App Store icons must have none). */
function png(canvas, { opaque = false } = {}) {
  const { size, pixels } = canvas;
  const channels = opaque ? 3 : 4;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, opaque ? COLOR_TYPE_RGB : COLOR_TYPE_RGBA, 0, 0, 0], 8);
  const stride = size * channels + 1;
  const rows = Buffer.alloc(size * stride);
  for (let i = 0; i < size * size; i++) {
    const at = Math.floor(i / size) * stride + 1 + (i % size) * channels;
    for (let c = 0; c < channels; c++) rows[at + c] = pixels[i * 4 + c];
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** A grid of square cells, each `unit` whole pixels wide, starting at pixel (`left`, `top`). */
class Grid {
  constructor(canvas, unit, left, top) {
    this.canvas = canvas;
    this.unit = unit;
    this.left = left;
    this.top = top;
  }

  fill(x, y, w, h, color) {
    const { unit } = this;
    this.canvas.fill(this.left + x * unit, this.top + y * unit, w * unit, h * unit, color);
  }

  /** A rectangle with its corners stepped in by `steps` cells, like the UI's clip-path corners. */
  stepped(x, y, w, h, steps, color) {
    for (let row = 0; row < h; row++) {
      const fromEdge = Math.min(row, h - 1 - row);
      const inset = Math.max(0, steps - fromEdge);
      this.fill(x + inset, y + row, w - inset * 2, 1, color);
    }
  }
}

const KEY_PALETTE = { shadow: SHADOW, side: AMBER_DARK, face: AMBER, highlight: AMBER_LIGHT, legend: LEGEND, lamp: LAMP };

/** Grey versions of the key colours, by luminance, scaled so the brightest is white (for tinted icons). */
function greyPalette(palette) {
  const luminance = (hex) => {
    const [r, g, b] = rgba(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const brightest = Math.max(...Object.values(palette).map(luminance));
  const grey = (hex) => {
    const level = Math.round((luminance(hex) / brightest) * 255);
    return `#${level.toString(16).padStart(2, '0').repeat(3)}`;
  };
  return Object.fromEntries(Object.entries(palette).map(([part, hex]) => [part, grey(hex)]));
}

const PROMPT_CELLS = [[3, 4], [4, 5], [5, 6], [4, 7], [3, 8]];

/** The keycap from the desktop icon, drawn in cells relative to its own top-left corner. */
function drawKey(grid, palette) {
  grid.stepped(1, 1, 16, 17, 1, rgba(palette.shadow));
  grid.stepped(0, 0, 16, 17, 1, rgba(palette.side));
  grid.stepped(0, 0, 16, 14, 1, rgba(palette.face));
  grid.fill(1, 0, 14, 1, rgba(palette.highlight));
  grid.fill(0, 1, 1, 12, rgba(palette.highlight));
  drawLegend(grid, rgba(palette.legend), rgba(palette.lamp));
}

/** The ">_" prompt and the ready lamp. */
function drawLegend(grid, legend, lamp) {
  for (const [x, y] of PROMPT_CELLS) grid.fill(x, y, 2, 1, legend);
  grid.fill(7, 8, 5, 1, legend);
  grid.fill(11, 3, 2, 2, lamp);
}

/** One-colour key body (no shadow) with the legend and lamp cut out, for Android themed icons. */
function drawKeySilhouette(grid) {
  grid.stepped(0, 0, 16, 17, 1, rgba(WHITE));
  drawLegend(grid, TRANSPARENT, TRANSPARENT);
}

/** A grid of `unit`-pixel cells that centres the 17 × 18-cell key on a `size` canvas. */
function centredKeyGrid(canvas, unit) {
  const left = Math.round((canvas.size - KEY_COLUMNS * unit) / 2);
  const top = Math.round((canvas.size - KEY_ROWS * unit) / 2);
  return new Grid(canvas, unit, left, top);
}

function keyOn({ size, unit, background, palette = KEY_PALETTE, silhouette = false }) {
  const canvas = new Canvas(size);
  if (background) canvas.fill(0, 0, size, size, rgba(background));
  const grid = centredKeyGrid(canvas, unit);
  if (silhouette) drawKeySilhouette(grid);
  else drawKey(grid, palette);
  return canvas;
}

function solid(size, color) {
  const canvas = new Canvas(size);
  canvas.fill(0, 0, size, size, rgba(color));
  return canvas;
}

const ICON_SIZE = 1024;
// iOS masks the full-bleed square itself; 36 px cells make the key about 60% of the icon.
const IOS_UNIT = 36;
// Android shows only the central 66% of a 108 dp adaptive layer as a guaranteed-safe circle
// (676 px of 1024). With 24 px cells the key's far corners sit about 297 px from the centre,
// inside that circle's 338 px radius, so no launcher mask clips it.
const ANDROID_UNIT = 24;
// The splash logo is masked to a circle on Android 12+, so the canvas is the key's
// diagonal (about 25 cells) plus a cell of margin.
const SPLASH_CELLS = 26;
const SPLASH_UNIT = 40;
// Google Play asks for its own 512 px listing icon and applies its own rounded mask.
const PLAY_ICON_SIZE = 512;
const PLAY_ICON_UNIT = 18;
const FAVICON_SIZE = 48;
const FAVICON_UNIT = 2;

const outputs = {
  'assets/icon.png': png(keyOn({ size: ICON_SIZE, unit: IOS_UNIT, background: GRAPHITE }), { opaque: true }),
  'assets/icon-dark.png': png(keyOn({ size: ICON_SIZE, unit: IOS_UNIT, background: GRAPHITE_DARK }), { opaque: true }),
  'assets/icon-tinted.png': png(keyOn({ size: ICON_SIZE, unit: IOS_UNIT, background: BLACK, palette: greyPalette(KEY_PALETTE) }), { opaque: true }),
  'assets/android-icon-foreground.png': png(keyOn({ size: ICON_SIZE, unit: ANDROID_UNIT })),
  'assets/android-icon-background.png': png(solid(ICON_SIZE, GRAPHITE), { opaque: true }),
  'assets/android-icon-monochrome.png': png(keyOn({ size: ICON_SIZE, unit: ANDROID_UNIT, silhouette: true })),
  'assets/splash-icon.png': png(keyOn({ size: SPLASH_CELLS * SPLASH_UNIT, unit: SPLASH_UNIT })),
  'assets/favicon.png': png(keyOn({ size: FAVICON_SIZE, unit: FAVICON_UNIT })),
  'store/play-icon.png': png(keyOn({ size: PLAY_ICON_SIZE, unit: PLAY_ICON_UNIT, background: GRAPHITE }), { opaque: true }),
};

for (const [path, bytes] of Object.entries(outputs)) {
  mkdirSync(dirname(join(APP_DIR, path)), { recursive: true });
  writeFileSync(join(APP_DIR, path), bytes);
}
console.log(`wrote ${Object.keys(outputs).join(', ')}`);
