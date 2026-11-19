/**
 * The link's Noise and CPace code against published test vectors (fixtures/*-vectors.json):
 * cacophony and snow for Noise, draft-irtf-cfrg-cpace-21 for CPace.
 *
 * XXpsk0 has no published vector, so its rules are checked through NNpsk0 and NKpsk0 (psk first,
 * e mixed into the key) and its token order through XX and XXpsk3, all on the same HandshakeState.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { sha512 } from '@noble/hashes/sha2.js';
import { CpaceInitiator, calculateGenerator, cpaceRespond, generatorString, lvCat } from '../src/link/cpace';
import { linkKeyFromSecret } from '../src/link/keys';
import { HandshakeState, IK, type HandshakePattern } from '../src/link/noise';
import { concatBytes, utf8Encode } from '../src/vault/bytes';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const hex = (text: string) => Uint8Array.from(Buffer.from(text, 'hex'));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk';
const PATTERNS: Record<string, { responderPreMessage: 's'[]; messages: Token[][] }> = {
  IK: { responderPreMessage: IK.responderPreMessage, messages: IK.messages as Token[][] },
  XX: { responderPreMessage: [], messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']] },
  XXpsk3: { responderPreMessage: [], messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se', 'psk']] },
  NNpsk0: { responderPreMessage: [], messages: [['psk', 'e'], ['e', 'ee']] },
  NKpsk0: { responderPreMessage: ['s'], messages: [['psk', 'e', 'es'], ['e', 'ee']] },
  NN: { responderPreMessage: [], messages: [['e'], ['e', 'ee']] },
};
/** Patterns without a static key on one side still need one to construct HandshakeState. */
const UNUSED_STATIC = linkKeyFromSecret(new Uint8Array(32).fill(7));

interface NoiseVector {
  source: string;
  protocol_name: string;
  init_prologue: string;
  init_psks?: string[];
  init_static?: string;
  init_ephemeral: string;
  init_remote_static?: string;
  resp_prologue: string;
  resp_psks?: string[];
  resp_static?: string;
  resp_ephemeral: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

/** The vector's one ephemeral key, handed out exactly once. */
function fixedEphemeral(bytes: Uint8Array) {
  let used = false;
  return (length: number) => {
    assert.ok(!used && length === bytes.length, 'unexpected random draw');
    used = true;
    return bytes;
  };
}

function runNoiseVector(v: NoiseVector): void {
  const base = PATTERNS[/^Noise_([A-Za-z0-9]+)_/.exec(v.protocol_name)![1]!]!;
  const pattern: HandshakePattern = { name: v.protocol_name, ...base };
  const initiator = new HandshakeState({
    pattern,
    initiator: true,
    prologue: hex(v.init_prologue),
    staticKey: v.init_static ? linkKeyFromSecret(hex(v.init_static)) : UNUSED_STATIC,
    remoteStatic: v.init_remote_static ? hex(v.init_remote_static) : undefined,
    psk: v.init_psks?.[0] ? hex(v.init_psks[0]) : undefined,
    random: fixedEphemeral(hex(v.init_ephemeral)),
  });
  const responder = new HandshakeState({
    pattern,
    initiator: false,
    prologue: hex(v.resp_prologue),
    staticKey: v.resp_static ? linkKeyFromSecret(hex(v.resp_static)) : UNUSED_STATIC,
    psk: v.resp_psks?.[0] ? hex(v.resp_psks[0]) : undefined,
    random: fixedEphemeral(hex(v.resp_ephemeral)),
  });
  const handshakeLength = pattern.messages.length;
  v.messages.slice(0, handshakeLength).forEach((message, i) => {
    const [writer, reader] = i % 2 === 0 ? [initiator, responder] : [responder, initiator];
    const ciphertext = writer.writeMessage(hex(message.payload));
    assert.equal(toHex(ciphertext), message.ciphertext, `handshake message ${i}`);
    assert.equal(toHex(reader.readMessage(ciphertext)), message.payload);
  });
  // transportKeys() needs both static keys, so transport messages are checked where both exist.
  if (!v.init_static || !v.resp_static) return;
  const initiatorKeys = initiator.transportKeys();
  const responderKeys = responder.transportKeys();
  if (v.handshake_hash) assert.equal(toHex(initiatorKeys.handshakeHash), v.handshake_hash, 'handshake hash');
  v.messages.slice(handshakeLength).forEach((message, offset) => {
    const fromInitiator = (handshakeLength + offset) % 2 === 0;
    const [sender, receiver] = fromInitiator ? [initiatorKeys, responderKeys] : [responderKeys, initiatorKeys];
    const ciphertext = sender.send.encryptWithAd(new Uint8Array(0), hex(message.payload));
    assert.equal(toHex(ciphertext), message.ciphertext, `transport message ${handshakeLength + offset}`);
    assert.equal(toHex(receiver.receive.decryptWithAd(new Uint8Array(0), ciphertext)), message.payload);
  });
}

describe('Noise against the published vectors', () => {
  const { vectors } = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'noise-vectors.json'), 'utf8')) as { vectors: NoiseVector[] };

  it('has the IK vectors from both sources', () => {
    assert.deepEqual(vectors.filter((v) => v.protocol_name === 'Noise_IK_25519_ChaChaPoly_SHA256').map((v) => v.source).sort(), ['cacophony', 'snow']);
  });

  for (const vector of vectors) {
    it(`${vector.source} ${vector.protocol_name}: every message byte for byte`, () => runNoiseVector(vector));
  }
});

