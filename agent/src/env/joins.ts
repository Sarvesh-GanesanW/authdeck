/**
 * Own-device joins of a set (env.join.*): the vault's check-code relay (joinRelay.ts), unchanged in
 * order, expiry and limits, carried between watching sessions under env event names.
 */
import { badRequest, rateLimited } from '../errors';
import { JoinRelay } from '../joinRelay';
import type { EnvEventName, EnvEvents, EventName, Events } from '../protocol';
import { RateLimiter, type RateLimit } from '../rateLimit';
import { isId } from '../vault/entry';
import { isWatching, type EnvLinkPort } from './peers';

/** Per paired device, as for vault joins: each request is shown on every other device. */
export const ENV_JOIN_REQUEST_RATE: RateLimit = { burst: 4, refillMs: 15_000 };

const EVENT_NAMES: Partial<Record<EventName, EnvEventName>> = {
  'vault.join.requested': 'env.join.requested',
  'vault.join.challenged': 'env.join.challenged',
  'vault.join.revealed': 'env.join.revealed',
  'vault.join.finished': 'env.join.finished',
  'vault.join.cancelled': 'env.join.cancelled',
};

type Params = Record<string, unknown>;

export class EnvJoins {
  private readonly relay: JoinRelay;
  private readonly setOf = new Map<string, string>();
  /** The set of the request being made right now: JoinRelay announces it before it returns its id. */
  private requesting: string | null = null;
  private readonly limits = new Map<string, RateLimiter>();

  constructor(private readonly deps: { port: EnvLinkPort; now: () => number }) {
    this.relay = new JoinRelay({
      now: deps.now,
      sendTo: (deviceId, event, data) => this.sendTo(deviceId, event, data),
      connected: () => new Set(this.deps.port.peers().filter(isWatching).map((peer) => peer.deviceId)),
      deviceName: (deviceId) => this.deps.port.peers().find((peer) => peer.deviceId === deviceId)?.deviceName ?? 'A device',
    });
  }

  request(deviceId: string, params: Params): { requestId: string; expiresAt: number } {
    if (!isId(params.setId)) throw badRequest('The set id is missing or malformed.');
    if (!this.limiter(deviceId).tryTake()) throw rateLimited('This device sent too many join requests. Wait a minute and try again.');
    this.requesting = params.setId;
    try {
      return this.relay.request(deviceId, params);
    } finally {
      this.requesting = null;
    }
  }

  challenge(deviceId: string, params: Params): Record<string, never> {
    return this.relay.challenge(deviceId, params);
  }

  reveal(deviceId: string, params: Params): Record<string, never> {
    return this.relay.reveal(deviceId, params);
  }

  finish(deviceId: string, params: Params): Record<string, never> {
    // env.join.finish has no vault id; one sent anyway is not passed on.
    return this.relay.finish(deviceId, { requestId: params.requestId, approved: params.approved });
  }

  cancel(deviceId: string, params: Params): Record<string, never> {
    return this.relay.cancel(deviceId, params);
  }

  deviceGone(deviceId: string): void {
    this.relay.deviceGone(deviceId);
  }

  expire(): void {
    this.relay.expire();
  }

  private limiter(deviceId: string): RateLimiter {
    let limiter = this.limits.get(deviceId);
    if (!limiter) this.limits.set(deviceId, (limiter = new RateLimiter(ENV_JOIN_REQUEST_RATE, this.deps.now)));
    return limiter;
  }

  private sendTo<E extends EventName>(deviceId: string, event: E, data: Events[E]): void {
    const name = EVENT_NAMES[event];
    if (!name) return;
    const message = this.envData(event, data);
    if (!message) return;
    for (const peer of this.deps.port.peers()) if (peer.deviceId === deviceId && isWatching(peer)) peer.send(name, message as EnvEvents[typeof name]);
  }

  private envData(event: EventName, data: Events[EventName]): EnvEvents[EnvEventName] | null {
    const requestId = (data as { requestId: string }).requestId;
    switch (event) {
      case 'vault.join.requested': {
        const setId = this.requesting ?? this.setOf.get(requestId);
        if (!setId) return null;
        this.setOf.set(requestId, setId);
        return { ...(data as Events['vault.join.requested']), setId };
      }
      case 'vault.join.finished': {
        this.setOf.delete(requestId);
        const finished = data as Events['vault.join.finished'];
        return { requestId, approved: finished.approved };
      }
      case 'vault.join.cancelled':
        this.setOf.delete(requestId);
        return data as Events['vault.join.cancelled'];
      default:
        return data as EnvEvents[EnvEventName];
    }
  }
}
