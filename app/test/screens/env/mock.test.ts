/**
 * The sample engine the screens build against keeps the contract's promises: answers close
 * requests, edits sign new versions, removals name what to rotate, and refusals are sentences.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { MOCK_OWNER_PHRASE, mockEnvActions as env, mockEnvEndRequest, mockEnvRequest, mockEnvScenario, useMockEnv } from '../../../src/screens/env/mock';
import { envSectionState, VARIABLE_NAME_RULE } from '../../../src/screens/env/view';

const state = () => useMockEnv.getState();
const acme = 'set-acme-api';

beforeEach(() => mockEnvScenario('full'));

describe('mock env: scenarios', () => {
  it('has a scenario for every section state', () => {
    for (const [scenario, expected] of [
      ['full', 'list'],
      ['empty', 'empty'],
      ['loading', 'loading'],
      ['locked', 'locked'],
      ['errors', 'list'],
      ['refused', 'list'],
    ] as const) {
      mockEnvScenario(scenario);
      assert.equal(envSectionState(state()), expected, scenario);
    }
  });

  it('has every role, and problems in the error scenario', () => {
    assert.deepEqual([...new Set(state().sets.map((s) => s.role))].sort(), ['member', 'outside', 'owner', 'removed']);
    mockEnvScenario('errors');
    const problems = state().sets.find((s) => s.id === acme)!.problems;
    assert.deepEqual(
      problems.map((p) => [p.kind, p.severity]),
      [
        ['file', 'error'],
        ['older-copy', 'warning'],
        ['offline', 'warning'],
        ['epoch', 'warning'],
      ],
    );
  });
});

describe('mock env: requests', () => {
  it('closes a request when it is answered, and opens a grant on Allow for 15 minutes', async () => {
    const request = mockEnvRequest('run');
    assert.deepEqual(await env.answer(request.id, 'grant'), { changes: null });
    assert.equal(state().incoming.length, 0);
    assert.equal(state().sets.find((s) => s.id === acme)!.grant?.usedBy[0], 'npm run dev');
  });

  it('returns a push\'s diff from signing it, and drops the request', async () => {
    const request = mockEnvRequest('push');
    assert.equal(request.changes, null);
    const { changes } = await env.answer(request.id, 'approve');
    assert.deepEqual(
      changes?.map((c) => [c.change, c.loadsCode]),
      [
        ['add', false],
        ['change', false],
        ['change', true],
        ['remove', false],
      ],
    );
    assert.equal(state().incoming.length, 0);
    assert.equal(env.pushedValue(request.id, 'FEATURE_FLAGS_URL'), 'https://flags.acme.dev/api');
    assert.equal(env.pushedValue(request.id, 'NOT_SENT'), null);
  });

  it('asks to unlock for requests that arrive while locked', () => {
    mockEnvScenario('locked');
    assert.equal(mockEnvRequest('pull').needsUnlock, true);
  });

  it('keeps why a request ended until it is dismissed', () => {
    const request = mockEnvRequest('run');
    mockEnvEndRequest(request.id, 'answered', "Maya's iPad");
    assert.equal(state().incoming.length, 0);
    assert.deepEqual(
      state().ended.map((e) => [e.id, e.reason, e.by]),
      [[request.id, 'answered', "Maya's iPad"]],
    );
    env.dismissEnded(request.id);
    assert.deepEqual(state().ended, []);
  });

  it('refuses an answer to a request that already ended, in a sentence', async () => {
    await assert.rejects(env.answer('nope', 'deny'), /That request already ended\./);
  });
});

describe('mock env: variables and members', () => {
  it('signs a new version on each save, and renames in place', async () => {
    await env.saveVariable(acme, { name: 'REDIS_URL', value: 'redis://new' });
    assert.equal(env.detail(acme)!.variables.find((v) => v.name === 'REDIS_URL')!.version, 3);
    await env.saveVariable(acme, { name: 'CACHE_URL', value: 'redis://new', previousName: 'REDIS_URL' });
    const names = env.detail(acme)!.variables.map((v) => v.name);
    assert.ok(names.includes('CACHE_URL') && !names.includes('REDIS_URL'));
    assert.equal(await env.reveal(acme, 'CACHE_URL'), 'redis://new');
  });

  it('checks names with envcore\'s rule: letters, digits and _', () => {
    assert.deepEqual(env.checkVariable('lower_case_ok', 'x'), []);
    assert.deepEqual(env.checkVariable('1BAD', 'x'), [`1BAD can't be a variable name. ${VARIABLE_NAME_RULE}`]);
    assert.equal(VARIABLE_NAME_RULE, "Names take letters, digits and _, and don't start with a digit.");
  });

  it('parses pasted .env lines without saving, naming the lines it left out', () => {
    const parsed = env.parseDotenv('# comment\nexport A=1\nB="two words"\n1X=3\nnot a line\nA=again');
    assert.deepEqual(parsed.values, [
      { name: 'B', value: 'two words' },
      { name: 'A', value: 'again' },
    ]);
    assert.equal(parsed.problems.length, 3);
    assert.equal(env.detail(acme)!.variables.some((v) => v.name === 'B'), false);
  });

  it('returns every name the removed member could read, to rotate', async () => {
    const before = env.detail(acme)!.variables.map((v) => v.name);
    const { rotate } = await env.removeMember(acme, 'm-ben');
    assert.deepEqual(rotate, before);
    assert.equal(env.detail(acme)!.members.some((m) => m.id === 'm-ben'), false);
  });

  it('makes this phone the owner only with the owner\'s phrase, taking every other device out', async () => {
    await assert.rejects(env.becomeOwner('set-ledgerline', MOCK_OWNER_PHRASE.slice().reverse()), /aren't the recovery phrase of ledgerline's owner/);
    const others = env.detail('set-ledgerline')!.members.filter((m) => !m.thisDevice).map((m) => m.label);
    const { removed, rotate } = await env.becomeOwner('set-ledgerline', MOCK_OWNER_PHRASE);
    assert.deepEqual(removed, others);
    assert.equal(rotate.length, env.detail('set-ledgerline')!.variables.length);
    assert.equal(state().sets.find((s) => s.id === 'set-ledgerline')!.role, 'owner');
    assert.equal(env.detail('set-ledgerline')!.members.length, 1);
  });

  it('fixes old-key values only for the list the owner reviewed, and names them to rotate either way', async () => {
    mockEnvScenario('errors');
    const names = state().sets.find((s) => s.id === acme)!.problems.find((p) => p.kind === 'epoch')!.names!;
    await assert.rejects(env.fixOldKeyLines(acme, true, names.slice(1)), /changed since this sheet showed them/);
    const { rotate } = await env.fixOldKeyLines(acme, false, names);
    assert.deepEqual(rotate, names);
    assert.equal(env.detail(acme)!.variables.some((v) => names.includes(v.name)), false);
    assert.equal(state().sets.find((s) => s.id === acme)!.problems.some((p) => p.kind === 'epoch'), false);
  });

  it("confirms the owner's words only as they were shown", async () => {
    const request = state().ownRequests[0]!;
    await assert.rejects(env.confirmOwnerWords(request.setId, ['other', ...request.ownerKeyWords.slice(1)]), /changed while this was open/);
    assert.equal(state().ownRequests[0]!.ownerConfirmed, false);
    await env.confirmOwnerWords(request.setId, request.ownerKeyWords);
    assert.equal(state().ownRequests[0]!.ownerConfirmed, true);
  });

  it('cancels its own request when the words do not match, leaving the set outside', async () => {
    const request = state().ownRequests[0]!;
    await env.cancelOwnRequest(request.setId);
    assert.equal(state().ownRequests.some((r) => r.setId === request.setId), false);
    const set = state().sets.find((s) => s.id === request.setId);
    if (set) assert.equal(set.role, 'outside');
  });

  it('takes a name of 1 to 40 characters, trimmed', async () => {
    useMockEnv.setState({ personName: null });
    await assert.rejects(env.setPersonName('   '), /1 to 40 characters/);
    await assert.rejects(env.setPersonName('x'.repeat(41)), /1 to 40 characters/);
    await env.setPersonName('  Chen Wei ');
    assert.equal(state().personName, 'Chen Wei');
  });

  it('flags names that change how programs start', () => {
    const flagged = env.detail(acme)!.variables.filter((v) => v.loadsCode).map((v) => v.name);
    assert.deepEqual(flagged, ['NODE_OPTIONS']);
  });

  it('deletes only a set this phone was removed from', async () => {
    await assert.rejects(env.deleteRemovedSet(acme), /Only a set this phone was removed from/);
    await env.deleteRemovedSet('set-tidepool-web');
    assert.equal(env.detail('set-tidepool-web'), null);
  });
});
