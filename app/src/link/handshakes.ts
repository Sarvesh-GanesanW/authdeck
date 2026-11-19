/**
 * The link's handshakes, for both sides. The app opens every connection; the agent answers.
 *
 * Session (a paired app) and QR pairing: Noise IK. The app already knows the computer's static
 * key (stored at pairing, or read from the QR code), so message 1 is encrypted to it and only that
 * computer can answer. For QR pairing, message 1 also carries the one-time secret from the QR
 * code, which proves the app saw the screen.
 *
 *   app   -> sessionHello  (IK message 1: e, es, s, ss; payload SessionHello)
 *   agent -> sessionAccept (IK message 2: e, ee, se; payload Accept)
 *
 * PIN pairing: CPace turns the PIN into a strong shared key (ISK), which keys a Noise XXpsk0
 * handshake that swaps and proves both static keys. XXpsk0 mixes the key into every message, so
 * each side knows the other ran CPace with the same PIN before trusting anything it says.
 *
 *   app   -> pinStart  (sid, Ya)
 *   agent -> pinReply  (Yb)
 *   app   -> pinHello  (XXpsk0 message 1: psk, e)          agent: a wrong PIN fails here
 *   agent -> pinAccept (XXpsk0 message 2: e, ee, s, es; payload Accept)
 *   app   -> pinFinish (XXpsk0 message 3: s, se; payload SessionHello with `pair`)
 *   agent -> transport ({"paired":true}, or {"error":…})
 *
 * After either handshake every frame is an encrypted transport frame (channel.ts).
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, takeRandom, utf8Decode, utf8Encode, type RandomBytes } from '../vault/bytes';
import { PROTOCOL_VERSION, type AgentInfo, type DeviceForm, type ProtocolError } from '../protocol';
import { SecureChannel } from './channel';
import { CPACE_ELEMENT_BYTES, CpaceInitiator, cpaceRespond, type CpaceInputs } from './cpace';
import { LinkError, LinkRefusal } from './errors';
import { FRAME, decodeFrame, encodeFrame, expectFrame } from './frames';
import type { LinkKeyPair } from './keys';
import { HandshakeState, IK, XX_PSK0 } from './noise';

const SESSION_PROLOGUE = utf8Encode('authdeck/link/session/v2');
const PIN_PROLOGUE = utf8Encode('authdeck/link/pin/v2');
const PIN_CHANNEL_ID = utf8Encode('authdeck/link/pin/v2');
const PIN_PSK_INFO = utf8Encode('authdeck/link/pin-psk/v2');
const PSK_BYTES = 32;
export const PIN_SID_BYTES = 16;
const PAIRED_ACK = { paired: true } as const;
const MAX_DEVICE_ID_LENGTH = 200;
const MAX_DEVICE_NAME_LENGTH = 200;
const MAX_SECRET_LENGTH = 200;
/** Handshake payloads are small JSON objects. */
const MAX_PAYLOAD_BYTES = 4096;

/** Who the app says it is when it pairs. The agent cleans the name before showing it. */
export interface PairRequest {
  deviceId: string;
  deviceName: string;
  form?: DeviceForm;
}

/** App to agent, inside the first encrypted handshake payload it sends. */
export interface SessionHello {
  protocol: number;
  /** Present when pairing. `secret` is the QR code's one-time secret; PIN pairing has none. */
  pair?: PairRequest & { secret?: string };
}

/** Agent to app: who it is, or why it said no. */
type Accept = { agent: AgentInfo } | { error: ProtocolError };

// ---------------------------------------------------------------------------
// Payload encoding (validated where it enters, since the other side may be anyone)
// ---------------------------------------------------------------------------

function encodeJson(value: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(value));
}

function decodeJson(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new LinkError('malformed', 'A handshake payload is too long.');
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes, 'A handshake payload'));
  } catch (err) {
    throw new LinkError('malformed', 'A handshake payload is not JSON.', { cause: err });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LinkError('malformed', 'A handshake payload is not an object.');
  return value as Record<string, unknown>;
}

function isShortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parsePairRequest(value: unknown): (PairRequest & { secret?: string }) | undefined {
  if (value === undefined) return undefined;
  const fields = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || !isShortText(fields.deviceId, MAX_DEVICE_ID_LENGTH) || !isShortText(fields.deviceName, MAX_DEVICE_NAME_LENGTH)) {
    throw new LinkError('malformed', 'The pairing request needs a device id and name.');
  }
  if (fields.secret !== undefined && !isShortText(fields.secret, MAX_SECRET_LENGTH)) throw new LinkError('malformed', 'The pairing secret is empty or not text.');
  const form = fields.form === 'phone' || fields.form === 'tablet' ? fields.form : undefined;
  return {
    deviceId: fields.deviceId,
    deviceName: fields.deviceName,
    ...(form ? { form } : {}),
    ...(typeof fields.secret === 'string' ? { secret: fields.secret } : {}),
  };
}

function parseSessionHello(bytes: Uint8Array): SessionHello {
  const fields = decodeJson(bytes);
  if (typeof fields.protocol !== 'number') throw new LinkError('malformed', 'The hello has no protocol version.');
  const pair = parsePairRequest(fields.pair);
  return { protocol: fields.protocol, ...(pair ? { pair } : {}) };
}

/** Returns the agent's info, or throws the refusal it sent. */
function parseAccept(bytes: Uint8Array): AgentInfo {
  const fields = decodeJson(bytes);
  const error = fields.error as ProtocolError | undefined;
  if (error && typeof error.code === 'string' && typeof error.message === 'string') throw new LinkRefusal(error);
  const agent = fields.agent as AgentInfo | undefined;
  if (!agent || typeof agent.agentId !== 'string' || typeof agent.name !== 'string') throw new LinkError('malformed', 'The computer did not say who it is.');
  return agent;
}

function versionRefusal(theirs: number): ProtocolError {
  return theirs > PROTOCOL_VERSION
    ? { code: 'version', message: 'This computer runs an older AuthDeck agent than the app.', hint: 'Update the AuthDeck agent on the computer.' }
    : { code: 'version', message: 'This app is older than the AuthDeck agent on the computer.', hint: 'Update the AuthDeck app.' };
}

/** Sent in the clear: the agent could not read the app's first message, so it has no key to use. */
const WRONG_COMPUTER_KEY: ProtocolError = {
  code: 'unauthorized',
  message: 'This computer did not accept the connection: its key is not the one this device expects.',
  hint: 'It may be a different computer at this address, or its key changed. Pair again.',
};

/** QR pairing needs the QR code's secret; an IK hello that asks to pair without one gets this. */
const NO_PAIR_SECRET: ProtocolError = {
  code: 'unauthorized',
  message: 'The pairing request has no QR code secret.',
  hint: 'Scan the QR code the computer shows, or pair with its PIN.',
};

const WRONG_PIN: ProtocolError = {
  code: 'bad_pin',
  message: 'That PIN is not right.',
  hint: 'Type the 6-digit PIN shown on the computer. After 3 wrong tries it shows a new one.',
};

/** Reads a handshake message; an integrity failure becomes the refusal the app should see. */
function readOrRefuse(handshake: HandshakeState, message: Uint8Array, refusal: ProtocolError): Uint8Array {
  try {
    return handshake.readMessage(message);
  } catch (err) {
    if (err instanceof LinkError && err.reason === 'decrypt') throw new LinkRefusal(refusal);
    throw err;
  }
}

function pinPsk(isk: Uint8Array): Uint8Array {
  return hkdf(sha256, isk, undefined, PIN_PSK_INFO, PSK_BYTES);
}

function cpaceInputs(pin: string, sid: Uint8Array, random: RandomBytes): CpaceInputs {
  return { prs: utf8Encode(pin), ci: PIN_CHANNEL_ID, sid, random };
}

// ---------------------------------------------------------------------------
// App side
// ---------------------------------------------------------------------------

export interface OpenedLink {
  channel: SecureChannel;
  agent: AgentInfo;
}

/** A session with a paired computer, or QR pairing (when `pair` carries the QR secret). */
export class SessionClient {
  private readonly handshake: HandshakeState;

