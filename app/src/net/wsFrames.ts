/**
 * RFC 6455 framing for the client side of AuthDeck's link, with no extensions. The parser checks
 * each frame's declared length against the limit from its header alone, before it keeps any of the
 * payload, so a peer can't make AuthDeck hold more than one allowed message.
 */
import { utf8Decode, utf8Encode } from '../vault/bytes';

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;
export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

export const CLOSE_CODE = {
  normal: 1000,
  protocolError: 1002,
  /** No status in the peer's close frame; never sent. */
  noStatus: 1005,
  /** The connection ended without a close frame; never sent. */
  abnormal: 1006,
  invalidData: 1007,
  /** The peer broke a rule that is not about framing, like sending pings far faster than any agent does. */
  policyViolation: 1008,
  tooBig: 1009,
} as const;

/** Control frames (close, ping, pong) carry at most this much. */
export const MAX_CONTROL_PAYLOAD = 125;
const MAX_HEADER_BYTES = 10; // 2, plus an 8-byte length. Server frames are never masked.
const MASK_KEY_BYTES = 4;
/**
 * Frames one message may be split into. The agent never fragments, and without a cap a peer could
 * send one-byte fragments without end, each costing a parse while never completing a message.
 */
export const MAX_FRAGMENTS_PER_MESSAGE = 64;

export type FrameEvent =
  | { kind: 'message'; data: Uint8Array | string }
  | { kind: 'ping'; payload: Uint8Array }
  | { kind: 'pong' }
  | { kind: 'close'; code: number; reason: string }
  /** The peer broke the protocol or a limit: answer with a close carrying `code`, then end. */
  | { kind: 'fail'; code: number; reason: string };

const isControl = (opcode: number): boolean => (opcode & 0x8) !== 0;
const KNOWN_OPCODES = new Set<number>(Object.values(OPCODE));

/** One client frame, masked with `maskKey` (4 fresh random bytes) as RFC 6455 requires. */
export function encodeClientFrame(opcode: Opcode, payload: Uint8Array, maskKey: Uint8Array): Uint8Array {
  const length = payload.length;
  const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const frame = new Uint8Array(2 + lengthBytes + MASK_KEY_BYTES + length);
  frame[0] = 0x80 | opcode;
  if (lengthBytes === 0) frame[1] = 0x80 | length;
  else if (lengthBytes === 2) {
    frame[1] = 0x80 | 126;
    frame[2] = length >> 8;
    frame[3] = length & 0xff;
  } else {
    frame[1] = 0x80 | 127;
    // Lengths here are far below 2^32: the top four bytes stay zero.
    new DataView(frame.buffer).setUint32(6, length);
  }
  const keyAt = 2 + lengthBytes;
  frame.set(maskKey.subarray(0, MASK_KEY_BYTES), keyAt);
  const payloadAt = keyAt + MASK_KEY_BYTES;
  for (let i = 0; i < length; i++) frame[payloadAt + i] = payload[i]! ^ maskKey[i & 3]!;
  return frame;
}

/** A close frame's payload: the code, then the reason in UTF-8 (kept short by the callers). */
export function closePayload(code: number, reason = ''): Uint8Array {
  const text = utf8Encode(reason).subarray(0, MAX_CONTROL_PAYLOAD - 2);
  const payload = new Uint8Array(2 + text.length);
  payload[0] = code >> 8;
  payload[1] = code & 0xff;
  payload.set(text, 2);
  return payload;
}

interface FrameHeader {
  fin: boolean;
  opcode: number;
  length: number;
}

const fail = (code: number, reason: string): FrameEvent => ({ kind: 'fail', code, reason });

/**
 * Parses server frames from a byte stream, one event at a time. Holds at most one frame header,
 * the message so far and the current frame's payload, which together never pass `maxMessageBytes`.
 * After a close or fail event it reads nothing more.
 */
export class FrameParser {
  /** The largest message (all its fragments together) and so the largest frame accepted. */
  maxMessageBytes: number;
  private readonly header = new Uint8Array(MAX_HEADER_BYTES);
  private headerFill = 0;
  private frame: FrameHeader | null = null;
  private payload = new Uint8Array(0);
  private payloadFill = 0;
  /** The opcode of a fragmented message in progress, and its fragments so far. */
  private messageOpcode: number | null = null;
  /** Grows by doubling up to the limit, so many tiny fragments cost neither objects nor copies. */
  private message = new Uint8Array(0);
  private messageBytes = 0;
  /** Frames of the fragmented message in progress, counted from each header. */
  private messageFragments = 0;
  private ended = false;

