// Draws the app icon and tray icons as pixel art and writes them as PNGs into resources/.
// electron-builder turns resources/icon.png into the .icns and .ico files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const AMBER = '#E8AD44';
const AMBER_LIGHT = '#F6C976';
const AMBER_DARK = '#A87425';
const LEGEND = '#5C3B0C';
const LAMP = '#62E3A0';
const GRAPHITE = '#22262E';
const GRAPHITE_LIGHT = '#343A46';
const GRAPHITE_DARK = '#191C22';
const SHADOW = '#121418';

// The 16 px tray key, filled with the even-odd rule so the legend cuts through.
const TRAY_KEY = 'M4 1h8v1h1v1h1v8h-1v1h-1v1H4v-1H3v-1H2V3h1V2h1zM10 3v2h2V3zM4 9v1h8V9zM4 14h8v1H4z';

function rgba(hex, alpha = 255) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
}

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

function png(canvas) {
  const { size, pixels } = canvas;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** Parses an SVG path made only of M, H, V, h, v and z into closed polygons. */
function polygons(path) {
  const shapes = [];
  let current = null;
  let x = 0;
  let y = 0;
  for (const [, command, args] of path.matchAll(/([MHVhvz])([^MHVhvz]*)/g)) {
    const numbers = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (command === 'M') {
      [x, y] = numbers;
      current = [[x, y]];
      shapes.push(current);
      continue;
    }
    if (command === 'z') continue;
    if (command === 'H') x = numbers[0];
    if (command === 'V') y = numbers[0];
    if (command === 'h') x += numbers[0];
    if (command === 'v') y += numbers[0];
    current.push([x, y]);
  }
  return shapes;
}

function insideEvenOdd(shapes, px, py) {
  let inside = false;
  for (const shape of shapes) {
    for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
      const [xi, yi] = shape[i];
      const [xj, yj] = shape[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function trayIcon(scale, color) {
  const shapes = polygons(TRAY_KEY);
  const canvas = new Canvas(16 * scale);
  for (let y = 0; y < canvas.size; y++) {
    for (let x = 0; x < canvas.size; x++) if (insideEvenOdd(shapes, (x + 0.5) / scale, (y + 0.5) / scale)) canvas.set(x, y, color);
  }
  return canvas;
}

/** A pixel grid of 32 × 32 cells, each `unit` pixels wide. */
class Grid {
  constructor(canvas, unit) {
    this.canvas = canvas;
    this.unit = unit;
  }

  fill(x, y, w, h, color) {
    this.canvas.fill(x * this.unit, y * this.unit, w * this.unit, h * this.unit, color);
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

function appIcon() {
  const canvas = new Canvas(1024);
  const grid = new Grid(canvas, 32);
  // Plate: 26 × 26 cells (832 px), the size macOS expects inside a 1024 px icon.
  grid.stepped(3, 3, 26, 26, 2, rgba(GRAPHITE_DARK));
  grid.stepped(3, 3, 26, 25, 2, rgba(GRAPHITE_LIGHT));
  grid.stepped(3, 4, 26, 24, 2, rgba(GRAPHITE));

  // Key: hard shadow, side, face, top highlight.
  grid.stepped(9, 9, 16, 17, 1, rgba(SHADOW));
  grid.stepped(8, 8, 16, 17, 1, rgba(AMBER_DARK));
  grid.stepped(8, 8, 16, 14, 1, rgba(AMBER));
  grid.fill(9, 8, 14, 1, rgba(AMBER_LIGHT));
  grid.fill(8, 9, 1, 12, rgba(AMBER_LIGHT));

  // Legend: a ">_" prompt, and the ready lamp.
  for (const [x, y] of [[11, 12], [12, 13], [13, 14], [12, 15], [11, 16]]) grid.fill(x, y, 2, 1, rgba(LEGEND));
  grid.fill(15, 16, 5, 1, rgba(LEGEND));
  grid.fill(19, 11, 2, 2, rgba(LAMP));
  return canvas;
}

mkdirSync('resources/tray', { recursive: true });
writeFileSync('resources/icon.png', png(appIcon()));
writeFileSync('resources/tray/trayTemplate.png', png(trayIcon(1, rgba('#000000'))));
writeFileSync('resources/tray/trayTemplate@2x.png', png(trayIcon(2, rgba('#000000'))));
writeFileSync('resources/tray/tray.png', png(trayIcon(1, rgba(AMBER))));
writeFileSync('resources/tray/tray@2x.png', png(trayIcon(2, rgba(AMBER))));
console.log('wrote resources/icon.png and resources/tray/*.png');
