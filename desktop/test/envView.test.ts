import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GrantTracker, envActivityItem, grantBanner, grantEndedItem, grantTrayLines, liveGrants } from '../src/shared/envView.ts';
import type { EnvGrant } from '../src/shared/state.ts';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 18, 11, 48);
/** A fixed clock, so the words don't depend on the machine's time zone. */
const clock = (at: number) => `T+${Math.round((at - NOW) / MINUTE)}`;

function grant(grantId: string, setName: string, endsIn: number, overrides: Partial<EnvGrant> = {}): EnvGrant {
  const endsAt = NOW + endsIn * MINUTE;
  return { grantId, setId: `set-${grantId}`, setName, path: `/code/${setName}/.authdeck/${setName}.env`, startedAt: endsAt - 15 * MINUTE, endsAt, by: 'Pixel 8', uses: [], ...overrides };
}

describe('env activity rows', () => {
  it("shows the agent's words for a request or an answer as they are", () => {
    const entry = { id: 7, at: NOW, kind: 'run' as const, setName: 'acme-api', title: 'Ran with acme-api', detail: 'npm test · 12 variables', outcome: { text: 'Inside the 15-min grant', tone: 'ok' as const } };
    assert.deepEqual(envActivityItem(entry), { kind: 'env', at: NOW, title: 'Ran with acme-api', detail: 'npm test · 12 variables', outcome: { text: 'Inside the 15-min grant', tone: 'ok' } });
  });

  it('says why a grant ended in the words for each reason the agent gives', () => {
    const open = grant('g1', 'acme-api', 5, { uses: ['npm run dev', 'npm test'] });
    assert.deepEqual(grantEndedItem(open, 'ended-on-computer', NOW), {
      kind: 'env',
      at: NOW,
      title: 'Grant for acme-api ended',
      detail: 'Allowed on Pixel 8 · used by npm run dev, npm test',
      outcome: { text: 'Ended here', tone: 'idle' },
    });
    const words = {
      expired: 'Ran out after 15 min',
      'ended-on-device': 'Ended on a device',
      'ended-on-computer': 'Ended here',
      'computer-locked': 'Ended when the computer locked',
      'computer-slept': 'Ended when the computer slept',
      'clock-jumped': "Ended when the computer's clock jumped",
      'set-changed': 'Ended when the set changed',
      unpaired: 'Ended when a device was unpaired',
    } as const;
    for (const [reason, text] of Object.entries(words)) {
      const row = grantEndedItem(open, reason as keyof typeof words, NOW);
      assert.equal(row.kind === 'env' && row.outcome.text, text, reason);
    }
    assert.match(grantEndedItem(grant('g3', 'acme-api', 0), 'expired', NOW).detail, /not used$/);
  });

  it('without a reason, says it ran out when its time is up, and ended early otherwise', () => {
    const outcome = (endsIn: number) => {
      const row = grantEndedItem(grant('g', 'acme-api', endsIn), undefined, NOW);
      return row.kind === 'env' && row.outcome.text;
    };
    assert.equal(outcome(0), 'Ran out after 15 min');
    assert.equal(outcome(5), 'Ended early');
  });

  it("adds a row for each grant that leaves the list, with the agent's reason for the one it names", () => {
    const tracker = new GrantTracker();
    const a = grant('a', 'acme-api', 9);
    const b = grant('b', 'acme-web', 12);
    assert.deepEqual(tracker.update([a, b], undefined, NOW), [], 'grants that open add no row');
    const rows = tracker.update([b], { grantId: 'a', reason: 'ended-on-device' }, NOW);
    assert.deepEqual(rows.map((row) => row.title), ['Grant for acme-api ended']);
    assert.equal(rows[0]!.kind === 'env' && rows[0]!.outcome.text, 'Ended on a device');
    assert.deepEqual(tracker.grants, [b]);
    const unnamed = tracker.update([], { grantId: 'other', reason: 'unpaired' }, NOW);
    assert.equal(unnamed[0]!.kind === 'env' && unnamed[0]!.outcome.text, 'Ended early', "a reason for another grant isn't borrowed");
  });

  it('forgets every grant when the agent stops', () => {
    const tracker = new GrantTracker();
    tracker.update([grant('a', 'acme-api', 9)], undefined, NOW);
    tracker.clear();
    assert.deepEqual(tracker.grants, []);
    assert.deepEqual(tracker.update([], undefined, NOW), []);
  });
});

describe('grant banner', () => {
  it('is hidden with no live grant, including one past its end', () => {
    assert.equal(grantBanner([], NOW, clock), null);
    assert.equal(grantBanner([grant('old', 'acme-api', 0)], NOW, clock), null);
  });

  it('names the set, the device, the end and what used it for one grant', () => {
    const view = grantBanner([grant('g1', 'acme-api', 10, { uses: ['npm run dev', 'npm test'] })], NOW, clock);
    assert.deepEqual(view, {
      kind: 'one',
      grantId: 'g1',
      setName: 'acme-api',
      title: 'acme-api is allowed here until T+10',
      detail: 'Pixel 8 allowed it for 15 minutes. Used by npm run dev and npm test.',
      endsAt: NOW + 10 * MINUTE,
    });
  });

  it('says when a grant is not used yet', () => {
    const view = grantBanner([grant('g1', 'acme-api', 10)], NOW, clock);
    assert.equal(view?.kind === 'one' && view.detail, 'Pixel 8 allowed it for 15 minutes. Not used yet.');
  });

  it('lists several grants soonest first, each with its own End now', () => {
    const view = grantBanner(
      [grant('late', 'acme-web', 13, { uses: ['pnpm dev'] }), grant('soon', 'billing', 4, { by: 'iPad mini' }), grant('gone', 'old', -1), grant('mid', 'acme-api', 9, { uses: ['a', 'b', 'c'] })],
      NOW,
      clock,
    );
    assert.equal(view?.kind, 'several');
    if (view?.kind !== 'several') return;
    assert.equal(view.title, '3 sets are allowed here');
    assert.deepEqual(
      view.rows.map((row) => [row.grantId, row.title, row.detail]),
      [
        ['soon', 'billing · until T+4', 'iPad mini · Not used yet.'],
        ['mid', 'acme-api · until T+9', 'Pixel 8 · Used by a, b and c.'],
        ['late', 'acme-web · until T+13', 'Pixel 8 · Used by pnpm dev.'],
      ],
    );
  });

  it('keeps only live grants, soonest first', () => {
    assert.deepEqual(liveGrants([grant('b', 'b', 5), grant('x', 'x', 0), grant('a', 'a', 2)], NOW).map((g) => g.grantId), ['a', 'b']);
  });
});

describe('tray lines for grants', () => {
  it('names up to three grants, then counts the rest', () => {
    assert.deepEqual(grantTrayLines([], NOW, clock), []);
    assert.deepEqual(grantTrayLines([grant('a', 'acme-api', 10)], NOW, clock), ['acme-api allowed until T+10']);
    const five = ['a', 'b', 'c', 'd', 'e'].map((name, i) => grant(name, name, i + 1));
    assert.deepEqual(grantTrayLines(five, NOW, clock), ['a allowed until T+1', 'b allowed until T+2', 'c allowed until T+3', 'and 2 more allowed']);
  });
});