  constructor(maxMessageBytes: number) {
    this.maxMessageBytes = maxMessageBytes;
  }

  /** Bytes the parser holds now: header, fragments and payload. For tests. */
  get heldBytes(): number {
    return this.headerFill + this.message.length + this.payload.length;
  }

  /**
   * Reads from `bytes` until one frame completes or they run out, so a caller counting calls counts
   * frames. Returns how many bytes it used (the rest belong to later frames) and the frame's event,
   * which is null for a fragment that doesn't end its message.
   */
  consume(bytes: Uint8Array): { used: number; event: FrameEvent | null } {
    let used = 0;
    while (!this.ended && used < bytes.length) {
      if (this.frame) {
        used += this.fillPayload(bytes.subarray(used));
      } else {
        const read = this.readHeader(bytes.subarray(used));
        used += read.used;
        if (read.event) return this.finish(used, read.event);
      }
      if (this.frame && this.payloadFill === this.payload.length) {
        const event = this.completeFrame();
        return event ? this.finish(used, event) : { used, event: null };
      }
    }
    return { used, event: null };
  }

  private fillPayload(bytes: Uint8Array): number {
    const take = Math.min(this.payload.length - this.payloadFill, bytes.length);
    this.payload.set(bytes.subarray(0, take), this.payloadFill);
    this.payloadFill += take;
    return take;
  }

  private finish(used: number, event: FrameEvent): { used: number; event: FrameEvent } {
    if (event.kind === 'close' || event.kind === 'fail') {
      this.ended = true;
      this.headerFill = 0;
      this.payload = new Uint8Array(0);
      this.message = new Uint8Array(0);
      this.messageBytes = 0;
      this.messageFragments = 0;
    }
    return { used, event };
  }

  /** Fills the header; once whole, checks it and sets up the payload. */
  private readHeader(bytes: Uint8Array): { used: number; event: FrameEvent | null } {
    let used = 0;
    while (used < bytes.length) {
      this.header[this.headerFill++] = bytes[used++]!;
      if (this.headerFill === 2) {
        const early = this.checkFirstBytes();
        if (early) return { used, event: early };
      }
      if (this.headerFill >= 2 && this.headerFill === this.headerLength()) {
        const event = this.startFrame();
        return { used, event };
      }
    }
    return { used, event: null };
  }

  private headerLength(): number {
    const short = this.header[1]! & 0x7f;
    return short === 126 ? 4 : short === 127 ? 10 : 2;
  }

  /** What the first two bytes alone rule out. */
  private checkFirstBytes(): FrameEvent | null {
    const [first, second] = [this.header[0]!, this.header[1]!];
    const opcode = first & 0x0f;
    if ((first & 0x70) !== 0) return fail(CLOSE_CODE.protocolError, 'reserved bits set with no extension agreed');
    if (!KNOWN_OPCODES.has(opcode)) return fail(CLOSE_CODE.protocolError, 'an unknown frame type');
    if ((second & 0x80) !== 0) return fail(CLOSE_CODE.protocolError, 'a masked frame from the server');
    if (isControl(opcode)) {
      if ((first & 0x80) === 0) return fail(CLOSE_CODE.protocolError, 'a fragmented control frame');
      if ((second & 0x7f) > MAX_CONTROL_PAYLOAD) return fail(CLOSE_CODE.protocolError, 'a control frame over 125 bytes');
    }
    return null;
  }

  /** The declared length, or a failure for one that is malformed or over the limit. */
  private declaredLength(): number | FrameEvent {
    const short = this.header[1]! & 0x7f;
    if (short < 126) return short;
    const view = new DataView(this.header.buffer);
    if (short === 126) {
      const length = view.getUint16(2);
      return length < 126 ? fail(CLOSE_CODE.protocolError, 'a frame length that is not minimally encoded') : length;
    }
    const high = view.getUint32(2);
    const low = view.getUint32(6);
    if (high >= 0x80000000) return fail(CLOSE_CODE.protocolError, 'a frame length with its top bit set');
    // Anything with high bits is past every limit; the number itself is never built.
    if (high > 0) return fail(CLOSE_CODE.tooBig, 'a frame longer than AuthDeck accepts');
    return low <= 0xffff ? fail(CLOSE_CODE.protocolError, 'a frame length that is not minimally encoded') : low;
  }

