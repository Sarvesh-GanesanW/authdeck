/** The request and join sheets: which answers each request offers, and what they say. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  answeredWords,
  changeLine,
  endedWords,
  joinBanner,
  joinSheet,
  lockedRequestText,
  pushSource,
  requestButtons,
  requestEnds,
  requestSheet,
  requestTitle,
} from '../../../src/screens/env/view';
import { aJoin, aRequest } from './fixtures';

const problem = { id: 'p', kind: 'file' as const, severity: 'error' as const, title: "A line isn't signed by a member", text: 'Line 14 (DATABASE_URL)…', hint: 'Revert that commit.' };

describe('request answers', () => {
  it('offers Allow for 15 minutes first for run and pull, then Allow once and Deny', () => {
    for (const kind of ['run', 'pull'] as const) {
      assert.deepEqual(requestButtons({ kind, problem: null }), [
        { answer: 'grant', label: 'Allow for 15 minutes', primary: true },
        { answer: 'once', label: 'Allow once', primary: false },
        { answer: 'deny', label: 'Deny', primary: false },
      ]);
    }
  });

  it('offers Deny and one approval for push, create and join-keys, never a 15-minute grant', () => {
    assert.deepEqual(
      requestButtons({ kind: 'push', problem: null }).map((b) => [b.answer, b.label]),
      [
        ['deny', 'Deny'],
        ['approve', 'Sign change'],
      ],
    );
    assert.equal(requestButtons({ kind: 'create', problem: null })[1]?.label, 'Create set');
    assert.equal(requestButtons({ kind: 'join-keys', problem: null })[1]?.label, 'Make keys');
  });

  it('offers only Deny when the file failed this device\'s check, and says why', () => {
    assert.deepEqual(requestButtons({ kind: 'run', problem }), [{ answer: 'deny', label: 'Deny', primary: false }]);
    const model = requestSheet(aRequest({ problem }));
    assert.deepEqual(model.warning, { title: problem.title, text: 'Line 14 (DATABASE_URL)… Revert that commit.', tone: 'danger' });
    assert.deepEqual(model.notes, ['Nothing in acme-api is released until the file is fixed.']);
    assert.equal(model.footnote, null);
  });
});

describe('request wording', () => {
  it('titles each kind by computer and set', () => {
    const titles = (['run', 'pull', 'push', 'create', 'join-keys'] as const).map((kind) => requestTitle({ kind, computerName: 'MacBook Pro', setName: 'acme-api' }));
    assert.deepEqual(titles, [
      "MacBook Pro wants acme-api's .env",
      "MacBook Pro wants to write acme-api's .env",
      'MacBook Pro wants to change acme-api',
      'MacBook Pro wants to create acme-api',
      'MacBook Pro wants this phone to join acme-api',
    ]);
  });

  it('counts down the time to answer', () => {
    assert.equal(requestEnds(52), "Ends in 0:52 if you don't answer");
    assert.equal(requestEnds(0), "Ends in 0:00 if you don't answer");
  });

  it('shows what a run gets and where it started, and what the grant covers', () => {
    const model = requestSheet(aRequest());
    assert.deepEqual(model.facts, [
      { label: 'Command', value: 'npm run dev' },
      { label: 'Folder', value: '~/code/acme-api' },
      { label: 'Started in', value: 'Terminal · zsh' },
      { label: 'Gets', value: '12 variables, into this process only' },
    ]);
    assert.deepEqual(model.notes, ['MacBook Pro reports the command. Allow only one you just started.']);
    assert.equal(model.footnote, '15 minutes covers acme-api on MacBook Pro. It ends early if the computer locks or sleeps, or AuthDeck Agent restarts.');
    assert.equal(requestSheet(aRequest({ startedIn: null })).facts.some((f) => f.label === 'Started in'), false);
  });

  it('warns when a pulled file isn\'t ignored by git, by its name', () => {
    const unignored = requestSheet(aRequest({ kind: 'pull', command: 'authdeck env pull', target: { path: '~/code/acme-api/.env.local', gitignored: false } }));
    assert.deepEqual(unignored.warning, {
      title: ".env.local isn't in .gitignore",
      text: 'A commit from this folder could publish the values. Add .env.local to .gitignore before you allow this.',
      tone: 'warn',
    });
    assert.equal(unignored.facts[0]?.value, '~/code/acme-api/.env.local');
    const ignored = requestSheet(aRequest({ kind: 'pull', target: { path: '~/code/acme-api/.env', gitignored: true } }));
    assert.equal(ignored.warning, null);
  });

  it('says a push is signed as yours and how teammates get it', () => {
    const model = requestSheet(aRequest({ kind: 'push', command: 'authdeck env push .env.local --prune' }));
    assert.equal(model.from, 'From authdeck env push .env.local --prune');
    assert.deepEqual(model.notes, ['This phone signs the change as yours. Teammates get it when MacBook Pro commits and pushes .authdeck/acme-api.env.']);
  });

  it('says first when the computer\'s file is older than this phone\'s copy', () => {
    const model = requestSheet(aRequest({ olderOnComputer: true }));
    assert.equal(model.notes[0], "MacBook Pro's file is older than this phone's copy. The values come from this phone's copy.");
  });

  it('asks to unlock while the vault is locked', () => {
    assert.deepEqual(lockedRequestText('your fingerprint, face or screen lock'), {
      title: 'Unlock to see the request',
      text: 'The vault is locked. Unlock with your fingerprint, face or screen lock to see the command and answer.',
    });
  });

  it('confirms each answer in a short line', () => {
    const run = { kind: 'run' as const, computerName: 'MacBook Pro', setName: 'acme-api' };
    assert.equal(answeredWords(run, 'grant'), 'Allowed acme-api on MacBook Pro for 15 minutes');
    assert.equal(answeredWords(run, 'once'), 'Allowed acme-api on MacBook Pro once');
    assert.equal(answeredWords(run, 'deny'), "Denied MacBook Pro's request");
    assert.equal(answeredWords({ ...run, kind: 'push' }, 'approve'), 'Signed the change to acme-api');
    assert.equal(answeredWords({ ...run, kind: 'create' }, 'approve'), 'Created acme-api');
  });

  it('lists a push\'s diff with marks, naming the file a pruned name was missing from', () => {
    assert.deepEqual(changeLine({ name: 'FEATURE_FLAGS_URL', change: 'add', loadsCode: false }), { mark: '+', name: 'FEATURE_FLAGS_URL', words: 'Added' });
    assert.deepEqual(changeLine({ name: 'STRIPE_WEBHOOK_SECRET', change: 'change', loadsCode: false }), { mark: '~', name: 'STRIPE_WEBHOOK_SECRET', words: 'New value' });
    assert.equal(changeLine({ name: 'LEGACY_API_KEY', change: 'remove', loadsCode: false }, '.env.local').words, 'Removed, not in .env.local');
    assert.equal(pushSource('authdeck env push .env.local --prune'), '.env.local');
    assert.equal(pushSource('authdeck env push --prune'), null);
  });
});

describe('ended requests', () => {
  const request = { computerName: 'MacBook Pro' };

  it('says which device answered, or that time ran out, or that the command stopped', () => {
    assert.equal(endedWords({ reason: 'answered', by: "Maya's iPad" }, request).title, "Answered on Maya's iPad");
    assert.equal(endedWords({ reason: 'answered', by: null }, request).title, 'Answered on another device');
    assert.deepEqual(endedWords({ reason: 'expired', by: null }, request), {
      title: 'Ran out',
      text: 'Nobody answered in time, so MacBook Pro got nothing. Run the command again to ask again.',
    });
    assert.deepEqual(endedWords({ reason: 'cancelled', by: null }, request), {
      title: 'Stopped on the computer',
      text: 'The command on MacBook Pro stopped before anyone answered.',
    });
  });

  it('calls it run out when this phone\'s clock ends it before the engine says why', () => {
    assert.equal(endedWords(null, request).title, 'Ran out');
  });
});

describe('join requests', () => {
  it('asks the owner to compare a teammate\'s name and six words', () => {
    const model = joinSheet(aJoin(), 'MacBook Pro', '.authdeck/acme-api.env');
    assert.equal(model.title, 'Chen Wei asks to join');
    assert.equal(model.subtitle, 'acme-api · from commit 9b07d13');
    assert.equal(model.compare, 'Ask Chen Wei to read the six words on their phone and pick each one as you hear it. Approve only if the name and all six words match.');
    assert.equal(model.effect, "Approving signs a new member list and wraps the key for Chen Wei's phone. Commit .authdeck/acme-api.env on MacBook Pro to send it.");
    assert.deepEqual([model.declineLabel, model.approveLabel], ['Decline', 'Approve']);
  });

  it('has an own device answered first, then approved once the codes match', () => {
    const waiting = joinSheet(aJoin({ via: 'own-device', label: 'Maya Rao · iPad mini', keyWords: null, commit: null }), null, null);
    assert.equal(waiting.approveLabel, 'Answer');
    assert.match(waiting.compare, /^Answer to show a 6-digit code/);
    const compare = joinSheet(aJoin({ via: 'own-device', label: 'Maya Rao · iPad mini', code: '304917' }), null, null);
    assert.equal(compare.approveLabel, 'Approve');
    assert.equal(compare.compare, 'Check that Maya Rao · iPad mini shows this same code before you approve.');
  });

  it('shows a waiting request at the top of the section', () => {
    assert.deepEqual(joinBanner(aJoin()), { title: 'Chen Wei asks to join', text: 'acme-api, from commit 9b07d13. Compare key words before you approve.' });
  });
});
