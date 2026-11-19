/**
 * The starter deck a new computer gets: editor, Git, run and app pages,
 * using apps that are actually installed on that computer.
 */
import type { AccountView } from '../auth/contract';
import { isAppEntry } from '../net/messages';
import type { Action, AppEntry, Modifier, Platform } from '../protocol';
import type { CapColor } from '../theme/colorways';
import { type Deck, type DeckKey, type Page, DEFAULT_SLOTS, MAX_SLOTS, MIN_SLOTS, newId, resizeSlots } from './model';

function key(label: string, glyph: string, color: CapColor, action: Action): DeckKey {
  return { id: newId('k'), label, icon: { kind: 'glyph', name: glyph }, color, action };
}

function hk(modifiers: Modifier[], k: string, focusAppId?: string): Action {
  return focusAppId ? { type: 'hotkey', modifiers, key: k, focusAppId } : { type: 'hotkey', modifiers, key: k };
}

function bg(command: string): Action {
  return { type: 'command', command, mode: 'background' };
}

function term(command: string): Action {
  return { type: 'command', command, mode: 'terminal' };
}

function page(name: string, keys: (DeckKey | null)[], extra: Partial<Page> = {}): Page {
  const slots = [...keys];
  while (slots.length < DEFAULT_SLOTS) slots.push(null);
  return { id: newId('p'), name, slots, focusApp: null, ...extra };
}

function findApp(apps: AppEntry[], ...names: string[]): AppEntry | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const n of names) {
    const want = norm(n);
    const hit = apps.find((a) => norm(a.name) === want);
    if (hit) return hit;
  }
  return undefined;
}

function appKey(app: AppEntry, label?: string): DeckKey {
  return {
    id: newId('k'),
    label: label ?? app.name,
    icon: { kind: 'app', appId: app.id },
    color: 'alpha',
    action: { type: 'launch', appId: app.id, appName: app.name },
  };
}

const DEV_APPS: [label: string, ...names: string[]][] = [
  ['VS Code', 'Visual Studio Code', 'Code', 'VSCodium'],
  ['Cursor', 'Cursor'],
  ['Zed', 'Zed'],
  ['IntelliJ IDEA', 'IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA Community Edition'],
  ['PyCharm', 'PyCharm', 'PyCharm Professional Edition', 'PyCharm Community Edition'],
  ['WebStorm', 'WebStorm'],
  ['Android Studio', 'Android Studio'],
  ['Xcode', 'Xcode'],
  ['iTerm', 'iTerm', 'iTerm2'],
  ['Ghostty', 'Ghostty'],
  ['Warp', 'Warp'],
  ['Terminal', 'Terminal', 'Windows Terminal', 'GNOME Terminal', 'Konsole', 'Ptyxis'],
  ['Chrome', 'Google Chrome', 'Chromium'],
  ['Firefox', 'Firefox', 'Mozilla Firefox', 'Firefox Developer Edition'],
  ['Arc', 'Arc'],
  ['Safari', 'Safari'],
  ['Edge', 'Microsoft Edge'],
  ['Docker', 'Docker', 'Docker Desktop'],
  ['Postman', 'Postman'],
  ['Insomnia', 'Insomnia'],
  ['TablePlus', 'TablePlus'],
  ['DBeaver', 'DBeaver', 'DBeaver Community'],
  ['GitHub Desktop', 'GitHub Desktop'],
  ['Slack', 'Slack'],
  ['Discord', 'Discord'],
  ['Figma', 'Figma'],
  ['Notion', 'Notion'],
  ['Obsidian', 'Obsidian'],
  ['Finder', 'Finder'],
  ['Files', 'File Explorer', 'Files', 'Dolphin', 'Nautilus'],
  ['Activity Monitor', 'Activity Monitor', 'Task Manager', 'System Monitor'],
];

/**
 * The starter deck copies the editor's id into most keys of its first page, so only apps within
 * the apps.list limits (net/messages.ts) are used, whatever path the list took to get here.
 */
