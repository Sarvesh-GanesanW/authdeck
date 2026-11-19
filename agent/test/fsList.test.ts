import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AgentError } from '../src/errors';
import { listFolder } from '../src/fsList';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-fs-')));
for (const dir of ['b-dir', 'A-dir', '.hidden-dir', 'Documents', 'code', 'Projects']) fs.mkdirSync(path.join(home, dir));
for (const file of ['z.txt', 'Y.md', '.env']) fs.writeFileSync(path.join(home, file), '');
fs.symlinkSync(path.join(home, 'A-dir'), path.join(home, 'link-to-dir'));
fs.symlinkSync(path.join(home, 'missing'), path.join(home, 'broken-link'));

describe('fs.list', () => {
  it('lists folders only by default, sorted case-insensitively, hiding dot-files and broken links', async () => {
    const result = await listFolder({}, home, 'macos');
    assert.equal(result.path, home);
    assert.deepEqual(result.entries.map((e) => e.name), ['A-dir', 'b-dir', 'code', 'Documents', 'link-to-dir', 'Projects']);
    assert.equal(result.sep, '/');
  });

  it('adds files after folders when asked', async () => {
    const result = await listFolder({ path: '~', includeFiles: true }, home, 'macos');
    assert.deepEqual(result.entries.filter((e) => e.kind === 'file').map((e) => e.name), ['Y.md', 'z.txt']);
    assert.equal(result.entries.at(-1)!.name, 'z.txt');
  });

  it('offers home, standard and code folders that exist as roots', async () => {
    const result = await listFolder({}, home, 'macos');
    assert.deepEqual(result.roots.map((r) => r.name), ['Home', 'Documents', 'code', 'Projects']);
  });

  it('reports a missing folder as not_found and a file as bad_request', async () => {
    await assert.rejects(listFolder({ path: '~/nope' }, home, 'macos'), (err: AgentError) => err.code === 'not_found');
    await assert.rejects(listFolder({ path: '~/z.txt' }, home, 'macos'), (err: AgentError) => err.code === 'bad_request');
  });

  it('gives the parent, and null at the root', async () => {
    assert.equal((await listFolder({ path: '~/A-dir' }, home, 'macos')).parent, home);
    assert.equal((await listFolder({ path: '/' }, home, 'macos')).parent, null);
  });
});
