/**
 * Deck backups: a JSON file with one computer's pages and keys. Export shares or downloads it;
 * import reads one back and checks every field before it can replace a deck.
 */
import * as DocumentPicker from 'expo-document-picker';
import { File as FsFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform as RNPlatform } from 'react-native';

import type { Action, Modifier, Platform, StepAction } from '../../protocol';
import type { Computer, Deck, DeckKey, KeyIcon, Page, Slot } from '../../state/model';
import { CAP_COLORS, type CapColor } from '../../theme/colorways';

const BACKUP_APP = 'authdeck';
/** Backups exported before the rename to AuthDeck carry this tag; they import the same way. */
const LEGACY_BACKUP_APP = 'devdeck';
const BACKUP_KIND = 'deck';
const BACKUP_VERSION = 1;
const MAX_PAGES = 100;
const MAX_SLOTS_PER_PAGE = 200;
/** More vault accounts than any vault holds: a list past this is not a deck AuthDeck wrote. */
const MAX_AUTO_ACCOUNTS = 1000;

interface DeckBackup {
  app: typeof BACKUP_APP;
  kind: typeof BACKUP_KIND;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  computer: { name: string; platform: Platform };
  deck: Deck;
}

export type ParsedBackup =
  | { ok: true; deck: Deck; from: DeckBackup['computer'] | null; keyCount: number }
  | { ok: false; problem: string };

export function backupJson(computer: Computer, deck: Deck): string {
  const backup: DeckBackup = {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    computer: { name: computer.name, platform: computer.platform },
    deck,
  };
  return JSON.stringify(backup, null, 2);
}

export function backupFileName(computer: Computer): string {
  const safe = computer.name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'computer';
  return `${BACKUP_APP}-${safe}-${new Date().toISOString().slice(0, 10)}.json`;
}

class ShapeError extends Error {}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function need(cond: unknown, where: string): asserts cond {
  if (!cond) throw new ShapeError(where);
}

function str(o: Obj, key: string, where: string): string {
  const v = o[key];
  need(typeof v === 'string', `${where}: "${key}" should be text`);
  return v;
}

function optStr(o: Obj, key: string, where: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  need(typeof v === 'string', `${where}: "${key}" should be text`);
  return v;
}

const MODIFIERS: readonly Modifier[] = ['mod', 'ctrl', 'alt', 'shift', 'meta'];

function stepAction(v: unknown, where: string): StepAction {
  need(isObj(v), `${where} is not an action`);
  switch (v.type) {
    case 'launch':
      return { type: 'launch', appId: str(v, 'appId', where), appName: str(v, 'appName', where) };
    case 'hotkey': {
      const mods = v.modifiers;
      need(Array.isArray(mods) && mods.every((m) => MODIFIERS.includes(m as Modifier)), `${where}: unknown modifier key`);
      return { type: 'hotkey', modifiers: mods as Modifier[], key: str(v, 'key', where), focusAppId: optStr(v, 'focusAppId', where) };
    }
    case 'text':
      need(v.pressEnter === undefined || typeof v.pressEnter === 'boolean', `${where}: "pressEnter" should be true or false`);
      return { type: 'text', text: str(v, 'text', where), pressEnter: v.pressEnter as boolean | undefined };
    case 'command':
      need(v.mode === 'terminal' || v.mode === 'background', `${where}: "mode" should be terminal or background`);
      need(v.timeoutSec === undefined || typeof v.timeoutSec === 'number', `${where}: "timeoutSec" should be a number`);
      return {
        type: 'command',
        command: str(v, 'command', where),
        cwd: optStr(v, 'cwd', where),
        mode: v.mode,
        timeoutSec: v.timeoutSec as number | undefined,
      };
    case 'url':
      return { type: 'url', url: str(v, 'url', where) };
    case 'open':
      return { type: 'open', path: str(v, 'path', where), withAppId: optStr(v, 'withAppId', where) };
    default:
      throw new ShapeError(`${where} has an unknown type`);
  }
}

function action(v: unknown, where: string): Action | null {
  if (v === null || v === undefined) return null;
  if (isObj(v) && v.type === 'macro') {
    need(Array.isArray(v.steps), `${where}: "steps" should be a list`);
    return {
      type: 'macro',
      steps: v.steps.map((s, i) => {
        const at = `${where}, step ${i + 1}`;
        need(isObj(s) && typeof s.delayMs === 'number' && s.delayMs >= 0, `${at}: "delayMs" should be a number`);
        return { action: stepAction(s.action, at), delayMs: s.delayMs };
      }),
    };
  }
  return stepAction(v, where);
}

function icon(v: unknown, where: string): KeyIcon {
  need(isObj(v), `${where}: missing icon`);
  if (v.kind === 'glyph') return { kind: 'glyph', name: str(v, 'name', where) };
  if (v.kind === 'app') return { kind: 'app', appId: str(v, 'appId', where) };
  need(v.kind === 'none', `${where}: unknown icon kind`);
  return { kind: 'none' };
}