export function starterDeck(platform: Platform, listed: AppEntry[]): Deck {
  const apps = listed.filter(isAppEntry);
  const editor = findApp(apps, 'Visual Studio Code', 'Code', 'VSCodium', 'Cursor');
  const terminal = findApp(apps, 'iTerm', 'iTerm2', 'Ghostty', 'Warp', 'Terminal', 'Windows Terminal', 'GNOME Terminal', 'Konsole', 'Ptyxis');
  const browser = findApp(apps, 'Google Chrome', 'Arc', 'Firefox', 'Mozilla Firefox', 'Microsoft Edge', 'Safari', 'Chromium');
  const ed = editor?.id;
  const mac = platform === 'macos';

  const code = page(
    'Code',
    [
      key('Command palette', 'square-chevron-right', 'alpha', hk(['mod', 'shift'], 'p', ed)),
      key('Quick open', 'search', 'alpha', hk(['mod'], 'p', ed)),
      key('Find in files', 'files', 'alpha', hk(['mod', 'shift'], 'f', ed)),
      key('Go to definition', 'arrow-bar-right', 'alpha', hk([], 'f12', ed)),
      key('Rename symbol', 'pencil', 'alpha', hk([], 'f2', ed)),
      key('Format document', 'text-align-left', 'alpha', hk(['shift', 'alt'], 'f', ed)),
      key('Toggle terminal', 'terminal', 'mod', hk(['ctrl'], '`', ed)),
      key('Toggle sidebar', 'layout', 'mod', hk(['mod'], 'b', ed)),
      key('Split editor', 'text-colums', 'mod', hk(['mod'], '\\', ed)),
      key('Comment line', 'message-text', 'alpha', hk(['mod'], '/', ed)),
      key('Save all', 'save', 'mod', mac ? hk(['mod', 'alt'], 's', ed) : hk(['mod', 'shift'], 's', ed)),
      key('Close editor', 'close', 'mod', hk(['mod'], 'w', ed)),
      null,
      key('Source control', 'git-branch', 'alpha', hk(['ctrl', 'shift'], 'g', ed)),
      key('Start debugging', 'play', 'b', hk([], 'f5', ed)),
      key('Step over', 'redo', 'mod', hk([], 'f10', ed)),
      key('Step into', 'arrow-bar-down', 'mod', hk([], 'f11', ed)),
      key('Step out', 'arrow-bar-up', 'mod', hk(['shift'], 'f11', ed)),
      key('Restart', 'reload', 'mod', hk(['mod', 'shift'], 'f5', ed)),
      key('Stop', 'stop', 'a', hk(['shift'], 'f5', ed)),
      key('Toggle breakpoint', 'target', 'mod', hk([], 'f9', ed)),
      ...(editor ? [appKey(editor, editor.name === 'Visual Studio Code' ? 'VS Code' : editor.name)] : []),
      ...(terminal ? [appKey(terminal)] : []),
      ...(browser ? [appKey(browser, browser.name.replace(/^Google /, '').replace(/^Mozilla /, ''))] : []),
    ],
    { focusApp: editor ? { appId: editor.id, appName: editor.name } : null },
  );

  const git = page('Git', [
    key('Status', 'list-box', 'c', bg('git status --short --branch')),
    key('Pull', 'download', 'c', bg('git pull')),
    key('Push', 'upload', 'c', bg('git push')),
    key('Fetch', 'refresh', 'c', bg('git fetch --all --prune')),
    key('Recent commits', 'clock', 'alpha', bg('git log --oneline -15')),
    key('Diff summary', 'file-text', 'alpha', bg('git diff --stat')),
    key('Branches', 'git-branch', 'alpha', bg('git branch --sort=-committerdate')),
    key('Stash', 'archive', 'mod', bg('git stash push')),
    key('Pop stash', 'arrow-up-box', 'mod', bg('git stash pop')),
    key('Open in terminal', 'terminal', 'mod', term('git status')),
  ]);

  const run = page('Run', [
    key('Dev server', 'server', 'a', term('npm run dev')),
    key('Tests', 'test-tube', 'c', bg('npm test')),
    key('Build', 'tools', 'c', bg('npm run build')),
    key('Lint', 'check-double', 'c', bg('npm run lint')),
    key('Install', 'package', 'mod', bg('npm install')),
    key('Open localhost', 'globe', 'alpha', { type: 'url', url: 'http://localhost:3000' }),
    key('Compose up', 'docker', 'b', bg('docker compose up -d')),
    key('Compose down', 'stop', 'mod', bg('docker compose down')),
    ...(editor ? [{ ...appKey(editor, 'Open in editor'), action: { type: 'open', path: '.', withAppId: editor.id } satisfies Action }] : []),
  ]);

  const installed: DeckKey[] = [];
  for (const [label, ...names] of DEV_APPS) {
    const app = findApp(apps, ...names);
    if (app && !installed.some((k) => k.icon.kind === 'app' && k.icon.appId === app.id)) installed.push(appKey(app, label));
  }
  const appsPage = page('Apps', installed.slice(0, DEFAULT_SLOTS));

  return { pages: [code, git, run, appsPage] };
}

