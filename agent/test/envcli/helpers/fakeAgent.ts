/**
 * A fake AuthDeck Agent: a socket server in a temp folder that speaks envSocketContract.ts. Each
 * test scripts the answer; every request line and every closed connection is recorded.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { EnvPlainValue } from '../../../src/envcore/types';
import { envSocketPath, type EnvReleaseParams, type EnvSocketMessage, type EnvSocketRequest } from '../../../src/envSocketContract';
import { fakeCore, fakeSeal } from './fakeCore';

export interface FakeConnection {
  request: EnvSocketRequest;
  send(message: Omit<EnvSocketMessage, 'id'>): void;
  /** Writes raw text, for malformed replies. */
  raw(text: string): void;
  end(): void;
}

export type Answer = (connection: FakeConnection) => void | Promise<void>;

export class FakeAgent {
  readonly requests: EnvSocketRequest[] = [];
  /** Requests whose connection the command closed before the agent answered. */
  readonly cancelled: string[] = [];
  answer: Answer = (c) => c.send({ ok: false, error: { code: 'failed', detail: 'No answer scripted.' } });
  private constructor(
    readonly home: string,
    readonly socketPath: string,
    private readonly server: net.Server,
  ) {}

  /** Listens at envSocketPath(home) for a fresh temp AuthDeck folder. */
  static async start(): Promise<FakeAgent> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adenv-'));
    const socketPath = envSocketPath(home, process.platform, os.userInfo().username);
    let agent: FakeAgent;
    const server = net.createServer((socket) => agent.accept(socket));
    agent = new FakeAgent(home, socketPath, server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return agent;
  }

  private accept(socket: net.Socket): void {
    let buffered = '';
    let answered = false;
    let request: EnvSocketRequest | null = null;
    socket.on('error', () => {});
    socket.on('close', () => {
      if (request && !answered) this.cancelled.push(request.id);
    });
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      const end = buffered.indexOf('\n');
      if (end < 0 || request) return;
      request = JSON.parse(buffered.slice(0, end)) as EnvSocketRequest;
      this.requests.push(request);
      const id = request.id;
      const connection: FakeConnection = {
        request,
        send: (message) => {
          if (!('progress' in message)) answered = true;
          socket.write(`${JSON.stringify({ id, ...message })}\n`);
        },
        raw: (text) => {
          answered = true;
          socket.write(text);
        },
        end: () => socket.end(),
      };
      void this.answer(connection);
    });
  }

  lastParams<T>(): T {
    return this.requests[this.requests.length - 1]!.params as T;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    fs.rmSync(this.home, { recursive: true, force: true });
  }
}

export const RELEASED_VALUES: EnvPlainValue[] = [
  { name: 'DATABASE_URL', value: 'postgres://u:p@db/app' },
  { name: 'PEM', value: '-----BEGIN-----\nabc\n-----END-----' },
];

/** Answers a release the way the agent does: sealed to the command's one-time key, under a link request id the agent picked. */
export function release(
  via: 'once' | 'grant' | 'new-grant',
  options: { progress?: string[]; sourceHash?: string; values?: EnvPlainValue[] } = {},
): Answer {
  return (c) => {
    const params = c.request.params as EnvReleaseParams;
    if (options.progress) c.send({ progress: { stage: 'asking', devices: options.progress, expiresAt: Date.now() + 60_000 } });
    const setId = (JSON.parse(params.file) as { setId: string }).setId;
    const requestId = `link-${c.request.id.slice(0, 8)}`;
    c.send({
      ok: true,
      result: {
        requestId,
        values: fakeSeal(options.values ?? RELEASED_VALUES, params.oneTimeKey, { set: setId, request: requestId }),
        by: 'Pixel 8',
        via,
        grantEndsAt: via === 'once' ? null : new Date(2026, 10, 18, 11, 58).getTime(),
        source: { rev: 7, fileHash: options.sourceHash ?? fakeCore.fileHash(params.file) },
      },
    });
  };
}
