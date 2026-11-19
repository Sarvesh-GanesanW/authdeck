/**
 * Persistent app state: paired computers, one deck per computer, and settings.
 * Everything here survives restarts (AsyncStorage). Live connection state is in live.ts.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { checkedComputers, checkedDecks, checkedPageIndex } from '../net/storedData';
import type { ColorwayId } from '../theme/colorways';
import { useLive } from './live';
import { SAVED_STATE_KEY, type SaveProblem, finishLoad, savedStateStorage, useSavedStateLoad } from './savedStorage';
import { type Computer, type Deck, type DeckKey, type Page, emptyPage, newId, resizeSlots } from './model';

export type ColorwaySetting = ColorwayId | 'system';

export interface Settings {
  colorway: ColorwaySetting;
  haptics: boolean;
  keySounds: boolean;
  keepAwake: boolean;
  /** Switch to a page when its linked app comes to the front on the computer. */
  autoSwitch: boolean;
  /** Print the shortcut or command on the front of each key. */
  sublegends: boolean;
}

interface State {
  deviceId: string;
  computers: Computer[];
  activeId: string | null;
  decks: Record<string, Deck>;
  /** Last page shown per computer. */
  pageIndex: Record<string, number>;
  settings: Settings;

  addComputer: (c: Computer, deck: Deck | null) => void;
  updateComputer: (agentId: string, patch: Partial<Computer>) => void;
  removeComputer: (agentId: string) => void;
  setActive: (agentId: string | null) => void;
  setPageIndex: (agentId: string, index: number) => void;
  setSettings: (patch: Partial<Settings>) => void;

  setDeck: (agentId: string, deck: Deck) => void;
  updatePage: (agentId: string, pageId: string, fn: (p: Page) => Page) => void;
  addPage: (agentId: string, name: string) => string;
  removePage: (agentId: string, pageId: string) => void;
  movePage: (agentId: string, from: number, to: number) => void;
  setKey: (agentId: string, pageId: string, index: number, key: DeckKey | null) => void;
  moveKey: (agentId: string, pageId: string, from: number, to: number) => void;
  moveKeyToPage: (agentId: string, fromPageId: string, index: number, toPageId: string) => boolean;
  resizePage: (agentId: string, pageId: string, size: number) => void;
}

/** What is saved: everything but the actions. */
type SavedState = Pick<State, 'deviceId' | 'computers' | 'activeId' | 'decks' | 'pageIndex' | 'settings'>;

const DEFAULT_SETTINGS: Settings = {
  colorway: 'graphite',
  haptics: true,
  keySounds: true,
  keepAwake: true,
  autoSwitch: true,
  sublegends: true,
};

/**
 * 2: keys may be 2FA keys (`DeckKey.otp`) and pages 2FA pages (`Page.otp`). Both fields are
 * optional, so a version 1 deck is already a valid version 2 deck.
 * 3: the connection is encrypted. A computer's bearer `token` is dropped and its `linkKey` is
 * missing until it is paired again (see needsRepair); its deck stays.
 * 4: every deck gets its 2FA page once (withTwoFaPage).
 */
const STORE_VERSION = 4;

/** The most pages a deck holds: the limit a deck backup is read back with. */
export const MAX_DECK_PAGES = 100;
export const TWO_FA_PAGE_NAME = '2FA';

/**
 * Gives a deck its 2FA page, last, the first time only: a deck already offered one never gets it
 * again, also after the person deleted it. A deck that already has a 2FA page of its own, or no
 * room for another page, is only marked.
 */
export function withTwoFaPage(deck: Deck): Deck {
  if (deck.twoFaOffered) return deck;
  if (deck.pages.some((p) => p.otp) || deck.pages.length >= MAX_DECK_PAGES) return { ...deck, twoFaOffered: true };
  const page: Page = { ...emptyPage(TWO_FA_PAGE_NAME), otp: true, autoAccounts: [] };
  return { ...deck, pages: [...deck.pages, page], twoFaOffered: true };
}

/**
 * Brings state saved by another version up to STORE_VERSION. Without a migrate function persist
 * drops saved state whose version differs, which would wipe every deck. Newer saves are kept as
 * they are, since extra fields do no harm.
 */
