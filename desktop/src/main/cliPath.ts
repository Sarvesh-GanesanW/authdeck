/**
 * Puts the `authdeck` command that ships inside AuthDeck Agent on the PATH, says whether it is
 * there, and takes it off again. The file system, the macOS admin prompt and the Windows user
 * PATH are passed in (cliPathSystem.ts has the real ones), so this logic is tested with fakes.
 *
 * - macOS: a symlink in /usr/local/bin to the wrapper script in the app bundle. /usr/local/bin is
 *   on every shell's PATH out of the box (/etc/paths) and the link follows app updates; it costs
 *   one admin prompt where the folder isn't writable. ~/.local/bin would need no prompt but is on
 *   no macOS PATH, so it would mean editing shell profiles.
 * - Linux: a launcher script in ~/.local/bin, rewritten at each start; for an AppImage it runs
 *   the AppImage itself.
 * - Windows: the app's cli folder (authdeck.cmd) on the user PATH.
 *
 * Every launcher starts the app in its CLI mode (CLI_MODE_FLAG, then `--` and the person's
 * arguments), where it runs only its own bundled command, so the computer needs no Node.js. The
 * app is never a general Node runtime: its RunAsNode fuse is off (scripts/afterPack.mjs).
 */
import path from 'node:path';
import type { CliPathState, Platform } from '../shared/state';

/** The command's bundled script, and the wrapper beside it that macOS links to and Windows runs. */
export const CLI_SCRIPT = 'authdeck.cjs';
/**
 * The app's first argument when a launcher runs the command. The person's arguments follow a `--`,
 * after which Chromium reads no switches, so none of them can change how the app itself starts.
 */
export const CLI_MODE_FLAG = '--authdeck-cli';
export const CLI_ARGS_SEPARATOR = '--';
const MAC_BIN_DIR = '/usr/local/bin';
const LINUX_BIN_DIR = path.posix.join('.local', 'bin');
/** The line that marks a Linux launcher as ours, so another program's `authdeck` is never touched. */
export const LINUX_LAUNCHER_MARK = '# Put here by AuthDeck Agent. Remove it in the AuthDeck Agent window.';
/** Any copy of the app's wrapper, wherever the app is: a link to one is ours even after the app moved. */
const MAC_WRAPPER_PATTERN = /\/AuthDeck Agent[^/]*\.app\/Contents\/Resources\/cli\/[^/]+$/;
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'ENOENT']);

export interface CliLayout {
  platform: Platform;
  /** The command's name: ENV_CLI_NAME. */
  name: string;
  /** The packaged cli folder: CLI_SCRIPT and the wrapper named `name` (`name`.cmd on Windows). */
  cliDir: string;
  home: string;
  /** Linux: what the launcher runs, the AppImage itself when the app runs from one. */
  executable: string;
  /** Linux: the app runs from an AppImage, whose cli folder is gone once it quits. */
  appImage: boolean;
  /** Linux AppImage: where versions before CLI mode copied the command's script, removed now. */
  dataDir: string;
  /** The PATH this app started with. */
  envPath: string;
}

export interface CliFiles {
  exists(file: string): boolean;
  /** The link's target, or null when `file` is missing or not a symlink. */
  readLink(file: string): string | null;
  /** Null when missing. */
  readText(file: string): string | null;
  /** Makes the folder too. */
  writeExecutable(file: string, text: string): void;
  symlink(target: string, file: string): void;
  /** No error when already gone. */
  remove(file: string): void;
}