  constructor(
    device: LinkKeyPair,
    agentKey: Uint8Array,
    random: RandomBytes,
    private readonly pair?: PairRequest & { secret: string },
  ) {
    if (pair && pair.secret.length === 0) throw new Error('QR pairing needs the secret from the QR code.');
    this.handshake = new HandshakeState({ pattern: IK, initiator: true, prologue: SESSION_PROLOGUE, staticKey: device, remoteStatic: agentKey, random });
  }

  hello(): Uint8Array {
    const payload: SessionHello = { protocol: PROTOCOL_VERSION, ...(this.pair ? { pair: this.pair } : {}) };
    return encodeFrame(FRAME.sessionHello, this.handshake.writeMessage(encodeJson(payload)));
  }

  /** Throws `LinkRefusal` when the computer said no, `LinkError` when the answer is not from it. */
  accept(frame: Uint8Array, maxMessageBytes: number): OpenedLink {
    const agent = parseAccept(this.handshake.readMessage(expectFrame(frame, FRAME.sessionAccept)));
    return { channel: new SecureChannel(this.handshake.transportKeys(), maxMessageBytes), agent };
  }
}

/** PIN pairing, one guess per instance. */
export class PinPairingClient {
  private readonly sid: Uint8Array;
  private readonly cpace: CpaceInitiator;
  private handshake: HandshakeState | null = null;
  private channel: SecureChannel | null = null;
  private agent: AgentInfo | null = null;

  constructor(
    private readonly device: LinkKeyPair,
    pin: string,
    private readonly request: PairRequest,
    private readonly random: RandomBytes,
  ) {
    if (pin.length === 0) throw new Error('PIN pairing needs the PIN shown on the computer.');
    this.sid = takeRandom(random, PIN_SID_BYTES);
    this.cpace = new CpaceInitiator(cpaceInputs(pin, this.sid, random));
  }

  start(): Uint8Array {
    return encodeFrame(FRAME.pinStart, concatBytes(this.sid, this.cpace.ya));
  }

  /** Reads the computer's CPace answer and sends the first PIN-keyed handshake message. */
  hello(replyFrame: Uint8Array): Uint8Array {
    const yb = expectFrame(replyFrame, FRAME.pinReply);
    const psk = pinPsk(this.cpace.finish(yb));
    this.handshake = new HandshakeState({
      pattern: XX_PSK0,
      initiator: true,
      prologue: concatBytes(PIN_PROLOGUE, this.sid, this.cpace.ya, yb),
      staticKey: this.device,
      psk,
      random: this.random,
    });
    return encodeFrame(FRAME.pinHello, this.handshake.writeMessage(new Uint8Array(0)));
  }

  /** Reads the computer's static key and info (a wrong PIN fails here too), and sends this device's. */
  finish(acceptFrame: Uint8Array, maxMessageBytes: number): Uint8Array {
    const handshake = this.requireHandshake();
    this.agent = parseAccept(handshake.readMessage(expectFrame(acceptFrame, FRAME.pinAccept)));
    const payload: SessionHello = { protocol: PROTOCOL_VERSION, pair: this.request };
    const frame = encodeFrame(FRAME.pinFinish, handshake.writeMessage(encodeJson(payload)));
    this.channel = new SecureChannel(handshake.transportKeys(), maxMessageBytes);
    return frame;
  }

  /** Reads the computer's confirmation. Returns the computer and its proven static key. */
  confirm(frame: Uint8Array): { agent: AgentInfo; agentKey: Uint8Array } {
    if (!this.channel || !this.agent) throw new Error('Call finish() before confirm().');
    const message = this.channel.open(frame);
    if (message === null) throw new LinkError('malformed', 'The pairing confirmation is cut short.');
    const fields = decodeJson(utf8Encode(message));
    if (fields.paired !== true) {
      parseAccept(utf8Encode(message));
      throw new LinkError('malformed', 'The computer did not confirm the pairing.');
    }
    return { agent: this.agent, agentKey: this.channel.remoteStatic };
  }

  private requireHandshake(): HandshakeState {
    if (!this.handshake) throw new Error('Call hello() before finish().');
    return this.handshake;
  }
}

