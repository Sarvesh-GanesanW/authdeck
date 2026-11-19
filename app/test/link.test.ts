import './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateLinkKey, linkKeyWords } from '../src/link/keys';
import { REPAIR_TITLE, computerLink } from '../src/net/linkState';
import type { Computer, Deck } from '../src/state/model';
import { migrateStore, needsRepair } from '../src/state/store';
import { toBase64Url } from '../src/vault/bytes';
import { seededRandom } from './helpers';

const random = seededRandom('link-tests');

/** A computer as protocol 1 saved it: a bearer token and no link key. */
const oldComputer = { agentId: 'mac', name: 'Mac', platform: 'macos', hosts: ['192.168.1.5'], port: 47474, token: 'f'.repeat(64), pairedAt: 1 };
const deck: Deck = { pages: [{ id: 'p1', name: 'Code', slots: [null] } as Deck['pages'][number]] };

describe('re-pairing after the link was encrypted', () => {
  it('a version 2 store loses the token, keeps the deck, and the computer needs pairing again', () => {
    const migrated = migrateStore({ deviceId: 'd', computers: [oldComputer], activeId: 'mac', decks: { mac: deck } }, 2);
    const [computer] = migrated.computers;
    assert.equal('token' in computer!, false);
    assert.equal(needsRepair(computer!), true);
    assert.deepEqual(migrated.decks.mac!.pages[0], deck.pages[0]);
    assert.equal(migrated.activeId, 'mac');
  });

  it('the settings sheet shows the pair-again state for an old record', () => {
    const [computer] = migrateStore({ computers: [oldComputer] }, 2).computers;
    const link = computerLink(computer!);
    assert.equal(link.kind, 'repair');
    assert.equal(link.kind === 'repair' && link.title, REPAIR_TITLE);
    assert.match(REPAIR_TITLE, /Pair again: AuthDeck now encrypts the connection/);
  });

  it('a computer paired with a link key shows its three key words', () => {
    const key = generateLinkKey(random);
    const computer: Computer = { agentId: 'mac', name: 'Mac', platform: 'macos', hosts: [], port: 47474, linkKey: toBase64Url(key.public), pairedAt: 1 };
    assert.equal(needsRepair(computer), false);
    assert.deepEqual(computerLink(computer), { kind: 'linked', keyWords: linkKeyWords(key.public).join(' · ') });
  });

  it('a version 4 store is left as it is', () => {
    const state = { computers: [{ ...oldComputer, linkKey: 'k' }], decks: { mac: deck } };
    assert.equal(migrateStore(state, 4), state);
  });
});
