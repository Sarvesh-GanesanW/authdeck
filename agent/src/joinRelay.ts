import crypto from 'node:crypto';
import { AgentError, badRequest } from './errors';
import { VAULT_JOIN_TTL_MS, type EventName, type Events, type VaultJoinChallenge, type VaultJoinRequest, type VaultJoinReveal } from './protocol';
import { cleanJoinName as cleanName, MAX_JOIN_NAME_LENGTH } from './vault/approval';

export { MAX_JOIN_NAME_LENGTH };
export const MAX_PENDING_JOINS = 16;
export const MAX_PENDING_JOINS_PER_DEVICE = 2;
const MAX_FIELD_LENGTH = 128;

type Stage = 'requested' | 'challenged' | 'revealed';

interface PendingJoin {
  requestId: string;
  /** Paired device ids (the agent's, not the vault's). */
  requester: string;
  approver: string | null;
  /** Devices that were told about the request, so they can drop it when it ends. */
  notified: string[];
  stage: Stage;
  expiresAt: number;
}

export interface JoinRelayDeps {
  now: () => number;
  /** Sends an event to every connection of one paired device. */
  sendTo: <E extends EventName>(deviceId: string, event: E, data: Events[E]) => void;
  /** Paired devices connected right now. */
  connected: () => Set<string>;
  deviceName: (deviceId: string) => string;
}

function shortText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_FIELD_LENGTH) throw badRequest(`${what} is missing or too long.`);
  return value;
}

/**
 * Names travel in plain text during a join, because no key exists yet, and the check code covers
 * them. The sending app cleans them (vault/approval.ts); the relay passes them on unchanged and
 * refuses one that isn't clean, because changing it would change the code on one side only.
 */
export function requireCleanJoinName(value: unknown, what = 'The device name'): string {
  const raw = shortText(value, what);
  if (cleanName(raw) !== raw) throw badRequest(`${what} has control characters or extra spaces. Update AuthDeck on that device.`);
  return raw;
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest(`${what} is missing.`);
  return value as Record<string, unknown>;
}

/**
 * Carries check-code approval messages between two connected devices. The relay is untrusted by
 * design (the check code catches a relay that tampers), so it only enforces order, expiry and limits.
 */
export class JoinRelay {
  private readonly joins = new Map<string, PendingJoin>();

  constructor(private readonly deps: JoinRelayDeps) {}

  request(from: string, params: Record<string, unknown>): { requestId: string; expiresAt: number } {
    this.expire();
    const raw = object(params.request, 'The join request');
    const request: VaultJoinRequest = {
      ed: shortText(raw.ed, 'The signing key'),
      x: shortText(raw.x, 'The sealing key'),
      name: requireCleanJoinName(raw.name),
      commit: shortText(raw.commit, 'The commitment'),
    };
    if (this.joins.size >= MAX_PENDING_JOINS) throw new AgentError('failed', 'Too many devices are asking to join right now.', 'Wait a few minutes and try again.');
    const own = [...this.joins.values()].filter((join) => join.requester === from).length;
    if (own >= MAX_PENDING_JOINS_PER_DEVICE) throw new AgentError('failed', 'This device already has join requests waiting.', 'Cancel them or wait for them to expire.');
    const others = [...this.deps.connected()].filter((id) => id !== from);
    if (others.length === 0) throw new AgentError('not_found', 'No other device is connected to this computer.', 'Open AuthDeck on a device that is already in the vault and connect it to this computer.');
    const requestId = crypto.randomUUID();
    const expiresAt = this.deps.now() + VAULT_JOIN_TTL_MS;
    this.joins.set(requestId, { requestId, requester: from, approver: null, notified: others, stage: 'requested', expiresAt });
    for (const id of others) this.deps.sendTo(id, 'vault.join.requested', { requestId, request, fromDevice: this.deps.deviceName(from), expiresAt });
    return { requestId, expiresAt };
  }

