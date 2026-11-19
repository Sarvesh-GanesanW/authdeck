/**
 * How a 2FA key's top face is laid out for its size. Big keys show the icon, the name and the
 * account above the code. Small ones follow the rule normal keys use (layoutKeyFace): when the
 * face can't hold the icon above two lines of the name, the icon goes and the name gets up to two
 * lines of its own, centred. A code is never shown without its name: on a crowded page the name
 * keeps one line and the code shrinks to CODE_FLOOR, splitting in two halves only there. The
 * code is never cut.
 */
import { type FittedLabel, MIN_LABEL_SCALE, fitLabel, layoutKeyFace, lineHeightFor } from '../../ui/keyLabel';

/** IBM Plex Mono's advance width, as a share of the font size. */
const MONO_ADVANCE = 0.6;
/** Extra tracking on the code, as a share of its size. */
export const CODE_TRACKING = 0.02;
/** Room left over so rounding never ellipsizes the last digit. */
const FIT_SLACK = 0.04;
/** The code's size in the approved design, on its 286-dp key. */
const CODE_MAX = 34;
/** The smallest the code is set while the page has room. */
export const CODE_MIN = 12;
/** The smallest on a crowded page; only here may the code break into its two halves. */
export const CODE_FLOOR = 10;
/** Space between the icon and the name. */
const ICON_GAP = 4;
/** The fewest characters of the name worth showing beside the icon on a big key. */
const MIN_TITLE_CHARS = 4;

/** The parts of keyMetrics this layout reads. */
export interface OtpKeyMetrics {
  v: number;
  w: number;
  capH: number;
  pad: number;
  led: number;
  label: number;
  /** The countdown rides on the front face. */
  sub: boolean;
}

export interface OtpLayout {
  /** False on a small key: no icon and no account line; the name, centred, over the code. */
  showIcon: boolean;
  /** The name's lines on a small key (always at least one); null on a big key. */
  title: FittedLabel | null;
  /** Code size. */
  code: number;
  /** Whether the code keeps the space between its halves ("123 456"). */
  grouped: boolean;
  /** The code's halves on two lines, on keys too narrow for it on one. */
  split: boolean;
  /** How far the code may run into the face's side padding, in dp, on keys too narrow for it. */
  bleed: number;
  /** Whether the small countdown fits under the code (keys without a front face for it). */
  countdown: boolean;
  /** Space above the name on a small key, to clear the status light. */
  nameTop: number;
  /** Space each side of the name on a small key too short to put it below the light. */
  nameInset: number;
  issuer: number;
  label: number;
  icon: number;
}

/** Width the code takes at a size, in dp, text scale included. */
function codeWidth(chars: number, size: number, fontScale: number): number {
  return chars * size * (MONO_ADVANCE + CODE_TRACKING + FIT_SLACK) * fontScale;
}

export function codeLineHeight(size: number): number {
  return Math.round(size * 1.15);
}

/**
 * `digits` is the code's length (6 for most codes; Steam codes are 5 letters). `groupable` says
 * whether it may be shown as two halves with a space ("123 456"). `open` is false while the
 * vault is locked, when a lock glyph stands where the code goes.
 */
