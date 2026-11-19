// Security review of env sets (0.4), round 3, phone engine. Each test is a proof of concept for one
// finding: it fails while the weakness is there and passes once it is fixed. Ids match the report.
import '../native';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { seededRandom } from '../helpers';
import { generateDeviceKeys } from '../../src/vault/crypto';
import { createdSet, disposeAll, rig, type Rig } from '../env/fakes';
import { liveNames, onRealAuthority, phraseOn, valueLineOf, withLine } from './helpers';

afterEach(disposeAll);

const random = seededRandom('envattacks-round3');

/** The owner's phone, with a vault recovery phrase, and a set it made. */
async function ownerWithPhrase(values: { name: string; value: string }[]): Promise<{ r: Rig; phrase: string; setId: string; recovery: ReturnType<typeof phraseOn>['keys'] }> {
  const r = await rig({ open: false });
  const { phrase, keys } = phraseOn(r, random);
  r.vault.state = 'open';
  await r.engine.vaultChanged();
  const setId = await createdSet(r, values);
  return { r, phrase, setId, recovery: keys };
}

/** The phone restored from the phrase, on a computer whose clone holds `history` (oldest first). */
async function restoredWith(r: Rig, setId: string, history: readonly string[]): Promise<Rig> {
  const restored = await rig({ seed: `restored-${history.length}` });
  restored.vault.vault = r.vault.vault;
  for (const text of history) restored.agent.put(setId, 'acme-api', text);
  await restored.engine.sync();
  return restored;
}

describe('ENV-14: a take-over signs a forged set that only reuses the real set id and the vault recovery keys', () => {
  it('becoming owner refuses a file whose chain has no header by a device of this vault, even with the real history below it', async () => {
    const { r, phrase, setId, recovery } = await ownerWithPhrase([{ name: 'DB_URL', value: 'postgres://prod-db/acme' }]);
    // Mallory, who can push to the repo, commits her own set with the real id and the vault's
    // recovery public keys (both are in the real file) and values of her choosing.
    const mallory = generateDeviceKeys(random);
    // Ids are self-certifying now: the strongest forgery copies the real authority (birth and
    // changes) and the vault's recovery keys, and Mallory signs the header and lines herself.
    const forged = onRealAuthority(r.agent.sets.get(setId)!.text, mallory, random, {
      recovery,
      values: [{ name: 'DB_URL', value: 'postgres://mallory-host/acme' }],
    });
    const restored = await restoredWith(r, setId, [...r.agent.sets.get(setId)!.history, forged.text]);

    const outcome = await restored.engine.becomeOwner(setId, phrase.split(' ')).then(
      () => 'taken',
      (err: Error) => err.message,
    );
    const now = restored.agent.sets.get(setId)!.text;
    assert.equal(now, forged.text, `the restored phone took over Mallory's set and signed her DB_URL as its own (${outcome})`);
  });
});

describe('ENV-16: the history floor stops at 50 pages, so padding commits hide a deletion', () => {
  it('a take-over refuses the swapped tombstone even when the deletion is more than 50 pages back', async () => {
    const { r, phrase, setId } = await ownerWithPhrase([
      { name: 'API_KEY', value: 'sk_live_1' },
      { name: 'OLD_TOKEN', value: 'leaked-and-revoked' },
    ]);
    const oldTokenLine = valueLineOf(r.agent.sets.get(setId)!.text, 'OLD_TOKEN');
    await r.engine.deleteVariable(setId, 'OLD_TOKEN');
    const crafted = withLine(r.agent.sets.get(setId)!.text, 'OLD_TOKEN', oldTokenLine);
    // The agent pages history by bytes (768 KB a page, files up to 384 KB): two padded commits a page,
    // as the fake agent pages. 101 commits of the crafted file, each with another comment, fill 50 pages.
    const padding = Array.from({ length: 101 }, (_, i) => `# padding ${i}\n${crafted}`);
    const restored = await restoredWith(r, setId, [...r.agent.sets.get(setId)!.history, ...padding]);

    const outcome = await restored.engine.becomeOwner(setId, phrase.split(' ')).then(
      () => 'taken',
      (err: Error) => err.message,
    );
    const now = restored.agent.sets.get(setId)!.text;
    assert.equal(now, padding[padding.length - 1], `the take-over wrote over the crafted file (${outcome}); OLD_TOKEN live: ${liveNames(now).includes('OLD_TOKEN')}`);
  });
});
