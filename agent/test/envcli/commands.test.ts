/**
 * Each command end to end in this process: a temp git repo, the fake core, and a fake agent on a
 * temp socket. Run's child, signals and Ctrl-C are in process.test.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { EnvCreateParams, EnvJoinParams, EnvListParams, EnvPushParams, EnvReleaseParams } from '../../src/envSocketContract';
import { ENV_GITATTRIBUTES_LINE, ENV_MERGE_DRIVER_COMMAND } from '../../src/envcore/types';
import { FakeAgent, release, RELEASED_VALUES as VALUES } from './helpers/fakeAgent';
import { FAKE_KEY_WORDS, fakeCore, fakeSeal } from './helpers/fakeCore';
import { runInProcess } from './helpers/inProcess';
import { makeFolder, makeRepo, type TestRepo } from './helpers/repo';

const MINUTE = 60_000;

let agent: FakeAgent;
let repo: TestRepo;

beforeEach(async () => {
  agent = await FakeAgent.start();
  repo = makeRepo({ remote: 'https://maya:secret@github.com/acme/acme-api.git' });
});
afterEach(async () => {
  await agent.stop();
  repo.remove();
});

const env = (argv: string[], options: { answers?: boolean[]; cwd?: string } = {}) => runInProcess(['env', ...argv], { cwd: options.cwd ?? repo.root, socketPath: agent.socketPath, answers: options.answers });


describe('authdeck env pull', () => {
  it('asks with the target and the git-ignore state, then writes .env with mode 0600', async () => {
    repo.addSet('acme-api');
    repo.write('.gitignore', '.env\n');
    agent.answer = release('once', { progress: ['Pixel 8'] });
    const outcome = await env(['pull']);
    assert.equal(outcome.code, 0, outcome.stderr);
    const params = agent.lastParams<EnvReleaseParams>();
    assert.equal(params.kind, 'pull');
    assert.deepEqual(params.target, { path: path.join(repo.root, '.env'), gitignored: true });
    assert.equal(params.file, repo.read('.authdeck/acme-api.env'));
    assert.equal(params.command, null);
    assert.equal(params.startedIn, 'Terminal · zsh');
    assert.equal(params.invocation, 'authdeck env pull');
    assert.deepEqual(params.project, { repoRoot: repo.root, remote: 'https://maya:secret@github.com/acme/acme-api.git', path: path.join(repo.root, '.authdeck/acme-api.env') });
    assert.equal(fs.statSync(path.join(repo.root, '.env')).mode & 0o777, 0o600);
    assert.match(repo.read('.env'), /^# Written by authdeck env pull from acme-api/);
    assert.match(repo.read('.env'), /DATABASE_URL=postgres:\/\/u:p@db\/app\nPEM='-----BEGIN-----\nabc\n-----END-----'\n$/);
    assert.equal(outcome.stderr, '');
    assert.equal(
      outcome.stdout,
      'acme-api: 12 variables, signatures check out (rev 7, epoch 3)\nAsking Pixel 8 to release them…\n✔ Allowed once. Wrote .env (2 variables, mode 0600).\n',
    );
  });

  it('warns when git does not ignore the file, and tells the agent', async () => {
    repo.addSet('acme-api');
    agent.answer = release('new-grant');
    const outcome = await env(['pull']);
    assert.equal(outcome.code, 0);
    assert.equal(outcome.stderr, '! .env is not in .gitignore here. A commit could publish the values.\n');
    assert.equal(agent.lastParams<EnvReleaseParams>().target?.gitignored, false);
    assert.match(outcome.stdout, /✔ Pixel 8 allowed acme-api for 15 minutes \(until 11:58\)\. Wrote \.env/);
  });

  it('writes variables that change how programs start, warning about each', async () => {
    repo.addSet('acme-api');
    repo.write('.gitignore', '.env\n');
    agent.answer = release('once', { values: [{ name: 'A', value: '1' }, { name: 'LD_PRELOAD', value: '/tmp/x.so' }] });
    const outcome = await env(['pull']);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.match(repo.read('.env'), /LD_PRELOAD=\/tmp\/x\.so/);
    assert.equal(outcome.stderr, '! .env sets LD_PRELOAD: it changes how programs start. Check its value before a program loads .env.\n');
  });

  it("skips a value with a ' together with $, ` or \\, saying so, and still exits 0", async () => {
    repo.addSet('acme-api');
    repo.write('.gitignore', '.env\n');
    agent.answer = release('once', { values: [{ name: 'A', value: '1' }, { name: 'GREETING', value: "it's $(touch x)" }, { name: 'QUOTE', value: "it's" }] });
    const outcome = await env(['pull']);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.match(repo.read('.env'), /\nA=1\nQUOTE="it's"\n$/);
    assert.doesNotMatch(repo.read('.env'), /GREETING/);
    assert.match(outcome.stdout, /Wrote \.env \(2 variables, skipped GREETING, mode 0600\)\.\n$/);
    assert.equal(outcome.stderr, "Skipped GREETING: its value can't be written to a .env safely (it has a ' together with $, ` or \\). Use authdeck env run to pass it.\n");
  });

  it('refuses a target whose folder is a link out of the repo, before asking anyone', async () => {
    repo.addSet('acme-api');
    const elsewhere = makeFolder();
    fs.symlinkSync(elsewhere, path.join(repo.root, 'out'));
    try {
      const outcome = await env(['pull', '--file', 'out/.env']);
      assert.equal(outcome.code, 64);
      assert.match(outcome.stderr, new RegExp(`^✗ out/\\.env is outside this repo \\(its folder is ${elsewhere.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\. Pull writes only inside the repo\\.\n`));
      assert.equal(agent.requests.length, 0);
      assert.deepEqual(fs.readdirSync(elsewhere), []);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a file without --force, before asking anyone', async () => {
    repo.addSet('acme-api');
    repo.write('.env', 'OLD=1\n');
    const outcome = await env(['pull']);
    assert.equal(outcome.code, 73);
    assert.equal(outcome.stderr, '✗ .env already exists.\n  Add --force to replace it, or name another file with --file.\n');
    assert.doesNotMatch(outcome.stderr, /^Usage$/m, 'help is for bad arguments only');
    assert.equal(agent.requests.length, 0);
    assert.equal(repo.read('.env'), 'OLD=1\n');
  });

  it('replaces the file with --force, still mode 0600', async () => {
    repo.addSet('acme-api');
    repo.write('.env.dev', 'OLD=1\n');
    fs.chmodSync(path.join(repo.root, '.env.dev'), 0o644);
    agent.answer = release('grant');
    const outcome = await env(['pull', '.env.dev', '--force']);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.doesNotMatch(repo.read('.env.dev'), /OLD/);
    assert.equal(fs.statSync(path.join(repo.root, '.env.dev')).mode & 0o777, 0o600);
    assert.match(outcome.stdout, /✔ acme-api allowed until 11:58 by Pixel 8\. Wrote \.env\.dev/);
    assert.deepEqual(fs.readdirSync(repo.root).filter((f) => f.endsWith('.tmp')), []);
  });

  it('says so when the values came from a newer copy than this folder has', async () => {
    repo.addSet('acme-api');
    agent.answer = release('once', { sourceHash: 'newer' });
    const outcome = await env(['pull']);
    assert.match(outcome.stdout, /Pixel 8 used its newer copy of acme-api \(rev 7\)\. Run git pull/);
  });

  it('writes nothing when the values were sealed to another key', async () => {
    repo.addSet('acme-api');
    agent.answer = (c) => {
      const params = c.request.params as EnvReleaseParams;
      c.send({ ok: true, result: { requestId: 'r1', values: fakeSeal(VALUES, 'someone-else', { set: 's_acme-api', request: 'r1' }), by: 'Pixel 8', via: 'once', grantEndsAt: null, source: { rev: 7, fileHash: fakeCore.fileHash(params.file) } } });
    };
    const outcome = await env(['pull']);
    assert.equal(outcome.code, 70);
    assert.match(outcome.stderr, /don't open with this command's one-time key/);
    assert.equal(repo.exists('.env'), false);
  });
});

describe('authdeck env push', () => {
  it('sends every variable in the file, and prints the diff after the phone signs', async () => {
    repo.addSet('acme-api');
    repo.write('.env.local', '# local\nexport FEATURE_FLAGS_URL=https://flags\nSTRIPE_WEBHOOK_SECRET="whsec_1"\n');
    agent.answer = (c) => {
      c.send({ progress: { stage: 'asking', devices: ['Pixel 8'], expiresAt: Date.now() + MINUTE } });
      c.send({ ok: true, result: { by: 'Pixel 8', fileHash: 'h', added: ['FEATURE_FLAGS_URL'], changed: ['STRIPE_WEBHOOK_SECRET'], removed: ['LEGACY_API_KEY'] } });
    };
    const outcome = await env(['push', '.env.local', '--prune']);
    assert.equal(outcome.code, 0, outcome.stderr);
    const params = agent.lastParams<EnvPushParams>();
    assert.equal(agent.requests[0]!.method, 'push');
    assert.deepEqual(params.values, [
      { name: 'FEATURE_FLAGS_URL', value: 'https://flags' },
      { name: 'STRIPE_WEBHOOK_SECRET', value: 'whsec_1' },
    ]);
    assert.equal(params.prune, true);
    assert.equal(params.source, '.env.local');
    assert.equal(params.invocation, 'authdeck env push .env.local --prune');
    assert.equal(
      outcome.stdout,
      [
        'Asking Pixel 8 to sign the change…',
        '✔ Signed by Pixel 8. Wrote .authdeck/acme-api.env.',
        'acme-api: + FEATURE_FLAGS_URL      added',
        '          ~ STRIPE_WEBHOOK_SECRET  changed',
        '          − LEGACY_API_KEY         removed',
        'Next: git commit -am "acme-api: add FEATURE_FLAGS_URL, change STRIPE_WEBHOOK_SECRET, remove LEGACY_API_KEY" && git push',
        '',
      ].join('\n'),
    );
  });

  it('says when nothing changed', async () => {
    repo.addSet('acme-api');
    repo.write('.env', 'A=1\n');
    agent.answer = (c) => c.send({ ok: true, result: { by: 'Pixel 8', fileHash: 'h', added: [], changed: [], removed: [] } });
    const outcome = await env(['push']);
    assert.equal(outcome.code, 0);
    assert.equal(agent.lastParams<EnvPushParams>().prune, false);
    assert.equal(outcome.stdout, '✔ Nothing to change: .env matches acme-api.\n');
  });

  it('refuses a missing file (66), a bad name (65), an unreadable line (65) and too many names (65) before asking', async () => {
    repo.addSet('acme-api');
    const missing = await env(['push', '.env.nope']);
    assert.equal(missing.code, 66);
    assert.match(missing.stderr, /✗ \.env\.nope doesn't exist\.\n  Name the file to read/);

    repo.write('.env', 'GOOD=1\nBAD-NAME=2\n');
    const badName = await env(['push']);
    assert.equal(badName.code, 65);
    assert.match(badName.stderr, /✗ \.env line 2: BAD-NAME can't be a variable name\./);

    repo.write('.env', 'A=1\nB="open\nsk_live_secret\n');
    const quote = await env(['push']);
    assert.equal(quote.code, 65);
    assert.match(quote.stderr, /✗ \.env line 2: a quote is opened and never closed\./);
    assert.doesNotMatch(quote.stderr, /sk_live_secret/);

    repo.write('.env', "A='x' sk_live_secret\n");
    const after = await env(['push']);
    assert.equal(after.code, 65);
    assert.match(after.stderr, /✗ \.env line 1: there is text after the closing quote\./);
    assert.doesNotMatch(after.stderr, /sk_live_secret/);

    repo.write('.env', Array.from({ length: 501 }, (_, i) => `V${i}=x`).join('\n'));
    const tooMany = await env(['push']);
    assert.equal(tooMany.code, 65);
    assert.match(tooMany.stderr, /\.env has more than 500 variables/);

    repo.write('.env', `BIG=${'x'.repeat(33 * 1024)}\n`);
    const tooBig = await env(['push']);
    assert.equal(tooBig.code, 65);
    assert.match(tooBig.stderr, /BIG in \.env is larger than 32 KB/);
    assert.equal(agent.requests.length, 0);
  });
});

describe('authdeck env init', () => {
  it('creates a set named after the repo, importing --from, and sets up the merge rule', async () => {
    repo.write('.env', 'A=1\nB=2\n');
    agent.answer = (c) => {
      c.send({ progress: { stage: 'asking', devices: ['Pixel 8'], expiresAt: Date.now() + MINUTE } });
      c.send({ ok: true, result: { setId: 's1', by: 'Pixel 8', fileHash: 'h', variables: 2, recovery: true } });
    };
    const outcome = await env(['init', '--from', '.env'], { answers: [true] });
    assert.equal(outcome.code, 0, outcome.stderr);
    const params = agent.lastParams<EnvCreateParams>();
    assert.equal(agent.requests[0]!.method, 'create');
    assert.equal(params.setName, 'acme-api');
    assert.equal(params.project.path, path.join(repo.root, '.authdeck/acme-api.env'));
    assert.equal(params.source, '.env');
    assert.deepEqual(params.values, [
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ]);
    assert.equal(
      outcome.stdout,
      [
        'Project  acme/acme-api (https://github.com/acme/acme-api.git)',
        'Set      acme-api → .authdeck/acme-api.env',
        'Import   2 names from .env',
        'Waiting for Pixel 8 to create the set…',
        '✔ Pixel 8 created acme-api: owner Pixel 8, 2 variables,',
        '  encrypted for 1 device and your recovery phrase.',
        'Wrote .authdeck/acme-api.env and a merge rule in .gitattributes.',
        'Deleted .env.',
        'Next: git add .authdeck .gitattributes',
        '      git commit -m "Add acme-api env set"',
        '',
      ].join('\n'),
    );
    assert.deepEqual(outcome.questions, ['.env still holds the plain values. Delete it? [y/N] ']);
    assert.equal(repo.exists('.env'), false);
    assert.equal(repo.read('.gitattributes'), `${ENV_GITATTRIBUTES_LINE}\n`);
    assert.equal(repo.git('config', '--local', 'merge.authdeck-env.driver').trim(), ENV_MERGE_DRIVER_COMMAND);
    assert.equal(repo.git('config', '--local', 'merge.authdeck-env.name').trim(), 'AuthDeck env set');
  });

  it('keeps .env when the answer is no, and leaves an existing merge rule alone', async () => {
    repo.write('.env', 'A=1\n');
    repo.write('.gitattributes', `*.png binary\n${ENV_GITATTRIBUTES_LINE}\n`);
    agent.answer = (c) => c.send({ ok: true, result: { setId: 's1', by: 'Pixel 8', fileHash: 'h', variables: 1, recovery: false } });
    const outcome = await env(['init', '--from', '.env', '--set', 'web']);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(agent.lastParams<EnvCreateParams>().setName, 'web');
    assert.match(outcome.stdout, /encrypted for 1 device\.\n/);
    assert.match(outcome.stdout, /Wrote \.authdeck\/web\.env\. \.gitattributes already has the merge rule\./);
    assert.match(outcome.stdout, /Next: git add \.authdeck\n/);
    assert.equal(repo.exists('.env'), true);
    assert.equal(repo.read('.gitattributes'), `*.png binary\n${ENV_GITATTRIBUTES_LINE}\n`);
  });

  it('makes an empty set without --from', async () => {
    agent.answer = (c) => c.send({ ok: true, result: { setId: 's1', by: 'Pixel 8', fileHash: 'h', variables: 0, recovery: false } });
    const outcome = await env(['init']);
    assert.equal(outcome.code, 0);
    assert.equal(agent.lastParams<EnvCreateParams>().source, null);
    assert.deepEqual(agent.lastParams<EnvCreateParams>().values, []);
    assert.match(outcome.stdout, /Import   nothing; the set starts empty/);
    assert.deepEqual(outcome.questions, []);
  });

  it('asks to join a set that is here when none of your devices is in it', async () => {
    repo.addSet('acme-api');
    agent.answer = (c) => {
      if (c.request.method === 'ls') {
        const params = c.request.params as EnvListParams;
        return c.send({ ok: true, result: { sets: [{ name: 'acme-api', setId: 's', path: params.files[0]!.path, variables: 12, members: 4, yourRole: null, grantEndsAt: null, problem: null }], joinRequests: [] } });
      }
      c.send({ progress: { stage: 'asking', devices: ['iPhone 16'], expiresAt: Date.now() + MINUTE } });
      c.send({
        ok: true,
        result: {
          by: 'iPhone 16',
          requestPath: '.authdeck/requests/d_Cw8EiT.json',
          request: { format: 1, set: 's', member: 'd_Cw8EiT', label: 'Chen Wei · iPhone 16', form: 'phone', ed: 'AA', x: 'AA', time: 1, sig: 's' },
        },
      });
    };
    const outcome = await env(['init'], { answers: [true] });
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(agent.requests.map((r) => r.method), ['ls', 'join']);
    assert.equal(agent.lastParams<EnvJoinParams>().file, repo.read('.authdeck/acme-api.env'));
    assert.deepEqual(outcome.questions, ['Ask to join it from your phone? [Y/n] ']);
    assert.equal(
      outcome.stdout,
      [
        'acme-api already lives here (owner: Maya Rao · Pixel 8).',
        'Waiting for iPhone 16 to make its keys…',
        '✔ Wrote .authdeck/requests/d_Cw8EiT.json',
        `Your key words:  ${FAKE_KEY_WORDS.join(' ')}`,
        'Commit and push it, or open a pull request. Then read the six',
        'words to Maya Rao; they approve on their phone.',
        '',
      ].join('\n'),
    );
    assert.equal(repo.git('config', '--local', 'merge.authdeck-env.driver').trim(), ENV_MERGE_DRIVER_COMMAND);
  });

  it('asks nothing when the person says no', async () => {
    repo.addSet('acme-api');
    agent.answer = (c) => c.send({ ok: true, result: { sets: [], joinRequests: [] } });
    const outcome = await env(['init'], { answers: [false] });
    assert.equal(outcome.code, 0);
    assert.deepEqual(agent.requests.map((r) => r.method), ['ls']);
    assert.match(outcome.stdout, /Nothing was asked\./);
  });

  it('only sets up the merge rule for someone already in the set', async () => {
    repo.addSet('acme-api');
    agent.answer = (c) => {
      const params = c.request.params as EnvListParams;
      c.send({ ok: true, result: { sets: [{ name: 'acme-api', setId: 's', path: params.files[0]!.path, variables: 12, members: 4, yourRole: 'member', grantEndsAt: null, problem: null }], joinRequests: [] } });
    };
    const outcome = await env(['init']);
    assert.equal(outcome.code, 0);
    assert.equal(outcome.stdout, "✔ You're already in acme-api (member). The merge rule is set up for this clone.\n");
    assert.equal(repo.read('.gitattributes'), `${ENV_GITATTRIBUTES_LINE}\n`);
  });

  it('refuses --from for a set that already exists, and several sets without --set', async () => {
    repo.addSet('acme-api');
    const from = await env(['init', '--from', '.env']);
    assert.equal(from.code, 64);
    assert.match(from.stderr, /acme-api already lives here\. To add the values in \.env, run authdeck env push \.env\./);
    repo.addSet('acme-api-prod');
    const several = await env(['init']);
    assert.equal(several.code, 64);
    assert.match(several.stderr, /has 2 sets: acme-api, acme-api-prod\.\n  Name one with --set/);
    assert.equal(agent.requests.length, 0);
  });
});

describe('authdeck env ls', () => {
  it('sends every set file here and prints the table', async () => {
    repo.addSet('acme-api');
    repo.addSet('acme-api-prod');
    agent.answer = (c) =>
      c.send({
        ok: true,
        result: {
          sets: [{ name: 'acme-api', setId: 's', path: 'p', variables: 12, members: 4, yourRole: 'owner', grantEndsAt: null, problem: null }],
          joinRequests: [],
        },
      });
    const outcome = await env(['ls']);
    assert.equal(outcome.code, 0, outcome.stderr);
    const params = agent.lastParams<EnvListParams>();
    assert.equal(params.repoRoot, repo.root);
    assert.deepEqual(params.files, [
      { path: path.join(repo.root, '.authdeck/acme-api.env'), file: repo.read('.authdeck/acme-api.env') },
      { path: path.join(repo.root, '.authdeck/acme-api-prod.env'), file: repo.read('.authdeck/acme-api-prod.env') },
    ]);
    assert.equal(outcome.stdout, 'SET       VARS  MEMBERS  YOU    ON THIS COMPUTER\nacme-api    12        4  owner  asks each time\n');
  });

  it('says there is no set without asking the agent', async () => {
    const outcome = await env(['ls']);
    assert.equal(outcome.code, 0);
    assert.match(outcome.stdout, /There is no env set in .*\. Run authdeck env init to make one\./);
    assert.equal(agent.requests.length, 0);
  });
});

describe('authdeck env merge (git merge driver)', () => {
  it('writes the merged file over %A and exits 0', async () => {
    const dir = makeFolder();
    const [o, a, b] = ['o', 'a', 'b'].map((n) => path.join(dir, n)) as [string, string, string];
    fs.writeFileSync(o, '');
    fs.writeFileSync(a, 'ours\n');
    fs.writeFileSync(b, 'theirs\n');
    const outcome = await env(['merge', o, a, b], { cwd: dir });
    assert.equal(outcome.code, 0);
    assert.equal(fs.readFileSync(a, 'utf8'), 'merged base=none\nours\ntheirs\n');
  });

  it('leaves %A alone and exits 1 for two headers or a refused side', async () => {
    const dir = makeFolder();
    const [o, a, b] = ['o', 'a', 'b'].map((n) => path.join(dir, n)) as [string, string, string];
    fs.writeFileSync(o, 'base\n');
    fs.writeFileSync(a, 'TWO-HEADERS\n');
    fs.writeFileSync(b, 'theirs\n');
    const two = await env(['merge', o, a, b], { cwd: dir });
    assert.equal(two.code, 1);
    assert.match(two.stderr, /both sides changed the member list at rev 8/);
    assert.equal(fs.readFileSync(a, 'utf8'), 'TWO-HEADERS\n');

    fs.writeFileSync(a, 'ours\n');
    fs.writeFileSync(b, 'UNSIGNED\n');
    const refused = await env(['merge', o, a, b], { cwd: dir });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /isn't signed by a member/);
    assert.equal(fs.readFileSync(a, 'utf8'), 'ours\n');
  });
});

describe('finding the set', () => {
  it('fails outside a git repo with no-repo (66)', async () => {
    const outcome = await env(['run', '--', 'true'], { cwd: makeFolder() });
    assert.equal(outcome.code, 66);
    assert.match(outcome.stderr, /isn't inside a git repository\.\n  Env sets live in the project's repo/);
  });

  it('fails with no-set (66), several-sets (64) and unknown-set (64)', async () => {
    const none = await env(['pull']);
    assert.equal(none.code, 66);
    assert.match(none.stderr, /There is no env set in .*\.\n  Run authdeck env init/);
    repo.addSet('a');
    repo.addSet('b');
    const several = await env(['pull']);
    assert.equal(several.code, 64);
    assert.match(several.stderr, /has 2 sets: a, b\./);
    const unknown = await env(['pull', '--set', 'c']);
    assert.equal(unknown.code, 64);
    assert.match(unknown.stderr, /There is no set named c here\.\n  Sets here: a, b\./);
  });

  it('refuses a set file the core refuses (65), naming the commit that brought the line in', async () => {
    repo.addSet('acme-api', { problem: { kind: 'unsigned-line', line: 1, name: 'DATABASE_URL' } });
    repo.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    repo.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'tamper');
    const commit = repo.git('rev-parse', '--short=7', 'HEAD').trim();
    const outcome = await env(['run', '--', 'true']);
    assert.equal(outcome.code, 65);
    assert.equal(
      outcome.stderr,
      `✗ .authdeck/acme-api.env line 1 (DATABASE_URL) isn't signed by a member of acme-api. It came in with commit ${commit}. Nothing was released.\n  Revert that commit, or set DATABASE_URL again from a member's phone.\n`,
    );
    assert.equal(agent.requests.length, 0);
  });

  it('refuses a set file over the size cap without reading it into the core', async () => {
    repo.write('.authdeck/acme-api.env', 'x'.repeat(385 * 1024));
    const outcome = await env(['pull']);
    assert.equal(outcome.code, 65);
    assert.match(outcome.stderr, /\.authdeck\/acme-api\.env is larger than 384 KB\./);
  });

  it('works from a subfolder of the repo', async () => {
    repo.addSet('acme-api');
    fs.mkdirSync(path.join(repo.root, 'src'));
    agent.answer = release('once');
    const outcome = await env(['pull'], { cwd: path.join(repo.root, 'src') });
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(repo.exists('src/.env'), true);
    assert.equal(agent.lastParams<EnvReleaseParams>().cwd, path.join(repo.root, 'src'));
  });
});

