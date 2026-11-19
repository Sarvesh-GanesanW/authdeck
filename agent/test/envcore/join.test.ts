/** Own-device check codes, teammates' key words and request files, and the joined device's check. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256 } from '@noble/hashes/sha2.js';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  addEnvMember,
  checkEnvJoined,
  createEnvJoinRequest,
  envApproverCheckCode,
  envCheckCode,
  envJoinRequestPath,
  envKeyWords,
  envNewDeviceCheckCode,
  readEnvJoinRequest,
  writeEnvJoinRequest,
  type EnvJoinRequestFile,
} from '../../src/envcore';
import { checkCode, createJoinChallenge, createJoinRequest, createJoinReveal } from '../../src/vault/approval';
import { lengthPrefixed, toBase64Url, utf8Encode } from '../../src/vault/bytes';
import { canonicalJson } from '../../src/vault/canonical';
import { seededRandom } from '../helpers/vault';
import { device, makeSet, T0 } from './fixtures';

const set = makeSet();
const random = seededRandom('join');
const chen = device('chen');

/** Six 11-bit words read as one big number: an independent take on the derivation. */
function referenceWords(ed: Uint8Array, x: Uint8Array): string[] {
  const digest = sha256(new Uint8Array([...utf8Encode('authdeck/env-keywords/v1'), ...lengthPrefixed(ed, x)]));
  const bits = BigInt(`0x${Buffer.from(digest).toString('hex')}`) >> BigInt(256 - 66);
  return Array.from({ length: 6 }, (_, i) => wordlist[Number((bits >> BigInt(55 - 11 * i)) & 0x7ffn)]!);
}

describe('key words', () => {
  it('match the pinned vectors', () => {
    const ed = Uint8Array.from({ length: 32 }, (_, i) => i);
    const x = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    assert.deepEqual(envKeyWords(ed, x), ['resource', 'hurry', 'warm', 'west', 'menu', 'civil']);
    assert.deepEqual(envKeyWords(new Uint8Array(32), new Uint8Array(32)), ['typical', 'genre', 'fix', 'jazz', 'profit', 'emotion']);
  });

  it('are the first 66 bits of the domain hash, and change with either key', () => {
    for (let i = 0; i < 20; i++) {
      const someone = device(`words-${i}`);
      assert.deepEqual(envKeyWords(someone.edPublic, someone.xPublic), referenceWords(someone.edPublic, someone.xPublic));
    }
    assert.notDeepEqual(envKeyWords(chen.edPublic, chen.xPublic), envKeyWords(chen.edPublic, device('other').xPublic));
    assert.notDeepEqual(envKeyWords(chen.edPublic, chen.xPublic), envKeyWords(device('other').edPublic, chen.xPublic));
  });
});

describe('own-device check codes', () => {
  function join(seed: string) {
    const rng = seededRandom(seed);
    const newDevice = device(`${seed}/new`);
    const { request, nonce } = createJoinRequest(newDevice, 'Maya · iPad mini', rng);
    const { challenge } = createJoinChallenge(set.owner, { vaultId: set.setId, vaultName: 'acme-api', deviceName: 'Maya · Pixel 8' }, rng);
    return { request, nonce, challenge, reveal: createJoinReveal(nonce) };
  }

  it('both screens show the same six digits', () => {
    const { request, nonce, challenge, reveal } = join('a');
    const code = envNewDeviceCheckCode(request, nonce, challenge);
    assert.match(code, /^\d{6}$/);
    assert.equal(envApproverCheckCode(request, challenge, reveal), code);
    assert.equal(envCheckCode(request, challenge, nonce), code);
  });

  it('never equals the vault code for the same messages', () => {
    for (let i = 0; i < 50; i++) {
      const { request, nonce, challenge } = join(`many-${i}`);
      assert.notEqual(envCheckCode(request, challenge, nonce), checkCode(request, challenge, nonce));
    }
  });

  it('refuses a reveal that does not match the commitment, and a malformed challenge', () => {
    const { request, challenge, nonce } = join('b');
    assert.throws(() => envApproverCheckCode(request, challenge, createJoinReveal(new Uint8Array(16))), /different number/);
    assert.throws(() => envNewDeviceCheckCode(request, nonce, { ...challenge, vault: 'x' }));
    assert.throws(() => envCheckCode(request, challenge, new Uint8Array(3)));
  });

  it('the new device accepts only the set it was offered, with its own keys, added by that owner', () => {
    const newDevice = device('a/new');
    const { challenge } = join('a');
    const member = { edPublic: newDevice.edPublic, xPublic: newDevice.xPublic, label: 'Maya · iPad mini', form: 'tablet' as const };
    const added = addEnvMember({ file: set.file, owner: set.owner, dataKeys: { 1: set.dataKey }, time: T0 + 1, member });
    assert.deepEqual(checkEnvJoined(set.file, newDevice, challenge), { status: 'not-yet' });
    const ok = checkEnvJoined(added, newDevice, challenge);
    assert.equal(ok.status, 'ok');
    assert.deepEqual((ok as { dataKey: Uint8Array }).dataKey, set.dataKey);
    assert.equal(checkEnvJoined(added, newDevice, { ...challenge, vault: makeSet('other').setId }).status, 'intercepted');
    assert.equal(checkEnvJoined(added, newDevice, { ...challenge, ed: toBase64Url(chen.edPublic) }).status, 'intercepted');
    assert.equal(checkEnvJoined(added, newDevice, { ...challenge, vaultName: 'acme-api-prod' }).status, 'intercepted');
    const otherKeys = { ...newDevice, xPublic: chen.xPublic };
    assert.equal(checkEnvJoined(added, otherKeys, challenge).status, 'intercepted');
  });
});

