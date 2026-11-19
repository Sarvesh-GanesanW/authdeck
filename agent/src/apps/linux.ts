import fs from 'node:fs/promises';
import path from 'node:path';
import { currentDesktops } from '../host';
import type { DesktopApp, InstalledApp } from './types';
import { localized, parseDesktopEntry, splitList } from './desktopFile';

export interface LinuxScanContext {
  env: NodeJS.ProcessEnv;
  home: string;
  hasTool: (name: string) => boolean;
}

/** XDG data dirs in priority order (user first). */
export function xdgDataDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local/share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return unique([dataHome, ...dataDirs]);
}

/** Folders holding .desktop files, highest priority first. */
export function applicationDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  return unique([
    ...xdgDataDirs(env, home).map((dir) => path.join(dir, 'applications')),
    path.join(home, '.local/share/flatpak/exports/share/applications'),
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
  ]);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => path.normalize(v)))];
}

/** Desktop file id per the XDG spec: path below the applications dir with "/" replaced by "-". */
export function desktopFileId(applicationsDir: string, filePath: string): string {
  return path.relative(applicationsDir, filePath).split(path.sep).join('-');
}

export async function scanLinuxApps(ctx: LinuxScanContext): Promise<InstalledApp[]> {
  const seen = new Set<string>();
  const apps: InstalledApp[] = [];
  for (const dir of applicationDirs(ctx.env, ctx.home)) {
    for (const filePath of await listDesktopFiles(dir)) {
      const desktopId = desktopFileId(dir, filePath);
      if (seen.has(desktopId)) continue;
      // An earlier dir's entry shadows later ones even when it is hidden.
      seen.add(desktopId);
      const content = await fs.readFile(filePath, 'utf8').catch(() => null);
      if (content === null) continue;
      const desktop = readDesktopApp(content, desktopId, filePath, ctx);
      if (!desktop) continue;
      apps.push({
        platform: 'linux',
        entry: { id: `linux:${desktopId}`, name: desktop.name, detail: desktopId, hasIcon: desktop.icon !== null },
        desktop,
      });
    }
  }
  return apps;
}

async function listDesktopFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listDesktopFiles(full)));
    else if (entry.name.endsWith('.desktop')) files.push(full);
  }
  return files.sort();
}

/** Applies the spec's visibility rules; returns null for entries that should not be listed. */
function readDesktopApp(content: string, desktopId: string, filePath: string, ctx: LinuxScanContext): DesktopApp | null {
  const fields = parseDesktopEntry(content);
  if (fields.get('Type') !== 'Application') return null;
  if (fields.get('NoDisplay') === 'true' || fields.get('Hidden') === 'true') return null;
  const name = localized(fields, 'Name', ctx.env.LC_MESSAGES || ctx.env.LC_ALL || ctx.env.LANG);
  const exec = fields.get('Exec');
  if (!name || !exec) return null;
  if (!isShownInDesktop(fields, currentDesktops(ctx.env))) return null;
  const tryExec = fields.get('TryExec');
  if (tryExec && !ctx.hasTool(tryExec)) return null;
  return {
    desktopId,
    filePath,
    name,
    exec,
    icon: fields.get('Icon') || null,
    startupWMClass: fields.get('StartupWMClass') || null,
    terminal: fields.get('Terminal') === 'true',
  };
}

function isShownInDesktop(fields: Map<string, string>, desktops: string[]): boolean {
  const onlyShowIn = splitList(fields.get('OnlyShowIn'));
  if (onlyShowIn.length > 0 && !onlyShowIn.some((d) => desktops.includes(d))) return false;
  const notShowIn = splitList(fields.get('NotShowIn'));
  return !notShowIn.some((d) => desktops.includes(d));
}
