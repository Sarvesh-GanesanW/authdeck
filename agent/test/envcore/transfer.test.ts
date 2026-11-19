/** Released values sealed to the CLI's one-time key or the agent's grant key, bound to one request. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnvFileRefused, newEnvTransferKey, openEnvSealedValues, sealEnvValues } from '../../src/envcore';
import { utf8Encode } from '../../src/vault/bytes';
import { encryptBox, sealKey } from '../../src/vault/crypto';
import { seededRandom } from '../helpers/vault';
import { makeSet, VALUES } from './fixtures';

const set = makeSet();
const random = seededRandom('transfer');
const cliKey = newEnvTransferKey(random);
const grantKey = newEnvTransferKey(random);
const run = { set: set.setId, request: 'req-1' };

describe('releasing values', () => {
  it('opens with the recipient key for the same request, values in order', () => {
    const sealed = sealEnvValues(VALUES, run, cliKey.xPublic, random);
    assert.deepEqual(openEnvSealedValues(sealed, run, cliKey), VALUES);
  });

  it('is bound to the request id, the set and the recipient', () => {
    const sealed = sealEnvValues(VALUES, run, cliKey.xPublic, random);
    assert.throws(() => openEnvSealedValues(sealed, { ...run, request: 'req-2' }, cliKey), /this request/);
    assert.throws(() => openEnvSealedValues(sealed, { ...run, set: makeSet('other').setId }, cliKey));
    assert.throws(() => openEnvSealedValues(sealed, run, grantKey));
    const other = sealEnvValues([{ name: 'A', value: 'b' }], run, cliKey.xPublic, random);
    assert.throws(() => openEnvSealedValues({ key: sealed.key, box: other.box }, run, cliKey), 'a box from another release');
  });

  it('inside a grant, the agent opens with its grant key and seals again for each run', () => {
    const granted = sealEnvValues(VALUES, { ...run, request: 'grant-req' }, grantKey.xPublic, random);
    const held = openEnvSealedValues(granted, { ...run, request: 'grant-req' }, grantKey);
    const later = sealEnvValues(held, { ...run, request: 'req-7' }, cliKey.xPublic, random);
    assert.deepEqual(openEnvSealedValues(later, { ...run, request: 'req-7' }, cliKey), VALUES);
  });

  it('refuses to seal values that break the rules, and to open contents that are malformed', () => {
    assert.throws(() => sealEnvValues([{ name: '9', value: '' }], run, cliKey.xPublic, random), EnvFileRefused);
    assert.throws(() => sealEnvValues(VALUES, run, new Uint8Array(32), random), /usable/);
    const transferKey = random(32);
    const forge = (json: string) => ({
      key: sealKey(transferKey, cliKey.xPublic, { vault: run.set, epoch: 0, to: `env-release/${run.request}` }),
      box: encryptBox(transferKey, utf8Encode(json), { vault: run.set, epoch: 0, kind: 'env-release', request: run.request }, random),
    });
    assert.deepEqual(openEnvSealedValues(forge('[{"name":"A","value":"1"}]'), run, cliKey), [{ name: 'A', value: '1' }]);
    for (const json of ['{}', '[{"name":"A"}]', '[{"name":"A","value":1}]', '[{"name":"A","value":"1","x":2}]', '[{"name":"A","value":"1"},{"name":"A","value":"2"}]']) {
      assert.throws(() => openEnvSealedValues(forge(json), run, cliKey), Error, json);
    }
  });
});
