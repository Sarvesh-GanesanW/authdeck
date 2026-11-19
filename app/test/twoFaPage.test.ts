/**
 * The 2FA page every deck is given: added once (new decks and decks saved by 0.3), never again
 * after it is deleted, filled with the vault's accounts as they come, and carried by deck backups.
 */
import { Platform } from './native';
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import type { AccountView } from '../src/auth/contract';
import { ConnectionManager } from '../src/net/connection';
import { MIN_TWO_FA_CELLS, pageCells, withNewAccounts } from '../src/screens/deck/twoFaPage';
import { backupJson, parseBackup } from '../src/screens/settings/deckBackup';
import { useLive } from '../src/state/live';
import { type Computer, type Deck, type Page, MAX_SLOTS, emptyPage } from '../src/state/model';
import { MAX_DECK_PAGES, TWO_FA_PAGE_NAME, migrateStore, useStore, withTwoFaPage } from '../src/state/store';
import { otpPage } from '../src/state/templates';
import { toBase64Url } from '../src/vault/bytes';
import { type TestServer, agentInfo, agentServer, newLinkKey, waitFor } from './linkServers';

const account = (id: string, issuer = id): AccountView => ({
  id,
  issuer,
  label: `${id}@example.com`,
  type: 'totp',
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  team: null,
});
const deckOf = (...names: string[]): Deck => ({ pages: names.map((n) => emptyPage(n)) });
const accountsOn = (page: Page) => page.slots.flatMap((k) => (k?.otp ? [k.otp.accountId] : []));
const twoFa = (deck: Deck) => deck.pages.find((p) => p.otp)!;

describe('every deck gets one 2FA page', () => {
  it('last, after the starter pages, as an empty 2FA page of its own', () => {
    const deck = withTwoFaPage(deckOf('Code', 'Git', 'Run', 'Apps'));
    assert.deepEqual(deck.pages.map((p) => p.name), ['Code', 'Git', 'Run', 'Apps', TWO_FA_PAGE_NAME]);
    const page = deck.pages[4]!;
    assert.equal(page.otp, true);
    assert.deepEqual(page.autoAccounts, []);
    assert.ok(page.slots.length > 0 && page.slots.every((k) => k === null));
    assert.equal(deck.twoFaOffered, true);
  });

  it('once: a deck it was offered to never gets it again, also after the page was deleted', () => {
    const given = withTwoFaPage(deckOf('Code'));
    assert.equal(withTwoFaPage(given), given);
    const deleted: Deck = { ...given, pages: given.pages.filter((p) => !p.otp) };
    assert.equal(withTwoFaPage(deleted).pages.length, 1);
  });

  it('a deck with a 2FA page of its own, or no room for a page, is only marked', () => {
    const own: Deck = { pages: [emptyPage('Code'), otpPage('Codes', [account('gh')])] };
    assert.deepEqual(withTwoFaPage(own), { ...own, twoFaOffered: true });
    const full: Deck = { pages: Array.from({ length: MAX_DECK_PAGES }, (_, i) => emptyPage(`Page ${i + 1}`)) };
    const marked = withTwoFaPage(full);
    assert.equal(marked.pages.length, MAX_DECK_PAGES);
    assert.equal(marked.twoFaOffered, true);
  });

  it('decks saved by 0.3 (store version 3) get it when the app updates; malformed ones are left for the load checks', () => {
    const migrated = migrateStore({ computers: [], decks: { mac: deckOf('Code', 'Apps'), bad: { pages: 'x' } } }, 3);
    assert.deepEqual(migrated.decks.mac!.pages.map((p) => p.name), ['Code', 'Apps', TWO_FA_PAGE_NAME]);
    assert.deepEqual(migrated.decks.bad, { pages: 'x' });
  });
});

describe('the 2FA page fills from the vault', () => {
  const blank = () => twoFa(withTwoFaPage(deckOf('Code')));

  it('after setup, every account gets a key showing its code', () => {
    const page = withNewAccounts(blank(), [account('gh'), account('aws')])!;
    assert.deepEqual(accountsOn(page), ['gh', 'aws']);
    assert.deepEqual(page.autoAccounts, ['gh', 'aws']);
    assert.equal(page.slots.find((k) => k?.otp)!.action, null);
  });

  it('an account added later is added; nothing changes when there is nothing new', () => {
    const first = withNewAccounts(blank(), [account('gh')])!;
    assert.equal(withNewAccounts(first, [account('gh')]), null);
    const second = withNewAccounts(first, [account('gh'), account('npm')])!;
    assert.deepEqual(accountsOn(second), ['gh', 'npm']);
  });

  it('a key the person removed is not put back', () => {
    const page = withNewAccounts(blank(), [account('gh'), account('aws')])!;
    const removed: Page = { ...page, slots: page.slots.map((k) => (k?.otp?.accountId === 'gh' ? null : k)) };
    assert.equal(withNewAccounts(removed, [account('gh'), account('aws')]), null);
    assert.deepEqual(accountsOn(withNewAccounts(removed, [account('gh'), account('aws'), account('npm')])!), ['npm', 'aws']);
  });

  it('an account already on the page (added from its empty spot) gets no second key', () => {
    const page = withNewAccounts(blank(), [account('gh')])!;
    const fromSpot = withNewAccounts({ ...page, autoAccounts: [] }, [account('gh')])!;
    assert.deepEqual(accountsOn(fromSpot), ['gh']);
  });

  it('a full page takes no more, and those accounts are not added later either', () => {
    const many = Array.from({ length: MAX_SLOTS + 2 }, (_, i) => account(`a${i}`));
    const page = withNewAccounts(blank(), many)!;
    assert.equal(page.slots.length, MAX_SLOTS);
    assert.equal(accountsOn(page).length, MAX_SLOTS);
    assert.equal(withNewAccounts(page, many), null);
  });

  it('once the person makes it a normal page, nothing more is added to it', () => {
    const { otp: _otp, ...normal } = withNewAccounts(blank(), [account('gh')])!;
    assert.equal(withNewAccounts(normal, [account('gh'), account('npm')]), null);
  });

  it('pages the person made into 2FA pages are left to them', () => {
    assert.equal(withNewAccounts(otpPage('Codes', [account('gh')]), [account('gh'), account('npm')]), null);
  });
});

