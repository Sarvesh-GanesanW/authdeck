import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { applicationDirs, desktopFileId, scanLinuxApps } from '../src/apps/linux';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'linux');

function scan(desktop: string, lang?: string) {
  return scanLinuxApps({
    env: {
      XDG_DATA_HOME: path.join(fixtures, 'home/.local/share'),
      XDG_DATA_DIRS: [path.join(fixtures, 'usr/share'), path.join(fixtures, 'flatpak')].join(':'),
      XDG_CURRENT_DESKTOP: desktop,
      ...(lang ? { LANG: lang } : {}),
    },
    home: path.join(fixtures, 'no-home'),
    hasTool: (name) => name !== 'missing-tool-xyz',
  });
}

describe('Linux app scan', () => {
  it('lists visible applications with XDG desktop ids', async () => {
    const apps = await scan('ubuntu:GNOME');
    const ids = apps.map((a) => a.entry.id).sort();
    assert.deepEqual(ids, [
      'linux:code.desktop',
      'linux:firefox.desktop',
      'linux:gnome-only.desktop',
      'linux:htop.desktop',
      'linux:kde4-kate.desktop',
      'linux:not-kde.desktop',
      'linux:org.gnome.Calculator.desktop',
    ]);
  });

  it('lets earlier dirs (the user dir) shadow later ones', async () => {
    const firefox = (await scan('GNOME')).find((a) => a.entry.id === 'linux:firefox.desktop');
    assert.equal(firefox?.entry.name, 'Firefox (user override)');
  });

  it('applies OnlyShowIn and NotShowIn for the current desktop', async () => {
    const names = (await scan('KDE')).map((a) => a.entry.name);
    assert.ok(!names.includes('GNOME Only'));
    assert.ok(!names.includes('Not On KDE'));
  });

  it('keeps Exec, Icon, WM class and Terminal internally', async () => {
    const apps = await scan('GNOME', 'de_DE.UTF-8');
    const code = apps.find((a) => a.entry.id === 'linux:code.desktop');
    assert.ok(code?.platform === 'linux');
    assert.equal(code.entry.name, 'Visual Studio Code (DE)');
    assert.equal(code.desktop.exec, '/usr/share/code/code --unity-launch %F');
    assert.equal(code.desktop.icon, 'vscode');
    assert.equal(code.desktop.startupWMClass, 'Code');
    const htop = apps.find((a) => a.entry.id === 'linux:htop.desktop');
    assert.ok(htop?.platform === 'linux');
    assert.equal(htop.entry.name, 'Htop Monitor');
    assert.equal(htop.desktop.terminal, true);
    assert.equal(htop.entry.hasIcon, false);
  });

  it('builds ids from the path below the applications dir', () => {
    assert.equal(desktopFileId('/usr/share/applications', '/usr/share/applications/kde4/kate.desktop'), 'kde4-kate.desktop');
  });

  it('searches XDG dirs, then flatpak and snap exports', () => {
    assert.deepEqual(applicationDirs({}, '/home/ada'), [
      '/home/ada/.local/share/applications',
      '/usr/local/share/applications',
      '/usr/share/applications',
      '/home/ada/.local/share/flatpak/exports/share/applications',
      '/var/lib/flatpak/exports/share/applications',
      '/var/lib/snapd/desktop/applications',
    ]);
  });
});
