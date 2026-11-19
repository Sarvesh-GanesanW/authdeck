/** Which request sheet AuthHost shows: one at a time, held until it closes, own-device joins at once. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { joinToShow, nextRequest, shownRequest, withClosed } from '../../../src/screens/env/hostQueue';
import { aJoin, aRequest } from './fixtures';

describe('request queue', () => {
  it('shows the oldest request not closed here', () => {
    const a = aRequest({ id: 'a' });
    const b = aRequest({ id: 'b' });
    assert.equal(nextRequest([a, b], new Set())?.id, 'a');
    assert.equal(nextRequest([a, b], new Set(['a']))?.id, 'b');
    assert.equal(nextRequest([a], new Set(['a'])), null);
  });

  it('follows the engine\'s newer copy of the held request, as when the vault unlocks', () => {
    const locked = aRequest({ id: 'a', needsUnlock: true });
    const unlocked = { ...locked, needsUnlock: false };
    assert.equal(shownRequest(locked, [unlocked], new Set()), unlocked);
  });

  it('keeps the held request once the engine drops it, so its sheet can finish', () => {
    const signed = aRequest({ id: 'a', kind: 'push', changes: [{ name: 'X', change: 'add', loadsCode: false }] });
    const next = aRequest({ id: 'b' });
    assert.equal(shownRequest(signed, [next], new Set()), signed);
    assert.equal(shownRequest(null, [next], new Set()), next);
  });

  it('forgets closed ids the engine no longer lists', () => {
    const closed = withClosed(new Set(['old']), 'a', ['a', 'b']);
    assert.deepEqual([...closed], ['a']);
  });
});

describe('join queue', () => {
  it('shows an own device\'s request at once, but a teammate\'s only when picked', () => {
    const teammate = aJoin({ id: 't' });
    const ipad = aJoin({ id: 'i', via: 'own-device', expiresAt: 1 });
    assert.equal(joinToShow([teammate], null, new Set()), null);
    assert.equal(joinToShow([teammate, ipad], null, new Set())?.id, 'i');
    assert.equal(joinToShow([teammate, ipad], 't', new Set())?.id, 't');
  });

  it('shows a picked request even if it was closed before', () => {
    const teammate = aJoin({ id: 't' });
    assert.equal(joinToShow([teammate], 't', new Set(['t']))?.id, 't');
    assert.equal(joinToShow([aJoin({ id: 'i', via: 'own-device' })], null, new Set(['i'])), null);
  });
});
