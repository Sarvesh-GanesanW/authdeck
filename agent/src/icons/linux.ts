import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { xdgDataDirs } from '../apps/linux';
import type { AppIcon } from '../protocol';
import { runProcess } from '../proc';
import { cleanIcon, MAX_ICON_PIXELS, MAX_ICON_PNG_BYTES } from './png';

const PREFERRED_PNG_SIZES = [128, 256, 96, 64, 48];
const FALLBACK_THEME = 'hicolor';
const KDE_DEFAULT_THEME = 'breeze';
/** Theme sub-folders that never hold app icons; skipping them keeps big themes cheap to index. */
const SKIPPED_CONTEXTS = new Set(['actions', 'emblems', 'emotes', 'animations', 'status', 'panel', 'stock', 'symbolic']);

type IconSize = number | 'scalable';
interface IconCandidate {
  file: string;
  size: IconSize;
  ext: 'png' | 'svg';
}

/** Folders that contain icon themes, highest priority first. */
function iconBaseDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  return [
    ...new Set([
      path.join(home, '.icons'),
      ...xdgDataDirs(env, home).map((dir) => path.join(dir, 'icons')),
      path.join(home, '.local/share/flatpak/exports/share/icons'),
      '/var/lib/flatpak/exports/share/icons',
    ]),
  ];
}

/** Size encoded in a theme folder name: "128x128", "128x128@2", "48", "scalable". */
export function parseSizeDir(name: string): IconSize | null {
  if (name === 'scalable') return 'scalable';
  const match = /^(\d+)(?:x\d+)?(?:@\d+x?)?$/.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Best file for an icon: a PNG in the preferred sizes, in order, then the largest PNG up to 256.
 * Only PNGs: an SVG-only icon is sent as no icon (the app shows its placeholder), since an SVG
 * any local program can install could make the app's renderer recurse or hang.
 */
export function pickBestIcon(candidates: readonly IconCandidate[]): IconCandidate | null {
  for (const size of PREFERRED_PNG_SIZES) {
    const png = candidates.find((c) => c.ext === 'png' && c.size === size);
    if (png) return png;
  }
  const pngs = candidates.filter((c) => c.ext === 'png' && typeof c.size === 'number' && c.size <= MAX_ICON_PIXELS);
  pngs.sort((a, b) => (b.size as number) - (a.size as number));
  return pngs[0] ?? null;
}

/** Icon name as written in Icon= minus a stray extension ("foo.png" -> "foo"). */
export function iconBaseName(icon: string): string {
  return icon.replace(/\.(png|svg|xpm)$/i, '');
}

export class LinuxIconResolver {
  private readonly themeIndexes = new Map<string, Promise<Map<string, IconCandidate[]>>>();
  private themeChain: Promise<string[]> | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly home: string,
  ) {}

  async load(icon: string): Promise<AppIcon | null> {
    const file = await this.resolve(icon);
    return file ? readIconFile(file) : null;
  }

  async resolve(icon: string): Promise<string | null> {
    if (path.isAbsolute(icon)) return (await isFile(icon)) && /\.png$/i.test(icon) ? icon : null;
    const name = iconBaseName(icon);
    for (const theme of await this.themes()) {
      const best = pickBestIcon((await this.themeIndex(theme)).get(name) ?? []);
      if (best) return best.file;
    }
    const pixmap = path.join('/usr/share/pixmaps', `${name}.png`);
    return (await isFile(pixmap)) ? pixmap : null;
  }

  private themes(): Promise<string[]> {
    this.themeChain ??= (async () => {
      const current = await detectIconTheme(this.env, this.home);
      const chain = current ? [current, ...(await this.inheritedThemes(current))] : [];
      return [...new Set([...chain, FALLBACK_THEME])];
    })();
    return this.themeChain;
  }

  private async inheritedThemes(theme: string, depth = 0): Promise<string[]> {
    if (depth > 3) return [];
    for (const base of iconBaseDirs(this.env, this.home)) {
      const index = await fs.readFile(path.join(base, theme, 'index.theme'), 'utf8').catch(() => null);
      if (index === null) continue;
      const parents = /^Inherits\s*=\s*(.+)$/m.exec(index)?.[1]?.split(',').map((t) => t.trim()).filter(Boolean) ?? [];
      const deeper = await Promise.all(parents.map((parent) => this.inheritedThemes(parent, depth + 1)));
      return [...parents, ...deeper.flat()];
    }
    return [];
  }

  private themeIndex(theme: string): Promise<Map<string, IconCandidate[]>> {
    let index = this.themeIndexes.get(theme);
    if (!index) {
      index = buildThemeIndex(iconBaseDirs(this.env, this.home).map((base) => path.join(base, theme)));
      this.themeIndexes.set(theme, index);
    }
    return index;
  }
}

