/**
 * Changes and checks: push, create and join over the socket; ls; the agent's own check of the
 * file the command read (rollback and tampering refused, exit 65); the device's file reads and
 * writes with their conflict check; and git history.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { HISTORY_PAGE } from '../../src/env/deviceMethods';
import { registryPath } from '../../src/env/envAgent';
import { fileHistory } from '../../src/env/git';
import {
  addEnvMember,
  changeEnvValues,
  createEnvJoinRequest,
  envFileHash,
  openEnvDataKey,
  planEnvPush,
  writeEnvFile,
  writeEnvJoinRequest,
} from '../../src/envcore';
import { ENV_EXIT_FOR } from '../../src/envSocketContract';
import { generateDeviceKeys } from '../../src/vault/crypto';
import type { LinkedDevice } from '../helpers/link';
import {
  callSocket,
  git,
  makeRepo,
  makeSet,
  nthEvent,
  oneTimeKey,
  random,
  releaseParams,
  removeTemps,
  startEnvAgent,
  T0,
  tempDir,
  VALUES,
  type Repo,
  type TestAgent,
  type TestSet,
} from './harness';

after(removeTemps);

function pushParams(repo: Repo, text: string, values = [{ name: 'FEATURE_FLAGS_URL', value: 'https://flags' }]) {
  return { project: { repoRoot: repo.root, remote: 'git@github.com:acme/api.git', path: repo.setPath }, file: text, source: '.env.local', values, prune: false, invocation: 'authdeck env push .env.local' };
}

/** The owner phone signs a change, as it would for a push. */
function signedChange(set: TestSet, pushed: { name: string; value: string }[]) {
  const dataKey = openEnvDataKey(set.file.header, set.owner);
  const changes = planEnvPush(VALUES, pushed, false);
  const result = changeEnvValues({ file: set.file, author: set.owner, dataKey, changes, time: T0 + 1000, random });
  return { kind: 'signed', file: writeEnvFile(result.file), added: result.added, changed: result.changed, removed: result.removed };
}

/** rev 2 of the set: the owner added a member. */
function withMember(set: TestSet): string {
  const member = generateDeviceKeys(random);
  const dataKey = openEnvDataKey(set.file.header, set.owner);
  const file = addEnvMember({ file: set.file, owner: set.owner, dataKeys: { 1: dataKey }, time: T0 + 2000, member: { edPublic: member.edPublic, xPublic: member.xPublic, label: 'Ben Okafor · Pixel 9', form: 'phone' } });
  return writeEnvFile(file);
}