describe('join request files', () => {
  const request = createEnvJoinRequest({ set: set.setId, device: chen, label: '  Chen Wei · iPhone 16 ', form: 'phone', time: T0 });
  const text = writeEnvJoinRequest(request);
  const path = envJoinRequestPath(chen.deviceId);

  it('round-trips, with the six words and the member to add', () => {
    assert.equal(request.label, 'Chen Wei · iPhone 16');
    assert.equal(path, `.authdeck/requests/${chen.deviceId}.json`);
    assert.ok(text.endsWith('}\n'));
    const read = readEnvJoinRequest(text, { set: set.setId, path });
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.deepEqual(read.request, request);
    assert.deepEqual(read.keyWords, envKeyWords(chen.edPublic, chen.xPublic));
    assert.deepEqual(read.member, { edPublic: chen.edPublic, xPublic: chen.xPublic, label: request.label, form: 'phone' });
  });

  it('reads a Windows line end, and refuses another set, the wrong path, a newer format and junk', () => {
    assert.equal(readEnvJoinRequest(text.replace('\n', '\r\n'), { set: set.setId }).ok, true);
    const reason = (body: string, expected = { set: set.setId, path }) => {
      const read = readEnvJoinRequest(body, expected);
      assert.equal(read.ok, false, body);
      return (read as { reason: string }).reason;
    };
    assert.equal(reason(text, { set: makeSet('other').setId, path }), 'it asks to join another set');
    assert.equal(reason(text, { set: set.setId, path: envJoinRequestPath(set.owner.deviceId) }), "the file's name doesn't match the device in it");
    assert.equal(reason(`${canonicalJson({ ...request, format: 2 })}\n`), 'it was made by a newer AuthDeck');
    assert.equal(reason('not json'), "the file isn't JSON");
    assert.equal(reason('[]'), "the file isn't a join request");
    assert.equal(reason(JSON.stringify(request, null, 2)), "the file isn't written the way AuthDeck writes it");
    assert.equal(reason(' '.repeat(5000)), 'the file is too large');
  });

  it('refuses a change to any field', () => {
    const other = device('other');
    const changes: Partial<Record<keyof EnvJoinRequestFile, unknown>>[] = [
      { set: makeSet('third').setId },
      { member: other.deviceId },
      { label: 'Maya Rao · Pixel 8' },
      { form: 'tablet' },
      { ed: toBase64Url(other.edPublic) },
      { x: toBase64Url(other.xPublic) },
      { time: T0 + 1 },
      { sig: createEnvJoinRequest({ set: set.setId, device: chen, label: 'x', form: null, time: T0 }).sig },
      { format: 0 },
      { extra: 1 } as Partial<Record<keyof EnvJoinRequestFile, unknown>>,
    ];
    for (const change of changes) {
      const tampered = `${canonicalJson({ ...request, ...change })}\n`;
      const expected = change.set ? { set: change.set as string } : { set: set.setId };
      assert.equal(readEnvJoinRequest(tampered, expected).ok, false, JSON.stringify(Object.keys(change)));
    }
  });

  it('refuses to make a request with an empty label or a bad set id', () => {
    assert.throws(() => createEnvJoinRequest({ set: set.setId, device: chen, label: '‮', form: null, time: T0 }));
    assert.throws(() => createEnvJoinRequest({ set: 'nope', device: chen, label: 'Chen', form: null, time: T0 }));
    assert.throws(() => envJoinRequestPath('../x'));
  });
});
