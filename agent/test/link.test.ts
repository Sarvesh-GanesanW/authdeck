/**
 * The encrypted link: the Noise and CPace code itself, the agent's copy against the app's copy,
 * and attacks on a running server.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import * as appHandshakes from '../../app/src/link/handshakes';
import { SecureChannel } from '../src/link/channel';
import { CpaceInitiator, cpaceRespond, generatorString, prependLen } from '../src/link/cpace';
import { LinkError, LinkRefusal } from '../src/link/errors';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { FRAME, encodeFrame, expectFrame } from '../src/link/frames';
import { LinkResponder, PIN_SID_BYTES, PinPairingClient, SessionClient, type PairRequest, type PinRunEnd, type ResponderHost } from '../src/link/handshakes';
import { linkFingerprint, linkKeyWords } from '../src/link/keys';
import { HandshakeState, IK, XX_PSK0 } from '../src/link/noise';
import { AppCatalog } from '../src/apps/catalog';
import type { ActionRunner } from '../src/actions/runner';
import type { FocusTracker } from '../src/focus';
import type { IconService } from '../src/icons/service';
import { MAX_PIN_FAILURES } from '../src/pairing';
import { HELLO_PATH, PROTOCOL_VERSION, type AgentInfo, type ProtocolError, type RunParams } from '../src/protocol';
import { AgentServer, CLOSE_LINK_BROKEN, CLOSE_UNAUTHORIZED } from '../src/server';
import { concatBytes, utf8Decode, utf8Encode } from '../src/vault/bytes';
import { connectDevice, newDeviceKey, pairByPin, pairByQr, random, RawSocket } from './helpers/link';
import { agentLinkKey, TEST_PIN, testConfig, testPairing } from './helpers/server';

const AGENT: AgentInfo = { agentId: 'agent', name: 'Mac', platform: 'macos', version: '0.0.0', protocol: PROTOCOL_VERSION };
const PAD: PairRequest = { deviceId: 'pad', deviceName: 'Pad', form: 'tablet' };
const MAX = 1024 * 1024;

// ---------------------------------------------------------------------------
// An independent Noise IK and XXpsk0 initiator on node:crypto, written straight from the spec
// (no shared code with src/link), to check the X25519, ChaChaPoly nonce, HKDF and hash steps.
// ---------------------------------------------------------------------------

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

const ref = {
  hash: (...parts: Uint8Array[]) => new Uint8Array(crypto.createHash('sha256').update(Buffer.concat(parts)).digest()),
  hmac: (key: Uint8Array, data: Uint8Array) => new Uint8Array(crypto.createHmac('sha256', key).update(data).digest()),
  dh(secret: Uint8Array, publicKey: Uint8Array): Uint8Array {
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, secret]), format: 'der', type: 'pkcs8' });
    const peer = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, publicKey]), format: 'der', type: 'spki' });
    return new Uint8Array(crypto.diffieHellman({ privateKey, publicKey: peer }));
  },
  publicKey(secret: Uint8Array): Uint8Array {
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, secret]), format: 'der', type: 'pkcs8' });
    return new Uint8Array(crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(X25519_SPKI.length));
  },
  hkdf(ck: Uint8Array, ikm: Uint8Array, n: 2 | 3): Uint8Array[] {
    const temp = ref.hmac(ck, ikm);
    const o1 = ref.hmac(temp, Uint8Array.of(1));
    const o2 = ref.hmac(temp, concatBytes(o1, Uint8Array.of(2)));
    return n === 2 ? [o1, o2] : [o1, o2, ref.hmac(temp, concatBytes(o2, Uint8Array.of(3)))];
  },
  nonce(n: number): Buffer {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(BigInt(n), 4);
    return nonce;
  },
  encrypt(key: Uint8Array, n: number, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const cipher = crypto.createCipheriv('chacha20-poly1305', key, ref.nonce(n), { authTagLength: 16 });
    cipher.setAAD(ad);
    return new Uint8Array(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
  },
  decrypt(key: Uint8Array, n: number, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const decipher = crypto.createDecipheriv('chacha20-poly1305', key, ref.nonce(n), { authTagLength: 16 });
    decipher.setAAD(ad);
    decipher.setAuthTag(ciphertext.subarray(-16));
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]));
  },
};

/** IK initiator, message by message from §5 and §7.5. Returns message 1 and a reader for message 2. */
function referenceIk(device: { secret: Uint8Array; public: Uint8Array }, responderStatic: Uint8Array, prologue: Uint8Array, payload: Uint8Array) {
  const name = utf8Encode(IK.name);
  assert.equal(name.length, 32, 'IK name is exactly HASHLEN, so h starts as the name itself');
  let h = name;
  let ck = name;
  let k: Uint8Array;
  h = ref.hash(h, prologue);
  h = ref.hash(h, responderStatic);
  const eSecret = new Uint8Array(crypto.randomBytes(32));
  const ePublic = ref.publicKey(eSecret);
  h = ref.hash(h, ePublic);
  [ck, k] = ref.hkdf(ck, ref.dh(eSecret, responderStatic), 2) as [Uint8Array, Uint8Array];
  const sealedStatic = ref.encrypt(k, 0, h, device.public);
  h = ref.hash(h, sealedStatic);
  [ck, k] = ref.hkdf(ck, ref.dh(device.secret, responderStatic), 2) as [Uint8Array, Uint8Array];
  const sealedPayload = ref.encrypt(k, 0, h, payload);
  h = ref.hash(h, sealedPayload);
  const message1 = concatBytes(ePublic, sealedStatic, sealedPayload);
  const readMessage2 = (message2: Uint8Array) => {
    const re = message2.subarray(0, 32);
    h = ref.hash(h, re);
    [ck, k] = ref.hkdf(ck, ref.dh(eSecret, re), 2) as [Uint8Array, Uint8Array];
    [ck, k] = ref.hkdf(ck, ref.dh(device.secret, re), 2) as [Uint8Array, Uint8Array];
    const reply = ref.decrypt(k, 0, h, message2.subarray(32));
    const [send, receive] = ref.hkdf(ck, new Uint8Array(0), 2) as [Uint8Array, Uint8Array];
    return { reply, send, receive };
  };
  return { message1, readMessage2 };
}

