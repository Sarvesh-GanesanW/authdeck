import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  CLI_SCRIPT,
  CliPathCancelled,
  CliPathError,
  addPathEntry,
  cliPathState,
  installCli,
  linuxLauncher,
  refreshCli,
  removeCli,
  removePathEntry,
  shellQuote,
  type CliLayout,
  type CliSystem,
} from '../src/main/cliPath.ts';

const MAC_APP = '/Applications/AuthDeck Agent.app/Contents/Resources/cli';
const MAC_LINK = '/usr/local/bin/authdeck';
const LINUX_HOME = '/home/maya';
const LINUX_LAUNCHER = '/home/maya/.local/bin/authdeck';
const WIN_CLI = 'C:\\Users\\maya\\AppData\\Local\\Programs\\AuthDeck Agent\\resources\\cli';

type Entry = { text: string } | { link: string };

/** A file system in a map. Folders listed in `readOnly` refuse changes the way root's folders do. */
function fakeSystem(entries: Record<string, Entry>, options: { readOnly?: string[]; userPath?: string; cancel?: boolean } = {}) {
  const fs = new Map<string, Entry>(Object.entries(entries));
  const log: string[] = [];
  let userPath = options.userPath ?? '';
  const guard = (file: string) => {
    if ((options.readOnly ?? []).includes(path.posix.dirname(file))) throw Object.assign(new Error(`EACCES: ${file}`), { code: 'EACCES' });
  };
  const system: CliSystem = {
    files: {
      exists: (file) => fs.has(file),
      readLink: (file) => {
        const entry = fs.get(file);
        return entry && 'link' in entry ? entry.link : null;
      },
      readText: (file) => {
        const entry = fs.get(file);
        if (!entry) return null;
        if ('link' in entry) throw new Error('reading through links is not faked');
        return entry.text;
      },
      writeExecutable: (file, text) => {
        guard(file);
        fs.set(file, { text });
        log.push(`write ${file}`);
      },
      symlink: (target, file) => {
        guard(file);
        fs.set(file, { link: target });
        log.push(`symlink ${file}`);
      },
      remove: (file) => {
        if (!fs.has(file)) return;
        guard(file);
        fs.delete(file);
        log.push(`remove ${file}`);
      },
    },
    admin: {
      link: async (target, file) => {
        if (options.cancel) throw new CliPathCancelled();
        fs.set(file, { link: target });
        log.push(`admin link ${file}`);
      },
      unlink: async (file) => {
        if (options.cancel) throw new CliPathCancelled();
        fs.delete(file);
        log.push(`admin unlink ${file}`);
      },
    },
    userPath: {
      read: async () => userPath,
      write: async (value) => {
        userPath = value;
        log.push(`user PATH ${value}`);
      },
    },
  };
  return { system, fs, log, userPath: () => userPath };
}

function layout(platform: CliLayout['platform'], overrides: Partial<CliLayout> = {}): CliLayout {
  const base: Record<CliLayout['platform'], CliLayout> = {
    macos: { platform, name: 'authdeck', cliDir: MAC_APP, home: '/Users/maya', executable: '', appImage: false, dataDir: '', envPath: '/usr/local/bin:/usr/bin:/bin' },
    linux: {
      platform,
      name: 'authdeck',
      cliDir: '/opt/AuthDeck Agent/resources/cli',
      home: LINUX_HOME,
      executable: '/opt/AuthDeck Agent/authdeck-agent',
      appImage: false,
      dataDir: '/home/maya/.local/share/authdeck-agent',
      envPath: '/home/maya/.local/bin:/usr/bin:/bin',
    },
    windows: { platform, name: 'authdeck', cliDir: WIN_CLI, home: 'C:\\Users\\maya', executable: '', appImage: false, dataDir: '', envPath: '' },
  };
  return { ...base[platform], ...overrides };
}

const macShipped = { [`${MAC_APP}/${CLI_SCRIPT}`]: { text: 'cli' }, [`${MAC_APP}/authdeck`]: { text: '#!/bin/sh' } };
const linuxShipped = { [`/opt/AuthDeck Agent/resources/cli/${CLI_SCRIPT}`]: { text: 'cli' } };
const winShipped = { [`${WIN_CLI}\\${CLI_SCRIPT}`]: { text: 'cli' }, [`${WIN_CLI}\\authdeck.cmd`]: { text: '@echo off' } };

