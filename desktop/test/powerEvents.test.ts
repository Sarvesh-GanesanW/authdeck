import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { endGrantsOnLockAndSleep } from '../src/main/powerEvents.ts';

describe('lock and sleep end every grant', () => {
  it("ends all grants with the contract's reason for each powerMonitor event", () => {
    const power = new EventEmitter();
    const reasons: string[] = [];
    endGrantsOnLockAndSleep(power, (reason) => reasons.push(reason));
    power.emit('lock-screen');
    power.emit('suspend');
    power.emit('unlock-screen');
    power.emit('resume');
    assert.deepEqual(reasons, ['computer-locked', 'computer-slept']);
  });

  it('ends them again on every lock, not just the first', () => {
    const power = new EventEmitter();
    let calls = 0;
    endGrantsOnLockAndSleep(power, () => calls++);
    power.emit('lock-screen');
    power.emit('lock-screen');
    assert.equal(calls, 2);
  });
});
