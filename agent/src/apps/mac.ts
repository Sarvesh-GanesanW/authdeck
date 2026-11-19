import fs from 'node:fs/promises';
import path from 'node:path';
import { mapLimit, runProcess } from '../proc';
import type { InstalledApp } from './types';

const PLUTIL_CONCURRENCY = 8;
const FINDER_PATH = '/System/Library/CoreServices/Finder.app';

/** Folders searched for .app bundles; /Applications is also searched one level down. */
function macAppFolders(home: string): { dir: string; descend: boolean }[] {
  return [
    { dir: '/Applications', descend: true },
    { dir: '/Applications/Utilities', descend: false },
    { dir: '/System/Applications', descend: false },
    { dir: '/System/Applications/Utilities', descend: false },
    { dir: path.join(home, 'Applications'), descend: true },
  ];
}

interface InfoPlist {
  CFBundleDisplayName?: unknown;
  CFBundleName?: unknown;
  CFBundleIdentifier?: unknown;
}

/** Display name the way Finder would show it, from Info.plist with the folder name as fallback. */
export function macAppName(plist: InfoPlist, bundlePath: string): string {
  const fromPlist = [plist.CFBundleDisplayName, plist.CFBundleName].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return fromPlist ?? path.basename(bundlePath, '.app');
}

export async function scanMacApps(home: string): Promise<InstalledApp[]> {
  const bundles: string[] = [];
  for (const { dir, descend } of macAppFolders(home)) bundles.push(...(await findBundles(dir, descend)));
  bundles.push(FINDER_PATH);

  const apps = await mapLimit([...new Set(bundles)], PLUTIL_CONCURRENCY, readBundle);
  const seenBundleIds = new Set<string>();
  return apps.filter((app): app is InstalledApp & { platform: 'macos' } => {
    if (!app) return false;
    if (!app.bundleId) return true;
    if (seenBundleIds.has(app.bundleId)) return false;
    seenBundleIds.add(app.bundleId);
    return true;
  });
}

async function findBundles(dir: string, descend: boolean): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.endsWith('.app')) found.push(full);
    else if (descend && entry.isDirectory() && full !== '/Applications/Utilities') found.push(...(await findBundles(full, false)));
  }
  return found;
}

async function readBundle(bundlePath: string): Promise<(InstalledApp & { platform: 'macos' }) | null> {
  try {
    await fs.access(bundlePath);
  } catch {
    return null;
  }
  const plist = await readInfoPlist(path.join(bundlePath, 'Contents', 'Info.plist'));
  const bundleId = typeof plist.CFBundleIdentifier === 'string' ? plist.CFBundleIdentifier : null;
  return {
    platform: 'macos',
    entry: { id: `mac:${bundlePath}`, name: macAppName(plist, bundlePath), ...(bundleId ? { detail: bundleId } : {}), hasIcon: true },
    bundlePath,
    bundleId,
  };
}

/** Reads Info.plist via plutil (handles binary plists). JSON fails on <date>/<data> values, so XML is the fallback. */
async function readInfoPlist(plistPath: string): Promise<InfoPlist> {
  const asJson = await runProcess('plutil', ['-convert', 'json', '-o', '-', plistPath], { timeoutMs: 10_000, tailChars: 1 });
  if (asJson.exitCode === 0) {
    try {
      return JSON.parse(asJson.stdout) as InfoPlist;
    } catch {
      // fall through to XML
    }
  }
  const asXml = await runProcess('plutil', ['-convert', 'xml1', '-o', '-', plistPath], { timeoutMs: 10_000, tailChars: 1 });
  return asXml.exitCode === 0 ? parsePlistXmlStrings(asXml.stdout) : {};
}

/** Top-level string values of an XML plist; enough for the three keys we need. */
export function parsePlistXmlStrings(xml: string): InfoPlist {
  const result: Record<string, string> = {};
  for (const match of xml.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    const key = decodeXmlEntities(match[1]!);
    if (!(key in result)) result[key] = decodeXmlEntities(match[2]!);
  }
  return result;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}