/** XXpsk0 initiator from §7.5 and §9: psk first, and every `e` also mixed into the key. */
function referenceXxPsk0(device: { secret: Uint8Array; public: Uint8Array }, psk: Uint8Array, prologue: Uint8Array) {
  let h: Uint8Array = ref.hash(utf8Encode(XX_PSK0.name));
  let ck: Uint8Array = h;
  let k: Uint8Array;
  let n = 0;
  const encryptAndHash = (plaintext: Uint8Array) => {
    const ciphertext = ref.encrypt(k, n++, h, plaintext);
    h = ref.hash(h, ciphertext);
    return ciphertext;
  };
  const decryptAndHash = (ciphertext: Uint8Array) => {
    const plaintext = ref.decrypt(k, n++, h, ciphertext);
    h = ref.hash(h, ciphertext);
    return plaintext;
  };
  const mixKey = (ikm: Uint8Array) => {
    [ck, k] = ref.hkdf(ck, ikm, 2) as [Uint8Array, Uint8Array];
    n = 0;
  };
  h = ref.hash(h, prologue);
  // -> psk, e
  let tempHash: Uint8Array;
  [ck, tempHash, k] = ref.hkdf(ck, psk, 3) as [Uint8Array, Uint8Array, Uint8Array];
  h = ref.hash(h, tempHash);
  const eSecret = new Uint8Array(crypto.randomBytes(32));
  const ePublic = ref.publicKey(eSecret);
  h = ref.hash(h, ePublic);
  mixKey(ePublic);
  const message1 = concatBytes(ePublic, encryptAndHash(new Uint8Array(0)));
  return {
    message1,
    /** <- e, ee, s, es; then -> s, se with the payload. */
    exchange(message2: Uint8Array, payload: Uint8Array) {
      const re = message2.subarray(0, 32);
      h = ref.hash(h, re);
      mixKey(re);
      mixKey(ref.dh(eSecret, re));
      const rs = decryptAndHash(message2.subarray(32, 80));
      mixKey(ref.dh(eSecret, rs));
      const reply = decryptAndHash(message2.subarray(80));
      const sealedStatic = encryptAndHash(device.public);
      mixKey(ref.dh(device.secret, re));
      const message3 = concatBytes(sealedStatic, encryptAndHash(payload));
      const [send, receive] = ref.hkdf(ck, new Uint8Array(0), 2) as [Uint8Array, Uint8Array];
      return { rs, reply, message3, send, receive };
    },
  };
}

