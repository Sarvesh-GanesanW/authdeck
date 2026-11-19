/**
 * Key labels break only at spaces, shrink to fit down to MIN_LABEL_SCALE, then end in an ellipsis.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MIN_LABEL_SCALE, fitLabel, layoutKeyFace, lineHeightFor } from '../src/ui/keyLabel';

/** A 11-px label in Plex Mono is 6.6 px a character: 30 px holds 4 characters, 40 px holds 6. */
const room = (width: number, lines = 2, fontSize = 11) => ({ width, height: lines * lineHeightFor(fontSize), fontSize, maxLines: 2 });

function noWordSplit(label: string, lines: string[]) {
  const words = new Set(label.split(' '));
  for (const line of lines) {
    for (const piece of line.split(' ')) {
      if (piece.endsWith('…')) continue;
      assert.ok(words.has(piece), `"${piece}" is part of a word, not a whole one (${JSON.stringify(lines)})`);
    }
  }
}

describe('fitting a key label', () => {
  it('wraps at spaces at the normal size when the words fit', () => {
    const f = fitLabel('Step over', room(40));
    assert.deepEqual(f.lines, ['Step', 'over']);
    assert.equal(f.fontSize, 11);
  });

  it('shrinks before it would break a word', () => {
    // "Command" is 7 characters: 46.2 px at 11, 42 px at 10, 37.8 px at 9.
    const f = fitLabel('Command palette', room(44, 2, 11));
    noWordSplit('Command palette', f.lines);
    assert.ok(f.fontSize < 11 && f.fontSize >= Math.round(11 * MIN_LABEL_SCALE));
  });

  it('ends in an ellipsis instead of splitting a word too long even when shrunk', () => {
    const f = fitLabel('Rename symbol', room(28));
    assert.equal(f.fontSize, Math.round(11 * MIN_LABEL_SCALE));
    noWordSplit('Rename symbol', f.lines);
    assert.ok(f.lines.some((l) => l.endsWith('…')));
    for (const line of f.lines) assert.ok(line.length * f.fontSize * 0.6 <= 28.5, `"${line}" is wider than the key`);
  });

  it('uses one line when only one fits, ending it in an ellipsis', () => {
    const f = fitLabel('Start debugging', { width: 60, height: 14, fontSize: 11, maxLines: 2 });
    assert.equal(f.lines.length, 1);
    assert.ok(f.lines[0]!.endsWith('…'));
    assert.ok(f.lines[0]!.startsWith('Start'));
  });

  it('never gives more than two lines', () => {
    const f = fitLabel('Open the project in the editor now', { width: 200, height: 200, fontSize: 11, maxLines: 2 });
    assert.ok(f.lines.length <= 2);
  });
});

describe('icon or no icon on a key', () => {
  // Two lines at the smallest size (9 px, 11-px line height) need 22 px under a 24-px icon and a 4-px gap.
  const face = (height: number, iconHeight = 24) => ({ width: 40, height, iconHeight, gap: 4, fontSize: 11 });

  it('keeps the icon when two lines fit under it', () => {
    const at = layoutKeyFace('Step over', face(24 + 4 + 22));
    assert.equal(at.showIcon, true);
    assert.deepEqual(at.label?.lines, ['Step', 'over']);
  });

  it('drops the icon one pixel below that, and the label gets the whole face', () => {
    const at = layoutKeyFace('Step over', face(24 + 4 + 21));
    assert.equal(at.showIcon, false);
    assert.deepEqual(at.label?.lines, ['Step', 'over']);
  });

  it('shows the whole label on a small key where the icon left room for "Step…" only', () => {
    const small = { ...face(34), width: 30 }; // a 46 x 56 key on a phone on its side
    assert.deepEqual(fitLabel('Step over', { width: 30, height: 34 - 24 - 4, fontSize: 11, maxLines: 2 }).lines, ['Step…']);
    const at = layoutKeyFace('Step over', small);
    assert.equal(at.showIcon, false);
    assert.deepEqual(at.label?.lines, ['Step', 'over']);
  });

  it('always keeps the icon of a key without a label', () => {
    assert.deepEqual(layoutKeyFace('', face(10)), { showIcon: true, label: null });
  });

  it('needs no decision for a key without an icon', () => {
    assert.equal(layoutKeyFace('Step over', face(20, 0)).showIcon, true);
  });
});


describe('a larger system font', () => {
  it('fits the label as if the key were smaller, so it never clips mid-word', () => {
    const room = { width: 47, height: 60, iconHeight: 0, gap: 4, fontSize: 11 };
    assert.deepEqual(layoutKeyFace('Command palette', room).label?.lines, ['Command', 'palette']);
    const scaled = layoutKeyFace('Command palette', { ...room, fontScale: 1.3 }).label!;
    // At 1.3x every line, drawn, must still fit 47 px: characters x size x 0.6 x scale.
    for (const line of scaled.lines) assert.ok(line.length * scaled.fontSize * 0.6 * 1.3 <= 47.5, line);
  });

  it('drops the icon sooner, since the label needs more room under it', () => {
    const face = { width: 40, height: 50, iconHeight: 24, gap: 4, fontSize: 11 };
    assert.equal(layoutKeyFace('Step over', face).showIcon, true);
    assert.equal(layoutKeyFace('Step over', { ...face, fontScale: 1.3 }).showIcon, false);
  });
});
