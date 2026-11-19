/**
 * Where each computer's icons are saved on this device: one AsyncStorage key per computer, apart
 * from the main state (connection.ts saves and loads them). Each may hold up to a megabyte, so a
 * computer's key goes when the computer is forgotten, and a launch sweeps any left behind.
 *
 * All computers' caches together stay within MAX_TOTAL_ICON_CACHE_CHARS: AsyncStorage on Android
 * is one database with a size cap, shared with the main state, and a cache per computer would
 * otherwise grow with every computer saved. Past the total, the caches of the computers used
 * longest ago go first (their icons load from the computer again). A small index, saved under its
 * own key, holds each cache's size in the order they were last used.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const ICON_CACHE_PREFIX = 'authdeck-icons-v1:';
/** DevDeck 0.1.0 saved icons under this prefix; AuthDeck never reads them. */
const LEGACY_ICON_CACHE_PREFIX = 'devdeck-icons-v1:';
/** The index: [agentId, chars][], least recently used first. Not under ICON_CACHE_PREFIX, so never an orphan. */
export const ICON_CACHE_INDEX_KEY = 'authdeck-icon-cache-index-v1';
/** About 4 MB of base64 across every computer's saved icons. */
export const MAX_TOTAL_ICON_CACHE_CHARS = 4_000_000;

export const iconCacheKey = (agentId: string): string => `${ICON_CACHE_PREFIX}${agentId}`;

type CacheStorage = Pick<typeof AsyncStorage, 'getAllKeys' | 'multiRemove' | 'getItem' | 'setItem' | 'removeItem'>;
type CacheIndex = [agentId: string, chars: number][];

/**
 * Of all the keys in AsyncStorage, the icon caches nothing uses: those of computers not saved any
 * more, and every 0.1.0 one. Any key without those prefixes is someone else's (the vault keeps its
 * own) and never named here.
 */
export function orphanedIconCacheKeys(keys: readonly string[], savedAgentIds: ReadonlySet<string>): string[] {
  return keys.filter(
    (key) =>
      key.startsWith(LEGACY_ICON_CACHE_PREFIX) || (key.startsWith(ICON_CACHE_PREFIX) && !savedAgentIds.has(key.slice(ICON_CACHE_PREFIX.length))),
  );
}

const isIndexEntry = (entry: unknown): entry is [string, number] =>
  Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && Number.isSafeInteger(entry[1]) && (entry[1] as number) >= 0;

/** The saved index; one that can't be read counts as empty, and the next launch measures the caches again. */
async function readIndex(storage: CacheStorage): Promise<CacheIndex> {
  try {
    const parsed: unknown = JSON.parse((await storage.getItem(ICON_CACHE_INDEX_KEY)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isIndexEntry) : [];
  } catch {
    return [];
  }
}

/** `index` with `agentId` moved to the end (used now) at `chars`. */
const markUsed = (index: CacheIndex, agentId: string, chars: number): CacheIndex => [...index.filter(([id]) => id !== agentId), [agentId, chars]];

/**
 * The computers whose caches go so the rest fit MAX_TOTAL_ICON_CACHE_CHARS: least recently used
 * first, never `keep` (the one being saved; a single cache is far under the total).
 */
export function iconCachesOverBudget(index: Readonly<CacheIndex>, keep?: string): string[] {
  let total = index.reduce((sum, [, chars]) => sum + chars, 0);
  const evicted: string[] = [];
  for (const [agentId, chars] of index) {
    if (total <= MAX_TOTAL_ICON_CACHE_CHARS) break;
    if (agentId === keep) continue;
    total -= chars;
    evicted.push(agentId);
  }
  return evicted;
}

/** Index changes run one at a time, so two saves never write over each other's index. */
let indexQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = indexQueue.then(task, task);
  indexQueue = run.catch(() => undefined);
  return run;
}

/** Removes `evicted` caches and saves the index without them. */
async function saveIndex(index: CacheIndex, evicted: readonly string[], storage: CacheStorage): Promise<void> {
  if (evicted.length > 0) await storage.multiRemove(evicted.map(iconCacheKey));
  const gone = new Set(evicted);
  await storage.setItem(ICON_CACHE_INDEX_KEY, JSON.stringify(index.filter(([id]) => !gone.has(id))));
}

/** A computer's saved icons (JSON), or null; reading them counts as using them. */
export function readIconCache(agentId: string, storage: CacheStorage = AsyncStorage): Promise<string | null> {
  return serialized(async () => {
    const raw = await storage.getItem(iconCacheKey(agentId));
    if (raw !== null) await saveIndex(markUsed(await readIndex(storage), agentId, raw.length), [], storage);
    return raw;
  });
}

/**
 * Saves a computer's icons (JSON), first removing the caches of the computers used longest ago
 * when all of them together would pass MAX_TOTAL_ICON_CACHE_CHARS. Returns the computers whose
 * caches were removed.
 */
export function writeIconCache(agentId: string, json: string, storage: CacheStorage = AsyncStorage): Promise<string[]> {
  return serialized(async () => {
    const index = markUsed(await readIndex(storage), agentId, json.length);
    const evicted = iconCachesOverBudget(index, agentId);
    await saveIndex(index, evicted, storage);
    await storage.setItem(iconCacheKey(agentId), json);
    return evicted;
  });
}

/** Deletes a computer's saved icons. */
export function removeIconCache(agentId: string, storage: CacheStorage = AsyncStorage): Promise<void> {
  return serialized(async () => {
    await storage.removeItem(iconCacheKey(agentId));
    await saveIndex((await readIndex(storage)).filter(([id]) => id !== agentId), [], storage);
  });
}

/** The size of a cache the index doesn't know (saved by an older build); null when it can't be read, which removes it. */
async function measure(key: string, storage: CacheStorage): Promise<number | null> {
  try {
    return (await storage.getItem(key))?.length ?? 0;
  } catch {
    // On Android a value over 2 MB can't be read back at all.
    return null;
  }
}

/**
 * Deletes the orphaned icon caches, then those past MAX_TOTAL_ICON_CACHE_CHARS, least recently
 * used first; caches the index doesn't know count as the oldest. `savedAgentIds` is read after the
 * key list, so a computer paired while the keys were being listed keeps its cache. Returns the
 * keys removed.
 */
export function sweepOrphanedIconCaches(savedAgentIds: () => ReadonlySet<string>, storage: CacheStorage = AsyncStorage): Promise<string[]> {
  return serialized(async () => {
    const keys = await storage.getAllKeys();
    const orphans = orphanedIconCacheKeys(keys, savedAgentIds());
    if (orphans.length > 0) await storage.multiRemove(orphans);
    const orphaned = new Set(orphans);
    const present = new Set(keys.filter((key) => key.startsWith(ICON_CACHE_PREFIX) && !orphaned.has(key)).map((key) => key.slice(ICON_CACHE_PREFIX.length)));
    const known = (await readIndex(storage)).filter(([id]) => present.has(id));
    const unknown: CacheIndex = [];
    const unreadable: string[] = [];
    for (const id of present) {
      if (known.some(([knownId]) => knownId === id)) continue;
      const chars = await measure(iconCacheKey(id), storage);
      if (chars === null) unreadable.push(id);
      else unknown.push([id, chars]);
    }
    const index = [...unknown, ...known];
    const evicted = [...unreadable, ...iconCachesOverBudget(index)];
    await saveIndex(index, evicted, storage);
    return [...orphans, ...evicted.map(iconCacheKey)];
  });
}
