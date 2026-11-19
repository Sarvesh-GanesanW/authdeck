import fs from 'node:fs';
import path from 'node:path';

/** Finds an executable on PATH, honouring PATHEXT on Windows. Returns null when absent. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const isWindows = process.platform === 'win32';
  const extensions = isWindows ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  if (path.isAbsolute(name)) return isExecutableFile(name) ? name : null;
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(file: string): boolean {
  try {
    // App execution aliases (e.g. WindowsApps\wt.exe) are reparse points that stat can't follow.
    const stat = process.platform === 'win32' ? fs.lstatSync(file) : fs.statSync(file);
    if (process.platform === 'win32') return !stat.isDirectory();
    if (!stat.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Tool lookup that remembers hits only, so a tool installed while the agent runs is picked up. */
export function createToolLookup(env: NodeJS.ProcessEnv = process.env): (name: string) => boolean {
  const found = new Set<string>();
  return (name) => {
    if (found.has(name)) return true;
    if (findExecutable(name, env) === null) return false;
    found.add(name);
    return true;
  };
}
