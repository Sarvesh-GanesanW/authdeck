/** Temp git repos for the command to run in. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fakeSetFile, type FakeSetFile } from './fakeCore';

export interface TestRepo {
  root: string;
  write(file: string, text: string): void;
  read(file: string): string;
  exists(file: string): boolean;
  git(...args: string[]): string;
  addSet(name: string, overrides?: Partial<FakeSetFile>): void;
  remove(): void;
}

export function makeRepo(options: { remote?: string } = {}): TestRepo {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adenv-repo-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q');
  if (options.remote) git('remote', 'add', 'origin', options.remote);
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  return {
    root,
    write,
    read: (file) => fs.readFileSync(path.join(root, file), 'utf8'),
    exists: (file) => fs.existsSync(path.join(root, file)),
    git,
    addSet: (name, overrides) => write(`.authdeck/${name}.env`, fakeSetFile(name, overrides)),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function makeFolder(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adenv-plain-')));
}
