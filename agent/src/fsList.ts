import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentError } from './errors';
import { resolveUserPath } from './host';
import type { FsEntry, FsListResult, Platform } from './protocol';

/** Common code folders offered as starting points when they exist. */
const CODE_FOLDERS = ['code', 'dev', 'src', 'projects', 'Projects', 'repos', 'workspace', 'Developer'];
const STANDARD_FOLDERS = ['Desktop', 'Documents', 'Downloads'];

export interface FsListOptions {
  path?: string;
  includeFiles?: boolean;
}

function byNameInsensitive(a: FsEntry, b: FsEntry): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
}

export async function listFolder(options: FsListOptions, home: string, platform: Platform): Promise<FsListResult> {
  const pathApi = platform === 'windows' ? path.win32 : path.posix;
  const target = resolveUserPath(options.path?.trim() || '~', home, platform);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) throw new AgentError('not_found', `The folder ${target} does not exist on this computer.`);
  if (!stat.isDirectory()) throw new AgentError('bad_request', `${target} is a file, not a folder.`);

  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch {
    throw new AgentError('permission', `AuthDeck is not allowed to read ${target}.`, platform === 'macos' ? 'Allow the app running the agent in System Settings → Privacy & Security → Files and Folders (or Full Disk Access).' : undefined);
  }

  const dirs: FsEntry[] = [];
  const files: FsEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    const full = pathApi.join(target, dirent.name);
    const kind = await entryKind(dirent, full);
    if (kind === 'dir') dirs.push({ name: dirent.name, path: full, kind });
    else if (kind === 'file' && options.includeFiles) files.push({ name: dirent.name, path: full, kind });
  }
  dirs.sort(byNameInsensitive);
  files.sort(byNameInsensitive);

  const parent = pathApi.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    entries: [...dirs, ...files],
    roots: await listRoots(home, platform),
    home,
    sep: platform === 'windows' ? '\\' : '/',
  };
}

/** dir/file for an entry, following symlinks; null when it can't be read. */
async function entryKind(dirent: import('node:fs').Dirent, full: string): Promise<'dir' | 'file' | null> {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  if (!dirent.isSymbolicLink()) return null;
  const stat = await fs.stat(full).catch(() => null);
  if (!stat) return null;
  return stat.isDirectory() ? 'dir' : 'file';
}

async function isDirectory(dir: string): Promise<boolean> {
  return fs.stat(dir).then((s) => s.isDirectory(), () => false);
}

async function listRoots(home: string, platform: Platform): Promise<FsEntry[]> {
  const pathApi = platform === 'windows' ? path.win32 : path.posix;
  const roots: FsEntry[] = [{ name: 'Home', path: home, kind: 'dir' }];
  for (const name of await existingFolderNames(home, [...STANDARD_FOLDERS, ...CODE_FOLDERS], platform)) {
    roots.push({ name, path: pathApi.join(home, name), kind: 'dir' });
  }
  if (platform === 'windows') {
    const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    const drives = await Promise.all(letters.map(async (letter) => ((await isDirectory(`${letter}:\\`)) ? letter : null)));
    for (const letter of drives) if (letter) roots.push({ name: `${letter}:`, path: `${letter}:\\`, kind: 'dir' });
  }
  return roots;
}

/**
 * Which of the wanted folder names exist in home, spelled as on disk. macOS and Windows disks
 * ignore case, so "projects" and "Projects" are one folder there and are listed once.
 */
async function existingFolderNames(home: string, wanted: string[], platform: Platform): Promise<string[]> {
  const entries = await fs.readdir(home, { withFileTypes: true }).catch(() => []);
  const onDisk = new Set(entries.map((e) => e.name));
  const caseInsensitive = new Map(entries.map((e) => [e.name.toLowerCase(), e.name]));
  const found: string[] = [];
  for (const name of wanted) {
    const actual = onDisk.has(name) ? name : platform === 'linux' ? undefined : caseInsensitive.get(name.toLowerCase());
    if (actual && !found.includes(actual) && (await isDirectory(path.join(home, actual)))) found.push(actual);
  }
  return found;
}
