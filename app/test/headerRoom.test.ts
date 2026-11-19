/**
 * The deck header's computer block shows its name only while the page tabs keep room for the
 * current page's segment, and the choice never flips back and forth.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pillDotOnly } from '../src/screens/deck/headerRoom';

const CONTROL = 44;

describe('the computer block in a one-row header', () => {
  it('waits until everything is measured', () => {
    assert.equal(pillDotOnly({ tabs: 0, need: 80, fill: 0, full: 160 }, false, CONTROL), null);
    assert.equal(pillDotOnly({ tabs: 200, need: 0, fill: 0, full: 160 }, false, CONTROL), null);
    assert.equal(pillDotOnly({ tabs: 200, need: 80, fill: 0, full: 0 }, false, CONTROL), null);
  });

  it('keeps the name while the tabs hold the current segment, and drops it when they would not', () => {
    assert.equal(pillDotOnly({ tabs: 120, need: 80, fill: 0, full: 160 }, false, CONTROL), false);
    assert.equal(pillDotOnly({ tabs: 60, need: 80, fill: 0, full: 160 }, false, CONTROL), true);
  });

  it('counts the free width beside the tabs on tablets', () => {
    assert.equal(pillDotOnly({ tabs: 60, need: 80, fill: 40, full: 160 }, false, CONTROL), false);
  });

  it('gives the same answer from either form, so it settles', () => {
    for (let tabs = 10; tabs < 400; tabs += 7) {
      const full = 160;
      const named = pillDotOnly({ tabs, need: 90, fill: 0, full }, false, CONTROL);
      // The same header with the light-only block: the tabs have gained full - CONTROL.
      const dotted = pillDotOnly({ tabs: tabs + full - CONTROL, need: 90, fill: 0, full }, true, CONTROL);
      assert.equal(named, dotted, `${tabs}`);
    }
  });
});
