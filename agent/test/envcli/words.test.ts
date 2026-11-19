/** The command's formatting: the ls table, the push diff, clocks and names from the repo. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { commitMessage, diffLines } from '../../src/envcli/commands/push';
import { lsTable } from '../../src/envcli/commands/ls';
import { setNameFrom } from '../../src/envcli/commands/init';
import { WAITING, WaitingLine } from '../../src/envcli/waiting';
import { commandLine, elapsed, listWords, printable, remoteWithoutCredentials, repoSlug, startedIn } from '../../src/envcli/words';

const at = (hours: number, minutes: number) => new Date(2026, 10, 18, hours, minutes).getTime();

describe('ls table', () => {
  it('prints the design rows: counts aligned right, role, and the grant', () => {
    const table = lsTable(
      {
        sets: [
          { name: 'acme-api', setId: 's1', path: '/r/.authdeck/acme-api.env', variables: 12, members: 4, yourRole: 'owner', grantEndsAt: at(11, 58), problem: null },
          { name: 'acme-api-prod', setId: 's2', path: '/r/.authdeck/acme-api-prod.env', variables: 6, members: 2, yourRole: 'owner', grantEndsAt: null, problem: null },
        ],
        joinRequests: [{ setName: 'acme-api', label: 'Chen Wei · iPhone 16' }],
      },
      '/r',
    );
    assert.equal(
      table,
      [
        'SET            VARS  MEMBERS  YOU    ON THIS COMPUTER',
        'acme-api         12        4  owner  allowed until 11:58',
        'acme-api-prod     6        2  owner  asks each time',
        '1 join request waiting: Chen Wei (iPhone 16) for acme-api',
        '',
      ].join('\n'),
    );
  });

  it('shows sets you are not in, and refused files by their title', () => {
    const table = lsTable(
      {
        sets: [
          { name: 'ledger', setId: null, path: '/r/.authdeck/ledger.env', variables: 0, members: 0, yourRole: null, grantEndsAt: null, problem: { kind: 'header-unsigned' } },
          { name: 'web', setId: 's', path: '/r/.authdeck/web.env', variables: 3, members: 2, yourRole: null, grantEndsAt: null, problem: null },
        ],
        joinRequests: [],
      },
      '/r',
    );
    assert.match(table, /ledger +0 +0 +- +refused: The member list isn't signed/);
    assert.match(table, /web +3 +2 +- +not a member/);
  });
});

describe('push diff', () => {
  const result = { added: ['FEATURE_FLAGS_URL'], changed: ['STRIPE_WEBHOOK_SECRET'], removed: ['LEGACY_API_KEY'] };

  it('lines up the names the way the design does', () => {
    assert.equal(
      diffLines('acme-api', result),
      'acme-api: + FEATURE_FLAGS_URL      added\n          ~ STRIPE_WEBHOOK_SECRET  changed\n          − LEGACY_API_KEY         removed\n',
    );
  });

  it('suggests a commit message naming at most three changes', () => {
    assert.equal(commitMessage('acme-api', { added: ['FEATURE_FLAGS_URL'], changed: [], removed: [] }), 'acme-api: add FEATURE_FLAGS_URL');
    assert.equal(commitMessage('a', { added: ['A', 'B'], changed: ['C'], removed: ['D', 'E'] }), 'a: add A, add B, change C and 2 more');
  });
});

describe('words', () => {
  it('formats waiting time and device lists', () => {
    assert.equal(elapsed(12_400), '0:12');
    assert.equal(elapsed(60_000), '1:00');
    assert.equal(listWords(['Pixel 8', 'iPad mini', 'Pixel 9']), 'Pixel 8, iPad mini or Pixel 9');
  });

  it('strips control characters from names the repo or agent supplies', () => {
    assert.equal(printable('Pixel\u001b[2J 8‮'), 'Pixel [2J 8');
  });

  it('names the terminal and shell for the phone', () => {
    assert.equal(startedIn({ TERM_PROGRAM: 'Apple_Terminal', SHELL: '/bin/zsh' }), 'Terminal · zsh');
    assert.equal(startedIn({ SHELL: '/usr/bin/fish' }), 'fish');
    assert.equal(startedIn({}), null);
  });

  it('quotes a command line as a shell would need it', () => {
    assert.equal(commandLine(['npm', 'run', 'seed:prod']), 'npm run seed:prod');
    assert.equal(commandLine(['sh', '-c', "echo 'hi' $X"]), `sh -c 'echo '\\''hi'\\'' $X'`);
  });

  it('reads remotes without their credentials', () => {
    assert.equal(remoteWithoutCredentials('https://user:token@github.com/acme/api.git'), 'https://github.com/acme/api.git');
    assert.equal(repoSlug('git@github.com:acme/api.git'), 'acme/api');
    assert.equal(repoSlug('https://user:token@gitlab.com/acme/api'), 'acme/api');
  });

  it('makes a set name from a repo name', () => {
    assert.equal(setNameFrom('Acme API'), 'acme-api');
    assert.equal(setNameFrom('__web.app__'), 'web.app__');
    assert.equal(setNameFrom('---'), null);
  });
});

describe('waiting line', () => {
  const progress = (devices: string[]) => ({ stage: 'asking' as const, devices, expiresAt: 0 });

  it('counts up in place on a terminal and leaves the last count', () => {
    let text = '';
    let now = 1000;
    const line = new WaitingLine({ write: (t: string) => (text += t), isTTY: true }, WAITING.release, 1000, () => now);
    line.update(progress(['Pixel 8']));
    now = 13_000;
    line.stop();
    assert.equal(text, '\r\x1b[2KAsking Pixel 8 to release them… waiting 0:00\r\x1b[2KAsking Pixel 8 to release them… waiting 0:12\n');
  });

  it('writes one line per change of devices elsewhere, without a clock', () => {
    let text = '';
    const line = new WaitingLine({ write: (t: string) => (text += t) }, WAITING.create, 0, () => 0);
    line.update(progress([]));
    line.update(progress([]));
    line.update(progress(['Pixel 8', 'iPad mini']));
    line.stop();
    assert.equal(text, 'Waiting for your phone or tablet to create the set…\nWaiting for Pixel 8 or iPad mini to create the set…\n');
  });
});