describe('authdeck on the PATH: macOS', () => {
  it('offers nothing when the build has no command', async () => {
    const { system } = fakeSystem({});
    assert.equal(await cliPathState(layout('macos'), system), null);
    await assert.rejects(installCli(layout('macos'), system), CliPathError);
  });

  it('links /usr/local/bin/authdeck to the wrapper in the bundle, without a prompt when the folder is writable', async () => {
    const mac = layout('macos');
    const { system, fs, log } = fakeSystem(macShipped);
    assert.deepEqual(await cliPathState(mac, system), { state: 'absent', location: MAC_LINK });
    await installCli(mac, system);
    assert.deepEqual(fs.get(MAC_LINK), { link: `${MAC_APP}/authdeck` });
    assert.deepEqual(log, [`symlink ${MAC_LINK}`]);
    assert.deepEqual(await cliPathState(mac, system), { state: 'installed', location: MAC_LINK, onPath: true });
  });

  it('asks for an administrator when /usr/local/bin belongs to root, both ways', async () => {
    const mac = layout('macos');
    const { system, log } = fakeSystem(macShipped, { readOnly: ['/usr/local/bin'] });
    await installCli(mac, system);
    assert.equal((await cliPathState(mac, system))?.state, 'installed');
    await removeCli(mac, system);
    assert.equal((await cliPathState(mac, system))?.state, 'absent');
    assert.deepEqual(log, [`admin link ${MAC_LINK}`, `admin unlink ${MAC_LINK}`]);
  });

  it('passes Cancel at the prompt on, changing nothing', async () => {
    const { system, fs } = fakeSystem(macShipped, { readOnly: ['/usr/local/bin'], cancel: true });
    await assert.rejects(installCli(layout('macos'), system), CliPathCancelled);
    assert.equal(fs.has(MAC_LINK), false);
  });

  it("calls a link to a moved copy of the app stale and points it at this one", async () => {
    const mac = layout('macos');
    const { system, fs } = fakeSystem({ ...macShipped, [MAC_LINK]: { link: '/Users/maya/Downloads/AuthDeck Agent.app/Contents/Resources/cli/authdeck' } });
    assert.deepEqual(await cliPathState(mac, system), { state: 'stale', location: MAC_LINK });
    await installCli(mac, system);
    assert.deepEqual(fs.get(MAC_LINK), { link: `${MAC_APP}/authdeck` });
  });

  it("never replaces or removes another program's authdeck", async () => {
    const mac = layout('macos');
    for (const entry of [{ text: '#!/bin/sh\necho other' }, { link: '/opt/homebrew/Cellar/authdeck/1.0/bin/authdeck' }]) {
      const { system, fs } = fakeSystem({ ...macShipped, [MAC_LINK]: entry });
      assert.deepEqual(await cliPathState(mac, system), { state: 'taken', location: MAC_LINK });
      await assert.rejects(installCli(mac, system), /belongs to another program/);
      await assert.rejects(removeCli(mac, system), /belongs to another program/);
      assert.deepEqual(fs.get(MAC_LINK), entry);
    }
  });

  it('removing when absent does nothing', async () => {
    const { system, log } = fakeSystem(macShipped);
    await removeCli(layout('macos'), system);
    assert.deepEqual(log, []);
  });
});

