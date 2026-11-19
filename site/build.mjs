#!/usr/bin/env node
/**
 * Builds the AuthDeck website into site/out: the home page with its icons, fonts and images, the
 * privacy policy (rendered from app/store/privacy.md), and the current release's downloads (cloned from dist/, so they take no extra disk space on APFS) with
 * a SHA256SUMS file. Run it after the release builds land in dist/.
 *
 *   node site/build.mjs
 */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownToHtml } from './markdown.mjs';

const SITE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(SITE);
const SRC = join(SITE, 'src');
const OUT = join(SITE, 'out');
const DIST = join(REPO, 'dist');
const ICON_DIR = join(REPO, 'app', 'node_modules', 'pixelarticons', 'svg');
/** The privacy policy's one source; the stores link to the page built from it. */
const PRIVACY_SOURCE = join(REPO, 'app', 'store', 'privacy.md');
/** Pieces shared by every page, filled in by the build and not published on their own. */
const PARTIALS = join(SRC, 'partials');
/** Pages with {{PLACEHOLDERS}}: written filled in, never copied as they are. */
const TEMPLATES = [join(SRC, 'index.html'), join(SRC, 'privacy', 'index.html')];
const LICENSE_URL = 'https://github.com/Sarvesh-GanesanW/authdeck/blob/main/LICENSE';
/** Where the site is published; link previews need it absolute. */
const SITE_URL = process.env.AUTHDECK_SITE_URL ?? 'https://authdeck.in/';

/** The release version is the desktop app's version; the phone app ships the same number. */
const VERSION = JSON.parse(await readFile(join(REPO, 'desktop', 'package.json'), 'utf8')).version;

/** Pixel icons the page uses, inlined as an SVG sprite. */
const ICONS = [
  'android', 'apple', 'check', 'copy', 'download', 'external-link', 'git-merge', 'key', 'keyboard',
  'linux', 'link', 'list-box', 'lock', 'monitor', 'play', 'qr-code', 'reload', 'server', 'shield',
  'smartphone', 'square-chevron-right', 'stop', 'tablet', 'terminal', 'text-align-left', 'text-cursor-input',
  'app-windows', 'bug', 'zap', 'pause', 'volume-3', 'volume-x',
];

/** Everything a visitor can download, in the order the page lists it. */
function releaseFiles(version) {
  return [
    { group: 'agent', id: 'mac-arm64', system: 'macOS', detail: 'Apple silicon (M1 and later)', file: `AuthDeck-Agent-${version}-mac-arm64.dmg` },
    { group: 'agent', id: 'mac-x64', system: 'macOS', detail: 'Intel', file: `AuthDeck-Agent-${version}-mac-x64.dmg` },
    { group: 'agent', id: 'win-x64', system: 'Windows', detail: 'Windows 10 and 11, 64-bit', file: `AuthDeck-Agent-${version}-win-x64.exe` },
    { group: 'agent', id: 'linux-appimage', system: 'Linux', detail: 'AppImage, for most distributions', file: `AuthDeck-Agent-${version}-linux-x86_64.AppImage` },
    { group: 'agent', id: 'linux-deb', system: 'Linux', detail: 'Debian, Ubuntu and Pop!_OS (.deb)', file: `AuthDeck-Agent-${version}-linux-amd64.deb` },
    { group: 'app', id: 'android-arm64', system: 'Android', detail: 'Most phones and tablets (64-bit ARM)', file: `AuthDeck-${version}-android-arm64.apk` },
    { group: 'app', id: 'android-universal', system: 'Android', detail: 'Every Android device, larger download', file: `AuthDeck-${version}-android.apk` },
    { group: 'app', id: 'ios-unsigned', system: 'iPhone and iPad', detail: 'Unsigned IPA, for sideloading tools', file: `AuthDeck-${version}-ios-unsigned.ipa` },
  ];
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function megabytes(bytes) {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function readRelease(version) {
  const files = releaseFiles(version);
  const missing = [];
  for (const entry of files) {
    try {
      entry.bytes = (await stat(join(DIST, entry.file))).size;
    } catch {
      missing.push(entry.file);
    }
  }
  if (missing.length) {
    throw new Error(`dist/ is missing ${missing.join(', ')}. Build release ${version} first (see README "Building from source").`);
  }
  for (const entry of files) entry.sha256 = await sha256(join(DIST, entry.file));
  return files;
}

async function iconSprite() {
  const symbols = [];
  for (const name of ICONS) {
    let svg;
    try {
      svg = await readFile(join(ICON_DIR, `${name}.svg`), 'utf8');
    } catch {
      throw new Error(`Icon "${name}" not found in ${ICON_DIR}. Run npm install in app/ first.`);
    }
    const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
    symbols.push(`<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" hidden>${symbols.join('')}</svg>`;
}

function downloadRow(entry) {
  const href = `downloads/${encodeURIComponent(entry.file)}`;
  return `
          <tr id="dl-${entry.id}">
            <th scope="row"><span class="dl-system">${escapeHtml(entry.system)}</span><span class="dl-detail">${escapeHtml(entry.detail)}</span></th>
            <td class="dl-file"><span class="dl-name">${escapeHtml(entry.file)}</span><span class="dl-size">${megabytes(entry.bytes)}</span></td>
            <td class="dl-hash"><button type="button" class="hash" data-hash="${entry.sha256}" aria-label="Copy the SHA-256 of ${escapeHtml(entry.file)}"><span>${entry.sha256.slice(0, 12)}…</span><svg aria-hidden="true"><use href="#i-copy"/></svg></button></td>
            <td class="dl-get"><a class="btn btn-quiet" href="${href}" download><span class="btn-face"><svg aria-hidden="true"><use href="#i-download"/></svg>Download</span></a></td>
          </tr>`;
}

/** What the page script needs to point the main button at the right file. */
function primaryDownloads(files) {
  return Object.fromEntries(files.map((entry) => [entry.id, { href: `downloads/${encodeURIComponent(entry.file)}`, size: megabytes(entry.bytes) }]));
}

function fillTemplate(template, values, name) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`${name} asks for {{${key}}}, which the build doesn't provide.`);
    return values[key];
  });
}