/** Runs one step as administrator after the macOS password prompt. Rejects with CliPathCancelled on Cancel. */
export interface MacAdmin {
  link(target: string, file: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

/** The user's own PATH (HKCU\Environment\Path), unexpanded. */
export interface UserPathStore {
  read(): Promise<string>;
  write(value: string): Promise<void>;
}

export interface CliSystem {
  files: CliFiles;
  admin: MacAdmin;
  userPath: UserPathStore;
}

/** A refusal or failure the window shows as it is. */
export class CliPathError extends Error {
  /** What to do about it. */
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'CliPathError';
    this.hint = hint;
  }
}

/** The person pressed Cancel at the admin prompt: nothing to report. */
export class CliPathCancelled extends Error {
  constructor() {
    super('Cancelled at the administrator prompt.');
    this.name = 'CliPathCancelled';
  }
}

function pathFor(platform: Platform): typeof path.posix {
  return platform === 'windows' ? path.win32 : path.posix;
}

/** Where the command goes: the link or launcher file, or on Windows the folder put on the PATH. */
export function cliLocation(layout: CliLayout): string {
  switch (layout.platform) {
    case 'macos':
      return path.posix.join(MAC_BIN_DIR, layout.name);
    case 'linux':
      return path.posix.join(layout.home, LINUX_BIN_DIR, layout.name);
    case 'windows':
      return layout.cliDir;
  }
}

function wrapperFile(layout: CliLayout): string {
  return pathFor(layout.platform).join(layout.cliDir, layout.platform === 'windows' ? `${layout.name}.cmd` : layout.name);
}

/** Whether this build carries the command (a development build may not). */
export function cliShipped(layout: CliLayout, files: CliFiles): boolean {
  const script = pathFor(layout.platform).join(layout.cliDir, CLI_SCRIPT);
  if (!files.exists(script)) return false;
  return layout.platform === 'linux' || files.exists(wrapperFile(layout));
}

/** Single-quotes a word for sh. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

export function linuxLauncher(layout: CliLayout): string {
  return ['#!/bin/sh', LINUX_LAUNCHER_MARK, `exec ${shellQuote(layout.executable)} ${CLI_MODE_FLAG} ${CLI_ARGS_SEPARATOR} "$@"`, ''].join('\n');
}

/** The copy of the command's script that launchers before CLI mode ran for an AppImage. */
function removeOldAppImageScript(layout: CliLayout, files: CliFiles): void {
  if (layout.appImage) files.remove(path.posix.join(layout.dataDir, CLI_SCRIPT));
}

/** How Windows compares PATH entries: case-insensitive, quotes and trailing slashes ignored. */
function samePathEntry(a: string, b: string): boolean {
  const normal = (entry: string) => entry.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '').toLowerCase();
  return normal(a) === normal(b);
}

export function pathEntries(value: string, separator: string): string[] {
  return value.split(separator).filter((entry) => entry.trim() !== '');
}

/** Adds `dir` to the end of a Windows PATH value, once. */
export function addPathEntry(value: string, dir: string): string {
  const entries = pathEntries(value, ';');
  return entries.some((entry) => samePathEntry(entry, dir)) ? entries.join(';') : [...entries, dir].join(';');
}

export function removePathEntry(value: string, dir: string): string {
  return pathEntries(value, ';')
    .filter((entry) => !samePathEntry(entry, dir))
    .join(';');
}

function macState(layout: CliLayout, files: CliFiles): CliPathState {
  const location = cliLocation(layout);
  const target = files.readLink(location);
  if (target === null) return files.exists(location) ? { state: 'taken', location } : { state: 'absent', location };
  if (target === wrapperFile(layout)) return { state: 'installed', location, onPath: true };
  return MAC_WRAPPER_PATTERN.test(target) ? { state: 'stale', location } : { state: 'taken', location };
}

function linuxState(layout: CliLayout, files: CliFiles): CliPathState {
  const location = cliLocation(layout);
  const text = files.readText(location);
  if (text === null) return files.exists(location) ? { state: 'taken', location } : { state: 'absent', location };
  if (!text.includes(LINUX_LAUNCHER_MARK)) return { state: 'taken', location };
  if (text !== linuxLauncher(layout)) return { state: 'stale', location };
  const binDir = path.posix.dirname(location);
  return { state: 'installed', location, onPath: pathEntries(layout.envPath, ':').some((entry) => entry.replace(/\/+$/, '') === binDir) };
}