describe('CPace against draft-irtf-cfrg-cpace-21', () => {
  const v = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cpace-vectors.json'), 'utf8')) as {
    [field in 'prs' | 'ci' | 'sid' | 'generatorString' | 'generatorStringSha512' | 'generator' | 'ya' | 'yb' | 'Ya' | 'Yb' | 'K' | 'isk']: string;
  } & { invalidY: string[] };
  const [prs, ci, sid] = [hex(v.prs), hex(v.ci), hex(v.sid)];
  /** The draft's scalar, fed through the implementation's sampler (64 bytes, little-endian, reduced). */
  const scalar = (value: string) => (length: number) => {
    assert.equal(length, 64);
    return concatBytes(hex(value), new Uint8Array(32));
  };
  const iskFormula = (adA: Uint8Array, adB: Uint8Array) =>
    sha512(concatBytes(lvCat(utf8Encode('CPaceRistretto255_ISK'), sid, hex(v.K)), lvCat(hex(v.Ya), adA), lvCat(hex(v.Yb), adB)));

  it('builds the generator string and generator', () => {
    assert.equal(toHex(generatorString(prs, ci, sid)), v.generatorString);
    assert.equal(toHex(sha512(generatorString(prs, ci, sid))), v.generatorStringSha512);
    assert.equal(toHex(calculateGenerator(prs, ci, sid).toBytes()), v.generator);
  });

  it('gives the draft Ya and Yb, and both sides the ISK of the draft formula with the link\'s empty AD', () => {
    assert.equal(toHex(iskFormula(utf8Encode('ADa'), utf8Encode('ADb'))), v.isk, 'the formula reproduces the draft ISK');
    const initiator = new CpaceInitiator({ prs, ci, sid, random: scalar(v.ya) });
    assert.equal(toHex(initiator.ya), v.Ya);
    const responder = cpaceRespond({ prs, ci, sid, random: scalar(v.yb) }, hex(v.Ya));
    assert.equal(toHex(responder.yb), v.Yb);
    const expected = toHex(iskFormula(new Uint8Array(0), new Uint8Array(0)));
    assert.equal(toHex(responder.isk), expected);
    assert.equal(toHex(initiator.finish(hex(v.Yb))), expected);
  });

  it('both sides refuse the draft\'s invalid points', () => {
    for (const bad of v.invalidY) {
      assert.throws(() => cpaceRespond({ prs, ci, sid, random: scalar(v.yb) }, hex(bad)));
      assert.throws(() => new CpaceInitiator({ prs, ci, sid, random: scalar(v.ya) }).finish(hex(bad)));
    }
  });
});
