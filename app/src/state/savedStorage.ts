/**
 * Where the main state (computers, decks, settings) is saved, and what happens when it can't be
 * read. The state is one AsyncStorage value. On Android that value is read through a 2 MB
 * CursorWindow, so a value past that fails to read ("Row too big") on every launch; the same goes
 * for a value that is not JSON any more. Loading therefore always finishes, as loaded or failed, and
 * a failed load leaves the saved value untouched until the person chooses to reset it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { create } from 'zustand';
import type { PersistStorage, StorageValue } from 'zustand/middleware';

/** The AsyncStorage key of the main state. Never the vault's or the auth flows' keys. */
export const SAVED_STATE_KEY = 'authdeck-v1';

/**
 * The most the main state may take when saved, in UTF-8 bytes: half of Android's CursorWindow, so
 * it always reads back. Real decks are far smaller; app ids and names from a computer are capped
 * (net/messages.ts LIMITS), and icons are saved under keys of their own (net/connection.ts).
 */
export const MAX_SAVED_STATE_BYTES = 1_000_000;

export type SavedStateLoad =
  | { status: 'loading' }
  | { status: 'loaded' }
  /** `tooLarge`: the platform said the saved value is too big to read. */
  | { status: 'failed'; tooLarge: boolean };

export const useSavedStateLoad = create<SavedStateLoad>(() => ({ status: 'loading' }));

/** Android's SQLiteBlobTooBigException and CursorWindow messages. */
const TOO_LARGE = /row too big|too big|cursorwindow|blob too big/i;

function describeLoadFailure(error: unknown): SavedStateLoad {
  const message = error instanceof Error ? error.message : String(error);
  return { status: 'failed', tooLarge: TOO_LARGE.test(message) };
}

/** Called by persist when a load ends: with an error when the value could not be read, parsed or merged. */
export function finishLoad(error: unknown): void {
  useSavedStateLoad.setState(error === undefined ? { status: 'loaded' } : describeLoadFailure(error), true);
}

/** The UTF-8 size of `text`, without allocating an encoded copy. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Why a save was skipped, for the person: the state stays in memory, the last good save stays on disk. */
export type SaveProblem = 'too-large' | 'write-failed';

/**
 * How long a save of a change that may wait (see SaveTiming) holds off for more changes. Each such
 * change starts the wait again, so a run of page changes is written once, after the last of them.
 */
export const DEFERRED_SAVE_MS = 500;
/**
 * The longest a waiting save is held, however many changes follow it: a computer switching pages
 * faster than DEFERRED_SAVE_MS would otherwise keep it from being written until the app is left.
 */
export const MAX_DEFERRED_SAVE_MS = 2000;

export interface SaveTiming<S> {
  /**
   * Top-level fields whose changes alone may wait DEFERRED_SAVE_MS before they are written: cheap
   * to lose on a hard kill (which page was showing), and changed often (each page switch). A save
   * that changes any other field is written at once, together with anything still waiting.
   */
  deferrable: readonly (keyof S)[];
  /** Calls `flush` when the app leaves the foreground. Defaults to the app's AppState. */
  onLeaveForeground?: (flush: () => void) => void;
}

/** True when `next` differs from `prev` only in `fields`. */
export function changedOnly<S>(prev: S, next: S, fields: readonly (keyof S)[]): boolean {
  for (const key of Object.keys(next as object) as (keyof S)[]) {
    if (!fields.includes(key) && prev[key] !== next[key]) return false;
  }
  return Object.keys(prev as object).length === Object.keys(next as object).length;
}

function onAppLeavingForeground(flush: () => void): void {
  // iOS goes 'inactive' first (app switcher, a call); Android goes straight to 'background'.
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') flush();
  });
}

/**
 * JSON in AsyncStorage, with two guards: nothing is written while a failed load is on screen (it
 * would replace decks the person may still get back), and nothing larger than
 * MAX_SAVED_STATE_BYTES is written (it could not be read again). `onProblem` hears about a skipped
 * save once, when saving starts failing, and not again until a save works.
 *
 * With `timing`, a change to only its deferrable fields waits a moment and is written with the
 * changes after it (persist serialises the whole state on every change, and a page switch should
 * not pay for that); it is written at once when the app leaves the foreground.
 */
export function savedStateStorage<S>(onProblem: (problem: SaveProblem) => void, timing?: SaveTiming<S>): PersistStorage<S> {
  let failing = false;
  const report = (problem: SaveProblem) => {
    if (!failing) onProblem(problem);
    failing = true;
  };

  const write = async (name: string, value: StorageValue<S>) => {
    if (useSavedStateLoad.getState().status === 'failed') return;
    const json = JSON.stringify(value);
    if (utf8Length(json) > MAX_SAVED_STATE_BYTES) {
      report('too-large');
      return;
    }
    try {
      await AsyncStorage.setItem(name, json);
      failing = false;
    } catch {
      report('write-failed');
    }
  };

  /** The newest state handed over, and the save of it that is still waiting, if any. */
  let lastState: S | null = null;
  let waiting: { name: string; value: StorageValue<S> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const cancelWaiting = () => {
    if (timer !== null) clearTimeout(timer);
    if (deadline !== null) clearTimeout(deadline);
    timer = null;
    deadline = null;
    waiting = null;
  };
  const flush = async () => {
    const save = waiting;
    cancelWaiting();
    if (save) await write(save.name, save.value);
  };
  if (timing) (timing.onLeaveForeground ?? onAppLeavingForeground)(() => void flush());

  return {
    getItem: async (name) => {
      const raw = await AsyncStorage.getItem(name);
      return raw === null ? null : (JSON.parse(raw) as StorageValue<S>);
    },
    setItem: async (name, value) => {
      const canWait = !!timing && lastState !== null && changedOnly(lastState, value.state, timing.deferrable);
      lastState = value.state;
      if (!canWait) {
        // Written now, so anything still waiting (an older state) is dropped rather than written after it.
        cancelWaiting();
        await write(name, value);
        return;
      }
      if (timer !== null) clearTimeout(timer);
      waiting = { name, value };
      timer = setTimeout(() => void flush(), DEFERRED_SAVE_MS);
      deadline ??= setTimeout(() => void flush(), MAX_DEFERRED_SAVE_MS);
    },
    removeItem: async (name) => {
      // A waiting save would bring back what is being removed.
      cancelWaiting();
      lastState = null;
      await AsyncStorage.removeItem(name);
    },
  };
}

/** What App draws: the splash until fonts and saved state are ready, the recovery screen if the state could not be read. */
export function launchScreen(fontsReady: boolean, load: SavedStateLoad): 'splash' | 'recovery' | 'app' {
  if (!fontsReady || load.status === 'loading') return 'splash';
  return load.status === 'failed' ? 'recovery' : 'app';
}
