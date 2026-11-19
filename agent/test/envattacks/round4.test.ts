// Security review of env sets (0.4), round 4, agent git history. Each test is a proof of concept for
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
/** The engine's MAX_HISTORY_PAGES. */
const MAX_PAGES = 50;

/** A repo in a temp folder, and git run in it. */
function tempRepo(prefix: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const commit = (text: string, message: string) => {
    fs.writeFileSync(path.join(dir, REL), text);
    git('add', REL);
    const messageFile = path.join(os.tmpdir(), `${path.basename(dir)}-msg`);
    fs.writeFileSync(messageFile, message);
    git('commit', '-q', '--allow-empty', '-F', messageFile);
    fs.rmSync(messageFile);
  };
  fs.mkdirSync(path.join(dir, '.authdeck'));
  git('init', '-q', '-b', 'main');
  return { dir, git, commit };
}

/** A set, its file after the owner deleted OLD_TOKEN, and the repo writer's file with the old line swapped back in. */
function deletionAndCrafted(seed: string) {
  const set = makeSet(seed, [
    { name: 'API_KEY', value: 'sk_live_1' },
    { name: 'OLD_TOKEN', value: 'leaked-and-revoked' },
  ]);
  const deleted = changeEnvValues({ file: set.file, author: set.owner, dataKey: set.dataKey, changes: { upsert: [], remove: ['OLD_TOKEN'] }, time: T0 + 5, random: seededRandom(`${seed}/delete`) });
  const deletedText = writeEnvFile(deleted.file);
  const oldLine = set.text.split('\n').find((l) => l.startsWith('OLD_TOKEN='))!;
  const crafted = deletedText.replace(/^OLD_TOKEN=.*$/m, oldLine);
  assert.notEqual(checkEnvFloor(crafted, envHistoryFloor(crafted, [{ commit: 'd', text: deletedText }])), null, 'control: with the deletion in history the floor refuses');
  return { set, deletedText, crafted };
}

/**
 * Reads history the way the phone engine does (historyFiles): pages until `more` is false, files
 * that came back null skipped. Then the take is decided: refused when the read is incomplete or
 * threw, or when the crafted file is below the floor.
 */
async function phoneDecides(dir: string, crafted: string): Promise<string> {
  const files: { commit: string; text: string }[] = [];
  let before: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const read = await fileHistory(dir, REL, before, HISTORY_PAGE);
      for (const c of read.commits) if (c.file !== null) files.push({ commit: c.commit, text: c.file });
      const last = read.commits[read.commits.length - 1];
      if (!read.more || !last) {
        const problem = checkEnvFloor(crafted, envHistoryFloor(crafted, files));
        return problem === null ? `taken (history read whole: ${files.length} files)` : `refused: ${problem.kind}`;
      }
      before = last.commit;
    }
    return 'refused: history too long';
  } catch (err) {
    return `refused: ${(err as Error).message}`;
  }
}

describe('ENV-20: a commit message past git\'s output cap empties the history, and the empty history counts as whole', () => {
  const repo = tempRepo('envattacks-r4-log-');
  after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  it('the floor still refuses the swapped tombstone when the repo writer\'s commit has a 17 MB message', async () => {
    const { set, deletedText, crafted } = deletionAndCrafted('log-overflow');
    repo.commit(set.text, 'add set');
    repo.commit(deletedText, 'delete OLD_TOKEN');
    // The repo writer swaps the tombstone back, in a commit whose subject alone is past the agent's
    // 16 MB output cap for git: `git log` is killed, and fileHistory answers "no commits, no more".
    repo.commit(`# swap\n${crafted}`, `chore: update ${'x'.repeat(17 * 1024 * 1024)}`);

    const decided = await phoneDecides(repo.dir, `# swap\n${crafted}`);
    assert.match(decided, /^refused/, `the phone ${decided}`);
  });
});

describe('ENV-21: one page of large versions overflows cat-file, and every file on that page, the tombstone among them, comes back null', () => {
  const repo = tempRepo('envattacks-r4-batch-');
  after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  it('the floor still refuses the swapped tombstone when 63 padded versions sit above the deletion', async () => {
    const { set, deletedText, crafted } = deletionAndCrafted('batch-overflow');
    repo.commit(set.text, 'add set');
    repo.commit(deletedText, 'delete OLD_TOKEN');
    // 63 distinct versions of ~300 KB (each under the 384 KB file cap): with the deletion they make
    // one 64-commit page whose blobs total ~19 MB, past the 16 MB cap on `git cat-file --batch`.
    const pad = 'p'.repeat(300 * 1024);
    let last = '';
    for (let i = 0; i < 63; i++) {
      last = `# ${i} ${pad}\n${crafted}`;
      repo.commit(last, `tidy ${i}`);
    }

    const decided = await phoneDecides(repo.dir, last);
    assert.match(decided, /^refused/, `the phone ${decided}`);
  });
});

describe('ENV-22: in a shallow clone the history stops at the clone\'s depth, and the cut history counts as whole', () => {
  const repo = tempRepo('envattacks-r4-shallow-');
  const clone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'envattacks-r4-shallow-clone-')));
  after(() => {
    fs.rmSync(repo.dir, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  });

  it('the floor still refuses the swapped tombstone in a clone made with --depth 1', async () => {
    const { set, deletedText, crafted } = deletionAndCrafted('shallow');
    repo.commit(set.text, 'add set');
    repo.commit(deletedText, 'delete OLD_TOKEN');
    repo.commit(`# tidy\n${crafted}`, 'tidy');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo.dir}`, clone]);
    assert.equal(execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: clone, encoding: 'utf8' }).trim(), 'true');

    const decided = await phoneDecides(clone, `# tidy\n${crafted}`);
    assert.match(decided, /^refused/, `the phone ${decided}`);
  });
});