/** A responder host that pairs anything, for driving the handshake code without a server. */
function memoryHost(pin = TEST_PIN): ResponderHost<string> & { failures: number; ends: PinRunEnd[]; paired: string[] } {
  const known = new Set<string>();
  const host = {
    failures: 0,
    ends: [] as PinRunEnd[],
    paired: [] as string[],
    agentInfo: () => AGENT,
    session: (linkKey: Uint8Array) => {
      if (!known.has(linkFingerprint(linkKey))) throw new LinkRefusal({ code: 'unauthorized', message: 'Not paired.' });
      return linkFingerprint(linkKey);
    },
    pairWithSecret: (linkKey: Uint8Array, request: PairRequest, secret: string) => {
      if (secret !== 'qr-secret') throw new LinkRefusal({ code: 'unauthorized', message: 'Used QR code.' });
      known.add(linkFingerprint(linkKey));
      host.paired.push(request.deviceId);
      return linkFingerprint(linkKey);
    },
    beginPin: () => pin,
    endPin: (end: PinRunEnd) => {
      host.ends.push(end);
      if (end === 'wrong-pin') host.failures += 1;
    },
    pairWithPin: (linkKey: Uint8Array, request: PairRequest) => {
      known.add(linkFingerprint(linkKey));
      host.paired.push(request.deviceId);
      return linkFingerprint(linkKey);
    },
  };
  return host;
}

const transportHeader = Uint8Array.of(PROTOCOL_VERSION, FRAME.transport);

describe('Noise, checked against an independent implementation', () => {
  it('IK: the reference initiator and the agent responder agree on every key', () => {
    const agentKey = agentLinkKey();
    const device = newDeviceKey();
    const host = memoryHost();
    const responder = new LinkResponder(host, agentKey, random, MAX);
    const hello = utf8Encode(JSON.stringify({ protocol: PROTOCOL_VERSION, pair: { ...PAD, secret: 'qr-secret' } }));
    const reference = referenceIk(device, agentKey.public, utf8Encode('authdeck/link/session/v2'), hello);
    const step = responder.receive(encodeFrame(FRAME.sessionHello, reference.message1));
    assert.ok(step.opened);
    assert.deepEqual(step.opened.channel.remoteStatic, device.public);
    const { reply, send, receive } = reference.readMessage2(step.send[0]!.subarray(2));
    assert.deepEqual(JSON.parse(utf8Decode(reply)), { agent: AGENT });
    // Transport, both ways: the chunk flag (1 = last) then the JSON, the frame header as AD.
    const fromAgent = step.opened.channel.seal('{"event":"x"}')[0]!;
    assert.equal(utf8Decode(ref.decrypt(receive, 0, transportHeader, fromAgent.subarray(2))), '\x01{"event":"x"}');
    const toAgent = concatBytes(transportHeader, ref.encrypt(send, 0, transportHeader, utf8Encode('\x01{"id":"1"}')));
    assert.equal(step.opened.channel.open(toAgent), '{"id":"1"}');
  });

  it('XXpsk0: the reference initiator and the agent responder agree on every key', () => {
    const agentKey = agentLinkKey();
    const device = newDeviceKey();
    const psk = new Uint8Array(crypto.randomBytes(32));
    const prologue = utf8Encode('any prologue');
    const responder = new HandshakeState({ pattern: XX_PSK0, initiator: false, prologue, staticKey: agentKey, psk, random });
    const reference = referenceXxPsk0(device, psk, prologue);
    assert.deepEqual(responder.readMessage(reference.message1), new Uint8Array(0));
    const message2 = responder.writeMessage(utf8Encode('hello'));
    const { rs, reply, message3, send, receive } = reference.exchange(message2, utf8Encode('payload 3'));
    assert.deepEqual(rs, agentKey.public);
    assert.equal(utf8Decode(reply), 'hello');
    assert.equal(utf8Decode(responder.readMessage(message3)), 'payload 3');
    const keys = responder.transportKeys();
    assert.deepEqual(keys.remoteStatic, device.public);
    assert.equal(utf8Decode(keys.receive.decryptWithAd(new Uint8Array(0), ref.encrypt(send, 0, new Uint8Array(0), utf8Encode('up')))), 'up');
    assert.equal(utf8Decode(ref.decrypt(receive, 0, new Uint8Array(0), keys.send.encryptWithAd(new Uint8Array(0), utf8Encode('down')))), 'down');
  });

  it('XXpsk0: a different pre-shared key fails at the first message', () => {
    const agentKey = agentLinkKey();
    const responder = new HandshakeState({ pattern: XX_PSK0, initiator: false, prologue: new Uint8Array(0), staticKey: agentKey, psk: new Uint8Array(32).fill(1), random });
    const reference = referenceXxPsk0(newDeviceKey(), new Uint8Array(32).fill(2), new Uint8Array(0));
    assert.throws(() => responder.readMessage(reference.message1), (err: LinkError) => err.reason === 'decrypt');
  });
});

