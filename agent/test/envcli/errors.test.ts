/** Every way a command ends: each error the agent can send maps to its contract exit code and words. */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ENV_EXIT_FOR, ENV_SOCKET_MAX_LINE_BYTES, envCommandErrorWords, type EnvCommandError, type EnvCommandErrorCode } from '../../src/envSocketContract';
import { FakeAgent } from './helpers/fakeAgent';
import { runInProcess } from './helpers/inProcess';
import { makeRepo, type TestRepo } from './helpers/repo';

/** One example of every error code. */
const EXAMPLES: Record<EnvCommandErrorCode, EnvCommandError> = {
  denied: { code: 'denied', kind: 'run', set: 'acme-api-prod', by: 'Pixel 8', command: 'npm run seed:prod', target: null },
  'no-answer': { code: 'no-answer', set: 'acme-api', devices: ['Pixel 8'], waitedSec: 60 },
  'file-refused': { code: 'file-refused', kind: 'run', set: 'acme-api', file: '.authdeck/acme-api.env', problem: { kind: 'older-header', seen: 7, found: 6 }, commit: null },
  'changed-meanwhile': { code: 'changed-meanwhile', file: '.authdeck/acme-api.env', by: 'Pixel 8' },
  'no-set': { code: 'no-set', folder: '/r' },
  'several-sets': { code: 'several-sets', folder: '/r', sets: ['a', 'b'] },
  'unknown-set': { code: 'unknown-set', set: 'c', sets: ['a'] },
  'no-repo': { code: 'no-repo', folder: '/r' },
  'no-input': { code: 'no-input', path: '.env' },
  'bad-name': { code: 'bad-name', path: '.env', line: 2, name: '1X' },
  'bad-dotenv': { code: 'bad-dotenv', path: '.env', line: 3, reason: 'unclosed-quote' },
  'target-exists': { code: 'target-exists', path: '.env' },
  'too-large': { code: 'too-large', path: '.env', limit: 'values', name: null },
  'agent-unavailable': { code: 'agent-unavailable' },
  'rate-limited': { code: 'rate-limited', retryAfterSec: 4 },
  'agent-version': { code: 'agent-version', agentVersion: '0.5.0', socketVersion: 2 },
  usage: { code: 'usage', detail: 'Bad.' },
  failed: { code: 'failed', detail: 'Broke.' },
};

const DESIGN_EXITS: Partial<Record<EnvCommandErrorCode, number>> = { denied: 77, 'no-answer': 75, 'file-refused': 65, 'bad-dotenv': 65, 'target-exists': 73, 'rate-limited': 75 };

let agent: FakeAgent;
let repo: TestRepo;

beforeEach(async () => {
  agent = await FakeAgent.start();
  repo = makeRepo();
  repo.addSet('acme-api');
});
afterEach(async () => {
  await agent.stop();
  repo.remove();
});

const run = () => runInProcess(['env', 'run', '--', 'true'], { cwd: repo.root, socketPath: agent.socketPath });

describe('errors from the agent', () => {
  for (const [code, error] of Object.entries(EXAMPLES) as [EnvCommandErrorCode, EnvCommandError][]) {
    it(`${code} ends with exit ${ENV_EXIT_FOR[code]} and the contract's words`, async () => {
      agent.answer = (c) => c.send({ ok: false, error });
      const outcome = await run();
      assert.equal(outcome.code, ENV_EXIT_FOR[code]);
      if (DESIGN_EXITS[code] !== undefined) assert.equal(outcome.code, DESIGN_EXITS[code]);
      const words = envCommandErrorWords(error);
      assert.ok(outcome.stderr.startsWith(`✗ ${words.message}${words.hint ? `\n  ${words.hint}` : ''}\n`), outcome.stderr);
    });
  }

  it('words a denial and no answer the way the design shows', async () => {
    agent.answer = (c) => c.send({ ok: false, error: EXAMPLES.denied });
    assert.equal((await run()).stderr, '✗ Pixel 8 denied acme-api-prod. npm run seed:prod did not start.\n');
    agent.answer = (c) => c.send({ ok: false, error: EXAMPLES['no-answer'] });
    assert.equal(
      (await run()).stderr,
      '✗ No member device answered in 60 s.\n  Open AuthDeck on Pixel 8, on the same network as this computer, and run this again.\n',
    );
  });
});

describe('replies the command cannot use', () => {
  const cases: [string, (c: Parameters<FakeAgent['answer']>[0]) => void, RegExp][] = [
    ['a line that is not JSON', (c) => c.raw('not json\n'), /can't read/],
    ['a reply to another request', (c) => c.raw(`${JSON.stringify({ id: 'other', ok: true, result: {} })}\n`), /can't read/],
    ['an error code the contract does not have', (c) => c.raw(`${JSON.stringify({ id: c.request.id, ok: false, error: { code: 'mystery' } })}\n`), /can't read/],
    ['closing without a reply', (c) => c.end(), /closed the connection without answering/],
    ['a line over the size cap', (c) => c.raw('x'.repeat(ENV_SOCKET_MAX_LINE_BYTES + 10)), /longer than the socket allows/],
  ];
  for (const [what, answer, words] of cases) {
    it(`fails with exit 70 for ${what}`, async () => {
      agent.answer = answer;
      const outcome = await run();
      assert.equal(outcome.code, 70);
      assert.match(outcome.stderr, words);
    });
  }

  it('sends one versioned request line naming the method', async () => {
    agent.answer = (c) => c.send({ ok: false, error: EXAMPLES.denied });
    await run();
    const [request] = agent.requests;
    assert.equal(request!.v, 1);
    assert.equal(request!.method, 'release');
    assert.match(request!.id, /^[0-9a-f-]{36}$/);
  });
});
