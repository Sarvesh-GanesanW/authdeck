/** Revealed values: one at a time, hidden after 30 seconds, and never shown once superseded. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ENV_REVEAL_MS } from '../../../src/auth/envContract';
import { type RevealClock, type RevealedValue, RevealTimer } from '../../../src/screens/env/reveal';

/** A clock that only moves when told to. */
class FakeClock implements RevealClock {
  at = 1_000_000;
  private timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  now = () => this.at;
  later = (run: () => void, ms: number) => {
    const timer = { at: this.at + ms, run, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  advance(ms: number): void {
    this.at += ms;
    for (const timer of this.timers.filter((t) => !t.cancelled && t.at <= this.at)) {
      timer.cancelled = true;
      timer.run();
    }
  }
}

function setup() {
  const clock = new FakeClock();
  const seen: (RevealedValue | null)[] = [];
  const timer = new RevealTimer((shown) => seen.push(shown), clock);
  return { clock, seen, timer };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('reveal timer', () => {
  it('hides a value exactly 30 seconds after it shows', async () => {
    const { clock, timer } = setup();
    await timer.reveal('DATABASE_URL', async () => 'postgres://x');
    assert.equal(timer.shown?.value, 'postgres://x');
    clock.advance(ENV_REVEAL_MS - 1);
    assert.equal(timer.shown?.name, 'DATABASE_URL');
    clock.advance(1);
    assert.equal(timer.shown, null);
  });

  it('counts down in whole seconds, rounding up', async () => {
    const { clock, timer } = setup();
    assert.equal(timer.secondsLeft(), null);
    await timer.reveal('A', async () => 'a');
    assert.equal(timer.secondsLeft(), 30);
    clock.advance(5_500);
    assert.equal(timer.secondsLeft(), 25);
    clock.advance(24_400);
    assert.equal(timer.secondsLeft(), 1);
  });

  it('shows one value at a time, and the first one\'s timer never hides the second', async () => {
    const { clock, timer, seen } = setup();
    await timer.reveal('A', async () => 'a');
    clock.advance(20_000);
    await timer.reveal('B', async () => 'b');
    assert.equal(timer.shown?.name, 'B');
    clock.advance(10_000);
    assert.equal(timer.shown?.name, 'B', "A's 30 s are up, but B was shown 10 s ago");
    clock.advance(20_000);
    assert.equal(timer.shown, null);
    assert.deepEqual(
      seen.map((s) => s?.name ?? null),
      ['A', null, 'B', null],
    );
  });

  it('drops a value that arrives after it was hidden or superseded', async () => {
    const { timer } = setup();
    const slow = deferred<string>();
    const first = timer.reveal('A', () => slow.promise);
    await timer.reveal('B', async () => 'b');
    slow.resolve('a');
    await first;
    assert.equal(timer.shown?.name, 'B');

    const late = deferred<string>();
    const third = timer.reveal('C', () => late.promise);
    timer.hide();
    late.resolve('c');
    await third;
    assert.equal(timer.shown, null);
  });

  it('shows nothing after dispose, even a value still loading', async () => {
    const { timer, seen } = setup();
    const slow = deferred<string>();
    const pending = timer.reveal('A', () => slow.promise);
    timer.dispose();
    slow.resolve('a');
    await pending;
    assert.equal(timer.shown, null);
    assert.deepEqual(seen, []);
  });

  it('passes a failed read on and shows nothing', async () => {
    const { timer } = setup();
    await assert.rejects(
      timer.reveal('A', async () => {
        throw new Error('A is no longer in this set.');
      }),
      /no longer in this set/,
    );
    assert.equal(timer.shown, null);
  });
});