describe('CPace', () => {
  const inputs = (pin: string, sid: Uint8Array) => ({ prs: utf8Encode(pin), ci: utf8Encode('ci'), sid, random });

  it('length-prefixes with LEB128 and pads DSI and PRS to one SHA-512 block', () => {
    assert.deepEqual([...prependLen(new Uint8Array(0))], [0]);
    assert.deepEqual([...prependLen(new Uint8Array(127)).subarray(0, 1)], [127]);
    assert.deepEqual([...prependLen(new Uint8Array(128)).subarray(0, 2)], [0x80, 0x01]);
    assert.deepEqual([...prependLen(new Uint8Array(300)).subarray(0, 2)], [0xac, 0x02]);
    const sid = new Uint8Array(16);
    const generator = generatorString(utf8Encode('123456'), utf8Encode('ci'), sid);
    // DSI (1+17) + PRS (1+6) + padding (1+102) is exactly 128 bytes, then CI and sid.
    assert.equal(generator.length, 128 + 3 + 17);
    assert.deepEqual(generator.subarray(0, 18), concatBytes(Uint8Array.of(17), utf8Encode('CPaceRistretto255')));
  });

  it('gives both sides the same key for the same PIN, and different keys otherwise', () => {
    const sid = new Uint8Array(crypto.randomBytes(16));
    const initiator = new CpaceInitiator(inputs('123456', sid));
    const right = cpaceRespond(inputs('123456', sid), initiator.ya);
    assert.deepEqual(initiator.finish(right.yb), right.isk);
    const other = new CpaceInitiator(inputs('123456', sid));
    const wrong = cpaceRespond(inputs('123457', sid), other.ya);
    assert.notDeepEqual(other.finish(wrong.yb), wrong.isk);
  });

  it('refuses the identity and invalid encodings', () => {
    const sid = new Uint8Array(16);
    const initiator = new CpaceInitiator(inputs('123456', sid));
    assert.throws(() => initiator.finish(new Uint8Array(32)), (err: LinkError) => err.reason === 'malformed');
    assert.throws(() => initiator.finish(new Uint8Array(32).fill(0xff)), (err: LinkError) => err.reason === 'malformed');
    assert.throws(() => cpaceRespond(inputs('123456', sid), new Uint8Array(31)), (err: LinkError) => err.reason === 'malformed');
  });
});

