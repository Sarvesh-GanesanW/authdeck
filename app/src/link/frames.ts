/**
 * Binary WebSocket frames of the link: [protocol version][frame type][body]. Text frames are never
 * part of the link; the agent uses them only to explain a refusal to an app that may be too old to
 * read anything else (see protocol.ts, Transport).
 */
import { concatBytes } from '../vault/bytes';
import { PROTOCOL_VERSION } from '../protocol';
import { LinkError } from './errors';

export const FRAME = {
  /** App: Noise IK message 1 (a paired app, or QR pairing). */
  sessionHello: 1,
  /** Agent: Noise IK message 2. */
  sessionAccept: 2,
  /** App: CPace sid and Ya. */
  pinStart: 3,
  /** Agent: CPace Yb. */
  pinReply: 4,
  /** App: Noise XXpsk0 message 1. */
  pinHello: 5,
  /** Agent: Noise XXpsk0 message 2. */
  pinAccept: 6,
  /** App: Noise XXpsk0 message 3. */
  pinFinish: 7,
  /** Either side: one encrypted Noise transport message. */
  transport: 8,
} as const;

export type FrameType = (typeof FRAME)[keyof typeof FRAME];

const HEADER_BYTES = 2;
const FRAME_TYPES = new Set<number>(Object.values(FRAME));

export function frameHeader(type: FrameType): Uint8Array {
  return Uint8Array.of(PROTOCOL_VERSION, type);
}

export function encodeFrame(type: FrameType, body: Uint8Array): Uint8Array {
  return concatBytes(frameHeader(type), body);
}

export interface Frame {
  type: FrameType;
  /** The header bytes, which transport frames authenticate as associated data. */
  header: Uint8Array;
  body: Uint8Array;
}

/** Throws `LinkError('version')` for another protocol version, `malformed` for anything unreadable. */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < HEADER_BYTES) throw new LinkError('malformed', 'A link frame is too short.');
  if (bytes[0] !== PROTOCOL_VERSION) throw new LinkError('version', `The other side speaks protocol ${bytes[0]}, not ${PROTOCOL_VERSION}.`);
  const type = bytes[1]!;
  if (!FRAME_TYPES.has(type)) throw new LinkError('malformed', `Frame type ${type} is not part of the link.`);
  return { type: type as FrameType, header: bytes.subarray(0, HEADER_BYTES), body: bytes.subarray(HEADER_BYTES) };
}

/** Decodes a frame and insists on its type; the link has one valid next step at every point. */
export function expectFrame(bytes: Uint8Array, type: FrameType): Uint8Array {
  const frame = decodeFrame(bytes);
  if (frame.type !== type) throw new LinkError('malformed', `Expected link frame ${type}, got ${frame.type}.`);
  return frame.body;
}
