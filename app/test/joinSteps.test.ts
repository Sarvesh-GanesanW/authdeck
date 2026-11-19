import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOIN_ATTEMPT_WINDOW_MS, JoinController } from '../src/auth/engine/join';
import { isLive, nextApproverStep, nextNewDeviceStep, stageFor } from '../src/auth/engine/joinSteps';
import { createJoinRequest } from '../src/vault/approval';
import { device, seededRandom } from './helpers';

const random = seededRandom('join-tests');

describe('new device steps', () => {
  it('reveals only after the challenge, and is let in only after revealing', () => {
    assert.equal(nextNewDeviceStep('asked', 'finished'), null);
    assert.equal(nextNewDeviceStep('asked', 'challenged'), 'revealed');
    assert.equal(nextNewDeviceStep('revealed', 'challenged'), null, 'a second challenge is ignored');
    assert.equal(nextNewDeviceStep('revealed', 'finished'), 'done');
    assert.equal(nextNewDeviceStep('revealed', 'refused'), 'failed');
  });

  it('ignores everything once it ended', () => {
    for (const event of ['challenged', 'finished', 'refused', 'cancelled', 'expired'] as const) {
      assert.equal(nextNewDeviceStep('done', event), null);
      assert.equal(nextNewDeviceStep('expired', event), null);
    }
  });
});

describe('approver steps', () => {
  it('sends its nonce only for a request it holds, then waits for the reveal before approving', () => {
    assert.equal(nextApproverStep('offered', 'revealed'), null);
    assert.equal(nextApproverStep('offered', 'approve'), null);
    assert.equal(nextApproverStep('offered', 'accept'), 'challenged');
    assert.equal(nextApproverStep('challenged', 'accept'), null, 'answers once');
    assert.equal(nextApproverStep('challenged', 'approve'), null);
    assert.equal(nextApproverStep('challenged', 'revealed'), 'revealed');
    assert.equal(nextApproverStep('revealed', 'revealed'), null);
    assert.equal(nextApproverStep('revealed', 'approve'), 'done');
  });

  it('can be denied, cancelled or expire at any live step', () => {
    for (const step of ['offered', 'challenged', 'revealed'] as const) {
      assert.equal(nextApproverStep(step, 'deny'), 'failed');
      assert.equal(nextApproverStep(step, 'cancelled'), 'failed');
      assert.equal(nextApproverStep(step, 'expired'), 'expired');
    }
  });

  it('shows the code only once both nonces are in', () => {
    assert.equal(stageFor('challenged'), 'waiting');
    assert.equal(stageFor('revealed'), 'compare');
    assert.equal(isLive('done'), false);
    assert.equal(isLive('offered'), true);
  });
});

describe('stopped join attempts', () => {
  it('counts requests that ended without approval over the last hour, not ones another device took', () => {
    let clock = 1_000_000;
    const host = {
      random,
      now: () => clock,
      request: async () => ({}) as never,
      keysForJoin: async () => device(random),
      renewJoinKeys: async () => undefined,
      adoptVault: async () => undefined,
      canApprove: () => true,
      approverOffer: async () => {
        throw new Error('not used');
      },
      addDevice: async () => 'vault',
      publish: () => undefined,
    };
    const joins = new JoinController(host);
    const ask = (requestId: string) => {
      const { request } = createJoinRequest(device(random), 'Pixel 8', random);
      joins.handleEvent('vault.join.requested', { requestId, request, fromDevice: 'x', expiresAt: clock + 5 * 60_000 });
    };
    try {
      for (const [id, reason] of [['a', 'cancelled'], ['b', 'disconnected'], ['c', 'taken']] as const) {
        ask(id);
        joins.handleEvent('vault.join.cancelled', { requestId: id, reason });
      }
      ask('d');
      joins.deny('d');
      assert.equal(joins.stoppedAttempts(), 3);
      clock += JOIN_ATTEMPT_WINDOW_MS + 1;
      assert.equal(joins.stoppedAttempts(), 0);
    } finally {
      joins.dispose();
    }
  });
});