describe('the link, agent copy against app copy', () => {
  it('pairs by QR, then signs in again with the stored keys', () => {
    const agentKey = agentLinkKey();
    const device = newDeviceKey();
    const host = memoryHost();
    const pairing = new appHandshakes.SessionClient(device, agentKey.public, random, { ...PAD, secret: 'qr-secret' });
    const responder = new LinkResponder(host, agentKey, random, MAX);
    const step = responder.receive(pairing.hello());
    assert.equal(step.opened?.paired, true);
    assert.deepEqual(pairing.accept(step.send[0]!, MAX).agent, AGENT);
    assert.deepEqual(host.paired, ['pad']);

    const session = new appHandshakes.SessionClient(device, agentKey.public, random);
    const again = new LinkResponder(host, agentKey, random, MAX).receive(session.hello());
    const { channel } = session.accept(again.send[0]!, MAX);
    assert.equal(again.opened?.paired, false);
    for (const frame of channel.seal('{"id":"1","method":"ping"}')) assert.equal(again.opened!.channel.open(frame), '{"id":"1","method":"ping"}');
  });

  it('pairs by PIN and learns the computer\'s key from inside the PIN-keyed handshake', () => {
    const agentKey = agentLinkKey();
    const device = newDeviceKey();
    const host = memoryHost();
    const client = new appHandshakes.PinPairingClient(device, TEST_PIN, PAD, random);
    const responder = new LinkResponder(host, agentKey, random, MAX);
    const reply = responder.receive(client.start());
    const accept = responder.receive(client.hello(reply.send[0]!));
    const done = responder.receive(client.finish(accept.send[0]!, MAX));
    const confirmed = client.confirm(done.send[0]!);
    assert.deepEqual(confirmed.agentKey, agentKey.public);
    assert.deepEqual(done.opened?.channel.remoteStatic, device.public);
    assert.deepEqual(host.ends, ['paired']);
  });

  it('a wrong PIN fails at the first PIN-keyed message and counts once', () => {
    const host = memoryHost();
    const client = new PinPairingClient(newDeviceKey(), '654321', PAD, random);
    const responder = new LinkResponder(host, agentLinkKey(), random, MAX);
    const reply = responder.receive(client.start());
    assert.throws(() => responder.receive(client.hello(reply.send[0]!)), (err: LinkRefusal) => err instanceof LinkRefusal && err.error.code === 'bad_pin');
    responder.abandon();
    assert.equal(host.failures, 1);
  });

  it('a run abandoned before the app sent a PIN-keyed message tested nothing: it ends once and counts nothing', () => {
    const host = memoryHost();
    const responder = new LinkResponder(host, agentLinkKey(), random, MAX);
    responder.receive(new PinPairingClient(newDeviceKey(), TEST_PIN, PAD, random).start());
    responder.abandon();
    responder.abandon();
    assert.deepEqual(host.ends, ['no-guess']);
    assert.equal(host.failures, 0);
  });

  it('a run that proved the PIN but ends with another protocol version still ends (it never stays stuck)', () => {
    const host = memoryHost();
    const responder = new LinkResponder(host, agentLinkKey(), random, MAX);
    const sid = random(PIN_SID_BYTES);
    const cpace = new CpaceInitiator({ prs: utf8Encode(TEST_PIN), ci: utf8Encode('authdeck/link/pin/v2'), sid, random });
    const yb = expectFrame(responder.receive(encodeFrame(FRAME.pinStart, concatBytes(sid, cpace.ya))).send[0]!, FRAME.pinReply);
    const psk = hkdf(sha256, cpace.finish(yb), undefined, utf8Encode('authdeck/link/pin-psk/v2'), 32);
    const app = new HandshakeState({ pattern: XX_PSK0, initiator: true, prologue: concatBytes(utf8Encode('authdeck/link/pin/v2'), sid, cpace.ya, yb), staticKey: newDeviceKey(), psk, random });
    const accept = responder.receive(encodeFrame(FRAME.pinHello, app.writeMessage(new Uint8Array(0))));
    app.readMessage(expectFrame(accept.send[0]!, FRAME.pinAccept));
    const finish = responder.receive(encodeFrame(FRAME.pinFinish, app.writeMessage(utf8Encode(JSON.stringify({ protocol: PROTOCOL_VERSION + 1, pair: PAD })))));
    assert.equal(finish.refused?.code, 'version');
    assert.deepEqual(host.ends, ['pin-proven']);
    assert.deepEqual(host.paired, []);
  });

  it('a run whose pairing throws still ends', () => {
    const host = { ...memoryHost(), pairWithPin: () => { throw new Error('disk full'); } };
    const ends: PinRunEnd[] = [];
    host.endPin = (end) => ends.push(end);
    const client = new PinPairingClient(newDeviceKey(), TEST_PIN, PAD, random);
    const responder = new LinkResponder(host, agentLinkKey(), random, MAX);
    const reply = responder.receive(client.start());
    const accept = responder.receive(client.hello(reply.send[0]!));
    assert.throws(() => responder.receive(client.finish(accept.send[0]!, MAX)), /disk full/);
    assert.deepEqual(ends, ['pin-proven']);
  });

  it('refuses an empty PIN or QR secret on the app side, and an empty secret on the agent', () => {
    assert.throws(() => new PinPairingClient(newDeviceKey(), '', PAD, random), /needs the PIN/);
    assert.throws(() => new appHandshakes.SessionClient(newDeviceKey(), agentLinkKey().public, random, { ...PAD, secret: '' }), /needs the secret/);
    const agentKey = agentLinkKey();
    const host = memoryHost();
    const responder = new LinkResponder(host, agentKey, random, MAX);
    const initiator = new HandshakeState({ pattern: IK, initiator: true, prologue: utf8Encode('authdeck/link/session/v2'), staticKey: newDeviceKey(), remoteStatic: agentKey.public, random });
    const hello = initiator.writeMessage(utf8Encode(JSON.stringify({ protocol: PROTOCOL_VERSION, pair: { ...PAD, secret: '' } })));
    assert.throws(() => responder.receive(encodeFrame(FRAME.sessionHello, hello)), (err: LinkError) => err instanceof LinkError && err.reason === 'malformed');
    assert.deepEqual(host.paired, []);
  });

  it('a relay that swaps in its own keys without the PIN gets nowhere', () => {
    // The relay sits between app and agent and runs each half itself with a guessed PIN.
    const agentHost = memoryHost();
    const agent = new LinkResponder(agentHost, agentLinkKey(), random, MAX);
    const app = new PinPairingClient(newDeviceKey(), TEST_PIN, PAD, random);
    const relayToAgent = new PinPairingClient(newDeviceKey(), '000000', PAD, random);
    const relayToApp = new LinkResponder(memoryHost('000000'), agentLinkKey(), random, MAX);

    const toApp = relayToApp.receive(app.start());
    assert.throws(() => relayToApp.receive(app.hello(toApp.send[0]!)), LinkRefusal);
    const toAgent = agent.receive(relayToAgent.start());
    assert.throws(() => agent.receive(relayToAgent.hello(toAgent.send[0]!)), LinkRefusal);
    agent.abandon();
    assert.equal(agentHost.failures, 1);
    assert.deepEqual(agentHost.paired, []);
  });

  it('a relay that passes the PAKE through but swaps the static keys gets nowhere', () => {
    const agentHost = memoryHost();
    const agent = new LinkResponder(agentHost, agentLinkKey(), random, MAX);
    const app = new PinPairingClient(newDeviceKey(), TEST_PIN, PAD, random);
    const reply = agent.receive(app.start());
    const accept = agent.receive(app.hello(reply.send[0]!));
    // Replace the agent's static key and payload with the relay's own: the app's handshake breaks.
    const relayed = accept.send[0]!.slice();
    relayed.set(newDeviceKey().public, 2 + 32);
    assert.throws(() => app.finish(relayed, MAX), (err: LinkError) => err.reason === 'decrypt');
    // And the app's own message 3 with a swapped static key is refused by the agent.
    const honest = new PinPairingClient(newDeviceKey(), TEST_PIN, PAD, random);
    const agent2 = new LinkResponder(agentHost, agentLinkKey(), random, MAX);
    const reply2 = agent2.receive(honest.start());
    const accept2 = agent2.receive(honest.hello(reply2.send[0]!));
    const finish = honest.finish(accept2.send[0]!, MAX).slice();
    finish.set(newDeviceKey().public, 2);
    assert.throws(() => agent2.receive(finish), (err: LinkError) => err.reason === 'decrypt');
    assert.deepEqual(agentHost.paired, []);
  });

  it('QR pairing to a wrong public key fails: the agent cannot read the first message', () => {
    const responder = new LinkResponder(memoryHost(), agentLinkKey(), random, MAX);
    const client = new SessionClient(newDeviceKey(), agentLinkKey().public, random, { ...PAD, secret: 'qr-secret' });
    assert.throws(() => responder.receive(client.hello()), (err: LinkRefusal) => err instanceof LinkRefusal && err.error.code === 'unauthorized');
  });

  it('an answer from a different computer is not accepted by the app', () => {
    const real = agentLinkKey();
    const impostor = new LinkResponder(memoryHost(), agentLinkKey(), random, MAX);
    const client = new SessionClient(newDeviceKey(), real.public, random, { ...PAD, secret: 'qr-secret' });
    // The impostor cannot even read message 1; a forged message 2 fails at the app.
    assert.throws(() => impostor.receive(client.hello()));
    const forged = encodeFrame(FRAME.sessionAccept, new Uint8Array(32 + 16 + 16));
    assert.throws(() => client.accept(forged, MAX), (err: LinkError) => err.reason === 'decrypt' || err.reason === 'malformed');
  });
});

