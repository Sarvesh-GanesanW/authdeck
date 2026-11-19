/**
 * CPace, the balanced PAKE of the CFRG (draft-irtf-cfrg-cpace), in its initiator-responder
 * setting over ristretto255 with SHA-512 ("CPACE-RISTR255-SHA512"). Function names follow the
 * draft. Each run lets someone without the PIN test exactly one guess, and only by talking to the
 * other side; a recorded run gives nothing to test PINs against offline.
 *
 * Associated data (ADa, ADb) is empty: the link binds the whole exchange into the Noise
 * handshake that follows instead (see handshakes.ts).
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, takeRandom, utf8Encode, type RandomBytes } from '../vault/bytes';
import { LinkError } from './errors';

const Point = ristretto255.Point;
type RistrettoPoint = InstanceType<typeof Point>;

/** G.DSI for ristretto255. */
const DSI = utf8Encode('CPaceRistretto255');
const ISK_DSI = concatBytes(DSI, utf8Encode('_ISK'));
/** H.s_in_bytes: the SHA-512 block size. */
const HASH_BLOCK_BYTES = 128;
export const CPACE_ELEMENT_BYTES = 32;
/** Bytes drawn per scalar: 64 reduced mod the group order is uniform to within 2^-128. */
const SCALAR_SOURCE_BYTES = 64;
const EMPTY = new Uint8Array(0);

/** prepend_len: the length as unsigned LEB128, then the data. */
export function prependLen(data: Uint8Array): Uint8Array {
  const length: number[] = [];
  let remaining = data.length;
  do {
    const low = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    length.push(remaining > 0 ? low | 0x80 : low);
  } while (remaining > 0);
  return concatBytes(Uint8Array.from(length), data);
}

/** lv_cat: every argument length-prefixed, then concatenated. */
export function lvCat(...parts: Uint8Array[]): Uint8Array {
  return concatBytes(...parts.map(prependLen));
}

/** generator_string: DSI and PRS fill the first hash block (zero padded), then CI and sid. */
export function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const zeroPadding = Math.max(0, HASH_BLOCK_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length);
  return lvCat(DSI, prs, new Uint8Array(zeroPadding), ci, sid);
}

/** calculate_generator: the RFC 9496 one-way map of SHA-512(generator_string). */
export function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): RistrettoPoint {
  return ristretto255_hasher.deriveToCurve!(sha512(generatorString(prs, ci, sid)));
}

function sampleScalar(random: RandomBytes): bigint {
  for (;;) {
    const scalar = Point.Fn.create(bytesToNumberLE(takeRandom(random, SCALAR_SOURCE_BYTES)));
    if (scalar !== 0n) return scalar;
  }
}

/** scalar_mult_vfy: refuses an invalid encoding and an identity result. */
function scalarMultVfy(scalar: bigint, encoded: Uint8Array): Uint8Array {
  let point: RistrettoPoint;
  try {
    point = Point.fromBytes(encoded);
  } catch (err) {
    throw new LinkError('malformed', 'The other side sent a PAKE message that is not a valid group element.', { cause: err });
  }
  const shared = point.multiply(scalar);
  if (shared.is0()) throw new LinkError('malformed', 'The other side sent the identity element in the PAKE.');
  return shared.toBytes();
}

/** ISK = H(lv_cat(DSI || "_ISK", sid, K) || transcript_ir(Ya, ADa, Yb, ADb)). */
function intermediateSessionKey(sid: Uint8Array, shared: Uint8Array, ya: Uint8Array, yb: Uint8Array): Uint8Array {
  const transcript = concatBytes(lvCat(ya, EMPTY), lvCat(yb, EMPTY));
  return sha512(concatBytes(lvCat(ISK_DSI, sid, shared), transcript));
}

export interface CpaceInputs {
  /** PRS: the password-related string (the PIN). */
  prs: Uint8Array;
  /** CI: the channel identifier. */
  ci: Uint8Array;
  /** sid: a fresh session id, the same on both sides. */
  sid: Uint8Array;
  random: RandomBytes;
}

/** The initiator: sends Ya, then turns the responder's Yb into the ISK. */
export class CpaceInitiator {
  readonly ya: Uint8Array;
  private readonly scalar: bigint;

  constructor(private readonly inputs: CpaceInputs) {
    this.scalar = sampleScalar(inputs.random);
    this.ya = calculateGenerator(inputs.prs, inputs.ci, inputs.sid).multiply(this.scalar).toBytes();
  }

  finish(yb: Uint8Array): Uint8Array {
    if (yb.length !== CPACE_ELEMENT_BYTES) throw new LinkError('malformed', 'The PAKE answer has the wrong length.');
    return intermediateSessionKey(this.inputs.sid, scalarMultVfy(this.scalar, yb), this.ya, yb);
  }
}

/** The responder: answers Ya with Yb and gets the ISK in one step. */
export function cpaceRespond(inputs: CpaceInputs, ya: Uint8Array): { yb: Uint8Array; isk: Uint8Array } {
  if (ya.length !== CPACE_ELEMENT_BYTES) throw new LinkError('malformed', 'The PAKE message has the wrong length.');
  const scalar = sampleScalar(inputs.random);
  const yb = calculateGenerator(inputs.prs, inputs.ci, inputs.sid).multiply(scalar).toBytes();
  return { yb, isk: intermediateSessionKey(inputs.sid, scalarMultVfy(scalar, ya), ya, yb) };
}
