/**
 * Lays out a key's label for the room on its top face. Labels are set in IBM Plex Mono, whose
 * every character advances 0.6 em, so the lines can be worked out here instead of left to the
 * text engine, which breaks a word that doesn't fit in the middle ("Comma / nd").
 *
 * Lines break only at spaces. When the words don't fit, the text shrinks, down to MIN_SCALE;
 * whatever still doesn't fit ends in an ellipsis.
 */

/** Advance of one IBM Plex Mono character, in em. */
const MONO_ADVANCE = 0.6;
/** Smallest the label may shrink to, against its normal size. */
export const MIN_LABEL_SCALE = 0.8;
const ELLIPSIS = '…';

export interface LabelRoom {
  /** Width the text may use, in dp. */
  width: number;
  /** Height the text may use, in dp. */
  height: number;
  /** Normal font size; the line height is 1.2 times it. */
  fontSize: number;
  /** At most this many lines, room permitting. */
  maxLines: number;
}

export interface FittedLabel {
  fontSize: number;
  lineHeight: number;
  lines: string[];
}

export function lineHeightFor(fontSize: number): number {
  return Math.round(fontSize * 1.2);
}

function charsPerLine(width: number, fontSize: number): number {
  return Math.max(1, Math.floor((width + 0.5) / (fontSize * MONO_ADVANCE)));
}

/** Greedy wrap at spaces; null when a word is longer than a line or more than `maxLines` are needed. */
function wrapWhole(words: string[], perLine: number, maxLines: number): string[] | null {
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (word.length > perLine) return null;
    if (!line) line = word;
    else if (line.length + 1 + word.length <= perLine) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length <= maxLines ? lines : null;
}

function cut(text: string, perLine: number): string {
  return text.length <= perLine ? text : `${text.slice(0, Math.max(0, perLine - 1)).trimEnd()}${ELLIPSIS}`;
}

/** At the smallest size: whole words where they fit, an ellipsis where they don't. */
function wrapTruncated(words: string[], perLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    const last = lines.length === maxLines - 1;
    let line = words[i]!;
    i++;
    while (i < words.length && line.length + 1 + words[i]!.length <= perLine) {
      line += ` ${words[i]}`;
      i++;
    }
    const more = i < words.length;
    if (last && more) line = cut(`${line} ${words.slice(i).join(' ')}`, perLine);
    else line = cut(line, perLine);
    lines.push(line);
  }
  return lines;
}

export function fitLabel(label: string, room: LabelRoom): FittedLabel {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const smallest = Math.max(1, Math.round(room.fontSize * MIN_LABEL_SCALE));
  const linesAt = (size: number) => Math.max(1, Math.min(room.maxLines, Math.floor(room.height / lineHeightFor(size))));
  for (let size = room.fontSize; size >= smallest; size--) {
    const lines = wrapWhole(words, charsPerLine(room.width, size), linesAt(size));
    if (lines) return { fontSize: size, lineHeight: lineHeightFor(size), lines };
  }
  return {
    fontSize: smallest,
    lineHeight: lineHeightFor(smallest),
    lines: wrapTruncated(words, charsPerLine(room.width, smallest), linesAt(smallest)),
  };
}

export interface FaceRoom {
  /** Width the text may use, in dp. */
  width: number;
  /** Height of the top face inside its padding, in dp: icon, gap and label share it. */
  height: number;
  /** Height the icon takes; 0 for a key without one. */
  iconHeight: number;
  /** Space kept between the icon and the label. */
  gap: number;
  /** Normal font size of the label. */
  fontSize: number;
  /** The system's font scale: text draws this much larger than its size, the icon doesn't. */
  fontScale?: number;
}

export interface FaceLayout {
  /** False on a key too small for its icon and a two-line label: the label is shown alone, centred. */
  showIcon: boolean;
  label: FittedLabel | null;
}

/**
 * Icon and label for a key's top face. A key whose face can't hold the icon above two lines of
 * the label at its smallest size drops the icon, so its label is read in full instead of cut to a
 * few letters. A key without a label always keeps its icon: then the icon is its meaning.
 */
export function layoutKeyFace(label: string, room: FaceRoom): FaceLayout {
  if (!label.trim()) return { showIcon: true, label: null };
  // The label is fitted in unscaled units, so its room shrinks by the font scale.
  const scale = room.fontScale && room.fontScale > 0 ? room.fontScale : 1;
  const twoSmallLines = 2 * lineHeightFor(Math.round(room.fontSize * MIN_LABEL_SCALE));
  const belowIcon = (room.height - room.iconHeight - room.gap) / scale;
  const showIcon = room.iconHeight === 0 || belowIcon >= twoSmallLines;
  const height = showIcon ? belowIcon : room.height / scale;
  return { showIcon, label: fitLabel(label, { width: room.width / scale, height, fontSize: room.fontSize, maxLines: 2 }) };
}