// ---------------------------------------------------------------------------
// Agent side
// ---------------------------------------------------------------------------

/**
 * The agent's decisions. Each may throw `LinkRefusal` to say no with a reason; the app sees it.
 * `D` is whatever the agent uses to name an authenticated device.
 */
export interface ResponderHost<D> {
  agentInfo(): AgentInfo;
  /** A paired app reconnecting with its static key. */
  session(linkKey: Uint8Array): D;
  /** QR pairing: the secret must be the one the computer shows now. */
  pairWithSecret(linkKey: Uint8Array, request: PairRequest, secret: string): D;
  /** Starts a PIN run and returns the PIN. Throws while pairing by PIN is closed or paused. */
  beginPin(): string;
  /** The PIN was right: save the device. Called inside the run, before `endPin`. */
  pairWithPin(linkKey: Uint8Array, request: PairRequest): D;
  /** Ends the run that beginPin started, exactly once, however it ended. */
  endPin(end: PinRunEnd): void;
}

/**
 * How a PIN run ended. Only `wrong-pin` is a guess that failed: a run abandoned before the app
 * sent its PIN-keyed message tested nothing, and one that got past it proved the PIN.
 */
export type PinRunEnd = 'paired' | 'wrong-pin' | 'no-guess' | 'pin-proven';

export interface ResponderStep<D> {
  /** Frames to send, in order. */
  send: Uint8Array[];
  /** Set once the channel is up: from now on only transport frames are valid. */
  opened?: { channel: SecureChannel; device: D; paired: boolean };
  /** The agent said no inside the encrypted handshake; close after sending. */
  refused?: ProtocolError;
}

type ResponderState =
  | { kind: 'start' }
  | { kind: 'pin-replied'; handshake: HandshakeState }
  | { kind: 'pin-accepted'; handshake: HandshakeState }
  | { kind: 'done' };

/** One connection's handshake on the agent. Feed it binary frames until it opens or throws. */
export class LinkResponder<D> {
  private state: ResponderState = { kind: 'start' };
  /** Where the PIN run that beginPin started has got to; null when none is open. */
  private pinRun: 'started' | 'proven' | null = null;

  constructor(
    private readonly host: ResponderHost<D>,
    private readonly staticKey: LinkKeyPair,
    private readonly random: RandomBytes,
    private readonly maxMessageBytes: number,
  ) {}

  /**
   * Throws `LinkError` for a frame that breaks the link (a wrong PIN is a `decrypt` failure at
   * pinHello) and `LinkRefusal` for a refusal that can only be sent in the clear.
   */
  receive(frame: Uint8Array): ResponderStep<D> {
    try {
      return this.step(frame);
    } catch (err) {
      this.state = { kind: 'done' };
      this.endPinRun(err instanceof LinkRefusal && err.error === WRONG_PIN ? 'wrong-pin' : this.unfinishedPinRun());
      throw err;
    }
  }

  /** The connection closed. An unfinished PIN run ends; it counts as a guess only if one was tested. */
  abandon(): void {
    this.endPinRun(this.unfinishedPinRun());
  }

  private unfinishedPinRun(): PinRunEnd {
    return this.pinRun === 'proven' ? 'pin-proven' : 'no-guess';
  }

  private endPinRun(end: PinRunEnd): void {
    if (this.pinRun === null) return;
    this.pinRun = null;
    this.host.endPin(end);
  }

  /** The plain-text refusal for a frame from another protocol version. */
  static versionRefusal(frame: Uint8Array): ProtocolError {
    return versionRefusal(frame[0] ?? 0);
  }

  private step(frame: Uint8Array): ResponderStep<D> {
    switch (this.state.kind) {
      case 'start':
        return decodeFrame(frame).type === FRAME.pinStart ? this.pinStart(frame) : this.sessionHello(frame);
      case 'pin-replied':
        return this.pinHello(this.state.handshake, frame);
      case 'pin-accepted':
        return this.pinFinish(this.state.handshake, frame);
      case 'done':
        throw new LinkError('malformed', 'The handshake is already over.');
    }
  }