describe('transport frames', () => {
  function pairOfChannels(): { app: SecureChannel; agent: SecureChannel } {
    const agentKey = agentLinkKey();
    const host = memoryHost();
    const client = new SessionClient(newDeviceKey(), agentKey.public, random, { ...PAD, secret: 'qr-secret' });
    const step = new LinkResponder(host, agentKey, random, MAX).receive(client.hello());
    return { app: client.accept(step.send[0]!, MAX).channel, agent: step.opened!.channel };
  }

  it('carries a message larger than one Noise message in authenticated chunks', () => {
    const { app, agent } = pairOfChannels();
    const big = JSON.stringify({ data: 'x'.repeat(200_000) });
    const frames = app.seal(big);
    assert.equal(frames.length, 4);
    assert.deepEqual(frames.map((f) => agent.open(f)), [null, null, null, big]);
  });

  it('rejects a frame with any bit flipped, in the header, ciphertext or tag', () => {
    for (const index of [1, 2, 10, -1]) {
      const { app, agent } = pairOfChannels();
      const frame = app.seal('{"id":"1"}')[0]!.slice();
      frame[index < 0 ? frame.length + index : index]! ^= 1;
      assert.throws(() => agent.open(frame), LinkError, `byte ${index}`);
    }
  });

  it('rejects a replayed frame', () => {
    const { app, agent } = pairOfChannels();
    const frame = app.seal('{"id":"1"}')[0]!;
    agent.open(frame);
    assert.throws(() => agent.open(frame), (err: LinkError) => err.reason === 'decrypt');
  });

  it('rejects frames out of order', () => {
    const { app, agent } = pairOfChannels();
    app.seal('{"id":"1"}');
    const second = app.seal('{"id":"2"}')[0]!;
    assert.throws(() => agent.open(second), (err: LinkError) => err.reason === 'decrypt');
  });

  it('rejects a truncated frame, and a message cut short after a dropped chunk', () => {
    const { app, agent } = pairOfChannels();
    const frame = app.seal('{"id":"1"}')[0]!;
    assert.throws(() => agent.open(frame.subarray(0, frame.length - 1)), LinkError);
    const { app: app2, agent: agent2 } = pairOfChannels();
    const chunks = app2.seal(JSON.stringify({ data: 'y'.repeat(100_000) }));
    assert.equal(agent2.open(chunks[0]!), null);
    assert.throws(() => agent2.open(app2.seal('{"id":"next"}')[0]!), LinkError);
  });

  it('refuses to join chunks past the size limit', () => {
    const agentKey = agentLinkKey();
    const client = new SessionClient(newDeviceKey(), agentKey.public, random, { ...PAD, secret: 'qr-secret' });
    const step = new LinkResponder(memoryHost(), agentKey, random, 100_000).receive(client.hello());
    const app = client.accept(step.send[0]!, MAX).channel;
    const frames = app.seal('z'.repeat(150_000));
    assert.equal(step.opened!.channel.open(frames[0]!), null);
    assert.throws(() => step.opened!.channel.open(frames[1]!), /longer than/);
  });
});

