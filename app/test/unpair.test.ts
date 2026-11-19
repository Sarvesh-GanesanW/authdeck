/** After removing a device: what the computer said about unpairing it, and the sentence the sheet shows. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readRemovals, unpairSentence } from '../src/auth/engine/unpair';

const TABLET = 'T'.repeat(22);
const PHONE = 'P'.repeat(22);

describe('unpairing a removed device', () => {
  it('says the device is also unpaired when the computer unpaired it', () => {
    const outcomes = readRemovals({ lengths: {}, removals: [{ device: TABLET, unpairedFrom: 'Mac mini' }] });
    assert.equal(unpairSentence('Pixel 8', outcomes.get(TABLET), 'Mac mini'), 'Pixel 8 is also unpaired from Mac mini.');
  });

  it('says how to unpair it when the computer did not know the device or never answered', () => {
    const outcomes = readRemovals({ lengths: {}, removals: [{ device: TABLET, unpairedFrom: null }] });
    assert.equal(unpairSentence('Pixel 8', outcomes.get(TABLET), 'Mac mini'), 'To stop Pixel 8 controlling Mac mini, unpair it in AuthDeck Agent.');
    assert.equal(unpairSentence('Pixel 8', undefined, null), 'To stop Pixel 8 controlling your computer, unpair it in AuthDeck Agent.');
  });

  it('reads an answer from an older agent, or a malformed one, as not told', () => {
    assert.equal(readRemovals({ lengths: {} }).size, 0);
    const outcomes = readRemovals({
      lengths: {},
      removals: [{ device: '__proto__', unpairedFrom: 'Mac' }, { device: PHONE, unpairedFrom: 7 }, { device: TABLET, unpairedFrom: '  ' }, 'x'],
    });
    assert.deepEqual([...outcomes], [[PHONE, null], [TABLET, null]]);
  });
});
