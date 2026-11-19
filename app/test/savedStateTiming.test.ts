/**
 * When the saved state is written: a page switch waits a moment and is written with the changes
 * after it, anything else is written at once, and leaving the app writes what is waiting.
 */
import './native';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = require('@react-native-async-storage/async-storage') as { getItem: (key: string) => Promise<string | null> };
import { DEFERRED_SAVE_MS, MAX_DEFERRED_SAVE_MS, SAVED_STATE_KEY, changedOnly, savedStateStorage, useSavedStateLoad } from '../src/state/savedStorage';
import { resetSavedDecksAndComputers, useStore } from '../src/state/store';

interface Saved {
  decks: { name: string }[];
  pageIndex: Record<string, number>;
}

const KEY = 'timing-test';

async function savedNow(): Promise<Saved | null> {
  const raw = await storage.getItem(KEY);
  return raw === null ? null : (JSON.parse(raw) as { state: Saved }).state;
}

function setUp() {
  let leave: () => void = () => undefined;
  const saved = savedStateStorage<Saved>(() => undefined, {
    deferrable: ['pageIndex'],
    onLeaveForeground: (flush) => {
      leave = flush;
    },
  });
  const save = (state: Saved) => saved.setItem(KEY, { state, version: 1 });
  return { saved, save, leave: () => leave() };
}

describe('when the saved state is written', () => {
  beforeEach(async () => {
    useSavedStateLoad.setState({ status: 'loaded' }, true);
    await setUp().saved.removeItem(KEY);
  });

  it('writes a page switch only after the switches stop', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { save } = setUp();
      const decks = [{ name: 'Code' }];
      await save({ decks, pageIndex: { a: 0 } });
      await save({ decks, pageIndex: { a: 1 } });
      mock.timers.tick(DEFERRED_SAVE_MS - 1);
      await save({ decks, pageIndex: { a: 2 } });
      mock.timers.tick(DEFERRED_SAVE_MS - 1);
      assert.deepEqual((await savedNow())?.pageIndex, { a: 0 }, 'nothing written while switching');
      mock.timers.tick(1);
      await Promise.resolve();
      assert.deepEqual((await savedNow())?.pageIndex, { a: 2 });
    } finally {
      mock.timers.reset();
    }
  });

  it('writes a run of page switches after MAX_DEFERRED_SAVE_MS, however many keep coming', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { save } = setUp();
      const decks = [{ name: 'Code' }];
      await save({ decks, pageIndex: { a: 0 } });
      const step = DEFERRED_SAVE_MS / 2;
      for (let i = 1; i * step < MAX_DEFERRED_SAVE_MS; i++) {
        await save({ decks, pageIndex: { a: i } });
        mock.timers.tick(step);
      }
      assert.deepEqual((await savedNow())?.pageIndex, { a: 0 }, 'still waiting');
      await save({ decks, pageIndex: { a: 99 } });
      mock.timers.tick(step);
      await Promise.resolve();
      assert.deepEqual((await savedNow())?.pageIndex, { a: 99 });
    } finally {
      mock.timers.reset();
    }
  });

  it('writes a deck change at once, with the page switch that was waiting', async () => {
    const { save } = setUp();
    const decks = [{ name: 'Code' }];
    await save({ decks, pageIndex: { a: 0 } });
    await save({ decks, pageIndex: { a: 3 } });
    await save({ decks: [{ name: 'Git' }], pageIndex: { a: 3 } });
    assert.deepEqual(await savedNow(), { decks: [{ name: 'Git' }], pageIndex: { a: 3 } });
  });

  it('writes a waiting page switch when the app leaves the foreground', async () => {
    const { save, leave } = setUp();
    const decks = [{ name: 'Code' }];
    await save({ decks, pageIndex: { a: 0 } });
    await save({ decks, pageIndex: { a: 1 } });
    leave();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((await savedNow())?.pageIndex, { a: 1 });
  });

  it('never writes a waiting save after the state is removed', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { saved, save } = setUp();
      const decks = [{ name: 'Code' }];
      await save({ decks, pageIndex: { a: 0 } });
      await save({ decks, pageIndex: { a: 1 } });
      await saved.removeItem(KEY);
      mock.timers.tick(DEFERRED_SAVE_MS);
      await Promise.resolve();
      assert.equal(await savedNow(), null);
    } finally {
      mock.timers.reset();
    }
  });

  it('compares fields by identity, ignoring the deferrable ones', () => {
    const decks = [{ name: 'Code' }];
    assert.equal(changedOnly<Saved>({ decks, pageIndex: {} }, { decks, pageIndex: { a: 1 } }, ['pageIndex']), true);
    assert.equal(changedOnly<Saved>({ decks, pageIndex: {} }, { decks: [...decks], pageIndex: {} }, ['pageIndex']), false);
  });
});

describe('resetting the saved decks', () => {
  it('drops a page switch still waiting, so it never writes the old state back', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await useStore.persist.rehydrate();
      useSavedStateLoad.setState({ status: 'loaded' }, true);
      useStore.getState().setPageIndex('agent-a', 1);
      useStore.getState().setPageIndex('agent-a', 2);
      await resetSavedDecksAndComputers();
      mock.timers.tick(MAX_DEFERRED_SAVE_MS);
      await new Promise((resolve) => setImmediate(resolve));
      const raw = await storage.getItem(SAVED_STATE_KEY);
      const pageIndex = raw === null ? {} : (JSON.parse(raw) as { state: Saved }).state.pageIndex;
      assert.equal(pageIndex['agent-a'], undefined);
    } finally {
      mock.timers.reset();
    }
  });
});

describe('forgetting a computer', () => {
  it('drops the page it last showed along with its deck', () => {
    useStore.getState().setPageIndex('agent-gone', 2);
    useStore.getState().setPageIndex('agent-kept', 1);
    useStore.getState().removeComputer('agent-gone');
    const { pageIndex } = useStore.getState();
    assert.equal('agent-gone' in pageIndex, false);
    assert.equal(pageIndex['agent-kept'], 1);
  });
});