describe('authdeck on the PATH: Linux', () => {
  it('writes a launcher in ~/.local/bin that runs the app in its CLI mode', async () => {
    const linux = layout('linux');
    const { system, fs } = fakeSystem(linuxShipped);
    assert.deepEqual(await cliPathState(linux, system), { state: 'absent', location: LINUX_LAUNCHER });
    await installCli(linux, system);
    const launcher = fs.get(LINUX_LAUNCHER);
    assert.ok(launcher && 'text' in launcher);
    assert.match(launcher.text, /^#!\/bin\/sh\n/);
    assert.match(launcher.text, /\nexec '\/opt\/AuthDeck Agent\/authdeck-agent' --authdeck-cli -- "\$@"\n$/);
    assert.doesNotMatch(launcher.text, /ELECTRON_RUN_AS_NODE/);
    assert.deepEqual(await cliPathState(linux, system), { state: 'installed', location: LINUX_LAUNCHER, onPath: true });
    await removeCli(linux, system);
    assert.equal(fs.has(LINUX_LAUNCHER), false);
  });

  it('says so when ~/.local/bin is not on the PATH yet', async () => {
    const linux = layout('linux', { envPath: '/usr/bin:/bin' });
    const { system } = fakeSystem(linuxShipped);
    await installCli(linux, system);
    assert.deepEqual(await cliPathState(linux, system), { state: 'installed', location: LINUX_LAUNCHER, onPath: false });
  });

  it('runs an AppImage itself, and removes the script copy older versions made', async () => {
    const linux = layout('linux', { appImage: true, executable: '/home/maya/Apps/AuthDeck-Agent.AppImage', cliDir: '/tmp/.mount_AuthDeXY/resources/cli' });
    const oldCopy = '/home/maya/.local/share/authdeck-agent/authdeck.cjs';
    const { system, fs } = fakeSystem({ [`/tmp/.mount_AuthDeXY/resources/cli/${CLI_SCRIPT}`]: { text: 'cli v1' }, [oldCopy]: { text: 'cli v0' } });
    await installCli(linux, system);
    assert.match(linuxLauncher(linux), /\nexec '\/home\/maya\/Apps\/AuthDeck-Agent\.AppImage' --authdeck-cli -- "\$@"\n$/);
    assert.equal(fs.has(oldCopy), false);
    await removeCli(linux, system);
    assert.equal(fs.has(LINUX_LAUNCHER), false);
  });

  it('rewrites our launcher at start when the app moved, and leaves others alone', async () => {
    const before = layout('linux', { executable: '/old/authdeck-agent' });
    const after = layout('linux');
    const { system, fs } = fakeSystem({ ...linuxShipped, [LINUX_LAUNCHER]: { text: linuxLauncher(before) } });
    assert.equal((await cliPathState(after, system))?.state, 'stale');
    await refreshCli(after, system);
    assert.deepEqual(fs.get(LINUX_LAUNCHER), { text: linuxLauncher(after) });

    const other = fakeSystem({ ...linuxShipped, [LINUX_LAUNCHER]: { text: '#!/bin/sh\nexec something-else' } });
    assert.equal((await cliPathState(after, other.system))?.state, 'taken');
    await refreshCli(after, other.system);
    assert.deepEqual(other.log, []);
  });

  it('leaves a launcher alone at start when the person never installed one', async () => {
    const { system, log } = fakeSystem(linuxShipped);
    await refreshCli(layout('linux'), system);
    assert.deepEqual(log, []);
  });

  it('quotes paths with quotes in them for sh', () => {
    assert.equal(shellQuote("/home/o'neil/app"), `'/home/o'\\''neil/app'`);
  });
});

describe('authdeck on the PATH: Windows', () => {
  it("adds the app's cli folder to the user PATH, once, and takes it off again", async () => {
    const win = layout('windows');
    const fake = fakeSystem(winShipped, { userPath: '%USERPROFILE%\\bin;C:\\Tools' });
    assert.deepEqual(await cliPathState(win, fake.system), { state: 'absent', location: WIN_CLI });
    await installCli(win, fake.system);
    assert.equal(fake.userPath(), `%USERPROFILE%\\bin;C:\\Tools;${WIN_CLI}`);
    assert.deepEqual(await cliPathState(win, fake.system), { state: 'installed', location: WIN_CLI, onPath: true });
    await installCli(win, fake.system);
    assert.equal(fake.userPath(), `%USERPROFILE%\\bin;C:\\Tools;${WIN_CLI}`, 'not added twice');
    await removeCli(win, fake.system);
    assert.equal(fake.userPath(), '%USERPROFILE%\\bin;C:\\Tools');
  });

  it('starts a PATH that was empty', () => {
    assert.equal(addPathEntry('', WIN_CLI), WIN_CLI);
  });

  it('matches entries the way Windows does: any case, quotes, trailing slash', () => {
    const value = `C:\\Tools;"${WIN_CLI.toUpperCase()}\\";;C:\\Other`;
    assert.equal(addPathEntry(value, WIN_CLI), `C:\\Tools;"${WIN_CLI.toUpperCase()}\\";C:\\Other`);
    assert.equal(removePathEntry(value, WIN_CLI), 'C:\\Tools;C:\\Other');
  });
});