function key(v: unknown, where: string): DeckKey {
  need(isObj(v), `${where} is not a key`);
  need(CAP_COLORS.includes(v.color as CapColor), `${where}: unknown key colour`);
  const k: DeckKey = {
    id: str(v, 'id', where),
    label: str(v, 'label', where),
    icon: icon(v.icon, where),
    color: v.color as CapColor,
    action: action(v.action, `${where}, action`),
  };
  // A 2FA key: its vault account instead of an action.
  if (v.otp !== undefined) {
    need(isObj(v.otp), `${where}: "otp" should name an account`);
    k.otp = { accountId: str(v.otp, 'accountId', where) };
    k.action = null;
  }
  return k;
}

/** The accounts already offered to a deck's own 2FA page, so removed keys stay removed. */
function autoAccounts(v: Obj, where: string): string[] | undefined {
  const list = v.autoAccounts;
  if (list === undefined) return undefined;
  need(
    Array.isArray(list) && list.length <= MAX_AUTO_ACCOUNTS && list.every((id) => typeof id === 'string'),
    `${where}: "autoAccounts" should be a list of account ids`,
  );
  return list as string[];
}

function page(v: unknown, index: number): Page {
  const where = `Page ${index + 1}`;
  need(isObj(v), `${where} is not a page`);
  need(Array.isArray(v.slots) && v.slots.length > 0 && v.slots.length <= MAX_SLOTS_PER_PAGE, `${where}: "slots" should be a list of keys`);
  const slots: Slot[] = v.slots.map((s, i) => (s === null ? null : key(s, `${where}, key ${i + 1}`)));
  let focusApp: Page['focusApp'] = null;
  if (isObj(v.focusApp)) {
    focusApp = { appId: str(v.focusApp, 'appId', where), appName: str(v.focusApp, 'appName', where) };
  }
  need(v.otp === undefined || typeof v.otp === 'boolean', `${where}: "otp" should be true or false`);
  const auto = autoAccounts(v, where);
  return {
    id: str(v, 'id', where),
    name: str(v, 'name', where),
    slots,
    cwd: optStr(v, 'cwd', where),
    focusApp,
    ...(v.otp === true ? { otp: true } : {}),
    ...(auto ? { autoAccounts: auto } : {}),
  };
}

function deck(v: unknown): Deck {
  need(isObj(v) && Array.isArray(v.pages), 'There is no list of pages');
  need(v.pages.length > 0 && v.pages.length <= MAX_PAGES, 'The deck has no pages');
  const pages = v.pages.map(page);
  const ids = pages.flatMap((p) => [p.id, ...p.slots.flatMap((s) => (s ? [s.id] : []))]);
  need(new Set(ids).size === ids.length, 'Two pages or keys share the same id');
  // A deck that was given its 2FA page keeps the mark, so importing it never adds a second one.
  return v.twoFaOffered === true ? { pages, twoFaOffered: true } : { pages };
}

function isBackupApp(v: unknown): boolean {
  return v === BACKUP_APP || v === LEGACY_BACKUP_APP;
}

function platformOf(v: unknown): Platform | null {
  return v === 'macos' || v === 'windows' || v === 'linux' ? v : null;
}

/** Accepts a AuthDeck backup file, or a bare `{ "pages": [...] }` deck. */
export function parseBackup(text: string): ParsedBackup {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'That file is not JSON. Pick a .json file exported from AuthDeck.' };
  }
  try {
    const backup = isObj(json) && isBackupApp(json.app) && json.kind === BACKUP_KIND ? json : null;
    if (backup && backup.version !== BACKUP_VERSION) {
      return { ok: false, problem: 'That backup comes from a newer AuthDeck. Update the app, then import it again.' };
    }
    const parsed = deck(backup ? backup.deck : json);
    const c = backup && isObj(backup.computer) ? backup.computer : null;
    const platform = c ? platformOf(c.platform) : null;
    const from = c && typeof c.name === 'string' && platform ? { name: c.name, platform } : null;
    const keyCount = parsed.pages.reduce((n, p) => n + p.slots.filter(Boolean).length, 0);
    return { ok: true, deck: parsed, from, keyCount };
  } catch (e) {
    if (!(e instanceof ShapeError)) throw e;
    return { ok: false, problem: `That file is not a AuthDeck deck (${e.message}). Pick a file exported from AuthDeck.` };
  }
}

/** Native: write to the cache and open the share sheet. Web: download the file. */
export async function saveBackupFile(fileName: string, json: string): Promise<void> {
  if (RNPlatform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return;
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device, so the backup cannot be saved.');
  }
  const file = new FsFile(Paths.cache, fileName);
  file.create({ overwrite: true });
  await file.write(json);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Save deck backup', UTI: 'public.json' });
}

/** Lets the person pick a backup file and returns its text, or null if they cancelled. */
export async function pickBackupText(): Promise<string | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/plain', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled) return null;
  const asset = res.assets[0];
  if (!asset) return null;
  // On the web the picker is a file input and hands back the browser's File.
  if (asset.file) return asset.file.text();
  return new FsFile(asset.uri).text();
}