  challenge(from: string, params: Record<string, unknown>): Record<string, never> {
    const join = this.find(params.requestId);
    if (join.requester === from) throw badRequest('A device can\'t approve itself.');
    if (join.stage !== 'requested' || join.approver !== null) throw new AgentError('failed', 'Another device is already answering this request.');
    const raw = object(params.challenge, 'The challenge');
    const challenge: VaultJoinChallenge = {
      ed: shortText(raw.ed, 'The approver key'),
      x: shortText(raw.x, 'The approver sealing key'),
      vault: shortText(raw.vault, 'The vault id'),
      vaultName: requireCleanJoinName(raw.vaultName, 'The vault name'),
      name: requireCleanJoinName(raw.name, 'The approver name'),
      nonce: shortText(raw.nonce, 'The nonce'),
    };
    join.approver = from;
    join.stage = 'challenged';
    for (const id of join.notified) if (id !== from) this.deps.sendTo(id, 'vault.join.cancelled', { requestId: join.requestId, reason: 'taken' });
    this.deps.sendTo(join.requester, 'vault.join.challenged', { requestId: join.requestId, challenge });
    return {};
  }

  reveal(from: string, params: Record<string, unknown>): Record<string, never> {
    const join = this.find(params.requestId);
    if (join.requester !== from) throw badRequest('Only the device that asked to join can reveal its number.');
    if (join.stage !== 'challenged') throw new AgentError('failed', 'Wait for the other device to answer before revealing.');
    const raw = object(params.reveal, 'The reveal');
    const reveal: VaultJoinReveal = { nonce: shortText(raw.nonce, 'The nonce') };
    join.stage = 'revealed';
    this.deps.sendTo(join.approver!, 'vault.join.revealed', { requestId: join.requestId, reveal });
    return {};
  }

  finish(from: string, params: Record<string, unknown>): Record<string, never> {
    const join = this.find(params.requestId);
    if (join.approver !== from) throw badRequest('Only the approving device can finish this request.');
    if (join.stage !== 'revealed') throw new AgentError('failed', 'The new device has not revealed its number yet.');
    if (typeof params.approved !== 'boolean') throw badRequest('"approved" must be true or false.');
    const vaultId = params.vaultId === undefined ? undefined : shortText(params.vaultId, 'The vault id');
    this.joins.delete(join.requestId);
    this.deps.sendTo(join.requester, 'vault.join.finished', { requestId: join.requestId, approved: params.approved, ...(vaultId ? { vaultId } : {}) });
    return {};
  }

  cancel(from: string, params: Record<string, unknown>): Record<string, never> {
    const join = this.find(params.requestId);
    if (join.requester !== from && join.approver !== from) throw badRequest('This device is not part of that request.');
    this.end(join, 'cancelled', from);
    return {};
  }

  /** A device disconnected for good: end the requests it was part of. */
  deviceGone(deviceId: string): void {
    for (const join of [...this.joins.values()]) if (join.requester === deviceId || join.approver === deviceId) this.end(join, 'disconnected', deviceId);
  }

  /** Ends requests older than five minutes and tells both sides. */
  expire(): void {
    const now = this.deps.now();
    for (const join of [...this.joins.values()]) if (join.expiresAt <= now) this.end(join, 'expired', null);
  }

  pendingCount(): number {
    return this.joins.size;
  }

  private end(join: PendingJoin, reason: 'cancelled' | 'expired' | 'disconnected', except: string | null): void {
    this.joins.delete(join.requestId);
    const parties = new Set([join.requester, ...(join.approver ? [join.approver] : join.notified)]);
    for (const id of parties) if (id !== except) this.deps.sendTo(id, 'vault.join.cancelled', { requestId: join.requestId, reason });
  }

  private find(requestId: unknown): PendingJoin {
    this.expire();
    const join = typeof requestId === 'string' ? this.joins.get(requestId) : undefined;
    if (!join) throw new AgentError('not_found', 'That join request has ended or expired.', 'Start again on the new device.');
    return join;
  }
}