describe('env changes over the socket', () => {
  let agent: TestAgent;
  let set: TestSet;
  let repo: Repo;
  let pixel: LinkedDevice;

  beforeEach(async () => {
    agent = await startEnvAgent();
    set = makeSet();
    repo = makeRepo(set);
    pixel = await agent.phone('Pixel 8', [set.owner.deviceId]);
  });
  afterEach(() => agent.stop());

  it('writes a signed push and tells watching phones the set changed', async () => {
    const call = callSocket(agent.socketPath, 'push', pushParams(repo, set.text));
    const { request } = await nthEvent(pixel, 'env.request');
    assert.equal(request.kind, 'push');
    assert.equal(request.remote, 'github.com/acme/api');
    assert.deepEqual(request.values, [{ name: 'FEATURE_FLAGS_URL', value: 'https://flags' }]);
    const answer = signedChange(set, [...VALUES, { name: 'FEATURE_FLAGS_URL', value: 'https://flags' }]);
    assert.equal((await pixel.request('env.request.answer', { requestId: request.requestId, answer })).ok, true);
    const reply = await call.reply;
    assert.deepEqual(reply.result, { by: 'Pixel 8', fileHash: envFileHash(answer.file), added: ['FEATURE_FLAGS_URL'], changed: [], removed: [] });
    assert.equal(fs.readFileSync(repo.setPath, 'utf8'), answer.file);
    assert.deepEqual(await nthEvent(pixel, 'env.sets.changed', 1), { setId: set.setId });
    const row = agent.envEvents.filter((event) => event.type === 'env.activity').at(-1) as any;
    assert.equal(row.entry.title, 'Changed acme-api');
    assert.equal(row.entry.detail, '1 added');
    assert.equal(row.entry.outcome.text, 'Signed by Pixel 8');
  });

  it('refuses a push the file changed under while the phone answered (changed-meanwhile, exit 75; conflict to the phone)', async () => {
    const call = callSocket(agent.socketPath, 'push', pushParams(repo, set.text));
    const { request } = await nthEvent(pixel, 'env.request');
    fs.appendFileSync(repo.setPath, '# a git pull\n');
    const answer = signedChange(set, [...VALUES, { name: 'FEATURE_FLAGS_URL', value: 'https://flags' }]);
    const answered = await pixel.request('env.request.answer', { requestId: request.requestId, answer });
    assert.equal(answered.error?.code, 'conflict');
    const reply = await call.reply;
    assert.deepEqual(reply.error, { code: 'changed-meanwhile', file: '.authdeck/acme-api.env', by: 'Pixel 8' });
    assert.equal(ENV_EXIT_FOR['changed-meanwhile'], 75);
    assert.ok(fs.readFileSync(repo.setPath, 'utf8').endsWith('# a git pull\n'), 'the newer file stays');
  });

  it('refuses a signed answer that fails the checks and keeps waiting', async () => {
    const call = callSocket(agent.socketPath, 'push', pushParams(repo, set.text));
    const { request } = await nthEvent(pixel, 'env.request');
    const forged = signedChange(set, [...VALUES, { name: 'X', value: 'y' }]);
    forged.file = forged.file.replace(/^X=enc:(\d+):(.)/m, (_m, epoch, c) => `X=enc:${epoch}:${c === 'A' ? 'B' : 'A'}`);
    assert.equal((await pixel.request('env.request.answer', { requestId: request.requestId, answer: forged })).error?.code, 'bad_request');
    assert.equal(fs.readFileSync(repo.setPath, 'utf8'), set.text);
    call.close();
  });

  it('refuses values that break the rules before asking (bad-name, too-large)', async () => {
    const bad = await callSocket(agent.socketPath, 'push', pushParams(repo, set.text, [{ name: '9LIVES', value: 'x' }])).reply;
    assert.deepEqual(bad.error, { code: 'bad-name', path: '.env.local', line: 1, name: '9LIVES' });
    const large = await callSocket(agent.socketPath, 'push', pushParams(repo, set.text, [{ name: 'BIG', value: 'x'.repeat(33 * 1024) }])).reply;
    assert.equal(large.error?.code, 'failed', 'larger than the socket field cap');
    assert.equal(pixel.events.some((e) => e.event === 'env.request'), false);
  });

  it('creates a set on the answering device and learns the new working tree', async () => {
    const root = path.join(tempDir(), 'new');
    fs.mkdirSync(root);
    git(root, 'init', '-q');
    const setPath = path.join(root, '.authdeck', 'pebble.env');
    const call = callSocket(agent.socketPath, 'create', { project: { repoRoot: root, remote: null, path: setPath }, setName: 'pebble', source: '.env', values: VALUES, invocation: 'authdeck env init --from .env' });
    const { request } = await nthEvent(pixel, 'env.request');
    assert.equal(request.kind, 'create');
    assert.equal(request.setId, null);
    const made = makeSet('pebble');
    assert.equal((await pixel.request('env.request.answer', { requestId: request.requestId, answer: { kind: 'created', file: made.text } })).ok, true);
    const reply = await call.reply;
    assert.deepEqual(reply.result, { setId: made.setId, by: 'Pixel 8', fileHash: envFileHash(made.text), variables: 2, recovery: false });
    assert.equal(fs.readFileSync(setPath, 'utf8'), made.text);
    const listed = await pixel.request('env.sets.list', {});
    assert.ok(listed.result.sets.some((s: any) => s.setId === made.setId && s.path === setPath && s.uncommitted === true));
  });

  it('writes a teammate join request file from the device that made the keys', async () => {
    const call = callSocket(agent.socketPath, 'join', { project: { repoRoot: repo.root, remote: null, path: repo.setPath }, file: set.text, invocation: 'authdeck env init' });
    const { request } = await nthEvent(pixel, 'env.request');
    assert.equal(request.kind, 'join-keys');
    const chen = generateDeviceKeys(random);
    const joinRequest = createEnvJoinRequest({ set: set.setId, device: chen, label: 'Chen Wei · iPhone 16', form: 'phone', time: T0 });
    await pixel.request('env.request.answer', { requestId: request.requestId, answer: { kind: 'join-keys', request: joinRequest } });
    const reply = await call.reply;
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.result.requestPath, `.authdeck/requests/${chen.deviceId}.json`);
    assert.ok(fs.existsSync(path.join(repo.root, reply.result.requestPath)));

    const ls = await callSocket(agent.socketPath, 'ls', { repoRoot: repo.root, remote: null, files: [{ path: repo.setPath, file: set.text }] }).reply;
    assert.deepEqual(ls.result.joinRequests, [{ setName: 'acme-api', label: 'Chen Wei · iPhone 16' }]);
    const read = await pixel.request('env.file.read', { path: repo.setPath, setId: set.setId });
    assert.equal(read.result.requests.length, 1);
    assert.equal(read.result.requests[0].commit, null, 'not committed yet');

    // The owner approves: one write adds the member and removes the request file.
    const write = await pixel.request('env.file.write', { path: repo.setPath, setId: set.setId, baseHash: envFileHash(set.text), removeRequests: [reply.result.requestPath] });
    assert.equal(write.ok, true, JSON.stringify(write.error));
    assert.equal(fs.existsSync(path.join(repo.root, reply.result.requestPath)), false);
  });

  it('finds a real join request behind 100 junk request files that sort first and came later', async () => {
    const chen = generateDeviceKeys(random);
    const joinRequest = createEnvJoinRequest({ set: set.setId, device: chen, label: 'Chen Wei · iPhone 16', form: 'phone', time: T0 });
    const requests = path.join(repo.root, '.authdeck', 'requests');
    fs.mkdirSync(requests, { recursive: true });
    fs.writeFileSync(path.join(requests, `${chen.deviceId}.json`), writeEnvJoinRequest(joinRequest));
    git(repo.root, 'add', '.');
    git(repo.root, 'commit', '-q', '-m', 'Ask to join');
    for (let i = 0; i < 100; i++) {
      // '-' sorts before every character a member id can start with.
      const name = `${'-'.repeat(19)}${String(i).padStart(3, '0')}`;
      fs.writeFileSync(path.join(requests, `${name}.json`), JSON.stringify({ set: set.setId, member: name, junk: true }));
    }
    git(repo.root, 'add', '.');
    git(repo.root, 'commit', '-q', '-m', 'Junk');

    const ls = await callSocket(agent.socketPath, 'ls', { repoRoot: repo.root, remote: null, files: [{ path: repo.setPath, file: set.text }] }).reply;
    assert.deepEqual(ls.result.joinRequests, [{ setName: 'acme-api', label: 'Chen Wei · iPhone 16' }]);
    const read = await pixel.request('env.file.read', { path: repo.setPath, setId: set.setId });
    assert.deepEqual(read.result.requests.map((r: any) => r.path), [`.authdeck/requests/${chen.deviceId}.json`]);
    assert.match(read.result.requests[0].commit, /^[0-9a-f]{7}$/);
    const listed = await pixel.request('env.sets.list', {});
    assert.equal(listed.result.sets[0].joinRequests, 1);
  });

  it('lists sets with the role of the watching devices', async () => {
    const ls = await callSocket(agent.socketPath, 'ls', { repoRoot: repo.root, remote: null, files: [{ path: repo.setPath, file: set.text }] }).reply;
    assert.deepEqual(ls.result.sets, [{ name: 'acme-api', setId: set.setId, path: repo.setPath, variables: 2, members: 1, yourRole: 'owner', grantEndsAt: null, problem: null }]);
  });
});

