/** `authdeck env` arguments: every command, its flags, and what counts as bad usage. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEnvArgs } from '../../src/envcli/args';
import { EnvCliFailure } from '../../src/envcli/failure';

function usageDetail(argv: string[]): string {
  try {
    parseEnvArgs(argv);
  } catch (err) {
    assert.ok(err instanceof EnvCliFailure && err.error.code === 'usage', String(err));
    assert.equal(err.exitCode, 64);
    return err.error.detail;
  }
  assert.fail(`${argv.join(' ')} parsed`);
}

describe('parseEnvArgs', () => {
  it('reads init with and without --from and --set', () => {
    assert.deepEqual(parseEnvArgs(['env', 'init']), { kind: 'init', from: null, set: null });
    assert.deepEqual(parseEnvArgs(['env', 'init', '--from', '.env', '--set=acme-api']), { kind: 'init', from: '.env', set: 'acme-api' });
  });

  it('reads ls', () => {
    assert.deepEqual(parseEnvArgs(['env', 'ls']), { kind: 'ls' });
  });

  it('reads push with a positional file, --file, --prune and --set', () => {
    assert.deepEqual(parseEnvArgs(['env', 'push']), { kind: 'push', file: '.env', prune: false, set: null });
    assert.deepEqual(parseEnvArgs(['env', 'push', '.env.local', '--prune']), { kind: 'push', file: '.env.local', prune: true, set: null });
    assert.deepEqual(parseEnvArgs(['env', 'push', '--file', 'x.env', '--set', 'prod']), { kind: 'push', file: 'x.env', prune: false, set: 'prod' });
  });

  it('reads pull with --force', () => {
    assert.deepEqual(parseEnvArgs(['env', 'pull']), { kind: 'pull', file: '.env', force: false, set: null });
    assert.deepEqual(parseEnvArgs(['env', 'pull', '--force', '--file=.env.dev']), { kind: 'pull', file: '.env.dev', force: true, set: null });
  });

  it('reads run, keeping everything after -- for the child, flags included', () => {
    assert.deepEqual(parseEnvArgs(['env', 'run', '--', 'npm', 'run', 'dev']), { kind: 'run', set: null, allow: [], command: ['npm', 'run', 'dev'] });
    assert.deepEqual(parseEnvArgs(['env', 'run', '--set', 'acme-api-prod', '--', 'node', '--help', '--', 'x']), {
      kind: 'run',
      set: 'acme-api-prod',
      allow: [],
      command: ['node', '--help', '--', 'x'],
    });
    assert.deepEqual(parseEnvArgs(['env', 'run', 'npm', 'test', '--set', 'x']), { kind: 'run', set: null, allow: [], command: ['npm', 'test', '--set', 'x'] });
  });

  it('reads --allow as many times as given, before the command', () => {
    assert.deepEqual(parseEnvArgs(['env', 'run', '--allow', 'NODE_OPTIONS', '--allow=PATH', '--', 'npm', 'test', '--allow', 'X']), {
      kind: 'run',
      set: null,
      allow: ['NODE_OPTIONS', 'PATH'],
      command: ['npm', 'test', '--allow', 'X'],
    });
    assert.match(usageDetail(['env', 'run', '--allow', 'NOT-A-NAME', '--', 'x']), /--allow takes a variable name, not "NOT-A-NAME"/);
    assert.match(usageDetail(['env', 'pull', '--allow', 'PATH']), /has no option --allow/);
  });

  it("reads git's merge driver call", () => {
    assert.deepEqual(parseEnvArgs(['env', 'merge', 'O', 'A', 'B']), { kind: 'merge', base: 'O', ours: 'A', theirs: 'B' });
  });

  it('reads help and version anywhere before a run command', () => {
    for (const argv of [['--help'], ['-h'], ['env', '--help'], ['env', 'push', '--help'], ['env', 'run', '--help']]) assert.deepEqual(parseEnvArgs(argv), { kind: 'help' }, argv.join(' '));
    assert.deepEqual(parseEnvArgs(['--version']), { kind: 'version' });
    assert.deepEqual(parseEnvArgs(['env', 'run', '--', 'x', '--help']), { kind: 'run', set: null, allow: [], command: ['x', '--help'] });
  });

  it('calls everything else bad usage, saying what was wrong', () => {
    assert.match(usageDetail([]), /Name a command/);
    assert.match(usageDetail(['env']), /Name a command/);
    assert.match(usageDetail(['vault']), /Unknown command "vault"/);
    assert.match(usageDetail(['env', 'join']), /Unknown command "authdeck env join"/);
    assert.match(usageDetail(['env', 'run']), /Name the command to run/);
    assert.match(usageDetail(['env', 'run', '--']), /Name the command to run/);
    assert.match(usageDetail(['env', 'push', '--force']), /has no option --force/);
    assert.match(usageDetail(['env', 'ls', 'extra']), /Too many arguments/);
    assert.match(usageDetail(['env', 'push', 'a', '--file', 'b']), /Name the file once/);
    assert.match(usageDetail(['env', 'pull', '--set']), /--set needs a value/);
    assert.match(usageDetail(['env', 'init', '--set', 'Bad Name']), /can't be a set name/);
    assert.match(usageDetail(['env', 'merge', 'O', 'A']), /authdeck env merge <base> <ours> <theirs>/);
  });
});