async function windowsState(layout: CliLayout, userPath: UserPathStore): Promise<CliPathState> {
  const location = cliLocation(layout);
  const entries = pathEntries(await userPath.read(), ';');
  return entries.some((entry) => samePathEntry(entry, location)) ? { state: 'installed', location, onPath: true } : { state: 'absent', location };
}

/** Where the command stands, or null when this build has none to offer. */
export async function cliPathState(layout: CliLayout, system: CliSystem): Promise<CliPathState | null> {
  if (!cliShipped(layout, system.files)) return null;
  switch (layout.platform) {
    case 'macos':
      return macState(layout, system.files);
    case 'linux':
      return linuxState(layout, system.files);
    case 'windows':
      return windowsState(layout, system.userPath);
  }
}

function takenError(location: string): CliPathError {
  return new CliPathError(`${location} belongs to another program.`, `AuthDeck Agent leaves it alone. Remove or rename it, then try again.`);
}

function isPermissionError(err: unknown): boolean {
  return PERMISSION_CODES.has((err as NodeJS.ErrnoException).code ?? '');
}

async function installMac(layout: CliLayout, files: CliFiles, admin: MacAdmin): Promise<void> {
  const location = cliLocation(layout);
  const target = wrapperFile(layout);
  try {
    files.remove(location);
    files.symlink(target, location);
  } catch (err) {
    if (!isPermissionError(err)) throw err;
    // /usr/local/bin is root's, or missing on a Mac without Homebrew.
    await admin.link(target, location);
  }
}

async function removeMac(layout: CliLayout, files: CliFiles, admin: MacAdmin): Promise<void> {
  const location = cliLocation(layout);
  try {
    files.remove(location);
  } catch (err) {
    if (!isPermissionError(err)) throw err;
    await admin.unlink(location);
  }
}

function installLinux(layout: CliLayout, files: CliFiles): void {
  files.writeExecutable(cliLocation(layout), linuxLauncher(layout));
  removeOldAppImageScript(layout, files);
}

function removeLinux(layout: CliLayout, files: CliFiles): void {
  files.remove(cliLocation(layout));
  removeOldAppImageScript(layout, files);
}

/** Puts the command on the PATH; a link or launcher for another copy of the app is replaced. */
export async function installCli(layout: CliLayout, system: CliSystem): Promise<void> {
  const state = await cliPathState(layout, system);
  if (state === null) throw new CliPathError('This build of AuthDeck Agent has no authdeck command.', 'Install AuthDeck Agent from a release to get it.');
  if (state.state === 'taken') throw takenError(state.location);
  switch (layout.platform) {
    case 'macos':
      return installMac(layout, system.files, system.admin);
    case 'linux':
      return installLinux(layout, system.files);
    case 'windows':
      return system.userPath.write(addPathEntry(await system.userPath.read(), cliLocation(layout)));
  }
}

/** Takes the command off the PATH. Never removes another program's file. */
export async function removeCli(layout: CliLayout, system: CliSystem): Promise<void> {
  const state = await cliPathState(layout, system);
  if (state === null || state.state === 'absent') return;
  if (state.state === 'taken') throw takenError(state.location);
  switch (layout.platform) {
    case 'macos':
      return removeMac(layout, system.files, system.admin);
    case 'linux':
      return removeLinux(layout, system.files);
    case 'windows':
      return system.userPath.write(removePathEntry(await system.userPath.read(), cliLocation(layout)));
  }
}

/**
 * At start, on Linux: rewrites our launcher for this copy of the app (an update or a moved
 * AppImage changes its paths, and launchers from before CLI mode ran the script directly).
 * macOS links follow the bundle, and Windows points at a folder updates keep.
 */
export async function refreshCli(layout: CliLayout, system: CliSystem): Promise<void> {
  if (layout.platform !== 'linux') return;
  const state = await cliPathState(layout, system);
  if (state?.state === 'installed' || state?.state === 'stale') installLinux(layout, system.files);
}