/** Indexes icons in theme folders laid out as size/context/name or context/size/name. */
async function buildThemeIndex(themeDirs: string[]): Promise<Map<string, IconCandidate[]>> {
  const index = new Map<string, IconCandidate[]>();
  const add = (file: string, size: IconSize) => {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (ext !== 'png' && ext !== 'svg') return;
    const name = path.basename(file, path.extname(file));
    if (name.endsWith('-symbolic')) return;
    const list = index.get(name) ?? [];
    list.push({ file, size, ext });
    index.set(name, list);
  };
  for (const themeDir of themeDirs) {
    for (const first of await subdirs(themeDir)) {
      const firstSize = parseSizeDir(first);
      if (firstSize === null && SKIPPED_CONTEXTS.has(first)) continue;
      for (const second of await subdirs(path.join(themeDir, first))) {
        const size = firstSize ?? parseSizeDir(second);
        if (size === null || SKIPPED_CONTEXTS.has(second)) continue;
        const dir = path.join(themeDir, first, second);
        for (const file of await fs.readdir(dir).catch(() => [])) add(path.join(dir, file), size);
      }
    }
  }
  return index;
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
}

async function isFile(file: string): Promise<boolean> {
  return fs.stat(file).then((s) => s.isFile(), () => false);
}

/** The file as an icon, cleaned, if it really is a PNG of at most 256×256 and 256 KB (the folder name may lie). */
async function readIconFile(file: string): Promise<AppIcon | null> {
  // A regular file only: a link to /dev/zero or a FIFO would be read without end or hang.
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.size > MAX_ICON_PNG_BYTES) return null;
  const png = await readAtMost(file, MAX_ICON_PNG_BYTES + 1);
  const icon = png && cleanIcon(png);
  return icon ? { mime: 'image/png', data: icon.toString('base64') } : null;
}

/** At most `limit` bytes of the file, opened without blocking, so a file swapped for a FIFO can't hang the read. */
async function readAtMost(file: string, limit: number): Promise<Buffer | null> {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return bytesRead < limit ? buffer.subarray(0, bytesRead) : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Current icon theme from GNOME settings or KDE's kdeglobals; null when unknown. */
async function detectIconTheme(env: NodeJS.ProcessEnv, home: string): Promise<string | null> {
  const gsettings = await runProcess('gsettings', ['get', 'org.gnome.desktop.interface', 'icon-theme'], { timeoutMs: 3000 }).catch(() => null);
  const gnomeTheme = gsettings?.exitCode === 0 ? gsettings.stdout.trim().replace(/^'|'$/g, '') : '';
  if (gnomeTheme && !/plasma|kde/i.test(env.XDG_CURRENT_DESKTOP ?? '')) return gnomeTheme;
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const kdeglobals = await fs.readFile(path.join(configHome, 'kdeglobals'), 'utf8').catch(() => '');
  const isKde = /plasma|kde/i.test(env.XDG_CURRENT_DESKTOP ?? '');
  return parseKdeIconTheme(kdeglobals) ?? (gnomeTheme || (isKde ? KDE_DEFAULT_THEME : null));
}

export function parseKdeIconTheme(kdeglobals: string): string | null {
  const section = /^\[Icons\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(kdeglobals)?.[1] ?? '';
  return /^Theme\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() ?? null;
}
