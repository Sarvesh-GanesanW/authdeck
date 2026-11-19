// Env messages on the link (net/messages.ts): every env event and result the phone receives is
// shape-checked, env events stay apart from the 0.3 events, and only the env feature is read
// from an agent's info.
import '../native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agentFeatures, isEnvComputerRequest, isMethodResult, readSessionMessage } from '../../src/net/messages';
import { FakeAgent, createRequest } from './fakes';

const event = (name: string, data: unknown) => readSessionMessage(JSON.stringify({ event: name, data }));

describe('env messages', () => {
  it('a well-formed env event is read as an env event, apart from the 0.3 events', () => {
    const request = createRequest(new FakeAgent(), 'c1', [{ name: 'A', value: '1' }]);
    assert.equal(event('env.request', { request }).kind, 'env-event');
    assert.equal(event('env.request.closed', { requestId: 'c1', reason: 'expired' }).kind, 'env-event');
    assert.equal(event('vault.changed', { vaultId: 'x' }).kind, 'event');
  });

  it('a damaged env event ends the session as malformed', () => {
    assert.equal(event('env.request', { request: { kind: 'run' } }).kind, 'malformed');
    assert.equal(event('env.request.closed', { requestId: 'c1', reason: 'whatever' }).kind, 'malformed');
    assert.equal(event('env.grants.changed', { grants: [{ grantId: 1 }] }).kind, 'malformed');
    const request = createRequest(new FakeAgent(), 'c1', [{ name: 'A', value: 'x'.repeat(40_000) }]);
    assert.equal(isEnvComputerRequest(request), false);
  });

  it('an unknown event from a newer agent is still dropped', () => {
    assert.equal(event('env.something-new', {}).kind, 'unknown-event');
  });

  it('env results are checked per method', () => {
    assert.equal(isMethodResult('env.watch', { requests: [], grants: [] }), true);
    assert.equal(isMethodResult('env.watch', { requests: [{}], grants: [] }), false);
    assert.equal(isMethodResult('env.file.read', { file: 'x', fileHash: 'h', commits: [null, 'abc'], requests: [] }), true);
    assert.equal(isMethodResult('env.file.read', { file: 5, fileHash: 'h', commits: [], requests: [] }), false);
    assert.equal(isMethodResult('env.file.write', {}), false);
    assert.equal(isMethodResult('env.history.read', { commits: [{ commit: 'c', time: 1, author: 'a', subject: 's', file: null }], more: false }), true);
    assert.equal(isMethodResult('ping', { time: 1 }), true);
  });

  it("only the env feature is read from an agent's features; anything else is ignored", () => {
    assert.deepEqual(agentFeatures(['env-sets', 'later-thing']), ['env-sets']);
    assert.deepEqual(agentFeatures(undefined), []);
    assert.deepEqual(agentFeatures('env-sets'), []);
  });
});