  private sessionHello(frame: Uint8Array): ResponderStep<D> {
    const handshake = new HandshakeState({ pattern: IK, initiator: false, prologue: SESSION_PROLOGUE, staticKey: this.staticKey, random: this.random });
    const hello = parseSessionHello(readOrRefuse(handshake, expectFrame(frame, FRAME.sessionHello), WRONG_COMPUTER_KEY));
    const linkKey = handshake.remoteStaticKey!;
    this.state = { kind: 'done' };
    let device: D;
    try {
      if (hello.protocol !== PROTOCOL_VERSION) throw new LinkRefusal(versionRefusal(hello.protocol));
      const pair = hello.pair;
      if (pair && pair.secret === undefined) throw new LinkRefusal(NO_PAIR_SECRET);
      device = pair ? this.host.pairWithSecret(linkKey, pair, pair.secret!) : this.host.session(linkKey);
    } catch (err) {
      if (!(err instanceof LinkRefusal)) throw err;
      const refusal: Accept = { error: err.error };
      return { send: [encodeFrame(FRAME.sessionAccept, handshake.writeMessage(encodeJson(refusal)))], refused: err.error };
    }
    const accept: Accept = { agent: this.host.agentInfo() };
    const reply = encodeFrame(FRAME.sessionAccept, handshake.writeMessage(encodeJson(accept)));
    const channel = new SecureChannel(handshake.transportKeys(), this.maxMessageBytes);
    return { send: [reply], opened: { channel, device, paired: hello.pair !== undefined } };
  }

  private pinStart(frame: Uint8Array): ResponderStep<D> {
    const body = expectFrame(frame, FRAME.pinStart);
    if (body.length !== PIN_SID_BYTES + CPACE_ELEMENT_BYTES) throw new LinkError('malformed', 'The PIN pairing start has the wrong length.');
    const sid = body.subarray(0, PIN_SID_BYTES);
    const ya = body.subarray(PIN_SID_BYTES);
    const pin = this.host.beginPin();
    this.pinRun = 'started';
    const { yb, isk } = cpaceRespond(cpaceInputs(pin, sid, this.random), ya);
    const handshake = new HandshakeState({
      pattern: XX_PSK0,
      initiator: false,
      prologue: concatBytes(PIN_PROLOGUE, sid, ya, yb),
      staticKey: this.staticKey,
      psk: pinPsk(isk),
      random: this.random,
    });
    this.state = { kind: 'pin-replied', handshake };
    return { send: [encodeFrame(FRAME.pinReply, yb)] };
  }

  private pinHello(handshake: HandshakeState, frame: Uint8Array): ResponderStep<D> {
    // A wrong PIN gives a different key, so this read fails its integrity check.
    readOrRefuse(handshake, expectFrame(frame, FRAME.pinHello), WRONG_PIN);
    this.pinRun = 'proven';
    const accept: Accept = { agent: this.host.agentInfo() };
    this.state = { kind: 'pin-accepted', handshake };
    return { send: [encodeFrame(FRAME.pinAccept, handshake.writeMessage(encodeJson(accept)))] };
  }

  private pinFinish(handshake: HandshakeState, frame: Uint8Array): ResponderStep<D> {
    const hello = parseSessionHello(handshake.readMessage(expectFrame(frame, FRAME.pinFinish)));
    if (!hello.pair) throw new LinkError('malformed', 'PIN pairing ended without a pairing request.');
    const channel = new SecureChannel(handshake.transportKeys(), this.maxMessageBytes);
    this.state = { kind: 'done' };
    let end: PinRunEnd = 'pin-proven';
    try {
      if (hello.protocol !== PROTOCOL_VERSION) throw new LinkRefusal(versionRefusal(hello.protocol));
      const device = this.host.pairWithPin(channel.remoteStatic, hello.pair);
      end = 'paired';
      return { send: channel.seal(JSON.stringify(PAIRED_ACK)), opened: { channel, device, paired: true } };
    } catch (err) {
      if (!(err instanceof LinkRefusal)) throw err;
      return { send: channel.seal(JSON.stringify({ error: err.error })), refused: err.error };
    } finally {
      this.endPinRun(end);
    }
  }
}
