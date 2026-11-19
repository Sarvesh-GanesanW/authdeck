// Security review of env sets (0.4), round 3, agent and env core. Each test is a proof of concept for
// one finding: it fails while the weakness is there and passes once it is fixed. Ids match the report.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { HISTORY_PAGE } from '../../src/env/deviceMethods';
import { fileHistory } from '../../src/env/git';
import { changeEnvValues, checkEnvFloor, envHistoryFloor, writeEnvFile } from '../../src/envcore';
import { makeSet, T0 } from '../envcore/fixtures';
import { seededRandom } from '../helpers/vault';

const REL = '.authdeck/acme-api.env';

describe("ENV-15: git's history simplification hides the deletion from the floor", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'envattacks-r3-')));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  const commit = (text: string, message: string) => {
    fs.writeFileSync(path.join(dir, REL), text);
    git('add', REL);
    git('commit', '-q', '-m', message);
  };

  it('the floor from the agent\'s history pages still holds the tombstone after a merge that takes the crafted side', async () => {
    const set = makeSet('floor-merge', [
      { name: 'API_KEY', value: 'sk_live_1' },
      { name: 'OLD_TOKEN', value: 'leaked-and-revoked' },
    ]);
    const deleted = changeEnvValues({ file: set.file, author: set.owner, dataKey: set.dataKey, changes: { upsert: [], remove: ['OLD_TOKEN'] }, time: T0 + 5, random: seededRandom('floor-merge/delete') });
    const deletedText = writeEnvFile(deleted.file);
    const oldLine = set.text.split('\n').find((l) => l.startsWith('OLD_TOKEN='))!;
    const crafted = deletedText.replace(/^OLD_TOKEN=.*$/m, oldLine);
    assert.equal(checkEnvFloor(crafted, envHistoryFloor(crafted, [{ commit: 'd', text: deletedText }])) !== null, true, 'control: with the deletion in history the floor refuses');

    fs.mkdirSync(path.join(dir, '.authdeck'));
    git('init', '-q', '-b', 'main');
    commit(set.text, 'add set');
    git('branch', 'side');
    commit(deletedText, 'delete OLD_TOKEN');
    // Swapping the tombstone back gives the file exactly as it was before the deletion.
    assert.equal(crafted, set.text);
    // A repo writer, with no force-push: a side branch from before the deletion, merged into main
    // keeping the side's file. Nothing is rewritten; the deletion stays an ancestor of HEAD.
    git('checkout', '-q', 'side');
    git('merge', '-q', '-s', 'ours', '-m', 'merge main', 'main');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--ff-only', 'side');
    assert.ok(git('log', '--format=%s').includes('delete OLD_TOKEN'), 'the deletion commit is in HEAD\'s history');

    const page = await fileHistory(dir, REL, null, HISTORY_PAGE);
    const history = page.commits.filter((c) => c.file !== null).map((c) => ({ commit: c.commit, text: c.file! }));
    const problem = checkEnvFloor(crafted, envHistoryFloor(crafted, history));
    assert.notEqual(problem, null, `history the agent served: ${page.commits.map((c) => c.subject).join(', ')}; the deletion was simplified away`);
  });
});
