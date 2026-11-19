import type { AppEntry } from '../protocol';

/** A Linux .desktop application after filtering, with the fields actions need. */
export interface DesktopApp {
  /** Desktop file id, e.g. "code.desktop" or "kde4-kate.desktop". */
  desktopId: string;
  filePath: string;
  name: string;
  exec: string;
  icon: string | null;
  startupWMClass: string | null;
  terminal: boolean;
}

/** An installed app plus the platform details the agent keeps to itself. */
export type InstalledApp =
  | { platform: 'macos'; entry: AppEntry; bundlePath: string; bundleId: string | null }
  | { platform: 'windows'; kind: 'lnk'; entry: AppEntry; lnkPath: string; targetPath: string }
  | { platform: 'windows'; kind: 'aumid'; entry: AppEntry; aumid: string }
  | { platform: 'linux'; entry: AppEntry; desktop: DesktopApp };

export function byName(a: InstalledApp, b: InstalledApp): number {
  return a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: 'base' }) || a.entry.id.localeCompare(b.entry.id);
}
