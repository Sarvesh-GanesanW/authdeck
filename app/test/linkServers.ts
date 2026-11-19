/// <reference types="node" />
/**
 * WebSocket servers for the net tests: a genuine agent (the link's own LinkResponder) and hostile
 * stand-ins that hold none of the computer's keys. They listen on loopback, port 0 by default.
 */
import crypto from 'node:crypto';
import { LinkError, LinkRefusal } from '../src/link/errors';
import type { SecureChannel } from '../src/link/channel';
import { LinkResponder, type ResponderHost } from '../src/link/handshakes';
import { generateLinkKey, type LinkKeyPair } from '../src/link/keys';
import { type AgentInfo, PROTOCOL_VERSION, type ProtocolError, WS_PATH } from '../src/protocol';

interface Peer {
  send(data: Uint8Array | string): void;
  close(): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
}
interface Server {
  address(): { port: number };
  clients: Set<Peer>;
  on(event: 'connection', listener: (peer: Peer) => void): void;
  close(done: () => void): void;
}
// The agent's own ws dependency: the app has no WebSocket server of its own.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WebSocketServer } = require('../../agent/node_modules/ws') as {
  WebSocketServer: new (options: { host: string; port: number; path: string }, ready: () => void) => Server;
};

export const random = (n: number) => new Uint8Array(crypto.randomBytes(n));
export const newLinkKey = (): LinkKeyPair => generateLinkKey(random);

export interface TestServer {
  host: string;
  port: number;
  /** WebSocket connections accepted so far. */
  connections: () => number;
  close: () => Promise<void>;
}

/** A server that hands each frame (bytes, or a string for a text frame) to `answer`. */
export function listen(host: string, port: number, answer: (peer: Peer, frame: Uint8Array | string) => void): Promise<TestServer> {
  return new Promise((resolve) => {
    let connections = 0;
    const wss = new WebSocketServer({ host, port, path: WS_PATH }, () =>
      resolve({
        host,
        port: wss.address().port,
        connections: () => connections,
        close: () =>
          new Promise<void>((done) => {
            wss.clients.forEach((peer) => peer.terminate());
            wss.close(() => done());
          }),
      }),
    );
    wss.on('connection', (peer) => {
      connections++;
      peer.on('message', (data, isBinary) => answer(peer, isBinary ? new Uint8Array(data) : data.toString('utf8')));
    });
  });
}

/** Answers every frame with the same plain-text refusal, as anything on the network could. */
export function plainRefuser(host: string, port: number, error: ProtocolError): Promise<TestServer> {
  return listen(host, port, (peer) => peer.send(JSON.stringify({ ok: false, error })));
}

/** Answers every frame with one binary frame of the given bytes. */
export function binaryAnswerer(host: string, port: number, bytes: Uint8Array): Promise<TestServer> {
  return listen(host, port, (peer) => peer.send(bytes));
}

export const agentInfo = (agentId: string, name = 'Mac'): AgentInfo => ({ agentId, name, platform: 'macos', version: '0.3.0', protocol: PROTOCOL_VERSION });

export interface AgentOptions {
  key: LinkKeyPair;
  info: AgentInfo;
  /** Refuse sessions inside the encrypted handshake with this error. */
  refuseSessions?: ProtocolError;
  /** Refuse QR pairings inside the encrypted handshake with this error. */
  refusePairing?: ProtocolError;
  pin?: string;
  /** Called once a channel is open, with the peer and the channel, to misbehave afterwards. */
  afterOpen?: (peer: Peer, channel: SecureChannel) => void;
  /** Answers each request inside the channel with this text (sealed), given the request's id. */
  answer?: (id: string) => string;
  /** Like `answer`, with the whole request; may answer later (or never) through `reply`. */
  answerRequest?: (request: { id: string; method: string; params: unknown }, reply: (text: string) => void) => void;
}

/** Sends `text` to the app inside the open channel, as the computer would. */
export function sendSealed(peer: Peer, channel: SecureChannel, text: string): void {
  channel.seal(text).forEach((frame) => peer.send(frame));
}

/** A genuine agent: the link's responder, replying the way the agent's server does. */
export function agentServer(host: string, port: number, options: AgentOptions): Promise<TestServer> {
  const responderHost: ResponderHost<string> = {
    agentInfo: () => options.info,
    session: () => {
      if (options.refuseSessions) throw new LinkRefusal(options.refuseSessions);
      return 'device';
    },
    pairWithSecret: () => {
      if (options.refusePairing) throw new LinkRefusal(options.refusePairing);
      return 'device';
    },
    beginPin: () => options.pin ?? '000000',
    pairWithPin: () => 'device',
    endPin: () => undefined,
  };
  const responders = new WeakMap<Peer, LinkResponder<string>>();
  const opened = new WeakMap<Peer, SecureChannel>();
  return listen(host, port, (peer, frame) => {
    if (typeof frame === 'string') return;
    const channel = opened.get(peer);
    if (channel) {
      try {
        const request = channel.open(frame);
        if (request !== null && options.answer) sendSealed(peer, channel, options.answer((JSON.parse(request) as { id: string }).id));
        if (request !== null && options.answerRequest) {
          options.answerRequest(JSON.parse(request) as { id: string; method: string; params: unknown }, (text) => sendSealed(peer, channel, text));
        }
      } catch {
        peer.close();
      }
      return;
    }
    let responder = responders.get(peer);
    if (!responder) {
      responder = new LinkResponder(responderHost, options.key, random, 1 << 20);
      responders.set(peer, responder);
    }
    try {
      const step = responder.receive(frame);
      step.send.forEach((f) => peer.send(f));
      if (step.opened) {
        opened.set(peer, step.opened.channel);
        options.afterOpen?.(peer, step.opened.channel);
      }
      if (step.refused) peer.close();
    } catch (err) {
      if (err instanceof LinkRefusal) peer.send(JSON.stringify({ ok: false, error: err.error }));
      else if (err instanceof LinkError) peer.close();
      else throw err;
    }
  });
}

/** Polls until `check` holds, or fails after `timeoutMs`. */
export async function waitFor(what: string, check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
