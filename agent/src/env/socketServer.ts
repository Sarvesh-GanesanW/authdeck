/**
 * The agent's end of the local socket the `authdeck` command talks to (envSocketContract.ts): one
 * request line per connection, progress lines while it waits, one reply line, then the agent
 * closes. The command closing its end cancels the request.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import {
  ENV_SOCKET_MAX_LINE_BYTES,
  ENV_SOCKET_VERSION,
  type EnvCommandError,
  type EnvSocketMessage,
  type EnvSocketMethod,
  type EnvSocketMethods,
  type EnvSocketProgress,
} from '../envSocketContract';

/** Connections open at once; each is one command waiting. */
export const MAX_SOCKET_CONNECTIONS = 32;
/** A command writes its one line at once; a connection that sends nothing is closed after this. */
const FIRST_LINE_TIMEOUT_MS = 10_000;
const SOCKET_METHODS: readonly EnvSocketMethod[] = ['release', 'push', 'create', 'join', 'ls'];
/** Request ids name the request on every device: short, URL-safe, made by the command. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Ends a socket request with an error the command words and exits on. */
export class EnvCommandFailure extends Error {
  constructor(readonly error: EnvCommandError) {
    super(`env command failed: ${error.code}`);
    this.name = 'EnvCommandFailure';
  }
}

/** One request being handled. */
export interface SocketRequest<M extends EnvSocketMethod = EnvSocketMethod> {
  id: string;
  method: M;
  /** Unchecked: the handler checks every field. */
  params: Record<string, unknown>;
  progress(progress: EnvSocketProgress): void;
  /** Aborted when the command closed the connection. */
  signal: AbortSignal;
}

/** Answers one request with its method's result, or throws EnvCommandFailure. */
export type SocketHandler = (request: SocketRequest) => Promise<EnvSocketMethods[EnvSocketMethod]['result']>;

export interface EnvSocketServerDeps {
  socketPath: string;
  platform: NodeJS.Platform;
  agentVersion: string;
  handle: SocketHandler;
  /** Called for an error that isn't an EnvCommandFailure: the command only hears "failed". */
  log(line: string): void;
}

export class EnvSocketInUse extends Error {
  constructor(socketPath: string) {
    super(`Another AuthDeck Agent is already listening on ${socketPath}. Stop it, then start this one.`);
    this.name = 'EnvSocketInUse';
  }
}

export class EnvSocketServer {
  private readonly server: net.Server;
  private readonly connections = new Set<net.Socket>();

  constructor(private readonly deps: EnvSocketServerDeps) {
    this.server = net.createServer({ allowHalfOpen: false }, (socket) => this.accept(socket));
    this.server.maxConnections = MAX_SOCKET_CONNECTIONS;
  }

  /** Listens on the socket path, replacing a socket left by an agent that stopped. */
  async listen(): Promise<void> {
    const { socketPath, platform } = this.deps;
    if (platform !== 'win32') await this.clearStaleSocket(socketPath);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    // The folder is already the person's alone (0700); the socket is too.
    if (platform !== 'win32') fs.chmodSync(socketPath, 0o600);
  }

  close(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async clearStaleSocket(socketPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (!stat.isSocket()) throw new Error(`${socketPath} exists and isn't a socket. Move it aside, then start AuthDeck Agent again.`);
    const answered = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (answered) throw new EnvSocketInUse(socketPath);
    fs.unlinkSync(socketPath);
  }

  private accept(socket: net.Socket): void {
    this.connections.add(socket);
    const abort = new AbortController();
    let pending = Buffer.alloc(0);
    let started = false;
    let replied = false;
    const firstLine = setTimeout(() => socket.destroy(), FIRST_LINE_TIMEOUT_MS);
    firstLine.unref();

    const write = (message: EnvSocketMessage | { id: string; ok: false; error: EnvCommandError }) => {
      if (!socket.writable) return;
      socket.write(`${JSON.stringify(message)}\n`);
    };
    const reply = (message: EnvSocketMessage) => {
      if (replied) return;
      replied = true;
      write(message);
      socket.end();
    };
    const fail = (id: string, error: EnvCommandError) => reply({ id, ok: false, error });

    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(firstLine);
      this.connections.delete(socket);
      if (!replied) abort.abort();
    });
    socket.on('end', () => {
      if (!replied) abort.abort();
    });
    socket.on('data', (chunk: Buffer) => {
      if (started) return; // One request per connection; anything after it is ignored.
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf(0x0a);
      if (end < 0) {
        if (pending.length > ENV_SOCKET_MAX_LINE_BYTES) fail('', { code: 'failed', detail: 'The request is longer than the socket allows.' });
        return;
      }
      started = true;
      clearTimeout(firstLine);
      const line = pending.subarray(0, end).toString('utf8');
      pending = Buffer.alloc(0);
      void this.handleLine(line, {
        progress: (progress, id) => {
          if (!replied) write({ id, progress });
        },
        reply,
        fail,
        signal: abort.signal,
      });
    });
  }

  private async handleLine(
    line: string,
    io: {
      progress(progress: EnvSocketProgress, id: string): void;
      reply(message: EnvSocketMessage): void;
      fail(id: string, error: EnvCommandError): void;
      signal: AbortSignal;
    },
  ): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return io.fail('', { code: 'failed', detail: "AuthDeck Agent couldn't read the request." });
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return io.fail('', { code: 'failed', detail: "AuthDeck Agent couldn't read the request." });
    const fields = value as Record<string, unknown>;
    const id = typeof fields.id === 'string' ? fields.id : '';
    if (fields.v !== ENV_SOCKET_VERSION) return io.fail(id, { code: 'agent-version', agentVersion: this.deps.agentVersion, socketVersion: ENV_SOCKET_VERSION });
    if (!REQUEST_ID_PATTERN.test(id)) return io.fail(id, { code: 'failed', detail: 'The request id is missing or malformed.' });
    const method = fields.method;
    if (typeof method !== 'string' || !SOCKET_METHODS.includes(method as EnvSocketMethod)) {
      return io.fail(id, { code: 'agent-version', agentVersion: this.deps.agentVersion, socketVersion: ENV_SOCKET_VERSION });
    }
    const params = fields.params;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return io.fail(id, { code: 'failed', detail: 'The request has no parameters.' });
    try {
      const result = await this.deps.handle({
        id,
        method: method as EnvSocketMethod,
        params: params as Record<string, unknown>,
        progress: (progress) => io.progress(progress, id),
        signal: io.signal,
      });
      io.reply({ id, ok: true, result } as EnvSocketMessage);
    } catch (err) {
      if (err instanceof EnvCommandFailure) return io.fail(id, err.error);
      this.deps.log(`env: ${method} failed unexpectedly (${err instanceof Error ? err.name : typeof err}: ${err instanceof Error ? err.message : ''})`);
      io.fail(id, { code: 'failed', detail: 'AuthDeck Agent ran into an unexpected error. Its log has the details.' });
    }
  }
}
