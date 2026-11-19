/**
 * The Noise Protocol Framework (revision 34, https://noiseprotocol.org/noise.html), with only
 * what the link needs: DH 25519, cipher ChaChaPoly, hash SHA256, and the IK and XXpsk0 patterns.
 * Section numbers in comments point at that spec. Pure TypeScript over @noble, so the app can
 * copy this folder as-is.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, takeRandom, utf8Encode, type RandomBytes } from '../vault/bytes';
import { LinkError } from './errors';
import { linkKeyFromSecret, type LinkKeyPair } from './keys';

export const DH_LEN = 32;
const HASH_LEN = 32;
export const TAG_LEN = 16;
/** §3: no Noise message may be longer than this. */
export const MAX_NOISE_MESSAGE = 65535;
/** §5.1: 2^64-1 is reserved; a counter this high never happens here, but it must not wrap. */
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk';

export interface HandshakePattern {
  /** The full protocol name (§8). */
  name: string;
  /** Pre-message public keys of the responder (§7.1). Only `s` is used. */
  responderPreMessage: 's'[];
  messages: Token[][];
}

/** §7.5: the initiator knows the responder's static key; the initiator's own is sent encrypted. */
export const IK: HandshakePattern = {
  name: 'Noise_IK_25519_ChaChaPoly_SHA256',
  responderPreMessage: ['s'],
  messages: [
    ['e', 'es', 's', 'ss'],
    ['e', 'ee', 'se'],
  ],
};

/** §7.5 and §9.4: both static keys are exchanged; every message is keyed by the pre-shared key. */
export const XX_PSK0: HandshakePattern = {
  name: 'Noise_XXpsk0_25519_ChaChaPoly_SHA256',
  responderPreMessage: [],
  messages: [
    ['psk', 'e'],
    ['e', 'ee', 's', 'es'],
    ['s', 'se'],
  ],
};

/** §5.1: 32 bits of zeros, then the 64-bit counter little-endian. */
function nonceBytes(counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, counter >>> 0, true);
  view.setUint32(8, Math.floor(counter / 2 ** 32), true);
  return nonce;
}

/** §4.3: HKDF with the chaining key as salt and an empty info. */
function noiseHkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const tempKey = hmac(sha256, chainingKey, inputKeyMaterial);
  const out1 = hmac(sha256, tempKey, Uint8Array.of(1));
  const out2 = hmac(sha256, tempKey, concatBytes(out1, Uint8Array.of(2)));
  if (outputs === 2) return [out1, out2];
  return [out1, out2, hmac(sha256, tempKey, concatBytes(out2, Uint8Array.of(3)))];
}

function dh(secret: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(secret, publicKey);
  } catch (err) {
    // noble refuses low-order points; §12.1 allows aborting on them.
    throw new LinkError('malformed', 'The other side sent a key that is not usable.', { cause: err });
  }
}

/** §5.1. */
export class CipherState {
  private key: Uint8Array | null = null;
  private counter = 0;

  initializeKey(key: Uint8Array): void {
    this.key = key;
    this.counter = 0;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext;
    const ciphertext = chacha20poly1305(this.key, nonceBytes(this.nextNonce()), ad).encrypt(plaintext);
    this.counter += 1;
    return ciphertext;
  }

  /** Throws `LinkError('decrypt')` on a bad tag; the counter only moves on success. */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext;
    let plaintext: Uint8Array;
    try {
      plaintext = chacha20poly1305(this.key, nonceBytes(this.nextNonce()), ad).decrypt(ciphertext);
    } catch (err) {
      throw new LinkError('decrypt', 'A message from the other side failed its integrity check.', { cause: err });
    }
    this.counter += 1;
    return plaintext;
  }

  private nextNonce(): number {
    if (this.counter >= MAX_NONCE) throw new LinkError('malformed', 'This connection has sent too many messages. Reconnect.');
    return this.counter;
  }
}

/** §5.2. */
class SymmetricState {
  private chainingKey: Uint8Array;
  private hash: Uint8Array;
  readonly cipher = new CipherState();

