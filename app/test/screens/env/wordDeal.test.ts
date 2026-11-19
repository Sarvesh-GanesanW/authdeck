/**
 * The six-word check deals its wrong words once per request (ENV-27): reopening or trying again
 * must show the same three words per step, or comparing deals gives the real words away.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dealFor, WORD_TRIES } from '../../../src/screens/env/wordDeal';

const WORDS = ['harbor', 'velvet', 'quarry', 'mosaic', 'lantern', 'ember'];

describe('the word deal', () => {
  it('offers the real word and two others at each of the six steps', () => {
    const { deal } = dealFor('request-a', WORDS);
    assert.equal(deal.steps.length, 6);
    deal.steps.forEach((choices, index) => {
      assert.equal(new Set(choices).size, 3);
      assert.ok(choices.includes(WORDS[index]!));
      assert.equal(choices.filter((w) => WORDS.includes(w)).length, 1);
    });
  });

  it('is the same deal, misses included, each time the same request asks', () => {
    const first = dealFor('request-b', WORDS);
    first.deal.misses += 1;
    const again = dealFor('request-b', WORDS);
    assert.equal(again.deal, first.deal);
    assert.deepEqual(again.deal.steps, first.deal.steps);
    assert.equal(again.deal.misses, 1);
  });

  it('stays stopped after a wrong pick until Try again, across reopening', () => {
    const first = dealFor('request-stop', WORDS);
    assert.equal(first.deal.stopped, false);
    first.deal.stopped = true;
    assert.equal(dealFor('request-stop', WORDS).deal.stopped, true);
  });

  it('deals afresh when the words change, or for another request', () => {
    const before = dealFor('request-c', WORDS);
    const changed = dealFor('request-c', ['tunnel', ...WORDS.slice(1)]);
    assert.notEqual(changed.id, before.id);
    assert.equal(changed.deal.misses, 0);
    assert.notEqual(dealFor('request-d', WORDS).deal, before.deal);
  });

  it('ends the check on the second wrong pick', () => {
    assert.equal(WORD_TRIES, 2);
  });
});
