// Security review of env sets (0.4), round 4, phone engine. Each test is a proof of concept for one
// finding: it fails while the weakness is there and passes once it is fixed. Ids match the report.
import '../native';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { seededRandom } from '../helpers';
import { generateDeviceKeys } from '../../src/vault/crypto';
import { createdSet, disposeAll, rig, type Rig } from '../env/fakes';
import { addMember, fileOf, onRealAuthority, phraseOn } from './helpers';

afterEach(disposeAll);

const random = seededRandom('envattacks-round4');

/** The owner's phone, with a vault recovery phrase, and a set it made. */
async function ownerWithPhrase(): Promise<{ r: Rig; phrase: string; setId: string; recovery: ReturnType<typeof phraseOn>['keys'] }> {
  const r = await rig({ open: false });
  const { phrase, keys } = phraseOn(r, random);
  r.vault.state = 'open';
  await r.engine.vaultChanged();
  const setId = await createdSet(r, [{ name: 'DB_URL', value: 'postgres://prod-db/acme' }]);
  return { r, phrase, setId, recovery: keys };
}

/** The phone restored from the phrase, on a computer whose clone holds `history` (oldest first, one commit each). */
async function restoredWith(r: Rig, setId: string, history: readonly string[]): Promise<Rig> {
  const restored = await rig({ seed: `restored4-${history.length}-${history[history.length - 1]!.length}` });
  restored.vault.vault = r.vault.vault;
  for (const text of history) restored.agent.put(setId, 'acme-api', text);
  await restored.engine.sync();
  return restored;
}

async function takeOver(restored: Rig, setId: string, phrase: string): Promise<string> {
  return restored.engine.becomeOwner(setId, phrase.split(' ')).then(
    () => 'taken',
    (err: Error) => err.message,
  );
}

describe('ENV-18: a header change that was never committed on its own breaks the chain, and the honest set reads as two sets', () => {
  it('a take-over of an honest set goes through when git skipped a rev (two members added between commits)', async () => {
    const { r, phrase, setId } = await ownerWithPhrase();
    // The owner adds two teammates in one sitting; the user commits once afterwards. Git holds
    // rev 1 and rev 3, never rev 2, which rev 3's prev names.
    await addMember(r, setId, generateDeviceKeys(random), 'Ana laptop');
    await addMember(r, setId, generateDeviceKeys(random), 'Raj laptop');
    const all = r.agent.sets.get(setId)!.history;
    const committed = all.filter((text) => fileOf(text).header.rev !== 2);
    assert.ok(committed.some((text) => fileOf(text).header.rev === 1) && fileOf(committed[committed.length - 1]!).header.rev === 3);
    const restored = await restoredWith(r, setId, committed);

    const outcome = await takeOver(restored, setId, phrase);
    assert.equal(outcome, 'taken', 'the restored phone refused its own honest set');
  });
});

describe('ENV-19: one forged commit anywhere in history blocks every first take of the set for good', () => {
  it('a take-over of the honest current file goes through after a repo writer committed and reverted a same-id set', async () => {
    const { r, phrase, setId, recovery } = await ownerWithPhrase();
    const honest = r.agent.sets.get(setId)!.history;
    const current = honest[honest.length - 1]!;
    // Mallory commits her own set under the real id, then a revert puts the honest file back.
    const mallory = generateDeviceKeys(random);
    // Ids are self-certifying now: the strongest forgery copies the real authority (birth and
    // changes) and the vault's recovery keys, and Mallory signs the header and lines herself.
    const forged = onRealAuthority(current, mallory, random, {
      recovery,
      values: [{ name: 'DB_URL', value: 'postgres://mallory-host/acme' }],
    });
    const restored = await restoredWith(r, setId, [...honest, forged.text, current]);

    const outcome = await takeOver(restored, setId, phrase);
    assert.equal(outcome, 'taken', 'a reverted forgery in history keeps the honest set from ever being taken');
  });
});