  constructor(protocolName: string) {
    const name = utf8Encode(protocolName);
    this.hash = name.length <= HASH_LEN ? concatBytes(name, new Uint8Array(HASH_LEN - name.length)) : sha256(name);
    this.chainingKey = this.hash;
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, tempKey] = noiseHkdf(this.chainingKey, inputKeyMaterial, 2);
    this.chainingKey = chainingKey!;
    this.cipher.initializeKey(tempKey!);
  }

  mixHash(data: Uint8Array): void {
    this.hash = sha256(concatBytes(this.hash, data));
  }

  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, tempHash, tempKey] = noiseHkdf(this.chainingKey, inputKeyMaterial, 3);
    this.chainingKey = chainingKey!;
    this.mixHash(tempHash!);
    this.cipher.initializeKey(tempKey!);
  }

  handshakeHash(): Uint8Array {
    return this.hash;
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** Initiator-to-responder first, then responder-to-initiator. */
  split(): [CipherState, CipherState] {
    const [key1, key2] = noiseHkdf(this.chainingKey, new Uint8Array(0), 2);
    const first = new CipherState();
    const second = new CipherState();
    first.initializeKey(key1!);
    second.initializeKey(key2!);
    return [first, second];
  }
}

/** Both directions of a finished handshake, from one side's point of view. */
export interface TransportKeys {
  send: CipherState;
  receive: CipherState;
  /** §11.2: identifies this session; used for channel binding. */
  handshakeHash: Uint8Array;
  /** The other side's static public key, as proven by the handshake. */
  remoteStatic: Uint8Array;
}

export interface HandshakeOptions {
  pattern: HandshakePattern;
  initiator: boolean;
  prologue: Uint8Array;
  staticKey: LinkKeyPair;
  /** Required when the pattern has the responder's static key as a pre-message and this side is the initiator. */
  remoteStatic?: Uint8Array;
  /** Required for psk patterns: 32 bytes. */
  psk?: Uint8Array;
  random: RandomBytes;
}

/** §5.3: one handshake, driven message by message in the pattern's order. */
export class HandshakeState {
  private readonly symmetric: SymmetricState;
  private readonly pattern: HandshakePattern;
  private readonly initiator: boolean;
  private readonly staticKey: LinkKeyPair;
  private readonly psk: Uint8Array | null;
  private readonly usesPsk: boolean;
  private readonly random: RandomBytes;
  private ephemeral: LinkKeyPair | null = null;
  private remoteEphemeral: Uint8Array | null = null;
  private remoteStatic: Uint8Array | null;
  private messageIndex = 0;

  constructor(options: HandshakeOptions) {
    this.pattern = options.pattern;
    this.initiator = options.initiator;
    this.staticKey = options.staticKey;
    this.random = options.random;
    this.remoteStatic = options.remoteStatic ?? null;
    this.psk = options.psk ?? null;
    this.usesPsk = this.pattern.messages.some((tokens) => tokens.includes('psk'));
    if (this.usesPsk && this.psk?.length !== 32) throw new Error(`${this.pattern.name} needs a 32-byte pre-shared key.`);
    this.symmetric = new SymmetricState(this.pattern.name);
    this.symmetric.mixHash(options.prologue);
    if (this.pattern.responderPreMessage.includes('s')) {
      const responderStatic = this.initiator ? this.remoteStatic : this.staticKey.public;
      if (!responderStatic) throw new Error(`${this.pattern.name} needs the responder's static key up front.`);
      this.symmetric.mixHash(responderStatic);
    }
  }

  get isFinished(): boolean {
    return this.messageIndex === this.pattern.messages.length;
  }

  /** True when the next message is this side's to write. */
  get isMyTurn(): boolean {
    return !this.isFinished && (this.messageIndex % 2 === 0) === this.initiator;
  }

  /** The other side's static key, once a message has carried it (or from the start, for IK's initiator). */
  get remoteStaticKey(): Uint8Array | null {
    return this.remoteStatic;
  }