export function otpLayout(m: OtpKeyMetrics, title: string, digits: number, groupable: boolean, open: boolean, fontScale = 1): OtpLayout {
  const scale = fontScale > 0 ? fontScale : 1;
  const inner = m.w - 2 * m.pad;
  const faceH = m.capH - m.pad - (Math.round(m.pad * 0.6) + m.v);
  const issuer = Math.round(Math.max(10, Math.min(15, m.w * 0.065)));
  const label = Math.round(Math.max(9, Math.min(13, m.w * 0.055)));
  const icon = m.v === 4 ? 24 : 12;

  // A small key keeps one line of its name, at its smallest, above the code.
  const nameLine = lineHeightFor(Math.round(m.label * MIN_LABEL_SCALE)) * scale;
  const codeRoom = faceH - nameLine - m.v;

  // The code, as big as the key allows, on one line: with its group space, then without, then
  // into the side padding. Below CODE_MIN it shrinks, down to CODE_FLOOR; only then does it break
  // into its two halves, at CODE_FLOOR. It is never cut.
  // Into the padding up to one voxel from the face's edge.
  const sidePad = Math.max(0, m.pad - m.v);
  const half = Math.ceil(digits / 2);
  const byWidth = (chars: number, bleed: number) => Math.floor((inner + 2 * bleed) / codeWidth(chars, 1, scale));
  const oneLine = [
    { grouped: groupable, split: false, bleed: 0 },
    { grouped: false, split: false, bleed: 0 },
    { grouped: false, split: false, bleed: sidePad },
  ].map((t) => ({
    t,
    size: Math.min(CODE_MAX, byWidth(digits + (t.grouped ? 1 : 0), t.bleed), Math.floor(m.capH * 0.3), lineHeightFit(codeRoom / scale, 1)),
  }));
  const split = [0, sidePad].map((bleed) => ({
    t: { grouped: false, split: true, bleed },
    size: Math.min(CODE_FLOOR, byWidth(half, bleed), lineHeightFit(codeRoom / scale, 2)),
  }));
  const biggest = (fits: typeof oneLine) => fits.reduce((a, b) => (b.size > a.size ? b : a));
  const best =
    oneLine.find((f) => f.size >= CODE_MIN) ??
    (biggest(oneLine).size >= CODE_FLOOR ? biggest(oneLine) : undefined) ??
    split.find((f) => f.size >= CODE_FLOOR) ??
    // A key too small even for that: the code smaller still, never cut.
    biggest([...oneLine, ...split]);
  const pick = best.t;
  const code = Math.max(1, best.size);
  const codeH = codeLineHeight(code) * (pick.split ? 2 : 1) * scale;
  const barH = m.sub ? 0 : m.v + 12 * scale;

  // The normal keys' rule decides whether the icon stays: room for it above two small lines. It is
  // decided with the code in place, so a key keeps its look when the vault locks or opens.
  const nameH = faceH - codeH - barH - m.v;
  const withIcon = layoutKeyFace(title, { width: inner, height: nameH, iconHeight: icon, gap: ICON_GAP, fontSize: issuer, fontScale: scale });
  const besideIcon = inner - (m.led + 2 * m.v) - icon - ICON_GAP;
  const nameChars = Math.min(MIN_TITLE_CHARS, Math.max(1, title.trim().length));
  const showIcon = withIcon.showIcon && besideIcon >= nameChars * issuer * MONO_ADVANCE * scale;
  const base = { showIcon, code, grouped: pick.grouped, split: pick.split, bleed: pick.bleed, issuer, label, icon };
  if (showIcon) return { ...base, title: null, countdown: !m.sub, nameTop: 0, nameInset: 0 };

  // Small key: the name always stays, over the code (or the lock glyph): two lines where they fit,
  // else one, ending in an ellipsis. Then it keeps clear of the status light, below it where
  // there's height, else narrower; the small countdown takes what room is left.
  const bottom = open ? codeH : icon;
  const room = faceH - bottom - m.v;
  const fitName = (inset: number) =>
    fitLabel(title || ' ', {
      width: (inner - 2 * inset) / scale,
      height: Math.max(room, nameLine) / scale,
      fontSize: m.label,
      maxLines: room >= 2 * nameLine ? 2 : 1,
    });
  const clear = m.led + m.v;
  let name = fitName(0);
  let nameTop = 0;
  let nameInset = 0;
  if (room - name.lines.length * name.lineHeight * scale >= clear) nameTop = clear;
  else {
    nameInset = clear;
    name = fitName(clear);
  }
  const left = room - nameTop - name.lines.length * name.lineHeight * scale - m.v;
  const countdown = !m.sub && open && left >= barH;
  return { ...base, title: name, countdown, nameTop, nameInset };
}

/** The biggest code size whose `lines` lines fit in `height`. */
function lineHeightFit(height: number, lines: number): number {
  let size = Math.floor(height / (1.15 * lines));
  while (size > 1 && lines * codeLineHeight(size) > height) size--;
  return Math.max(1, size);
}