describe('the link on a running agent', () => {
  let server: AgentServer;
  let port: number;
  let logLines: string[];
  const linkKey = agentLinkKey();
  const store = testPairing(testConfig());

  before(async () => {
    logLines = [];
    const catalog = new AppCatalog(async () => []);
    await catalog.rescan();
    server = new AgentServer({
      agentInfo: AGENT,
      port: 0,
      home: '/Users/ada',
      platform: 'macos',
      pairing: store.pairing,
      linkKey,
      catalog,
      icons: {} as IconService,
      runner: { run: async (_params: RunParams) => ({ durationMs: 1 }) } as unknown as ActionRunner,
      focus: { clientConnected() {}, clientDisconnected() {}, current: async () => ({ supported: false, appId: null, name: '' }) } as unknown as FocusTracker,
      vaults: {} as never,
      log: (line) => logLines.push(line),
      emit: () => {},
    });
    port = await server.listen();
  });

  after(() => server.close());

  const qrSecret = () => store.config().pairSecret;
  const refusalOf = (promise: Promise<unknown>) =>
    promise.then(
      () => assert.fail('expected a refusal'),
      // A refusal in the clear (helpers attach it) or inside the handshake (the app's LinkRefusal).
      (err: { refusal?: ProtocolError; error?: ProtocolError }) => err.refusal ?? err.error ?? assert.fail(String(err)),
    );

  it('discovery shows the key fingerprint and nothing secret', async () => {
    const hello = (await (await fetch(`http://127.0.0.1:${port}${HELLO_PATH}`)).json()) as Record<string, unknown>;
    assert.equal(hello.fingerprint, linkFingerprint(linkKey.public));
    assert.equal(hello.protocol, 2);
    const text = JSON.stringify(hello);
    for (const secret of [store.config().pin, qrSecret(), Buffer.from(linkKey.secret).toString('base64url')]) assert.ok(!text.includes(secret));
  });

  it('pairs by QR, reconnects with the stored keys, and runs a request', async () => {
    const device = newDeviceKey();
    const paired = await pairByQr(port, linkKey.public, qrSecret(), device, PAD);
    paired.close();
    const session = await connectDevice(port, device, linkKey.public);
    assert.equal((await session.request('ping', {})).ok, true);
    session.close();
  });

  it('a used QR code is refused', async () => {
    const secret = qrSecret();
    (await pairByQr(port, linkKey.public, secret, newDeviceKey(), { deviceId: 'a', deviceName: 'A' })).close();
    const refusal = await refusalOf(pairByQr(port, linkKey.public, secret, newDeviceKey(), { deviceId: 'b', deviceName: 'B' }));
    assert.equal(refusal.code, 'unauthorized');
    assert.match(refusal.message, /already used/);
  });

  it('QR pairing with a wrong public key fails', async () => {
    const refusal = await refusalOf(pairByQr(port, agentLinkKey().public, qrSecret(), newDeviceKey(), PAD));
    assert.equal(refusal.code, 'unauthorized');
  });

  it('an unpaired key is refused, inside the encrypted handshake', async () => {
    const refusal = await refusalOf(connectDevice(port, newDeviceKey(), linkKey.public));
    assert.equal(refusal.code, 'unauthorized');
    assert.match(refusal.message, /not paired/);
  });

  it('a plaintext call after the handshake is refused and closes the connection', async () => {
    const session = await pairByQr(port, linkKey.public, qrSecret(), newDeviceKey(), PAD);
    session.raw.send(JSON.stringify({ id: '1', method: 'ping', params: {} }));
    assert.equal(await session.closed, CLOSE_LINK_BROKEN);
  });

  it('a tampered or replayed frame closes the connection', async () => {
    const session = await pairByQr(port, linkKey.public, qrSecret(), newDeviceKey(), PAD);
    const frame = session.channel.seal('{"id":"1","method":"ping","params":{}}')[0]!;
    session.raw.send(frame);
    session.raw.send(frame);
    assert.equal(await session.closed, CLOSE_LINK_BROKEN);
  });

  it('an old token-only app is refused with a clear error it can read', async () => {
    const raw = new RawSocket(port);
    await raw.opened();
    raw.send(JSON.stringify({ id: '1', method: 'auth', params: { token: 'f'.repeat(64), deviceId: 'pad' } }));
    const message = await raw.next();
    assert.ok(message && 'text' in message);
    const reply = JSON.parse(message.text);
    assert.equal(reply.id, '1');
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'unauthorized');
    assert.match(reply.error.message, /now encrypts the connection/);
    assert.match(reply.error.hint, /pair again/);
    assert.equal(await raw.closed, CLOSE_UNAUTHORIZED);
  });

  it('another protocol version gets a plain message, not a hang', async () => {
    const raw = new RawSocket(port);
    await raw.opened();
    raw.send(Uint8Array.of(PROTOCOL_VERSION + 1, FRAME.sessionHello, 0));
    const refusal = await raw.nextRefusal();
    assert.equal(refusal.code, 'version');
    assert.match(refusal.hint!, /Update the AuthDeck agent/);
  });

  it('pairs by PIN, then reconnects with the key it learned', async () => {
    const device = newDeviceKey();
    const { agent, agentKey, raw } = await pairByPin(port, store.config().pin, device, { deviceId: 'phone', deviceName: 'Phone', form: 'phone' });
    raw.close();
    assert.deepEqual(agent, AGENT);
    assert.deepEqual(agentKey, linkKey.public);
    const session = await connectDevice(port, device, agentKey);
    assert.equal((await session.request('ping', {})).ok, true);
    session.close();
  });

  it(`a wrong PIN fails; after ${MAX_PIN_FAILURES} the PIN changes and PIN pairing pauses`, async () => {
    const pin = store.config().pin;
    const wrong = pin === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_PIN_FAILURES; i++) {
      const refusal = await refusalOf(pairByPin(port, wrong, newDeviceKey(), PAD));
      assert.equal(refusal.code, 'bad_pin');
    }
    assert.notEqual(store.config().pin, pin);
    const locked = await refusalOf(pairByPin(port, store.config().pin, newDeviceKey(), PAD));
    assert.equal(locked.code, 'locked');
    assert.ok(logLines.some((line) => line.includes('wrong PIN')));
  });
});

describe('key words', () => {
  it('are six words that follow the key', () => {
    const key = agentLinkKey();
    assert.equal(linkKeyWords(key.public).length, 6);
    assert.deepEqual(linkKeyWords(key.public), linkKeyWords(Uint8Array.from(key.public)));
    assert.notDeepEqual(linkKeyWords(key.public), linkKeyWords(agentLinkKey().public));
  });
});