describe('the agent checks the file the command read', () => {
  let agent: TestAgent;
  let set: TestSet;
  let repo: Repo;

  beforeEach(async () => {
    agent = await startEnvAgent();
    set = makeSet();
    repo = makeRepo(set);
  });
  afterEach(() => agent.stop());

  it('refuses a rolled-back file (older member list) with exit 65, even after a restart', async () => {
    const rev2 = withMember(set);
    fs.writeFileSync(repo.setPath, rev2);
    const accepted = await callSocket(agent.socketPath, 'ls', { repoRoot: repo.root, remote: null, files: [{ path: repo.setPath, file: rev2 }] }).reply;
    assert.equal(accepted.result.sets[0].problem, null);
    assert.equal(accepted.result.sets[0].members, 2);
    fs.writeFileSync(repo.setPath, set.text);

    const home = agent.home;
    await agent.stop();
    agent = await startEnvAgent({ home });
    const reply = await callSocket(agent.socketPath, 'release', releaseParams(repo, set.text, oneTimeKey().xPublic)).reply;
    assert.equal(reply.error.code, 'file-refused');
    assert.deepEqual(reply.error.problem, { kind: 'older-header', seen: 2, found: 1 });
    assert.equal(ENV_EXIT_FOR['file-refused'], 65);
    const stored = JSON.parse(fs.readFileSync(registryPath(home), 'utf8'));
    assert.equal(stored.heads[set.setId].head.rev, 2);
    if (process.platform !== 'win32') assert.equal(fs.statSync(registryPath(home)).mode & 0o777, 0o600);
  });

  it('refuses a tampered line and names the commit that brought it in', async () => {
    const tampered = set.text.replace(/^(DATABASE_URL=enc:\d+:)(.)/m, (_m, start, c) => `${start}${c === 'A' ? 'B' : 'A'}`);
    fs.writeFileSync(repo.setPath, tampered);
    git(repo.root, 'commit', '-q', '-am', 'Edit by hand');
    const commit = git(repo.root, 'rev-parse', '--short=7', 'HEAD').trim();
    const reply = await callSocket(agent.socketPath, 'release', releaseParams(repo, tampered, oneTimeKey().xPublic)).reply;
    assert.equal(reply.error.code, 'file-refused');
    assert.equal(reply.error.problem.kind, 'unsigned-line');
    assert.equal(reply.error.file, '.authdeck/acme-api.env');
    assert.equal(reply.error.commit, commit);
  });
});

