import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LinuxIconResolver, iconBaseName, parseKdeIconTheme, parseSizeDir, pickBestIcon } from '../src/icons/linux';
import { grayPng } from './helpers/png';

function makeTree(files: Record<string, string | Uint8Array>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-icons-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/** A real PNG of this size; one that declares a huge bitmap stays small on disk. */
const png = (width: number, height: number): Uint8Array => grayPng(width, height);

describe('Linux icon lookup', () => {
  it('parses theme size folders', () => {
    assert.equal(parseSizeDir('128x128'), 128);
    assert.equal(parseSizeDir('64x64@2'), 64);
    assert.equal(parseSizeDir('48'), 48);
    assert.equal(parseSizeDir('scalable'), 'scalable');
    assert.equal(parseSizeDir('apps'), null);
  });

  it('prefers 128, 256, 96, 64, 48 png, then the largest png up to 256; never svg', () => {
    const c = (size: number | 'scalable', ext: 'png' | 'svg') => ({ file: `${size}.${ext}`, size, ext });
    assert.equal(pickBestIcon([c(48, 'png'), c(256, 'png'), c('scalable', 'svg')])!.file, '256.png');
    assert.equal(pickBestIcon([c(48, 'png'), c(64, 'png')])!.file, '64.png');
    assert.equal(pickBestIcon([c(32, 'png'), c('scalable', 'svg')])!.file, '32.png');
    assert.equal(pickBestIcon([c('scalable', 'svg')]), null);
    assert.equal(pickBestIcon([c(16, 'png'), c(32, 'png')])!.file, '32.png');
    assert.equal(pickBestIcon([c(512, 'png')]), null);
    assert.equal(pickBestIcon([]), null);
  });

  it('finds icons in the current theme, its parents, then hicolor and pixmaps', async () => {
    const root = makeTree({
      'share/icons/Papirus/index.theme': '[Icon Theme]\nName=Papirus\nInherits=breeze,hicolor\n',
      'share/icons/Papirus/64x64/apps/firefox.svg': '<svg/>',
      'share/icons/breeze/apps/48/kate.png': png(48, 48),
      'share/icons/hicolor/48x48/apps/bomb.png': png(20000, 20000),
      'share/icons/hicolor/48x48/apps/vscode.png': 'png48',
      'share/icons/hicolor/128x128/apps/vscode.png': 'png128',
      'share/icons/hicolor/scalable/apps/vscode.svg': '<svg/>',
      'share/icons/hicolor/48x48/actions/vscode-thing.png': 'skip',
      'home/.config/kdeglobals': '[General]\nX=1\n[Icons]\nTheme=Papirus\n',
    });
    const env = { XDG_DATA_DIRS: path.join(root, 'share'), XDG_CURRENT_DESKTOP: 'KDE', XDG_CONFIG_HOME: path.join(root, 'home/.config'), PATH: '' };
    const resolver = new LinuxIconResolver(env, path.join(root, 'home'));
    // SVG only: no icon, and the app shows its placeholder.
    assert.equal(await resolver.resolve('firefox'), null);
    assert.equal(await resolver.resolve('kate'), path.join(root, 'share/icons/breeze/apps/48/kate.png'));
    assert.equal(await resolver.resolve('vscode.png'), path.join(root, 'share/icons/hicolor/128x128/apps/vscode.png'));
    assert.equal(await resolver.resolve('vscode-thing'), null);
    assert.equal(await resolver.load('firefox'), null);
    assert.deepEqual(await resolver.load('kate'), { mime: 'image/png', data: Buffer.from(png(48, 48)).toString('base64') });
    // Not a PNG inside, or a PNG that declares a huge bitmap: not sent.
    assert.equal(await resolver.load('vscode'), null);
    assert.equal(await resolver.load('bomb'), null);
  });

  it('accepts absolute png Icon paths only', async () => {
    const root = makeTree({ 'a.png': 'x', 'b.xpm': 'x', 'c.svg': '<svg/>' });
    const resolver = new LinuxIconResolver({ PATH: '' }, root);
    assert.equal(await resolver.resolve(path.join(root, 'a.png')), path.join(root, 'a.png'));
    assert.equal(await resolver.resolve(path.join(root, 'b.xpm')), null);
    assert.equal(await resolver.resolve(path.join(root, 'c.svg')), null);
    assert.equal(await resolver.resolve(path.join(root, 'missing.png')), null);
  });

  it('reads only regular files: a link to /dev/zero or a FIFO is no icon, and nothing hangs', async () => {
    const root = makeTree({ 'share/icons/hicolor/48x48/apps/real.png': png(48, 48) });
    const apps = path.join(root, 'share/icons/hicolor/48x48/apps');
    fs.symlinkSync('/dev/zero', path.join(apps, 'zero.png'));
    execFileSync('mkfifo', [path.join(apps, 'pipe.png')]);
    const resolver = new LinuxIconResolver({ XDG_DATA_DIRS: path.join(root, 'share'), PATH: '' }, path.join(root, 'home'));
    assert.equal(await resolver.load('zero'), null);
    assert.equal(await resolver.load('pipe'), null);
    assert.notEqual(await resolver.load('real'), null);
  });

  it('reads helpers', () => {
    assert.equal(iconBaseName('org.gnome.Calculator'), 'org.gnome.Calculator');
    assert.equal(iconBaseName('foo.svg'), 'foo');
    assert.equal(parseKdeIconTheme('[Icons]\nTheme=breeze-dark\n[KDE]\nTheme=x\n'), 'breeze-dark');
    assert.equal(parseKdeIconTheme('[KDE]\nTheme=x\n'), null);
  });
});
