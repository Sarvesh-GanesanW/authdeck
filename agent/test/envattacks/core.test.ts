// Security review of env sets (0.4), env core and CLI. Each test is a proof of concept for one
// finding: it fails while the weakness is there and passes once it is fixed. Ids match the report.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  mergeEnvFiles,
  nextEnvTrust,
  openEnvDataKey,
  rekeyEnvSet,
  signEnvHeader,
  verifyEnvFile,
  writeEnvFile,
  type EnvHeader,
} from '../../src/envcore';
import { envMemberRecord } from '../../src/envcore/keys';
import { runChild } from '../../src/envcli/child';
import { device, makeSet, T0, verified } from '../envcore/fixtures';
import { seededRandom } from '../helpers/vault';

describe('ENV-05: rollback across a re-key: a file at a newer epoch may drop any variable', () => {
  it('a device that remembers STRIPE_SECRET_KEY refuses a newer-epoch file without it', () => {
    const set = makeSet('rollback');
    const trust = nextEnvTrust(null, verified(set.text, null));
    // The owner re-keys (a removal, a new phrase, settling headers): every live name keeps its version.
    const rekeyed = rekeyEnvSet({ file: set.file, owner: set.owner, dataKeys: { 1: set.dataKey }, time: T0 + 10, random: seededRandom('rollback/rekey') });
    const text = writeEnvFile(rekeyed.file);
    assert.equal(verifyEnvFile(text, trust).ok, true, 'the real re-keyed file passes');

    // A repo writer (or the computer) deletes one value line from the real epoch-2 file.
    const dropped = text
      .split('\n')
      .filter((line) => !line.startsWith('STRIPE_SECRET_KEY='))
      .join('\n');
    const result = verifyEnvFile(dropped, trust);
    assert.equal(result.ok, false, 'a remembered live variable vanished without a tombstone, and the file was still accepted');
  });
});

describe('ENV-06: the recovery identity signs a member change that is not a take-over', () => {
  /** The recovery identity adds `stranger` while keeping the owner. */
  function recoverySignedAddition(seed: string) {
    const set = makeSet(seed);
    const header = set.file.header;
    const stranger = device(`${seed}/stranger`);
    const dataKey = openEnvDataKey(header, set.recovery);
    const record = envMemberRecord(dataKey, { set: header.set, epoch: header.epoch }, { edPublic: stranger.edPublic, xPublic: stranger.xPublic, label: 'Maya Rao · iPad mini', form: 'tablet' }, 'member', T0 + 5);
    const { sig: _sig, ...rest } = header;
    const unsigned: Omit<EnvHeader, 'sig'> = { ...rest, rev: 3, members: [...header.members, record], time: T0 + 5, signer: set.recovery.deviceId };
    const forgedHeader = signEnvHeader(unsigned, set.recovery);
    return { set, text: writeEnvFile({ header: forgedHeader, values: set.file.values }), forgedHeader };
  }

  it('a device that trusts rev 1 refuses a later header the recovery identity signed without making a new owner', () => {
    const { set, text } = recoverySignedAddition('recovery-loose');
    const trust = nextEnvTrust(null, verified(set.text, null));
    const result = verifyEnvFile(text, trust);
    assert.equal(result.ok, false, 'followsLoosely let the recovery identity add a member and keep the owner');
  });

  it('the merge driver does not keep such a header over the owner-signed one', () => {
    const { set, text } = recoverySignedAddition('recovery-merge');
    const outcome = mergeEnvFiles({ base: set.text, ours: set.text, theirs: text, trust: null });
    assert.notEqual(outcome.kind, 'merged', 'the merge kept a recovery-signed header that changed no owner');
  });

  it('the same header at the next rev is refused too: the recovery identity signs no header', () => {
    const { set, forgedHeader } = recoverySignedAddition('recovery-chained');
    const chained = signEnvHeader({ ...forgedHeader, rev: 2 }, set.recovery);
    const trust = nextEnvTrust(null, verified(set.text, null));
    assert.equal(verifyEnvFile(writeEnvFile({ header: chained, values: set.file.values }), trust).ok, false);
  });
});

describe("ENV-07: a member's variable runs code on every computer that runs the set", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envattacks-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('NODE_OPTIONS from the set does not load a module into `authdeck env run -- node …`', async () => {
    const marker = path.join(dir, 'ran');
    const payload = path.join(dir, 'payload.cjs');
    fs.writeFileSync(payload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
    // Any member signs this value; every teammate's `authdeck env run -- npm test` gets it.
    const values = [{ name: 'NODE_OPTIONS', value: `--require ${payload}` }];
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
    try {
      await runChild({ command: [process.execPath, '-e', ''], cwd: dir, env, values, hasTerminal: false, stderr: { write: () => true } });
    } catch {
      // Refusing the run is a fix too.
    }
    assert.equal(fs.existsSync(marker), false, 'a module named by a set value ran inside the child before its own code');
  });
});