  /** Checks a whole header against the message state and the limit, before any payload is kept. */
  private startFrame(): FrameEvent | null {
    const length = this.declaredLength();
    if (typeof length !== 'number') return length;
    const fin = (this.header[0]! & 0x80) !== 0;
    const opcode = this.header[0]! & 0x0f;
    if (!isControl(opcode)) {
      if (opcode === OPCODE.continuation && this.messageOpcode === null) return fail(CLOSE_CODE.protocolError, 'a continuation with no message started');
      if (opcode !== OPCODE.continuation && this.messageOpcode !== null) return fail(CLOSE_CODE.protocolError, 'a new message inside a fragmented one');
      if (length > this.maxMessageBytes - this.messageBytes) return fail(CLOSE_CODE.tooBig, 'a message longer than AuthDeck accepts');
      const refusal = this.fragmentRefusal(fin, opcode, length);
      if (refusal) return refusal;
    }
    this.headerFill = 0;
    this.frame = { fin, opcode, length };
    this.payload = new Uint8Array(length);
    this.payloadFill = 0;
    return null;
  }

  /**
   * Counts a fragment and refuses one that adds nothing: an empty fragment that doesn't end its
   * message carries no data, so a stream of them would cost parsing without ever reaching a limit.
   */
  private fragmentRefusal(fin: boolean, opcode: number, length: number): FrameEvent | null {
    const fragmented = !fin || opcode === OPCODE.continuation;
    if (!fragmented) return null;
    if (!fin && length === 0) return fail(CLOSE_CODE.protocolError, 'an empty fragment that does not end its message');
    this.messageFragments++;
    return this.messageFragments > MAX_FRAGMENTS_PER_MESSAGE ? fail(CLOSE_CODE.policyViolation, 'a message in more fragments than AuthDeck accepts') : null;
  }

  private completeFrame(): FrameEvent | null {
    const frame = this.frame!;
    const payload = this.payload;
    this.frame = null;
    this.payload = new Uint8Array(0);
    this.payloadFill = 0;
    if (isControl(frame.opcode)) return this.controlEvent(frame.opcode, payload);
    if (frame.opcode !== OPCODE.continuation) this.messageOpcode = frame.opcode;
    const unfragmented = frame.fin && this.messageBytes === 0;
    if (!unfragmented) this.appendFragment(payload);
    if (!frame.fin) return null;
    const whole = unfragmented ? payload : this.message.slice(0, this.messageBytes);
    const opcode = this.messageOpcode!;
    this.messageOpcode = null;
    this.message = new Uint8Array(0);
    this.messageBytes = 0;
    this.messageFragments = 0;
    if (opcode === OPCODE.binary) return { kind: 'message', data: whole };
    try {
      return { kind: 'message', data: utf8Decode(whole) };
    } catch {
      return fail(CLOSE_CODE.invalidData, 'a text message that is not UTF-8');
    }
  }

  private appendFragment(payload: Uint8Array): void {
    const needed = this.messageBytes + payload.length;
    if (needed > this.message.length) {
      // startFrame keeps `needed` within the limit, so the buffer never grows past it.
      const grown = new Uint8Array(Math.max(needed, Math.min(this.maxMessageBytes, Math.max(this.message.length * 2, 256))));
      grown.set(this.message.subarray(0, this.messageBytes));
      this.message = grown;
    }
    this.message.set(payload, this.messageBytes);
    this.messageBytes = needed;
  }

  private controlEvent(opcode: number, payload: Uint8Array): FrameEvent {
    if (opcode === OPCODE.ping) return { kind: 'ping', payload };
    if (opcode === OPCODE.pong) return { kind: 'pong' };
    if (payload.length === 0) return { kind: 'close', code: CLOSE_CODE.noStatus, reason: '' };
    if (payload.length === 1) return fail(CLOSE_CODE.protocolError, 'a close frame with a one-byte status');
    try {
      return { kind: 'close', code: (payload[0]! << 8) | payload[1]!, reason: utf8Decode(payload.subarray(2)) };
    } catch {
      return fail(CLOSE_CODE.invalidData, 'a close reason that is not UTF-8');
    }
  }
}