/** Fills a page template; `root` is the relative path from the page back to the site's top. */
async function renderPage(relPath, root, values) {
  const shared = { VERSION, ROOT: root, LICENSE_URL };
  const footer = fillTemplate(await readFile(join(PARTIALS, 'footer.html'), 'utf8'), shared, 'partials/footer.html');
  const template = await readFile(join(SRC, relPath), 'utf8');
  const html = fillTemplate(template, {
    ...shared,
    SITE_URL: escapeHtml(SITE_URL),
    MARK_SPRITE: await readFile(join(PARTIALS, 'mark.html'), 'utf8'),
    FOOTER: footer,
    ...values,
  }, relPath);
  await mkdir(dirname(join(OUT, relPath)), { recursive: true });
  await writeFile(join(OUT, relPath), html);
}

function isPublished(path) {
  return !TEMPLATES.includes(path) && path !== PARTIALS && dirname(path) !== PARTIALS;
}

async function cloneInto(source, target) {
  // A clone on APFS costs no space; elsewhere this falls back to a copy.
  await copyFile(source, target, constants.COPYFILE_FICLONE);
}

async function build() {
  const files = await readRelease(VERSION);
  await rm(OUT, { recursive: true, force: true });
  await cp(SRC, OUT, { recursive: true, filter: isPublished });
  await renderPage('index.html', '', {
    ICON_SPRITE: await iconSprite(),
    AGENT_ROWS: files.filter((f) => f.group === 'agent').map(downloadRow).join(''),
    APP_ROWS: files.filter((f) => f.group === 'app').map(downloadRow).join(''),
    PRIMARY_DOWNLOADS: JSON.stringify(primaryDownloads(files)).replace(/</g, '\\u003c'),
  });
  await renderPage(join('privacy', 'index.html'), '../', {
    POLICY: markdownToHtml(await readFile(PRIVACY_SOURCE, 'utf8')),
  });

  const downloads = join(OUT, 'downloads');
  await mkdir(downloads, { recursive: true });
  for (const entry of files) await cloneInto(join(DIST, entry.file), join(downloads, entry.file));
  await writeFile(join(downloads, 'SHA256SUMS'), files.map((f) => `${f.sha256}  ${f.file}\n`).join(''));
  // The folder itself has no listing; send anyone who opens it to the download table.
  await writeFile(join(downloads, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=../#download"><title>AuthDeck downloads</title><a href="../#download">AuthDeck downloads</a>\n');

  console.log(`Built AuthDeck ${VERSION} site in ${OUT} with ${files.length} downloads.`);
}

await build();
