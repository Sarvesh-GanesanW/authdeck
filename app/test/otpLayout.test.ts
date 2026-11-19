/**
 * 2FA keys at every size: the code is never cut and never shown without its name, and small keys
 * drop the icon the way normal keys do.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CODE_FLOOR, CODE_MIN, type OtpKeyMetrics, codeLineHeight, otpLayout } from '../src/screens/deck/otpLayout';
import { MIN_LABEL_SCALE } from '../src/ui/keyLabel';

/** keyMetrics (ui/Keycap) for a 2FA key, which always asks for a front face; Keycap pulls in native modules. */
function metrics(width: number, height: number): OtpKeyMetrics {
  const v = Math.min(width, height) >= 112 ? 4 : 2;
  const w = Math.round(width / v) * v;
  const h = Math.round(height / v) * v;
  const sub = v === 4;
  const capH = h - (v === 4 ? 20 : 8);
  return { v, w, capH, pad: v === 4 ? (w >= 150 ? 16 : 12) : 8, led: v === 4 ? 8 : 6, label: Math.round(Math.min(18, Math.max(11, w * 0.095))), sub };
}

/** Width of a line of the code in Plex Mono with its tracking, in dp. */
const codeWidth = (chars: number, size: number, scale = 1) => chars * size * 0.62 * scale;

function codeFits(m: OtpKeyMetrics, digits: number, scale = 1) {
  const s = otpLayout(m, 'GitHub', digits, true, true, scale);
  const chars = s.split ? Math.ceil(digits / 2) : digits + (s.grouped ? 1 : 0);
  const faceH = m.capH - m.pad - (Math.round(m.pad * 0.6) + m.v);
  const room = m.w - 2 * m.pad + 2 * s.bleed;
  const codeH = codeLineHeight(s.code) * (s.split ? 2 : 1) * scale;
  const nameH = s.title ? s.nameTop + s.title.lines.length * s.title.lineHeight * scale + m.v : 0;
  const at = `${m.w}x${m.capH}`;
  assert.ok(s.showIcon || s.title, `${at}: a code without its name`);
  // Keys under about 44 x 48 dp (60 for eight digits) hold the name and the code at CODE_FLOOR in no
  // way: the code shrinks further.
  if (m.w >= (digits > 6 ? 60 : 44) && faceH >= 26) {
    assert.ok(s.code >= CODE_FLOOR, `${at}: code ${s.code} below the floor`);
    if (!s.showIcon) assert.ok(nameH + codeH <= faceH, `${at}: name and code taller than the face`);
  }
  if (s.split) assert.ok(s.code <= CODE_FLOOR, `${at}: split at ${s.code}, above the floor`);
  assert.ok(codeWidth(chars, s.code, scale) <= room, `${at}: ${chars} characters at ${s.code} need more than ${room} dp`);
  assert.ok(s.bleed < m.pad, 'the code stays off the key edge');
  return s;
}

describe('2FA key layout', () => {
  it('keeps the approved design on big keys: icon, name and code in its groups', () => {
    const s = otpLayout(metrics(286, 300), 'GitHub', 6, true, true);
    assert.equal(s.showIcon, true);
    assert.equal(s.grouped, true);
    assert.equal(s.split, false);
    assert.equal(s.code, 34);
  });

  it('never cuts the code, from the smallest phone key to a tablet key, at 6 and 8 digits', () => {
    for (let w = 40; w <= 300; w += 2) {
      for (const aspect of [1, 1.15, 1.3]) {
        codeFits(metrics(w, Math.round(w * aspect)), 6);
        codeFits(metrics(w, Math.round(w * aspect)), 8);
      }
    }
  });

  it('still fits the code with larger system text', () => {
    for (let w = 56; w <= 300; w += 4) codeFits(metrics(w, w + 8), 6, 1.3);
  });

  it('sheds the group space, then the padding, then shrinks to the floor, and splits only there', () => {
    const wide = otpLayout(metrics(120, 128), 'GitHub', 6, true, true);
    assert.deepEqual([wide.grouped, wide.split], [true, false]);
    const narrow = otpLayout(metrics(56, 64), 'GitHub', 6, true, true);
    assert.deepEqual([narrow.grouped, narrow.split], [false, false]);
    // The 45 x 52 key of a small phone on its side: one line below the minimum, not two halves.
    const tiny = otpLayout(metrics(45, 52), 'GitHub', 6, true, true);
    assert.equal(tiny.split, false);
    assert.ok(tiny.code >= CODE_FLOOR && tiny.code < CODE_MIN, `${tiny.code}`);
    for (let w = 40; w <= 300; w += 2) {
      const s = otpLayout(metrics(w, w + 8), 'GitHub', 6, true, true);
      if (s.split) assert.equal(s.code <= CODE_FLOOR, true, `${w}: split at ${s.code}`);
    }
  });

  it('drops the icon on small keys and gives the name up to two lines, centred over the code', () => {
    const s = otpLayout(metrics(64, 72), 'Amazon Web Services', 6, true, true);
    assert.equal(s.showIcon, false);
    assert.ok(s.title);
    assert.ok(s.title.lines.length >= 1 && s.title.lines.length <= 2);
    assert.ok(s.title.fontSize >= Math.round(metrics(64, 72).label * MIN_LABEL_SCALE));
  });

  it('keeps a key in the same style whether the vault is open or locked', () => {
    for (let w = 40; w <= 300; w += 4) {
      const m = metrics(w, w + 8);
      assert.equal(otpLayout(m, 'GitHub', 6, true, true).showIcon, otpLayout(m, 'GitHub', 6, true, false).showIcon, `${w}`);
    }
  });

  it('never shows a code without its name: one line, ending in an ellipsis, on a crowded key', () => {
    for (let w = 40; w < 112; w += 2) {
      for (const open of [true, false]) {
        const s = otpLayout(metrics(w, w + 8), 'Amazon Web Services', 6, true, open);
        assert.ok(s.showIcon || (s.title && s.title.lines.length >= 1), `${w}`);
      }
    }
    const crowded = otpLayout(metrics(45, 52), 'Amazon Web Services', 6, true, true);
    assert.equal(crowded.title?.lines.length, 1);
    assert.ok(crowded.title?.lines[0]!.endsWith('…'));
  });

  it('keeps the name clear of the status light', () => {
    for (let w = 40; w < 112; w += 2) {
      const m = metrics(w, w + 8);
      const s = otpLayout(m, 'Cloudflare', 6, true, true);
      if (s.showIcon) continue;
      assert.ok(s.nameTop >= m.led + m.v || s.nameInset >= m.led + m.v, `${w}: name under the light`);
    }
  });

  it('gives the name room before the small countdown', () => {
    for (let w = 40; w < 112; w += 2) {
      const s = otpLayout(metrics(w, w + 8), 'GitHub', 6, true, true);
      if (s.countdown) assert.ok(s.showIcon || s.title, `${w}: countdown shown without the name`);
    }
  });

  it('never groups Steam codes', () => {
    assert.equal(otpLayout(metrics(286, 300), 'Steam', 5, false, true).grouped, false);
  });
});
