/**
 * Checks for what the app saved from a computer, run again when it is reloaded: a value that was
 * fine when it arrived may come back damaged, or from a build with weaker checks. Each check keeps
 * every good entry and drops only the bad ones, so one bad entry never costs the whole cache.
 */
import { parseLinkPublicKey } from '../link/keys';
import type { AppIcon, Platform } from '../protocol';
import type { Computer, Deck, DeckKey, Page, Slot } from '../state/model';
import { isAllowedHost } from './discovery';
import { LIMITS, isAppIcon, isSafeAgentId } from './messages';
import { cleanName } from './trust';

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
/** A string within one of the limits apps.list and fs.list are checked against (messages.ts). */
const isText = (value: unknown, max: number): value is string => isString(value) && value.length <= max;
const isOptionalText = (value: unknown, max: number): boolean => value === undefined || isText(value, max);
const PLATFORMS: ReadonlySet<unknown> = new Set<Platform>(['macos', 'windows', 'linux']);
const isPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65535;

/** Own entries only; results are built with Object.fromEntries, so a saved "__proto__" key stays a key. */
const entriesOf = (value: Fields): [string, unknown][] => Object.keys(value).map((key) => [key, value[key]]);

/** A saved icon cache: entries that are no icon (null) or a well-formed one. */
export function checkedIconCache(saved: unknown): Record<string, AppIcon | null> {
  if (!isFields(saved)) return {};
  return Object.fromEntries(entriesOf(saved).filter((entry): entry is [string, AppIcon | null] => entry[1] === null || isAppIcon(entry[1])));
}

function isLinkKey(value: unknown): value is string {
  if (!isString(value)) return false;
  try {
    parseLinkPublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/** One saved computer, its name cleaned and its addresses limited to the local network; null when damaged. */
function checkedComputer(saved: unknown): Computer | null {
  if (!isFields(saved)) return null;
  const { agentId, name, platform, hosts, port, linkKey, pairedAt } = saved;
  if (!isSafeAgentId(agentId) || !isString(name) || !PLATFORMS.has(platform) || !isPort(port)) return null;
  // A damaged key is dropped with its computer: without a key the entry would pass for one saved
  // before link keys, which a weaker rule re-pairs. Its deck stays, for when it is paired again.
  if (linkKey !== undefined && !isLinkKey(linkKey)) return null;
  return {
    agentId,
    name: cleanName(name) || agentId,
    platform: platform as Platform,
    hosts: Array.isArray(hosts) ? hosts.filter((host): host is string => isString(host) && isAllowedHost(host)) : [],
    port,
    ...(linkKey !== undefined ? { linkKey } : {}),
    pairedAt: typeof pairedAt === 'number' && Number.isFinite(pairedAt) ? pairedAt : 0,
  };
}

/** Saved computers: damaged entries, ids no computer could have, and repeated ids dropped. */
export function checkedComputers(saved: unknown): Computer[] {
  if (!Array.isArray(saved)) return [];
  const computers: Computer[] = [];
  for (const entry of saved) {
    const computer = checkedComputer(entry);
    if (computer && !computers.some((c) => c.agentId === computer.agentId)) computers.push(computer);
  }
  return computers;
}

/**
 * The parts of a key that came from the computer (app ids, app names, folder paths), held to the
 * limits apps.list and fs.list are checked against: a key saved before those limits, or by an
 * older build, can't keep a string large enough to make the saved state unloadable.
 */
function hasSoundAppFields(key: DeckKey): boolean {
  const icon = key.icon as unknown;
  if (!isFields(icon) || !isString(icon.kind)) return false;
  if (icon.kind === 'app' && !isText(icon.appId, LIMITS.appId)) return false;
  return key.action === null || key.action === undefined || hasSoundActionFields(key.action);
}

function hasSoundActionFields(action: unknown): boolean {
  if (!isFields(action) || !isString(action.type)) return false;
  switch (action.type) {
    case 'launch':
      return isText(action.appId, LIMITS.appId) && isText(action.appName, LIMITS.appName);
    case 'hotkey':
      return isOptionalText(action.focusAppId, LIMITS.appId);
    case 'open':
      return isOptionalText(action.withAppId, LIMITS.appId) && isText(action.path, LIMITS.fsPath);
    case 'command':
      return isOptionalText(action.cwd, LIMITS.fsPath);
    case 'macro':
      return Array.isArray(action.steps) && action.steps.every((step) => isFields(step) && hasSoundActionFields(step.action));
    default:
      return true;
  }
}

function checkedSlot(saved: unknown): Slot {
  if (!isFields(saved) || !isString(saved.id) || !isString(saved.label)) return null;
  const key = saved as unknown as DeckKey;
  return hasSoundAppFields(key) ? key : null;
}

function checkedPage(saved: unknown): Page | null {
  if (!isFields(saved) || !isString(saved.id) || !isString(saved.name) || !Array.isArray(saved.slots)) return null;
  const { focusApp, cwd } = saved;
  const focusOk =
    focusApp === undefined ||
    focusApp === null ||
    (isFields(focusApp) && isText(focusApp.appId, LIMITS.appId) && isText(focusApp.appName, LIMITS.appName));
  const page = { ...(saved as unknown as Page), slots: saved.slots.map(checkedSlot), ...(focusOk ? {} : { focusApp: null }) };
  if (!isOptionalText(cwd, LIMITS.fsPath)) delete page.cwd;
  return page;
}

/**
 * Saved decks: a damaged key becomes an empty slot, a damaged page is dropped, a deck with no page
 * left too, and so is a deck under an id no computer could have (see isSafeAgentId).
 */
export function checkedDecks(saved: unknown): Record<string, Deck> {
  if (!isFields(saved)) return {};
  const decks: [string, Deck][] = [];
  for (const [agentId, deck] of entriesOf(saved)) {
    if (!isSafeAgentId(agentId) || !isFields(deck) || !Array.isArray(deck.pages)) continue;
    const pages = deck.pages.map(checkedPage).filter((page): page is Page => page !== null);
    if (pages.length > 0) decks.push([agentId, { ...(deck as unknown as Deck), pages }]);
  }
  return Object.fromEntries(decks);
}

/** The last page shown per computer: entries under an id no computer could have, or not a page number, dropped. */
export function checkedPageIndex(saved: unknown): Record<string, number> {
  if (!isFields(saved)) return {};
  return Object.fromEntries(
    entriesOf(saved).filter((entry): entry is [string, number] => isSafeAgentId(entry[0]) && Number.isInteger(entry[1]) && (entry[1] as number) >= 0),
  );
}