export function migrateStore(persisted: unknown, version: number): State {
  let state = persisted as State;
  if (version < 3 && Array.isArray(state?.computers)) {
    // Protocol 1 tokens no longer open anything; keeping them would only keep a secret around.
    const computers = state.computers.map((c) => {
      const { token: _token, ...rest } = c as Computer & { token?: string };
      return rest;
    });
    state = { ...state, computers };
  }
  if (version < 4 && typeof state?.decks === 'object' && state.decks !== null) {
    // Not checked yet (merge checks decks after this): anything not shaped like a deck is left for it.
    const decks = Object.entries(state.decks).map(([id, d]) => [id, Array.isArray(d?.pages) ? withTwoFaPage(d) : d]);
    state = { ...state, decks: Object.fromEntries(decks) as Record<string, Deck> };
  }
  return state;
}

/** True for a computer paired before the connection was encrypted: it has no link key yet. */
export function needsRepair(computer: Computer): boolean {
  return !computer.linkKey;
}

/**
 * A computer's entry in a record keyed by agentId. Own entries only: a plain lookup of an id such
 * as "__proto__" or "toString" would read Object.prototype and pass for a saved deck.
 */
export function entryFor<T>(record: Readonly<Record<string, T>>, agentId: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, agentId) ? record[agentId] : undefined;
}

const SAVE_PROBLEMS: Record<SaveProblem, { title: string; detail: string }> = {
  'too-large': {
    title: 'AuthDeck could not save your latest changes',
    detail: 'Your decks are too large to save on this device. Remove some pages or keys; the last saved decks are kept.',
  },
  'write-failed': {
    title: 'AuthDeck could not save your latest changes',
    detail: 'This device did not accept the save. Free up some storage; the last saved decks are kept.',
  },
};

function tellSaveProblem(problem: SaveProblem): void {
  useLive.getState().showToast({ tone: 'fail', ...SAVE_PROBLEMS[problem] });
}

function mapDeck(decks: Record<string, Deck>, agentId: string, fn: (d: Deck) => Deck): Record<string, Deck> {
  const d = entryFor(decks, agentId);
  if (!d) return decks;
  return { ...decks, [agentId]: fn(d) };
}

function mapPage(deck: Deck, pageId: string, fn: (p: Page) => Page): Deck {
  return { ...deck, pages: deck.pages.map((p) => (p.id === pageId ? fn(p) : p)) };
}

