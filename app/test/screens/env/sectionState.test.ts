/** The ".env sets" section: which state it draws, the order of its rows, and each row's lines. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  envSectionState,
  memberDetail,
  orderSets,
  setAbilities,
  setCounts,
  setRow,
  setSubtitle,
  variableMeta,
  variablesHeading,
} from '../../../src/screens/env/view';
import { anOwnRequest, aSet, DAY, MIN, NOW } from './fixtures';

const own = anOwnRequest();

describe('section state', () => {
  it('shows loading and locked before anything else', () => {
    assert.equal(envSectionState({ status: 'loading', sets: [aSet()], ownRequests: [] }), 'loading');
    assert.equal(envSectionState({ status: 'locked', sets: [aSet()], ownRequests: [] }), 'locked');
  });

  it('is empty only with no sets and no join requests of its own', () => {
    assert.equal(envSectionState({ status: 'open', sets: [], ownRequests: [] }), 'empty');
    assert.equal(envSectionState({ status: 'open', sets: [], ownRequests: [own] }), 'list');
    assert.equal(envSectionState({ status: 'open', sets: [aSet()], ownRequests: [] }), 'list');
  });

  it('lists sets you are in first, then ones you could join, then removed ones, keeping the engine order within each', () => {
    const sets = [
      aSet({ id: 'r', role: 'removed' }),
      aSet({ id: 'o1', role: 'owner' }),
      aSet({ id: 'x', role: 'outside' }),
      aSet({ id: 'm', role: 'member' }),
      aSet({ id: 'o2', role: 'owner' }),
    ];
    assert.deepEqual(
      orderSets(sets).map((s) => s.id),
      ['o1', 'm', 'o2', 'x', 'r'],
    );
  });
});

describe('set rows', () => {
  it('counts variables and members, and says "only you" for a set of one', () => {
    assert.equal(setCounts(aSet()), '12 variables · 4 members');
    assert.equal(setCounts(aSet({ variableCount: 1, memberCount: 1 })), '1 variable · only you');
    assert.equal(setCounts(aSet({ role: 'member', memberCount: 1 })), '12 variables · 1 member');
  });

  it('puts the most serious problem first, in its colour', () => {
    const row = setRow(
      aSet({
        problems: [{ id: 'p', kind: 'file', severity: 'error', title: "A line isn't signed by a member", text: '…' }],
        grant: { grantId: 'g', computerName: 'MacBook Pro', endsAt: NOW + 10 * MIN, by: 'x', usedBy: [] },
      }),
      NOW,
    );
    assert.deepEqual([row.status, row.tone], ["A line isn't signed by a member", 'danger']);
    const warning = setRow(aSet({ problems: [{ id: 'p', kind: 'offline', severity: 'warning', title: 'MacBook Pro is offline', text: '…' }] }), NOW);
    assert.equal(warning.tone, 'warning');
  });

  it('shows an open grant with its end time', () => {
    const row = setRow(aSet({ grant: { grantId: 'g', computerName: 'MacBook Pro', endsAt: new Date(2026, 10, 18, 11, 58).getTime(), by: 'x', usedBy: [] } }), NOW);
    assert.deepEqual([row.status, row.tone, row.tag], ['Allowed on MacBook Pro until 11:58', 'ok', 'owner']);
  });

  it('ignores a grant that already ended', () => {
    const row = setRow(aSet({ grant: { grantId: 'g', computerName: 'MacBook Pro', endsAt: NOW - MIN, by: 'x', usedBy: [] }, lastReleasedAt: NOW - 3 * DAY }), NOW);
    assert.equal(row.status, 'Last released 15 Nov');
  });

  it('marks a removed set read-only and a set this device is outside of', () => {
    assert.deepEqual(setRow(aSet({ role: 'removed' }), NOW), {
      title: 'acme-api',
      tag: 'removed',
      detail: '12 variables',
      status: 'You were removed. Read-only here.',
      tone: 'danger',
    });
    const outside = setRow(aSet({ role: 'outside' }), NOW);
    assert.deepEqual([outside.tag, outside.status], ['not in it', 'On MacBook Pro. Ask to join to use it.']);
  });

  it('names the owner on a member row, by person', () => {
    assert.equal(setRow(aSet({ role: 'member', ownerLabel: 'Ben Okafor · Pixel 9' }), NOW).status, 'Ben Okafor owns it');
    assert.equal(setRow(aSet({ role: 'member', ownerLabel: null }), NOW).status, 'Not released yet · on MacBook Pro');
  });

  it('says when the computer is offline, then when the set was last released', () => {
    assert.equal(setRow(aSet({ computerOnline: false }), NOW).status, 'MacBook Pro is offline');
    assert.equal(setRow(aSet({ lastReleasedAt: new Date(2026, 10, 18, 9, 30).getTime() }), NOW).status, 'Last released today 09:30');
    assert.equal(setRow(aSet(), NOW).status, 'Not released yet · on MacBook Pro');
  });
});

describe('set sheet', () => {
  it('lets each role do only its own things', () => {
    assert.deepEqual(setAbilities('owner'), { editVariables: true, reveal: true, manageMembers: true, askToJoin: false, becomeOwner: false, deleteCopy: false });
    assert.deepEqual(setAbilities('member'), { editVariables: true, reveal: true, manageMembers: false, askToJoin: false, becomeOwner: true, deleteCopy: false });
    assert.deepEqual(setAbilities('outside'), { editVariables: false, reveal: false, manageMembers: false, askToJoin: true, becomeOwner: true, deleteCopy: false });
    assert.deepEqual(setAbilities('removed'), { editVariables: false, reveal: true, manageMembers: false, askToJoin: false, becomeOwner: false, deleteCopy: true });
  });

  it('subtitles the set by repo and file, or by what this phone can do with it', () => {
    assert.equal(setSubtitle(aSet()), 'acme/api · .authdeck/acme-api.env');
    assert.equal(setSubtitle(aSet({ role: 'removed', repo: 'tidepool/web' })), 'tidepool/web · read-only on this phone');
    assert.equal(setSubtitle(aSet({ repo: null, role: 'outside' })), "MacBook Pro · this phone isn't in it");
  });

  it('dates a removed set\'s variables to when this phone last read them', () => {
    assert.equal(variablesHeading(aSet(), 12), 'Variables · 12');
    assert.equal(variablesHeading(aSet({ role: 'removed', syncedAt: new Date(2026, 10, 14).getTime() }), 3), 'Variables, as of 14 Nov');
  });

  it('shows each value\'s version, signer and time, and the countdown while revealed', () => {
    const variable = { name: 'STRIPE_WEBHOOK_SECRET', version: 5, by: 'Maya', byMemberId: 'm', time: new Date(2026, 10, 18, 11, 20).getTime(), loadsCode: false };
    assert.equal(variableMeta(variable, NOW), 'v5 · Maya · today 11:20');
    assert.equal(variableMeta(variable, NOW, 24), 'Hides in 0:24 · v5 · Maya · today 11:20');
    assert.equal(variableMeta({ ...variable, time: new Date(2026, 10, 12).getTime() }, NOW), 'v5 · Maya · 12 Nov');
  });

  it('labels this phone and when the others joined', () => {
    const base = { id: 'a', label: 'Maya Rao · iPad mini', form: 'tablet' as const, role: 'member' as const, since: new Date(2026, 10, 12).getTime() };
    assert.equal(memberDetail({ ...base, thisDevice: false }), 'Joined 12 Nov');
    assert.equal(memberDetail({ ...base, thisDevice: true }), 'This phone');
  });
});
