/**
 * The env sets contracts (slice 0): the words a refused file and a failed command print, the exit
 * codes the design promises, and the caps every reader shares.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ENV_LIMITS, ENV_NAME_PATTERN, ENV_SET_NAME_PATTERN, envFileProblemWords, type EnvFileProblem } from '../src/envcore/types';
import { ENV_EXIT, ENV_EXIT_FOR, envCommandErrorWords, envSocketPath } from '../src/envSocketContract';

const atComputer = { file: '.authdeck/acme-api.env', set: 'acme-api', where: 'computer' } as const;

describe('env command words', () => {
  it('words a tampered line the way the design shows, ending in exit 65', () => {
    const error = {
      code: 'file-refused',
      kind: 'run',
      set: 'acme-api',
      file: '.authdeck/acme-api.env',
      problem: { kind: 'unsigned-line', line: 14, name: 'DATABASE_URL' },
      commit: '77b0e1d',
    } as const;
    assert.deepEqual(envCommandErrorWords(error), {
      message: ".authdeck/acme-api.env line 14 (DATABASE_URL) isn't signed by a member of acme-api. It came in with commit 77b0e1d. Nothing was released.",
      hint: "Revert that commit, or set DATABASE_URL again from a member's phone.",
    });
    assert.equal(ENV_EXIT_FOR[error.code], 65);
  });

  it('words a denial by what did not happen, ending in exit 77', () => {
    const run = { code: 'denied', kind: 'run', set: 'acme-api-prod', by: 'Pixel 8', command: 'npm run seed:prod', target: null } as const;
    assert.equal(envCommandErrorWords(run).message, 'Pixel 8 denied acme-api-prod. npm run seed:prod did not start.');
    const pull = { code: 'denied', kind: 'pull', set: 'acme-api', by: 'Pixel 8', command: null, target: '.env' } as const;
    assert.equal(envCommandErrorWords(pull).message, 'Pixel 8 denied acme-api. .env was not written.');
    assert.equal(ENV_EXIT_FOR.denied, 77);
  });

  it('names the devices to open when nobody answers, ending in exit 75', () => {
    const words = envCommandErrorWords({ code: 'no-answer', set: 'acme-api', devices: ['Pixel 8'], waitedSec: 60 });
    assert.equal(words.message, 'No member device answered in 60 s.');
    assert.equal(words.hint, 'Open AuthDeck on Pixel 8, on the same network as this computer, and run this again.');
    const several = envCommandErrorWords({ code: 'no-answer', set: 'acme-api', devices: ['Pixel 8', 'iPad mini', 'Pixel 9'], waitedSec: 60 });
    assert.match(several.hint ?? '', /^Open AuthDeck on Pixel 8, iPad mini or Pixel 9,/);
    assert.equal(ENV_EXIT_FOR['no-answer'], 75);
  });

  it('gives every failure a sysexits code', () => {
    const codes = new Set<number>(Object.values(ENV_EXIT));
    for (const [code, exit] of Object.entries(ENV_EXIT_FOR)) assert.ok(codes.has(exit), code);
  });
});

describe('env file problem words', () => {
  const problems: EnvFileProblem[] = [
    { kind: 'unreadable', line: 3, detail: 'no = after the name' },
    { kind: 'conflict-markers', line: 9 },
    { kind: 'newer-format', format: 2 },
    { kind: 'too-large', limit: 'value', name: 'CERT_PEM' },
    { kind: 'bad-name', line: 12, name: '9LIVES' },
    { kind: 'duplicate-name', line: 20, name: 'REDIS_URL' },
    { kind: 'header-unsigned' },
    { kind: 'header-chain', rev: 8 },
    { kind: 'older-header', seen: 7, found: 6 },
    { kind: 'unsigned-line', line: 14, name: 'DATABASE_URL' },
    { kind: 'not-a-member', line: 15, name: 'REDIS_URL', author: 'Lm2pQ7rTz0aYbXc3VwE1dA' },
    { kind: 'older-value', line: 16, name: 'STRIPE_SECRET_KEY', seen: 7, found: 6 },
    { kind: 'wrong-epoch', line: 17, name: 'SENTRY_DSN', epoch: 2, current: 3 },
  ];

  it('has a title, a sentence and a next step for every problem, on both surfaces', () => {
    for (const problem of problems) {
      for (const where of ['computer', 'phone'] as const) {
        const words = envFileProblemWords(problem, { ...atComputer, where, commit: '77b0e1d' });
        assert.ok(words.title && words.message.endsWith('.') && words.hint.endsWith('.'), `${problem.kind} on ${where}`);
      }
    }
  });

  it('says the commit only when git knows it', () => {
    const problem: EnvFileProblem = { kind: 'unsigned-line', line: 14, name: 'DATABASE_URL' };
    assert.doesNotMatch(envFileProblemWords(problem, atComputer).message, /commit/);
    assert.equal(envFileProblemWords(problem, atComputer).hint, "Undo the change to that line, or set DATABASE_URL again from a member's phone.");
  });
});

describe('env names and caps', () => {
  it('takes variable names shells and dotenv loaders take', () => {
    for (const name of ['DATABASE_URL', '_PRIVATE', 'next_public_api', 'A1']) assert.match(name, ENV_NAME_PATTERN);
    for (const name of ['9LIVES', 'WITH-DASH', 'WITH SPACE', '', 'É']) assert.doesNotMatch(name, ENV_NAME_PATTERN);
  });

  it('takes set names that work as file names', () => {
    for (const name of ['acme-api', 'acme-api-prod', 'ledgerline', 'web.v2']) assert.match(name, ENV_SET_NAME_PATTERN);
    for (const name of ['Acme', '-api', '../api', 'a/b', '.hidden']) assert.doesNotMatch(name, ENV_SET_NAME_PATTERN);
  });

  it('keeps a full file and a full push within half of one 1 MiB link message, leaving room for JSON', () => {
    assert.ok(ENV_LIMITS.fileBytes + ENV_LIMITS.valueTotalBytes <= 512 * 1024);
  });
});

describe('env socket path', () => {
  it('is a socket in the AuthDeck folder, or a per-user pipe on Windows', () => {
    assert.equal(envSocketPath('/Users/maya/.authdeck', 'darwin', 'maya'), '/Users/maya/.authdeck/agent.sock');
    assert.equal(envSocketPath('C:\\Users\\maya\\.authdeck', 'win32', 'maya'), '\\\\.\\pipe\\authdeck-agent-maya');
  });
});