// The page shown is saved a moment after the last switch, not on every switch.
const savedState = savedStateStorage<SavedState>(tellSaveProblem, { deferrable: ['pageIndex'] });

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      deviceId: newId('d'),
      computers: [],
      activeId: null,
      decks: {},
      pageIndex: {},
      settings: DEFAULT_SETTINGS,

      addComputer: (c, deck) =>
        set((s) => {
          const others = s.computers.filter((x) => x.agentId !== c.agentId);
          const decks = deck && !entryFor(s.decks, c.agentId) ? { ...s.decks, [c.agentId]: deck } : s.decks;
          // Adding never switches computers: the caller makes it active only when the person chose it.
          return { computers: [...others, c], decks };
        }),
      updateComputer: (agentId, patch) =>
        set((s) => ({ computers: s.computers.map((c) => (c.agentId === agentId ? { ...c, ...patch } : c)) })),
      removeComputer: (agentId) =>
        set((s) => {
          const computers = s.computers.filter((c) => c.agentId !== agentId);
          const { [agentId]: _gone, ...decks } = s.decks;
          const { [agentId]: _shown, ...pageIndex } = s.pageIndex;
          return {
            computers,
            decks,
            pageIndex,
            activeId: s.activeId === agentId ? (computers[0]?.agentId ?? null) : s.activeId,
          };
        }),
      setActive: (agentId) => set({ activeId: agentId }),
      setPageIndex: (agentId, index) => set((s) => ({ pageIndex: { ...s.pageIndex, [agentId]: index } })),
      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      setDeck: (agentId, deck) => set((s) => ({ decks: { ...s.decks, [agentId]: deck } })),
      updatePage: (agentId, pageId, fn) => set((s) => ({ decks: mapDeck(s.decks, agentId, (d) => mapPage(d, pageId, fn)) })),
      addPage: (agentId, name) => {
        const page = emptyPage(name);
        set((s) => ({ decks: mapDeck(s.decks, agentId, (d) => ({ ...d, pages: [...d.pages, page] })) }));
        return page.id;
      },
      removePage: (agentId, pageId) =>
        set((s) => ({
          decks: mapDeck(s.decks, agentId, (d) =>
            d.pages.length <= 1 ? d : { ...d, pages: d.pages.filter((p) => p.id !== pageId) },
          ),
        })),
      movePage: (agentId, from, to) =>
        set((s) => ({
          decks: mapDeck(s.decks, agentId, (d) => {
            const pages = [...d.pages];
            const [p] = pages.splice(from, 1);
            if (!p) return d;
            pages.splice(Math.max(0, Math.min(pages.length, to)), 0, p);
            return { ...d, pages };
          }),
        })),
      setKey: (agentId, pageId, index, key) =>
        get().updatePage(agentId, pageId, (p) => {
          const slots = [...p.slots];
          if (index < 0 || index >= slots.length) return p;
          slots[index] = key;
          return { ...p, slots };
        }),
      moveKey: (agentId, pageId, from, to) =>
        get().updatePage(agentId, pageId, (p) => {
          if (from === to) return p;
          const slots = [...p.slots];
          const [k] = slots.splice(from, 1);
          slots.splice(to, 0, k ?? null);
          return { ...p, slots };
        }),
      moveKeyToPage: (agentId, fromPageId, index, toPageId) => {
        const deck = entryFor(get().decks, agentId);
        const from = deck?.pages.find((p) => p.id === fromPageId);
        const to = deck?.pages.find((p) => p.id === toPageId);
        const key = from?.slots[index];
        if (!deck || !from || !to || !key) return false;
        let target = to.slots.indexOf(null);
        const toSlots = [...to.slots];
        if (target < 0) {
          toSlots.push(null);
          target = toSlots.length - 1;
        }
        toSlots[target] = key;
        set((s) => ({
          decks: mapDeck(s.decks, agentId, (d) => ({
            ...d,
            pages: d.pages.map((p) => {
              if (p.id === fromPageId) {
                const slots = [...p.slots];
                slots[index] = null;
                return { ...p, slots };
              }
              if (p.id === toPageId) return { ...p, slots: toSlots };
              return p;
            }),
          })),
        }));
        return true;
      },
      resizePage: (agentId, pageId, size) =>
        get().updatePage(agentId, pageId, (p) => ({ ...p, slots: resizeSlots(p.slots, size) })),
    }),
    {
      name: SAVED_STATE_KEY,
      version: STORE_VERSION,
      migrate: migrateStore,
      storage: savedState,
      // Called on every load, also when reading, parsing, migrating or merging failed, so the app
      // never waits on the splash for a load that ended in an error.
      onRehydrateStorage: () => (_state, error) => finishLoad(error),
      partialize: (s): SavedState => ({
        deviceId: s.deviceId,
        computers: s.computers,
        activeId: s.activeId,
        decks: s.decks,
        pageIndex: s.pageIndex,
        settings: s.settings,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>;
        const merged = { ...current, ...p, settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) } };
        // Computers and decks hold what computers sent (names, app ids): checked again on load.
        if (p.computers !== undefined) {
          merged.computers = checkedComputers(p.computers);
          const savedActive = merged.activeId ?? null;
          const stillSaved = savedActive === null || merged.computers.some((c) => c.agentId === savedActive);
          merged.activeId = stillSaved ? savedActive : (merged.computers[0]?.agentId ?? null);
        }
        if (p.decks !== undefined) merged.decks = checkedDecks(p.decks);
        if (p.pageIndex !== undefined) merged.pageIndex = checkedPageIndex(p.pageIndex);
        return merged;
      },
    },
  ),
);

/**
 * For the recovery screen: deletes the saved decks, computers and settings (one AsyncStorage key,
 * never the vault's or the auth flows' storage), then loads again from nothing.
 */
export async function resetSavedDecksAndComputers(): Promise<void> {
  // Through the saved-state storage, so a save still waiting is dropped instead of writing the old state back.
  await savedState.removeItem(SAVED_STATE_KEY);
  useSavedStateLoad.setState({ status: 'loading' }, true);
  await useStore.persist.rehydrate();
}

/** For the recovery screen: reads the saved state again, for a failure that may not repeat. */
export async function retryLoad(): Promise<void> {
  useSavedStateLoad.setState({ status: 'loading' }, true);
  await useStore.persist.rehydrate();
}

export function useActiveComputer(): Computer | null {
  return useStore((s) => s.computers.find((c) => c.agentId === s.activeId) ?? null);
}

export function useActiveDeck(): Deck | null {
  return useStore((s) => (s.activeId ? (entryFor(s.decks, s.activeId) ?? null) : null));
}
