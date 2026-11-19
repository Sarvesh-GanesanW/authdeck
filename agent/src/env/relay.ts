/**
 * Requests from this computer (run, pull, push, create, join-keys) on their way to devices: each
 * goes to the watching sessions it routes to, also to ones that start watching while it waits. The
 * first answer that checks out wins; the others are told it closed. The request ends when answered,
 * when it runs out (ENV_REQUEST_TTL_MS), or when the command closes its connection.
 */
import { AgentError, badRequest } from '../errors';
import type { EnvJoinRequestFile, EnvSealedValues } from '../envcore/types';
import type { EnvAnswer, EnvComputerRequest } from '../protocol';
import { isWatching, type EnvLinkPort, type EnvPeer } from './peers';

export type AskOutcome<T> = { outcome: 'answered'; value: T } | { outcome: 'expired' } | { outcome: 'cancelled' };

/** What an accepted answer gives the command, and, when it was taken but couldn't be carried out, the error its device gets. */
export interface AnswerHandled<T> {
  value: T;
  deviceError?: AgentError;
}

export interface Ask<T> {
  request: EnvComputerRequest;
  /** Whether a watching session gets this request. */
  routesTo(peer: EnvPeer & { members: readonly string[] }): boolean;
  /** Checks and carries out an answer. Throws AgentError to refuse it; the request keeps waiting. Synchronous, so two answers can't race. */
  handle(answer: EnvAnswer, peer: EnvPeer): AnswerHandled<T>;
  /** The devices asked so far, by name, each time the list changes. */
  onDevices(devices: string[]): void;
  /** Aborted when the command closed its connection. */
  signal: AbortSignal;
}

interface Pending {
  ask: Ask<unknown>;
  recipients: Set<EnvPeer>;
  devices: string;
  finish(outcome: AskOutcome<unknown>): void;
}

export interface RelayDeps {
  port: EnvLinkPort;
  now(): number;
}

export class EnvRelay {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: RelayDeps) {}

  count(): number {
    return this.pending.size;
  }

  /** When the first waiting request runs out (a slot frees up then at the latest); null when none waits. */
  soonestExpiry(): number | null {
    const ends = [...this.pending.values()].map((pending) => pending.ask.request.expiresAt);
    return ends.length > 0 ? Math.min(...ends) : null;
  }

  /** Sends the request to every session it routes to and waits for the first answer that checks out. */
  ask<T>(ask: Ask<T>): Promise<AskOutcome<T>> {
    const { requestId } = ask.request;
    if (this.pending.has(requestId)) throw new Error(`Request ${requestId} is already waiting.`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => close('expired'), Math.max(0, ask.request.expiresAt - this.deps.now()));
      const onAbort = () => close('cancelled');
      const pending: Pending = {
        ask: ask as Ask<unknown>,
        recipients: new Set(),
        devices: '',
        finish: (outcome) => {
          clearTimeout(timer);
          ask.signal.removeEventListener('abort', onAbort);
          this.pending.delete(requestId);
          resolve(outcome as AskOutcome<T>);
        },
      };
      const close = (reason: 'expired' | 'cancelled') => {
        if (!this.pending.has(requestId)) return;
        for (const peer of pending.recipients) peer.send('env.request.closed', { requestId, reason });
        pending.finish({ outcome: reason });
      };
      this.pending.set(requestId, pending);
      if (ask.signal.aborted) return close('cancelled');
      ask.signal.addEventListener('abort', onAbort);
      for (const peer of this.deps.port.peers()) {
        if (!isWatching(peer) || !ask.routesTo(peer)) continue;
        pending.recipients.add(peer);
        peer.send('env.request', { request: ask.request });
      }
      this.reportDevices(pending);
    });
  }

  /**
   * A session called env.watch (again): it joins the requests it routes to, and leaves those it
   * no longer does. Returns the requests it may answer, oldest first.
   */
  watched(peer: EnvPeer): EnvComputerRequest[] {
    const requests: EnvComputerRequest[] = [];
    for (const pending of this.pending.values()) {
      if (isWatching(peer) && pending.ask.routesTo(peer)) {
        pending.recipients.add(peer);
        requests.push(pending.ask.request);
      } else {
        pending.recipients.delete(peer);
      }
      this.reportDevices(pending);
    }
    return requests.sort((a, b) => a.askedAt - b.askedAt);
  }

  peerGone(peer: EnvPeer): void {
    for (const pending of this.pending.values()) {
      if (pending.recipients.delete(peer)) this.reportDevices(pending);
    }
  }

  /** A device's answer. `not_found` when the request ended or was never sent to this session. */
  answer(peer: EnvPeer, requestId: unknown, raw: unknown): Record<string, never> {
    const pending = typeof requestId === 'string' ? this.pending.get(requestId) : undefined;
    if (!pending || !pending.recipients.has(peer)) {
      throw new AgentError('not_found', 'That request was already answered, ran out, or the command stopped.', 'Run the command on the computer again.');
    }
    const answer = parseAnswer(raw);
    const handled = pending.ask.handle(answer, peer);
    for (const other of pending.recipients) if (other !== peer) other.send('env.request.closed', { requestId: pending.ask.request.requestId, reason: 'answered', by: peer.deviceName });
    pending.finish({ outcome: 'answered', value: handled.value });
    if (handled.deviceError) throw handled.deviceError;
    return {};
  }

  /** The agent is stopping: every waiting command is told it was cancelled. */
  cancelAll(): void {
    for (const pending of [...this.pending.values()]) {
      for (const peer of pending.recipients) peer.send('env.request.closed', { requestId: pending.ask.request.requestId, reason: 'cancelled' });
      pending.finish({ outcome: 'cancelled' });
    }
  }

  private reportDevices(pending: Pending): void {
    const names = [...new Set([...pending.recipients].map((peer) => peer.deviceName))];
    const key = JSON.stringify(names);
    if (key === pending.devices) return;
    pending.devices = key;
    pending.ask.onDevices(names);
  }
}

