/**
 * Devices for the server tests, speaking the link through the app's own copy of the link code
 * (app/src/link), so every server test is also a test of the agent against the app.
 */
import crypto from 'node:crypto';
import WebSocket from 'ws';
import type { SecureChannel } from '../../../app/src/link/channel';
import { PinPairingClient, SessionClient, type PairRequest } from '../../../app/src/link/handshakes';
import { generateLinkKey, type LinkKeyPair } from '../../../app/src/link/keys';
import type { AgentInfo } from '../../src/protocol';
import { WS_PATH } from '../../src/protocol';

export const random = (length: number) => new Uint8Array(crypto.randomBytes(length));
export const newDeviceKey = (): LinkKeyPair => generateLinkKey(random);
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type Reply = { ok: boolean; result?: any; error?: { code: string; message: string; hint?: string } };
export type Received = { binary: Uint8Array } | { text: string };

/** A WebSocket that hands over messages one at a time, for driving the link step by step. */
export class RawSocket {
  readonly socket: WebSocket;
  private readonly queue: Received[] = [];
  private wake: (() => void) | null = null;
  readonly closed: Promise<number>;

  /** `host` lets a test come from another of this computer's addresses (a second LAN peer). */
  constructor(port: number, host = '127.0.0.1', options: WebSocket.ClientOptions = {}) {
    this.socket = new WebSocket(`ws://${host}:${port}${WS_PATH}`, options);
    this.socket.on('message', (data, isBinary) => {
      this.queue.push(isBinary ? { binary: new Uint8Array(data as Buffer) } : { text: data.toString() });
      this.wake?.();
    });
    this.closed = new Promise((resolve) => this.socket.on('close', (code) => {
      resolve(code);
      this.wake?.();
    }));
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(data: Uint8Array | string): void {
    this.socket.send(data);
  }

  /** The next message, or null once the socket has closed with nothing left. */
  async next(): Promise<Received | null> {
    for (;;) {
      const message = this.queue.shift();
      if (message) return message;
      if (this.socket.readyState === WebSocket.CLOSED) return null;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }

  async nextBinary(): Promise<Uint8Array> {
    const message = await this.next();
    if (!message || !('binary' in message)) throw new Error(`Expected a binary frame, got ${message ? message.text : 'a closed socket'}`);
    return message.binary;
  }

  /** The plain-text refusal the agent sends before closing. */
  async nextRefusal(): Promise<{ code: string; message: string; hint?: string }> {
    const message = await this.next();
    if (!message || !('text' in message)) throw new Error('Expected a plain-text refusal');
    return JSON.parse(message.text).error;
  }

  close(): void {
    this.socket.close();
  }
}

/** A device with an open encrypted channel. */
export class LinkedDevice {
  private nextId = 1;
  private readonly waiting = new Map<string, (message: Reply) => void>();
  readonly events: { event: string; data: any }[] = [];

  constructor(
    readonly raw: RawSocket,
    readonly channel: SecureChannel,
    readonly agent: AgentInfo,
  ) {
    void this.pump();
  }

  get closed(): Promise<number> {
    return this.raw.closed;
  }

  request(method: string, params: unknown): Promise<Reply> {
    const id = String(this.nextId++);
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      for (const frame of this.channel.seal(JSON.stringify({ id, method, params }))) this.raw.send(frame);
    });
  }

  async event(name: string): Promise<{ event: string; data: any }> {
    for (let tries = 0; tries < 100; tries++) {
      const found = this.events.find((e) => e.event === name);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`No ${name} event`);
  }

  close(): void {
    this.raw.close();
  }

  private async pump(): Promise<void> {
    for (;;) {
      const received = await this.raw.next();
      if (!received) return;
      if (!('binary' in received)) throw new Error(`Plain text after the handshake: ${received.text}`);
      const text = this.channel.open(received.binary);
      if (text === null) continue;
      const message = JSON.parse(text);
      if (message.event) this.events.push(message);
      else this.waiting.get(message.id)?.(message);
    }
  }
}

async function openRaw(port: number): Promise<RawSocket> {
  const raw = new RawSocket(port);
  await raw.opened();
  return raw;
}

/**
 * Whether to send a first request after the handshake, as the app does at once. The agent counts
 * a device as connected only from its first encrypted frame.
 */
export interface SessionOptions {
  signIn?: boolean;
}

/** Signs in a paired device (Noise IK). Rejects with the refusal's message when the agent says no. */
export async function connectDevice(port: number, device: LinkKeyPair, agentKey: Uint8Array, options: SessionOptions = {}): Promise<LinkedDevice> {
  const raw = await openRaw(port);
  const client = new SessionClient(device, agentKey, random);
  raw.send(client.hello());
  return finishSession(raw, client, options);
}

/** QR pairing: IK to the key in the QR code, carrying its secret. The channel stays open. */
export async function pairByQr(port: number, agentKey: Uint8Array, secret: string, device: LinkKeyPair, request: PairRequest, options: SessionOptions = {}): Promise<LinkedDevice> {
  const raw = await openRaw(port);
  const client = new SessionClient(device, agentKey, random, { ...request, secret });
  raw.send(client.hello());
  return finishSession(raw, client, options);
}

async function finishSession(raw: RawSocket, client: SessionClient, { signIn = true }: SessionOptions): Promise<LinkedDevice> {
  const reply = await raw.next();
  if (!reply) throw new Error('The agent closed the connection');
  if ('text' in reply) throw Object.assign(new Error(JSON.parse(reply.text).error.message), { refusal: JSON.parse(reply.text).error });
  const { channel, agent } = client.accept(reply.binary, MAX_MESSAGE_BYTES);
  const device = new LinkedDevice(raw, channel, agent);
  if (signIn) await device.request('ping', {});
  return device;
}

/** PIN pairing (CPace, then XXpsk0). Resolves with what the app would store. */
export interface PinOptions {
  /** Connect to this address of the computer instead of 127.0.0.1. */
  host?: string;
  /** A slow phone or network: waits this long before sending the guess. */
  guessDelayMs?: number;
}

export async function pairByPin(port: number, pin: string, device: LinkKeyPair, request: PairRequest, options: PinOptions = {}): Promise<{ agent: AgentInfo; agentKey: Uint8Array; raw: RawSocket }> {
  const raw = new RawSocket(port, options.host);
  await raw.opened();
  const client = new PinPairingClient(device, pin, request, random);
  raw.send(client.start());
  const reply = await nextOrRefusal(raw);
  if (options.guessDelayMs) await new Promise((resolve) => setTimeout(resolve, options.guessDelayMs));
  raw.send(client.hello(reply));
  raw.send(client.finish(await nextOrRefusal(raw), MAX_MESSAGE_BYTES));
  return { ...client.confirm(await nextOrRefusal(raw)), raw };
}

async function nextOrRefusal(raw: RawSocket): Promise<Uint8Array> {
  const reply = await raw.next();
  if (!reply) throw new Error('The agent closed the connection');
  if ('text' in reply) throw Object.assign(new Error(JSON.parse(reply.text).error.message), { refusal: JSON.parse(reply.text).error });
  return reply.binary;
}
