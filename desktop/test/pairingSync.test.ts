import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PairingSync, type PairingControl } from '../src/main/pairingSync.ts';

/** A stand-in agent whose window can run out or refuse to open, like a busy agent.json. */
function fakeAgent() {
  const calls: string[] = [];
  const agent = {
    calls,
    open: false,
    failNext: false,
    control: {
      isOpen: () => agent.open,
      open: () => {
        calls.push('open');
        if (agent.failNext) {
          agent.failNext = false;
          throw new Error('busy');
        }
        agent.open = true;
      },
      close: () => {
        calls.push('close');
        agent.open = false;
      },
    } satisfies PairingControl,
  };
  return agent;
}

describe('desktop pairing window', () => {
  it('opens when the pairing view is on screen and closes when the window hides', () => {
    const sync = new PairingSync();
    const agent = fakeAgent();
    assert.equal(sync.sync(agent.control, true, true), true);
    assert.equal(agent.open, true);
    assert.equal(sync.sync(agent.control, true, true), false, 'already open: nothing to do');
    assert.equal(sync.sync(agent.control, false, true), true, 'hidden or minimized');
    assert.equal(agent.open, false);
    assert.deepEqual(agent.calls, ['open', 'close']);
  });

  it('closes when the view changes, e.g. after a device paired', () => {
    const sync = new PairingSync();
    const agent = fakeAgent();
    sync.sync(agent.control, true, true);
    assert.equal(sync.sync(agent.control, true, false), true);
    assert.equal(agent.open, false);
  });

  it('never opens while hidden or while another view shows', () => {
    const sync = new PairingSync();
    const agent = fakeAgent();
    assert.equal(sync.sync(agent.control, false, true), false);
    assert.equal(sync.sync(agent.control, true, false), false);
    assert.deepEqual(agent.calls, []);
  });

  it('stays closed after running out until asked, or until the view is shown anew', () => {
    const sync = new PairingSync();
    const agent = fakeAgent();
    sync.sync(agent.control, true, true);
    agent.open = false; // ran out after 10 minutes
    assert.equal(sync.sync(agent.control, true, true), false);
    assert.equal(sync.sync(agent.control, true, true), false);
    assert.deepEqual(agent.calls, ['open']);
    sync.openAgain(agent.control, true);
    assert.equal(agent.open, true);
    agent.open = false;
    sync.sync(agent.control, true, true);
    sync.sync(agent.control, false, true); // hidden
    sync.sync(agent.control, true, true); // shown anew
    assert.equal(agent.open, true);
  });

  it('leaves alone a window it did not open (the command line opened it)', () => {
    const sync = new PairingSync();
    const agent = fakeAgent();
    agent.open = true;
    assert.equal(sync.sync(agent.control, false, true), false);
    assert.equal(agent.open, true);
  });

  it('does not open from a hidden window', () => {
    const sync = new PairingSync();
    const agent = fakeAgent();
    sync.openAgain(agent.control, false);
    assert.deepEqual(agent.calls, []);
  });

  it('shows pairing as closed, without throwing, when the agent cannot open it', () => {
    const errors: string[] = [];
    const sync = new PairingSync((message) => errors.push(message));
    const agent = fakeAgent();
    agent.failNext = true;
    assert.equal(sync.sync(agent.control, true, true), false);
    assert.equal(agent.open, false);
    assert.match(errors[0]!, /Could not open pairing: busy/);
    assert.equal(sync.sync(agent.control, true, true), false, 'no retry loop; the button opens it');
    sync.openAgain(agent.control, true);
    assert.equal(agent.open, true);
  });
});
