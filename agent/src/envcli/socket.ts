/**
 * The command's side of the agent's local socket (envSocketContract.ts): one request line, then
 * progress lines and one reply. Closing the connection cancels the request on every device.
 */
import net from 'node:net';

import {
  ENV_EXIT_FOR,
  ENV_SOCKET_MAX_LINE_BYTES,
  ENV_SOCKET_VERSION,
  type EnvSocketMethod,
  type EnvSocketMethods,
  type EnvSocketProgress,
  type EnvSocketRequest,
} from '../envSocketContract';
import { EnvCliCancelled, EnvCliFailure } from './failure';

/** Connection errors that mean nobody is listening: the agent isn't running. */
const AGENT_DOWN_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'ECONNRESET', 'EPIPE']);

export interface AgentCall {
  socketPath: string;
  /** The socket request's id, which the agent's lines echo. */
  requestId: string;
  onProgress(progress: EnvSocketProgress): void;
  /** Aborting closes the socket, which cancels the request; the call rejects with EnvCliCancelled. */
  signal: AbortSignal;
}

export function askAgent<M extends EnvSocketMethod>(method: M, params: EnvSocketMethods[M]['params'], call: AgentCall): Promise<EnvSocketMethods[M]['result']> {
  const request: EnvSocketRequest<M> = { v: ENV_SOCKET_VERSION, id: call.requestId, method, params };
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(call.socketPath);
    let connected = false;
    let settled = false;
    let pending = Buffer.alloc(0);

    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      call.signal.removeEventListener('abort', onAbort);
      socket.destroy();
      outcome();
    };
    const fail = (detail: string) => finish(() => reject(new EnvCliFailure({ code: 'failed', detail })));
    const onAbort = () => finish(() => reject(new EnvCliCancelled(abortSignalName(call.signal))));

    if (call.signal.aborted) return onAbort();
    call.signal.addEventListener('abort', onAbort);

    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!connected && AGENT_DOWN_CODES.has(err.code ?? '')) finish(() => reject(new EnvCliFailure({ code: 'agent-unavailable' })));
      else fail(`The connection to AuthDeck Agent failed (${err.code ?? err.message}).`);
    });
    socket.on('close', () => fail('AuthDeck Agent closed the connection without answering.'));
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let end = pending.indexOf(0x0a); end >= 0 && !settled; end = pending.indexOf(0x0a)) {
        const line = pending.subarray(0, end).toString('utf8');
        pending = pending.subarray(end + 1);
        handleLine(line);
      }
      if (pending.length > ENV_SOCKET_MAX_LINE_BYTES) fail('AuthDeck Agent sent a line longer than the socket allows.');
    });

    function handleLine(line: string): void {
      const message = parseMessage(line, request.id);
      if (!message) return fail("AuthDeck Agent sent a reply this command can't read.");
      if ('progress' in message) return call.onProgress(message.progress);
      if (message.ok) return finish(() => resolve(message.result as EnvSocketMethods[M]['result']));
      finish(() => reject(new EnvCliFailure(message.error)));
    }
  });
}

type ParsedMessage =
  | { progress: EnvSocketProgress }
  | { ok: true; result: unknown }
  | { ok: false; error: EnvCliFailure['error'] };

/** Checks the outer shape of an agent line; the result itself is the agent's to get right. */
function parseMessage(line: string, id: string): ParsedMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(value) || value.id !== id) return null;
  if (isObject(value.progress) && Array.isArray(value.progress.devices) && typeof value.progress.expiresAt === 'number') {
    return { progress: { stage: 'asking', devices: value.progress.devices.map(String), expiresAt: value.progress.expiresAt } };
  }
  if (value.ok === true && isObject(value.result)) return { ok: true, result: value.result };
  if (value.ok === false && isObject(value.error) && typeof value.error.code === 'string' && Object.hasOwn(ENV_EXIT_FOR, value.error.code)) return { ok: false, error: value.error as EnvCliFailure['error'] };
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortSignalName(signal: AbortSignal): NodeJS.Signals {
  return typeof signal.reason === 'string' && signal.reason.startsWith('SIG') ? (signal.reason as NodeJS.Signals) : 'SIGINT';
}
