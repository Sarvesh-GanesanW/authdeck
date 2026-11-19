/**
 * With app lock on, changing the deck asks for the same unlock as the vault; pressing keys does not.
 */
import './native';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { mockActions, useMockVault } from '../src/auth/mock';
import { EDIT_UNLOCK_REASON, afterEditUnlock, mustLeaveEditing, pickAfterEditUnlock } from '../src/screens/deck/editGate';

describe('the edit gate', () => {
  beforeEach(() => {
    useMockVault.setState({ appLock: true, status: 'locked' });
  });

  it('does not open edit mode when the unlock is cancelled', async () => {
    let editing = false;
    let refused = '';
    const reasons: string[] = [];
    const cancelled = async (reason: string) => {
      reasons.push(reason);
      throw new Error('Unlock was cancelled.');
    };
    const opened = await afterEditUnlock(cancelled, () => (editing = true), (m) => (refused = m));
    assert.equal(opened, false);
    assert.equal(editing, false);
    assert.equal(refused, 'Unlock was cancelled.');
    assert.deepEqual(reasons, [EDIT_UNLOCK_REASON]);
  });

  it('opens edit mode only after the vault prompt has opened the vault', async () => {
    let statusWhenOpened: string | null = null;
    const opened = await afterEditUnlock(
      mockActions.requireUnlock,
      () => (statusWhenOpened = useMockVault.getState().status),
      () => assert.fail('should not refuse'),
    );
    assert.equal(opened, true);
    assert.equal(statusWhenOpened, 'open');
  });

  it('asks for nothing when app lock is off', async () => {
    useMockVault.setState({ appLock: false, status: 'locked' });
    let editing = false;
    await afterEditUnlock(mockActions.requireUnlock, () => (editing = true), () => assert.fail('should not refuse'));
    assert.equal(editing, true);
    assert.equal(useMockVault.getState().status, 'locked', 'no prompt, so the vault stays locked');
  });

  it('ends edit mode when the vault locks under it, only with app lock on', () => {
    assert.equal(mustLeaveEditing(true, { appLock: true, status: 'locked' }), true);
    assert.equal(mustLeaveEditing(true, { appLock: true, status: 'open' }), false);
    assert.equal(mustLeaveEditing(true, { appLock: false, status: 'locked' }), false);
    assert.equal(mustLeaveEditing(false, { appLock: true, status: 'locked' }), false);
  });
});

describe('importing a deck backup', () => {
  beforeEach(() => {
    useMockVault.setState({ appLock: true, status: 'locked' });
  });

  it('never opens the file picker when the unlock is cancelled', async () => {
    let pickerOpened = false;
    let refused = '';
    const picked = await pickAfterEditUnlock(
      async () => {
        throw new Error('Unlock was cancelled.');
      },
      async () => {
        pickerOpened = true;
        return '{"deck":{}}';
      },
      (m) => (refused = m),
    );
    assert.equal(picked, null);
    assert.equal(pickerOpened, false);
    assert.equal(refused, 'Unlock was cancelled.');
  });

  it('opens the picker after the unlock and hands back what was picked', async () => {
    const picked = await pickAfterEditUnlock(mockActions.requireUnlock, async () => 'backup text', () => assert.fail('should not refuse'));
    assert.equal(picked, 'backup text');
    assert.equal(useMockVault.getState().status, 'open');
  });
});
