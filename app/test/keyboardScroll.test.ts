import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KeyboardScrollMemory } from '../src/ui/keyboardScroll';

describe('a secure sheet’s scroll around the keyboard', () => {
  it('goes back to where the body was before the keyboard came up', () => {
    const memory = new KeyboardScrollMemory();
    assert.equal(memory.overlapChanged(320, 0), null);
    // Scrolled to the focused field, then to the next one while the keyboard stayed up.
    assert.equal(memory.overlapChanged(340, 140), null);
    assert.deepEqual(memory.overlapChanged(0, 260), { restoreTo: 0 });
  });

  it('keeps a body that was already scrolled where it was', () => {
    const memory = new KeyboardScrollMemory();
    memory.overlapChanged(300, 90);
    assert.deepEqual(memory.overlapChanged(0, 400), { restoreTo: 90 });
  });

  it('does nothing when the keyboard was never up, and starts over each time', () => {
    const memory = new KeyboardScrollMemory();
    assert.equal(memory.overlapChanged(0, 50), null);
    memory.overlapChanged(300, 10);
    memory.overlapChanged(0, 200);
    assert.equal(memory.overlapChanged(0, 200), null);
    memory.overlapChanged(300, 30);
    assert.deepEqual(memory.overlapChanged(0, 120), { restoreTo: 30 });
  });
});
