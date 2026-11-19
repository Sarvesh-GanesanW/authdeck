import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { InstalledApp } from '../apps/types';
import type { AppIcon } from '../protocol';
import type { LinuxIconResolver } from './linux';
import { renderMacIcons } from './mac';
import { cleanIcon, MAX_ICON_PIXELS } from './png';
import { runProcess } from '../proc';
import { aumidShellPath, renderWindowsIcons } from './windows';

const NO_ICON_SUFFIX = '.none';

/** Serves app icons, caching rendered PNGs on disk keyed by app id and the app file's mtime. */
export class IconService {
  constructor(
    private readonly cacheDir: string,
    private readonly linuxResolver: LinuxIconResolver | null,
  ) {}

  async icons(apps: Map<string, InstalledApp | undefined>): Promise<Record<string, AppIcon | null>> {
    const result: Record<string, AppIcon | null> = {};
    const toRender: { id: string; app: InstalledApp; cacheBase: string }[] = [];
    for (const [id, app] of apps) {
      result[id] = null;
      if (!app || !app.entry.hasIcon) continue;
      if (app.platform === 'linux') {
        result[id] = app.desktop.icon ? await this.linuxResolver!.load(app.desktop.icon) : null;
        continue;
      }
      const cacheBase = await this.cacheBase(app);
      const cached = await readCached(cacheBase);
      if (cached === undefined) toRender.push({ id, app, cacheBase });
      else result[id] = cached;
    }
    if (toRender.length > 0) {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const rendered = await this.render(toRender);
      for (const [index, job] of toRender.entries()) {
        const png = await servable(rendered[index] ?? null, job.app.platform, `${job.cacheBase}.png`);
        result[job.id] = png ? { mime: 'image/png', data: png.toString('base64') } : null;
        await (png ? fs.writeFile(`${job.cacheBase}.png`, png) : fs.writeFile(job.cacheBase + NO_ICON_SUFFIX, ''));
      }
    }
    return result;
  }

  private async cacheBase(app: InstalledApp): Promise<string> {
    const source = iconSourceFile(app);
    const mtime = source ? Math.trunc((await fs.stat(source).catch(() => null))?.mtimeMs ?? 0) : 0;
    const hash = crypto.createHash('sha1').update(app.entry.id).digest('hex').slice(0, 20);
    return path.join(this.cacheDir, `${hash}-${mtime}`);
  }

  /** All jobs come from one platform's catalog. */
  private async render(jobs: { app: InstalledApp; cacheBase: string }[]): Promise<(Buffer | null)[]> {
    if (jobs[0]!.app.platform === 'macos') {
      const ok = await renderMacIcons(jobs.map((job) => ({ src: renderSource(job.app), dest: `${job.cacheBase}.png` })));
      // The script wrote the files itself; read them back.
      return Promise.all(jobs.map((job, i) => (ok[i] ? fs.readFile(`${job.cacheBase}.png`) : null)));
    }
    const pngs = await renderWindowsIcons(jobs.map((job) => ({ path: renderSource(job.app) })));
    return pngs.map((png) => (png ? Buffer.from(png, 'base64') : null));
  }
}

/** What the OS icon renderer is pointed at. */
function renderSource(app: InstalledApp): string {
  switch (app.platform) {
    case 'macos':
      return app.bundlePath;
    case 'windows':
      return app.kind === 'aumid' ? aumidShellPath(app.aumid) : app.lnkPath;
    case 'linux':
      return app.desktop.filePath;
  }
}

/** File whose change should invalidate the cached icon. */
function iconSourceFile(app: InstalledApp): string | null {
  switch (app.platform) {
    case 'macos':
      return path.join(app.bundlePath, 'Contents', 'Info.plist');
    case 'windows':
      return app.kind === 'lnk' ? app.lnkPath : null;
    case 'linux':
      return app.desktop.filePath;
  }
}

/**
 * The rendered icon, cleaned (png.ts cleanIcon), if the app will take it (a PNG up to 256×256 and
 * 256 KB). macOS and Windows render at 128, so this is a guard: a bigger PNG on macOS is scaled
 * down with sips, and anything still unfit is sent as no icon.
 */
async function servable(png: Buffer | null, platform: InstalledApp['platform'], file: string): Promise<Buffer | null> {
  if (!png) return null;
  const cleaned = cleanIcon(png);
  if (cleaned || platform !== 'macos') return cleaned;
  await fs.writeFile(file, png);
  const scaled = await runProcess('sips', ['-s', 'format', 'png', '-Z', String(MAX_ICON_PIXELS), file], { timeoutMs: 10_000 }).catch(() => null);
  const again = scaled?.exitCode === 0 ? await fs.readFile(file).catch(() => null) : null;
  const scaledIcon = again && cleanIcon(again);
  if (scaledIcon) return scaledIcon;
  await fs.rm(file, { force: true });
  return null;
}

/** Cached icon, null when a previous render found none, undefined when not cached. */
async function readCached(cacheBase: string): Promise<AppIcon | null | undefined> {
  const png = await fs.readFile(`${cacheBase}.png`).catch(() => null);
  // A cache from before icons were checked or cleaned may hold anything: clean it, or render it again.
  const icon = png && cleanIcon(png);
  if (icon) return { mime: 'image/png', data: icon.toString('base64') };
  if (png) return undefined;
  const none = await fs.stat(cacheBase + NO_ICON_SUFFIX).catch(() => null);
  return none ? null : undefined;
}
