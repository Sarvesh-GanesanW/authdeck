/**
 * How the env code sees the link: signed-in sessions of paired devices. server.ts makes one
 * EnvPeer per session; env events reach a session only after it called env.watch.
 */
import type { EnvEventName, EnvEvents } from '../protocol';

export interface EnvPeer {
  /** The paired device (the agent's id for it, not a member id). */
  readonly deviceId: string;
  readonly deviceName: string;
  /** Member ids from env.watch: routing only. Null until the session calls it. */
  members: readonly string[] | null;
  /** Sends an env event to this session, if it still may receive events. */
  send<E extends EnvEventName>(event: E, data: EnvEvents[E]): void;
}

/** What the env code needs from the link server. */
export interface EnvLinkPort {
  /** Signed-in sessions, watching or not. */
  peers(): EnvPeer[];
}

export function isWatching(peer: EnvPeer): peer is EnvPeer & { members: readonly string[] } {
  return peer.members !== null;
}

/** Sends one event to every watching session. */
export function sendToWatching<E extends EnvEventName>(port: EnvLinkPort, event: E, data: EnvEvents[E]): void {
  for (const peer of port.peers()) if (isWatching(peer)) peer.send(event, data);
}