/** Symbols for well-known 2FA issuers, matched on the issuer name with case and punctuation ignored. */
const ISSUER_GLYPHS: [match: RegExp, glyph: string][] = [
  [/github|gitlab|bitbucket/, 'git-branch'],
  [/aws|amazonwebservices|cloudflare|azure|digitalocean|vercel|netlify|heroku/, 'cloud'],
  [/google|gmail|outlook|proton|fastmail|mail/, 'mail'],
  [/stripe|paypal|bank|coinbase|binance|wise|revolut/, 'credit-card'],
  [/npm|pypi|docker|crates/, 'box'],
  [/hetzner|linode|ovh|server|ssh/, 'server'],
  [/steam|epic|xbox|playstation|nintendo|battle|riot/, 'gamepad'],
  [/discord/, 'discord'],
  [/slack/, 'slack'],
  [/apple|icloud/, 'apple'],
];
const SHARED_GLYPH = 'users';
const DEFAULT_OTP_GLYPH = 'shield';

/** The symbol a new 2FA key gets for an account; shared accounts show who shares them. */
export function otpGlyph(account: Pick<AccountView, 'issuer' | 'label' | 'team'>): string {
  if (account.team) return SHARED_GLYPH;
  const name = (account.issuer || account.label).toLowerCase().replace(/[^a-z0-9]/g, '');
  return ISSUER_GLYPHS.find(([match]) => match.test(name))?.[1] ?? DEFAULT_OTP_GLYPH;
}

/** The key's own label: the issuer, or the account label when the site gave no issuer. */
export function otpKeyLabel(account: Pick<AccountView, 'issuer' | 'label'>): string {
  return account.issuer || account.label;
}

/** A 2FA key for a vault account. */
export function otpKey(account: AccountView): DeckKey {
  return {
    id: newId('k'),
    label: otpKeyLabel(account),
    icon: { kind: 'glyph', name: otpGlyph(account) },
    color: 'alpha',
    action: null,
    otp: { accountId: account.id },
  };
}

/** A 2FA page with a key for every account, in vault order, and one spot left to add an account. */
export function otpPage(name: string, accounts: AccountView[]): Page {
  const blank: Page = { id: newId('p'), name, slots: [], focusApp: null, otp: true };
  const { page: filled } = withAccountKeys(blank, accounts);
  return { ...filled, slots: resizeSlots(filled.slots, Math.max(MIN_SLOTS, filled.slots.length)) };
}

/** Accounts that already have a key on the page. */
function accountsOnPage(page: Page): Set<string> {
  return new Set(page.slots.flatMap((k) => (k?.otp?.accountId ? [k.otp.accountId] : [])));
}

/**
 * Adds a 2FA key for each account that has none on the page yet: into empty spots from `from`
 * onwards first, then any empty spot, then new spots (keeping one spare to add an account).
 * `left` counts the accounts that did not fit because the page is at MAX_SLOTS.
 */
export function withAccountKeys(page: Page, accounts: AccountView[], from = 0): { page: Page; added: number; left: number } {
  const present = accountsOnPage(page);
  const missing = accounts.filter((a) => !present.has(a.id));
  const slots = [...page.slots];
  const emptyFrom = (start: number) => {
    const after = slots.findIndex((k, i) => i >= start && k === null);
    return after >= 0 ? after : slots.indexOf(null);
  };
  let added = 0;
  for (const account of missing) {
    let at = emptyFrom(from);
    if (at < 0 && slots.length < MAX_SLOTS) {
      slots.push(null);
      at = slots.length - 1;
    }
    if (at < 0) break;
    slots[at] = otpKey(account);
    added++;
  }
  if (!slots.includes(null) && slots.length < MAX_SLOTS) slots.push(null);
  return { page: { ...page, slots }, added, left: missing.length - added };
}