describe('deck backups keep the 2FA page as it is', () => {
  const computer: Computer = { agentId: 'mac', name: 'Mac', platform: 'macos', hosts: [], port: 47474, pairedAt: 1 };

  it('its keys, the accounts offered to it and the mark come back on import', () => {
    const deck = withTwoFaPage(deckOf('Code'));
    const filled: Deck = { ...deck, pages: deck.pages.map((p) => withNewAccounts(p, [account('gh'), account('aws')]) ?? p) };
    const parsed = parseBackup(backupJson(computer, filled));
    assert.ok(parsed.ok);
    assert.equal(parsed.deck.twoFaOffered, true);
    const page = twoFa(parsed.deck);
    assert.deepEqual(page.autoAccounts, ['gh', 'aws']);
    assert.deepEqual(accountsOn(page), ['gh', 'aws']);
    assert.equal(withTwoFaPage(parsed.deck), parsed.deck);
  });

  it('a backup with a damaged list of offered accounts is refused', () => {
    const deck = withTwoFaPage(deckOf('Code'));
    const json = JSON.parse(backupJson(computer, deck));
    json.deck.pages[1].autoAccounts = [7];
    const parsed = parseBackup(JSON.stringify(json));
    assert.equal(parsed.ok, false);
  });
});

describe('a newly paired computer', () => {
  const servers: TestServer[] = [];
  let stop: (() => void) | null = null;
  beforeEach(() => {
    Platform.OS = 'web';
  });
  afterEach(() => {
    stop?.();
    stop = null;
  });
  after(() => Promise.all(servers.map((s) => s.close())));

  it('gets the starter deck with the 2FA page last', async () => {
    const key = newLinkKey();
    const server = await agentServer('127.0.0.1', 0, {
      key,
      info: agentInfo('new-mac'),
      answerRequest: (request, reply) => reply(JSON.stringify({ id: request.id, ok: true, result: request.method === 'apps.list' ? { apps: [] } : {} })),
    });
    servers.push(server);
    const computer: Computer = { agentId: 'new-mac', name: 'Mac', platform: 'macos', hosts: ['127.0.0.1'], port: server.port, linkKey: toBase64Url(key.public), pairedAt: 1 };
    useStore.setState({ computers: [computer], decks: {}, activeId: 'new-mac' });
    useLive.setState({ toast: null });
    const manager = new ConnectionManager(async () => [], async () => null);
    stop = manager.init();
    await waitFor('the starter deck', () => !!useStore.getState().decks['new-mac']);
    const deck = useStore.getState().decks['new-mac']!;
    assert.equal(deck.pages.at(-1)!.name, TWO_FA_PAGE_NAME);
    assert.equal(deck.pages.at(-1)!.otp, true);
    assert.equal(deck.twoFaOffered, true);
  });
});

describe('a 2FA page lays out only what it holds', () => {
  const twoFa = (accounts: number, size = 30): Page =>
    withNewAccounts({ ...emptyPage('2FA', size), otp: true, autoAccounts: [] }, Array.from({ length: accounts }, (_, i) => account(`a${i}`)))!;

  it('a normal page shows every slot', () => {
    const page = emptyPage('Code', 30);
    assert.deepEqual(pageCells(page, false), { cells: 30, shown: 30 });
    assert.deepEqual(pageCells(page, true), { cells: 30, shown: 30 });
  });

  it('a few accounts get the minimum grid, so their keys are big', () => {
    assert.deepEqual(pageCells({ ...emptyPage('2FA', 30), otp: true, autoAccounts: [] }, false), { cells: MIN_TWO_FA_CELLS, shown: MIN_TWO_FA_CELLS });
    assert.deepEqual(pageCells(twoFa(3), false), { cells: MIN_TWO_FA_CELLS, shown: MIN_TWO_FA_CELLS });
  });

  it('shows the keys and the "Add account" spot after them, and one more spot while editing, on the same grid', () => {
    const page = twoFa(20);
    assert.deepEqual(pageCells(page, false), { cells: 22, shown: 21 });
    assert.deepEqual(pageCells(page, true), { cells: 22, shown: 22 });
    assert.equal(page.slots[20], null, 'the "Add account" spot is empty');
  });

  it('counts up to the last key, gaps included, and never past the page', () => {
    const page = twoFa(3);
    const slots = [...page.slots];
    slots[12] = slots[0]!;
    slots[0] = null;
    assert.deepEqual(pageCells({ ...page, slots }, false), { cells: 15, shown: 14 });
    // Filling a page grows it to keep one empty spot (withAccountKeys): 30 accounts on 31 slots.
    const full = twoFa(30, 30);
    assert.deepEqual(pageCells(full, false), { cells: full.slots.length, shown: full.slots.length });
    const nearly = twoFa(28, 30);
    assert.deepEqual(pageCells(nearly, true), { cells: 30, shown: 30 });
  });
});
