/**
 * The words behind the steps several sheets share: the one-time name, the six-word pick on both
 * sides of a join, the teammate's check of the owner's words, code-loading names, and what to rotate afterwards.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  oldKeyRotate,
  oldKeyText,
  firstName,
  OLD_OWNER_VALUES,
  ownerWords,
  ownRequestStatus,
  personNameReady,
  REFUSED_TITLE,
  removedRotate,
  setRow,
  takeOverRotate,
  waitingForOwner,
  WORD_COUNT,
  wordChoices,
  wordStepQuestion,
} from '../../../src/screens/env/view';
import { anOwnRequest, aSet, NOW } from './fixtures';

const WORDS = ['harbor', 'velvet', 'quarry', 'mosaic', 'lantern', 'ember'];
const POOL = ['harbor', 'mosaic', 'apple', 'zebra', 'cloud', 'velvet', 'stone'];

/** Steps through the given numbers, wrapping each below n. */
function seeded(...numbers: number[]): (n: number) => number {
  let i = 0;
  return (n) => numbers[i++ % numbers.length]! % n;
}

describe('your name', () => {
  it('takes 1 to 40 characters once trimmed', () => {
    assert.equal(personNameReady(''), false);
    assert.equal(personNameReady('   '), false);
    assert.equal(personNameReady(' Maya '), true);
    assert.equal(personNameReady('x'.repeat(40)), true);
    assert.equal(personNameReady('x'.repeat(41)), false);
  });
});

describe('the six-word pick', () => {
  it('asks for all six words', () => {
    assert.equal(WORD_COUNT, 6);
  });

  it('offers each real word and two others that are none of the six', () => {
    for (let index = 0; index < WORD_COUNT; index++) {
      for (let seed = 0; seed < 20; seed++) {
        const choices = wordChoices(WORDS, index, POOL, seeded(seed, seed * 3 + 1, seed * 7 + 2, 5, 11));
        assert.equal(choices.length, 3);
        assert.equal(new Set(choices).size, 3);
        assert.ok(choices.includes(WORDS[index]!));
        assert.equal(choices.filter((w) => WORDS.includes(w)).length, 1);
      }
    }
  });

  it("doesn't always put the real word in the same place", () => {
    const places = new Set<number>();
    for (let seed = 0; seed < 12; seed++) places.add(wordChoices(WORDS, 3, POOL, seeded(2, 3, 4, seed)).indexOf('mosaic'));
    assert.ok(places.size > 1);
  });

  it('asks for each word by its place and the person', () => {
    assert.equal(wordStepQuestion(0, 'Chen Wei · iPhone 16'), 'Word 1 of 6: which word did Chen Wei say?');
    assert.equal(wordStepQuestion(5, 'Chen Wei · iPhone 16'), 'Word 6 of 6: which word did Chen Wei say?');
  });
});

describe("the teammate's check of the owner's words", () => {
  it('names the owner in the ask, the warning and the wait', () => {
    assert.deepEqual(ownerWords('Ben Okafor · Pixel 9'), {
      label: "Ben Okafor's words",
      check: "Check Ben's words",
      ask: 'Ask Ben Okafor to read their six words out, then pick each one as you hear it.',
      wrongWord: "That word doesn't match. Don't go on unless every word matches.",
      mismatch: "Don't continue. Someone may be pretending to be Ben Okafor.",
      waiting: 'Waiting for Ben Okafor to add you.',
    });
  });

  it('calls the owner by first name on the button', () => {
    assert.equal(firstName('Ben Okafor · Pixel 9'), 'Ben');
    assert.equal(firstName('sdk_gphone64_arm64'), 'sdk_gphone64_arm64');
  });
});

describe('old-key values', () => {
  it('lists them for the owner, and tells members who fixes them', () => {
    assert.equal(oldKeyText(['A', 'B']), 'These values were saved under the old key: A and B.');
    assert.equal(waitingForOwner(aSet({ ownerLabel: 'Ben Okafor · Pixel 9' })), 'Waiting for Ben Okafor to fix the set.');
    assert.equal(waitingForOwner(aSet({ ownerLabel: null })), 'Waiting for the owner to fix the set.');
  });

  it('says to rotate dropped values if still used, since git history keeps them', () => {
    const dropped = oldKeyRotate(false, ['A', 'B'], ['A', 'B']);
    assert.match(dropped.text, /A and B are removed from the set\. .*git history: if a secret is still used anywhere, rotate it/);
    assert.equal(dropped.after, null);
    const kept = oldKeyRotate(true, ['A'], ['A']);
    assert.match(kept.text, /^A is under the current key now\./);
    assert.ok(kept.after);
  });
});

describe('what to rotate', () => {
  it('after a removal, names the device and its values', () => {
    const words = removedRotate('Ben Okafor · Pixel 9', ['A']);
    assert.equal(words.title, 'Removed Ben Okafor');
    assert.match(words.text, /could read 1 value before it was removed/);
  });

  it('after a take-over, names who to ask back and what to rotate', () => {
    const words = takeOverRotate('ledgerline', ['Ben Okafor · Pixel 9', 'Lin Park · Pixel 8'], ['A', 'B']);
    assert.equal(words.title, "You're the owner now");
    assert.match(words.text, /^These devices were taken out and need to ask to join again: Ben Okafor · Pixel 9 and Lin Park · Pixel 8\./);
    assert.deepEqual(words.rotate, ['A', 'B']);
    assert.match(takeOverRotate('pebble', [], []).text, /No other devices were in pebble\./);
    assert.ok(words.text.endsWith(OLD_OWNER_VALUES));
    assert.match(OLD_OWNER_VALUES, /^Values the old owner device wrote are kept\. If that device may be in someone else's hands, check them and rotate any you're unsure of\.$/);
  });
});

describe('a set this phone refused', () => {
  const refusedNote = "orbit-api's history goes back further than this phone checks, so it didn't take the set.";
  const request = anOwnRequest({ setId: 'set-2', ownerConfirmed: true });

  it('shows the refusal in place of the wait on the join card', () => {
    assert.deepEqual(ownRequestStatus(request, [aSet({ id: 'set-2', role: 'outside', refusedNote })]), { text: refusedNote, refused: true });
    assert.deepEqual(ownRequestStatus({ ...request, ownerConfirmed: false }, [aSet({ id: 'set-2', role: 'outside', refusedNote })]), { text: refusedNote, refused: true });
  });

  it("waits for the owner once their words are confirmed, and says nothing before", () => {
    assert.deepEqual(ownRequestStatus(request, [aSet({ id: 'set-2', role: 'outside' })]), { text: 'Waiting for Ben Okafor to add you.', refused: false });
    assert.equal(ownRequestStatus({ ...request, ownerConfirmed: false }, []), null);
  });

  it('marks the set row as refused', () => {
    const row = setRow(aSet({ role: 'outside', refusedNote }), NOW);
    assert.equal(row.status, REFUSED_TITLE);
    assert.equal(row.tone, 'danger');
  });
});