// ---------------------------------------------------------------------------
// Answers are checked for shape here; what they mean is the request's to check.
// ---------------------------------------------------------------------------

const MAX_FIELD_CHARS = 4096;
const MAX_CHANGED_NAMES = 1000;
const MAX_LINK_MESSAGE_CHARS = 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, what: string, maxChars = MAX_FIELD_CHARS): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) throw badRequest(`${what} is missing or malformed.`);
  return value;
}

function sealedValues(value: unknown): EnvSealedValues {
  if (!isObject(value) || !isObject(value.key) || !isObject(value.box)) throw badRequest('The released values are missing.');
  const { key, box } = value;
  if (!Number.isSafeInteger(box.epoch)) throw badRequest('The released values are malformed.');
  return {
    key: { e: field(key.e, 'The sealed key'), r: field(key.r, 'The sealed key'), ct: field(key.ct, 'The sealed key') },
    // The box holds every value: as large as a link message allows.
    box: { epoch: box.epoch as number, n: field(box.n, 'The box'), ct: field(box.ct, 'The box', MAX_LINK_MESSAGE_CHARS), c: field(box.c, 'The box') },
  };
}

function names(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CHANGED_NAMES || !value.every((name) => typeof name === 'string' && name.length <= 256)) {
    throw badRequest('The list of changed names is malformed.');
  }
  return value as string[];
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw badRequest(`${what} is missing.`);
  return value;
}

/** The answer's outer shape, rebuilt from known fields only. */
export function parseAnswer(raw: unknown): EnvAnswer {
  if (!isObject(raw) || typeof raw.kind !== 'string') throw badRequest('The answer is missing.');
  switch (raw.kind) {
    case 'deny':
      return { kind: 'deny' };
    case 'release': {
      if (raw.scope !== 'once' && raw.scope !== 'grant') throw badRequest('A release is either once or for 15 minutes.');
      const source = raw.source;
      if (!isObject(source) || !Number.isSafeInteger(source.rev) || typeof source.fileHash !== 'string') throw badRequest('The release does not say which copy it came from.');
      return { kind: 'release', scope: raw.scope, values: sealedValues(raw.values), source: { rev: source.rev as number, fileHash: field(source.fileHash, 'The file hash') } };
    }
    case 'signed':
      return { kind: 'signed', file: text(raw.file, 'The signed file'), added: names(raw.added), changed: names(raw.changed), removed: names(raw.removed) };
    case 'created':
      return { kind: 'created', file: text(raw.file, 'The new set file') };
    case 'join-keys':
      if (!isObject(raw.request)) throw badRequest('The join request is missing.');
      return { kind: 'join-keys', request: raw.request as unknown as EnvJoinRequestFile };
    default:
      throw badRequest(`"${raw.kind}" is not an answer this agent knows.`);
  }
}