  writeMessage(payload: Uint8Array): Uint8Array {
    if (!this.isMyTurn) throw new Error('It is not this side\'s turn to write a handshake message.');
    const parts: Uint8Array[] = [];
    for (const token of this.currentTokens()) {
      switch (token) {
        case 'e':
          this.ephemeral = linkKeyFromSecret(takeRandom(this.random, DH_LEN));
          parts.push(this.ephemeral.public);
          this.mixEphemeral(this.ephemeral.public);
          break;
        case 's':
          parts.push(this.symmetric.encryptAndHash(this.staticKey.public));
          break;
        case 'psk':
          this.symmetric.mixKeyAndHash(this.psk!);
          break;
        default:
          this.mixDh(token);
      }
    }
    parts.push(this.symmetric.encryptAndHash(payload));
    this.messageIndex += 1;
    const message = concatBytes(...parts);
    if (message.length > MAX_NOISE_MESSAGE) throw new Error('A handshake payload is too long for one Noise message.');
    return message;
  }

  /** Returns the payload. Throws `LinkError` when the message is short, altered or keyed differently. */
  readMessage(message: Uint8Array): Uint8Array {
    if (this.isFinished || this.isMyTurn) throw new LinkError('malformed', 'A handshake message arrived out of turn.');
    if (message.length > MAX_NOISE_MESSAGE) throw new LinkError('malformed', 'A handshake message is longer than a Noise message may be.');
    let offset = 0;
    const take = (length: number): Uint8Array => {
      if (offset + length > message.length) throw new LinkError('malformed', 'A handshake message is cut short.');
      const part = message.subarray(offset, offset + length);
      offset += length;
      return part;
    };
    for (const token of this.currentTokens()) {
      switch (token) {
        case 'e':
          this.remoteEphemeral = Uint8Array.from(take(DH_LEN));
          this.mixEphemeral(this.remoteEphemeral);
          break;
        case 's': {
          const length = this.symmetric.cipher.hasKey() ? DH_LEN + TAG_LEN : DH_LEN;
          this.remoteStatic = Uint8Array.from(this.symmetric.decryptAndHash(take(length)));
          break;
        }
        case 'psk':
          this.symmetric.mixKeyAndHash(this.psk!);
          break;
        default:
          this.mixDh(token);
      }
    }
    const payload = this.symmetric.decryptAndHash(message.subarray(offset));
    this.messageIndex += 1;
    return payload;
  }

  /** §5.3 Split(), after the last message. */
  transportKeys(): TransportKeys {
    if (!this.isFinished || !this.remoteStatic) throw new Error('The handshake is not finished.');
    const [initiatorToResponder, responderToInitiator] = this.symmetric.split();
    return {
      send: this.initiator ? initiatorToResponder : responderToInitiator,
      receive: this.initiator ? responderToInitiator : initiatorToResponder,
      handshakeHash: this.symmetric.handshakeHash(),
      remoteStatic: this.remoteStatic,
    };
  }

  private currentTokens(): Token[] {
    return this.pattern.messages[this.messageIndex]!;
  }

  /** §9.2: in a psk handshake, `e` is also mixed into the key. */
  private mixEphemeral(publicKey: Uint8Array): void {
    this.symmetric.mixHash(publicKey);
    if (this.usesPsk) this.symmetric.mixKey(publicKey);
  }

  /** §7.1: the first letter is the initiator's key, the second the responder's. */
  private mixDh(token: 'ee' | 'es' | 'se' | 'ss'): void {
    const initiatorUses = token[0] === 'e' ? 'ephemeral' : 'static';
    const responderUses = token[1] === 'e' ? 'ephemeral' : 'static';
    const mine = this.initiator ? initiatorUses : responderUses;
    const theirs = this.initiator ? responderUses : initiatorUses;
    const secret = mine === 'ephemeral' ? this.ephemeral?.secret : this.staticKey.secret;
    const publicKey = theirs === 'ephemeral' ? this.remoteEphemeral : this.remoteStatic;
    if (!secret || !publicKey) throw new Error(`The ${token} step is missing a key; the pattern is wrong.`);
    this.symmetric.mixKey(dh(secret, publicKey));
  }
}
