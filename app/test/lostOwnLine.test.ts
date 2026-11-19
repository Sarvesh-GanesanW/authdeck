import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OWN_LINES_READ_BACK, ownLineStatus, type OwnLineInput } from '../src/auth/engine/lostOwnLine';

const h = (n: number) => String(n).padStart(43, 'h');
const chain = (n: number) => Array.from({ length: n }, (_, i) => h(i));
const head = (seq: number, hash = h(seq)) => ({ seq, hash });
const input = (patch: Partial<OwnLineInput>): OwnLineInput => ({ ownHead: head(4), localChain: chain(5), folderChain: chain(5), folderHead: head(4), ...patch });

describe('lost own line', () => {
  it('is fine with no own head, or when the local copy holds the head', () => {
    assert.deepEqual(ownLineStatus(input({ ownHead: null, localChain: [] })), { kind: 'held' });
    assert.deepEqual(ownLineStatus(input({ folderChain: [] })), { kind: 'held' });
  });

  it('reads back when the folder still holds the head the local copy lost', () => {
    assert.deepEqual(ownLineStatus(input({ localChain: chain(3) })), { kind: 'read-back', message: OWN_LINES_READ_BACK });
  });

  it('waits for a read when the folder has not been read yet', () => {
    assert.equal(ownLineStatus(input({ localChain: chain(3), folderChain: null })).kind, 'read-back');
  });

  it('is lost for good when neither copy holds the signed seq, and never offers to sign it again', () => {
    const status = ownLineStatus(input({ localChain: chain(4), folderChain: chain(4), folderHead: head(3) }));
    assert.equal(status.kind, 'lost');
    if (status.kind !== 'lost') return;
    assert.equal(status.seq, 4);
    assert.equal(status.folderHadIt, false);
    assert.match(status.message, /will not sign that change again/);
    assert.match(status.message, /restore it with your recovery phrase/);
    assert.match(status.message, /recovery phrase/);
    assert.match(status.message, /shut down while saving/);
  });

  it('says the folder lost it when the folder was seen holding the head', () => {
    const status = ownLineStatus(input({ localChain: chain(2), folderChain: chain(2), folderHead: head(4) }));
    assert.equal(status.kind, 'lost');
    if (status.kind === 'lost') {
      assert.equal(status.folderHadIt, true);
      assert.match(status.message, /restore the folder from a backup/);
      assert.match(status.message, /delete the vault from this device, then restore it with your recovery phrase/);
    }
  });

  it('is lost when the folder holds another line at the signed seq', () => {
    assert.equal(ownLineStatus(input({ localChain: chain(4), folderChain: [...chain(4), 'x'.repeat(43)] })).kind, 'lost');
  });

  it('is lost when the local copy holds another line at the signed seq, since a read never replaces it', () => {
    assert.equal(ownLineStatus(input({ ownHead: head(4, 'y'.repeat(43)), folderChain: [...chain(4), 'y'.repeat(43)] })).kind, 'lost');
  });
});