describe('device reads and writes of set files', () => {
  let agent: TestAgent;
  let set: TestSet;
  let repo: Repo;
  let pixel: LinkedDevice;

  beforeEach(async () => {
    agent = await startEnvAgent();
    set = makeSet();
    repo = makeRepo(set);
    pixel = await agent.phone('Pixel 8', [set.owner.deviceId]);
    // The agent learns working trees from the command.
    await callSocket(agent.socketPath, 'ls', { repoRoot: repo.root, remote: 'https://github.com/acme/api', files: [{ path: repo.setPath, file: set.text }] }).reply;
  });
  afterEach(() => agent.stop());

  it('lists known sets with git state', async () => {
    const listed = await pixel.request('env.sets.list', {});
    const [summary] = listed.result.sets;
    assert.equal(summary.setId, set.setId);
    assert.equal(summary.remote, 'github.com/acme/api');
    assert.equal(summary.fileHash, envFileHash(set.text));
    assert.equal(summary.uncommitted, false);
    assert.match(summary.headCommit, /^[0-9a-f]{7}$/);
    assert.equal(summary.problem, null);
  });

  it('reads a file with the commit of each line', async () => {
    const read = await pixel.request('env.file.read', { path: repo.setPath, setId: set.setId });
    const head = git(repo.root, 'rev-parse', '--short=7', 'HEAD').trim();
    assert.equal(read.result.file, set.text);
    assert.equal(read.result.commits.length, set.text.split('\n').length - 1);
    assert.ok(read.result.commits.every((commit: string | null) => commit === head));
    assert.equal((await pixel.request('env.file.read', { path: repo.setPath, setId: 'AAAAAAAAAAAAAAAAAAAAAA' })).error?.code, 'not_found');
  });

  it('writes a change against the hash the device read, and answers conflict when the file moved on', async () => {
    const changed = signedChange(set, [...VALUES, { name: 'NEW', value: 'v' }]).file;
    const write = await pixel.request('env.file.write', { path: repo.setPath, setId: set.setId, baseHash: envFileHash(set.text), file: changed });
    assert.deepEqual(write.result, { fileHash: envFileHash(changed) });
    const stale = await pixel.request('env.file.write', { path: repo.setPath, setId: set.setId, baseHash: envFileHash(set.text), file: changed });
    assert.equal(stale.error?.code, 'conflict');
  });

  it('refuses a written file that rolls the set back', async () => {
    const rev2 = withMember(set);
    assert.equal((await pixel.request('env.file.write', { path: repo.setPath, setId: set.setId, baseHash: envFileHash(set.text), file: rev2 })).ok, true);
    const back = await pixel.request('env.file.write', { path: repo.setPath, setId: set.setId, baseHash: envFileHash(rev2), file: set.text });
    assert.equal(back.error?.code, 'bad_request');
    assert.equal(fs.readFileSync(repo.setPath, 'utf8'), rev2);
  });

  it('refuses to remove anything but a join request file', async () => {
    const write = await pixel.request('env.file.write', { path: repo.setPath, setId: set.setId, baseHash: envFileHash(set.text), removeRequests: ['../../.ssh/id_ed25519'] });
    assert.equal(write.error?.code, 'bad_request');
  });

  it('never writes through a .authdeck folder that is a link', { skip: process.platform === 'win32' }, async () => {
    const elsewhere = path.join(tempDir(), 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.renameSync(path.join(repo.root, '.authdeck'), path.join(elsewhere, '.authdeck'));
    fs.symlinkSync(path.join(elsewhere, '.authdeck'), path.join(repo.root, '.authdeck'));
    const changed = signedChange(set, [...VALUES, { name: 'NEW', value: 'v' }]).file;
    const write = await pixel.request('env.file.write', { path: repo.setPath, setId: set.setId, baseHash: envFileHash(set.text), file: changed });
    assert.equal(write.ok, false);
    assert.equal(fs.readFileSync(path.join(elsewhere, '.authdeck', 'acme-api.env'), 'utf8'), set.text);
  });

  it('pages through history, newest first, with the file at each commit', async () => {
    const texts = [set.text];
    let file = set.file;
    for (let i = 0; i < 3; i++) {
      const dataKey = openEnvDataKey(file.header, set.owner);
      file = changeEnvValues({ file, author: set.owner, dataKey, changes: { upsert: [{ name: `V${i}`, value: String(i) }], remove: [] }, time: T0 + i, random }).file;
      const text = writeEnvFile(file);
      texts.push(text);
      fs.writeFileSync(repo.setPath, text);
      git(repo.root, 'commit', '-q', '-am', `Change ${i}`);
    }
    const first = await pixel.request('env.history.read', { path: repo.setPath, setId: set.setId });
    assert.equal(first.ok, true, JSON.stringify(first.error));
    assert.equal(first.result.commits.length, 4);
    assert.equal(first.result.more, false);
    assert.deepEqual(first.result.commits.map((c: any) => c.subject), ['Change 2', 'Change 1', 'Change 0', 'Add acme-api']);
    assert.deepEqual(first.result.commits.map((c: any) => c.file), [...texts].reverse());
    assert.equal(first.result.commits[0].author, 'Maya');
    const before = await pixel.request('env.history.read', { path: repo.setPath, setId: set.setId, before: first.result.commits[1].commit });
    assert.deepEqual(before.result.commits.map((c: any) => c.subject), ['Change 0', 'Add acme-api']);
    const bad = await pixel.request('env.history.read', { path: repo.setPath, setId: set.setId, before: '--output=/tmp/x' });
    assert.equal(bad.error?.code, 'bad_request');
  });

  it('serves every distinct version once, across merges, and pages through all of them', async () => {
    const versions = [set.text];
    let file = set.file;
    const change = (i: number) => {
      const dataKey = openEnvDataKey(file.header, set.owner);
      file = changeEnvValues({ file, author: set.owner, dataKey, changes: { upsert: [{ name: `V${i}`, value: String(i) }], remove: [] }, time: T0 + i, random }).file;
      const text = writeEnvFile(file);
      versions.push(text);
      fs.writeFileSync(repo.setPath, text);
      git(repo.root, 'commit', '-q', '-am', `Change ${i}`);
    };
    git(repo.root, 'branch', 'side');
    change(0);
    change(1);
    // A side branch from before both changes, merged keeping its file: main's changes stay ancestors.
    git(repo.root, 'checkout', '-q', 'side');
    git(repo.root, 'commit', '-q', '--allow-empty', '-m', 'Side work');
    git(repo.root, 'merge', '-q', '-s', 'ours', '-m', 'Merge main', 'main');
    git(repo.root, 'checkout', '-q', 'main');
    git(repo.root, 'merge', '-q', '--ff-only', 'side');
    // The same version again: served once, at its newest commit.
    fs.writeFileSync(repo.setPath, versions[2]!);
    git(repo.root, 'commit', '-q', '-am', 'Back to change 1');

    const served: string[] = [];
    let before: string | undefined;
    for (;;) {
      // One version a page, so paging goes through the merge.
      const page = await fileHistory(repo.root, repo.relPath, before ?? null, { ...HISTORY_PAGE, commits: 1 });
      served.push(...page.commits.map((c) => c.file!));
      if (!page.more) break;
      before = page.commits.at(-1)!.commit;
    }
    assert.equal(new Set(served).size, served.length, 'no version twice');
    assert.deepEqual(new Set(served), new Set(versions), 'every version, the side-merged ones included');
  });

  it('serves a deletion of the file as a null version, not an error', async () => {
    git(repo.root, 'rm', '-q', repo.relPath);
    git(repo.root, 'commit', '-q', '-m', 'Remove set');
    fs.mkdirSync(path.dirname(repo.setPath), { recursive: true });
    fs.writeFileSync(repo.setPath, set.text);
    git(repo.root, 'add', repo.relPath);
    git(repo.root, 'commit', '-q', '-m', 'Add back');
    const page = await fileHistory(repo.root, repo.relPath, null, HISTORY_PAGE);
    assert.deepEqual(page.commits.map((c) => [c.subject, c.file === null]), [['Add back', false], ['Remove set', true]]);
    assert.equal(page.more, false);
  });

  it('fails, instead of answering an empty page, when the page cursor is no longer in the history', async () => {
    const read = await pixel.request('env.history.read', { path: repo.setPath, setId: set.setId, before: 'a'.repeat(40) });
    assert.equal(read.error?.code, 'failed');
    assert.match(read.error?.message, /history changed while it was being read/);
  });

  it('refuses a shallow clone with the way out', async () => {
    fs.writeFileSync(repo.setPath, `# change\n${set.text}`);
    git(repo.root, 'commit', '-q', '-am', 'Change');
    const clone = path.join(tempDir(), 'shallow');
    git(repo.root, 'clone', '-q', '--depth', '1', `file://${repo.root}`, clone);
    await assert.rejects(fileHistory(clone, repo.relPath, null, HISTORY_PAGE), { message: "This repo is a shallow clone, so its history can't be checked. Run git fetch --unshallow, then try again." });
  });

  it('fails when a version of the file is missing from a partial clone, instead of serving it as deleted', async () => {
    fs.writeFileSync(repo.setPath, `# change\n${set.text}`);
    git(repo.root, 'commit', '-q', '-am', 'Change');
    git(repo.root, 'config', 'uploadpack.allowFilter', 'true');
    const clone = path.join(tempDir(), 'partial');
    git(repo.root, 'clone', '-q', '--no-checkout', '--filter=blob:none', `file://${repo.root}`, clone);
    await assert.rejects(fileHistory(clone, repo.relPath, null, HISTORY_PAGE), { message: /missing part of the set file's history/ });
  });

  it('reads author and subject capped, so a huge commit message neither fills the output nor the page', async () => {
    fs.writeFileSync(repo.setPath, `# change\n${set.text}`);
    git(repo.root, 'add', repo.relPath);
    const message = path.join(tempDir(), 'message');
    fs.writeFileSync(message, `Tidy ${'x'.repeat(17 * 1024 * 1024)}`);
    git(repo.root, 'commit', '-q', '-F', message);
    const page = await fileHistory(repo.root, repo.relPath, null, HISTORY_PAGE);
    assert.equal(page.commits.length, 2);
    assert.ok(page.commits[0]!.subject.startsWith('Tidy xxx'));
    assert.ok(page.commits[0]!.subject.length <= 200);
    assert.equal(page.more, false);
  });

  it('keeps a page within its byte budget from the sizes alone, at least one version a page', async () => {
    const pad = 'p'.repeat(300 * 1024);
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(repo.setPath, `# ${i} ${pad}\n${set.text}`);
      git(repo.root, 'commit', '-q', '-am', `Pad ${i}`);
    }
    const sizes: number[] = [];
    let before: string | null = null;
    for (;;) {
      const page = await fileHistory(repo.root, repo.relPath, before, { ...HISTORY_PAGE, bytes: 400 * 1024 });
      sizes.push(page.commits.length);
      if (!page.more) break;
      before = page.commits.at(-1)!.commit;
    }
    assert.deepEqual(sizes, [1, 1, 1, 2], 'one padded version a page, then the last padded one with the small first version');
  });
});
