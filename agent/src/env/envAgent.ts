/**
 * Env sets in the agent: the local socket for the `authdeck` command, the env.* link methods,
 * requests relayed to devices, and grants held in memory. The computer never holds a set's data
 * key; it relays ciphertext and keeps a grant's values only sealed to a key in this process.
 */
import crypto from 'node:crypto';
import path from 'node:path';

import { envFileHash } from '../envcore';
import type { EnvActivityEntry, EnvAgentControl, EnvAgentEventListener } from '../envSocketContract';
import { ENV_REQUEST_TTL_MS, type EnvGrant, type EnvGrantEndReason } from '../protocol';
import type { RandomBytes } from '../vault/bytes';
import { EnvCommands } from './commands';
import { EnvDeviceMethods } from './deviceMethods';
import { GRANT_CHECK_MS, GrantStore, type GrantClock } from './grants';
import { EnvJoins } from './joins';
import { sendToWatching, type EnvLinkPort, type EnvPeer } from './peers';
import { ProjectRegistry } from './registry';
import { EnvRelay } from './relay';
import { EnvSocketServer } from './socketServer';
import type { EnvState } from './state';
import { readSetFile, setFileLocation, WorkTreeError } from './workTree';

/** What server.ts calls: the env side of each session. */
export interface EnvLinkHandler {
  /** Called once by the server with its sessions. */
  bind(port: EnvLinkPort): void;
  /** An env.* method from a signed-in session. Throws AgentError. */
  handleLink(peer: EnvPeer, method: string, params: Record<string, unknown>): Promise<unknown>;
  /** A session closed. */
  peerGone(peer: EnvPeer): void;
  /** A paired device was unpaired: its grants end. */
  deviceUnpaired(deviceId: string): void;
}

export interface EnvAgentDeps {
  /** The AuthDeck folder (config.ts authdeckHome); the registry lives in env/projects.json under it. */
  home: string;
  /** envSocketPath(home, …); tests pass a temp one. */
  socketPath: string;
  platform: NodeJS.Platform;
  agentVersion: string;
  log(line: string): void;
  onEvent?: EnvAgentEventListener;
  clock?: GrantClock;
  random?: RandomBytes;
  /** Defaults to ENV_REQUEST_TTL_MS. */
  requestTtlMs?: number;
  /** Defaults to GRANT_CHECK_MS; 0 turns the timer off (tests call checkGrants). */
  grantCheckMs?: number;
}

const systemClock: GrantClock = { now: Date.now, monotonic: () => performance.now() };
const nodeRandom: RandomBytes = (length) => new Uint8Array(crypto.randomBytes(length));

/** <AuthDeck folder>/env/projects.json */
export function registryPath(home: string): string {
  return path.join(home, 'env', 'projects.json');
}

export class EnvAgent implements EnvAgentControl, EnvLinkHandler {
  private readonly state: EnvState;
  private readonly commands: EnvCommands;
  private readonly methods: EnvDeviceMethods;
  private readonly socket: EnvSocketServer;
  private port: EnvLinkPort = { peers: () => [] };
  private timer: NodeJS.Timeout | null = null;
  private nextActivityId = 1;

  /** Throws RegistryUnreadable when the remembered heads can't be read: env sets then stay off. */
  constructor(private readonly deps: EnvAgentDeps) {
    const clock = deps.clock ?? systemClock;
    const random = deps.random ?? nodeRandom;
    const portRef: EnvLinkPort = { peers: () => this.port.peers() };
    this.state = {
      registry: ProjectRegistry.load(registryPath(deps.home)),
      grants: new GrantStore({ clock, random, onChange: (grants, ended) => this.grantsChanged(grants, ended) }),
      relay: new EnvRelay({ port: portRef, now: clock.now }),
      joins: new EnvJoins({ port: portRef, now: clock.now }),
      port: portRef,
      now: clock.now,
      random,
      requestTtlMs: deps.requestTtlMs ?? ENV_REQUEST_TTL_MS,
      declared: new Map(),
      activity: (entry) => this.activity(entry),
      setsChanged: (setId) => sendToWatching(this.port, 'env.sets.changed', { setId }),
      log: (line) => deps.log(line.replace(/[\p{Cc}\p{Cf}]/gu, ' ')),
    };
    this.commands = new EnvCommands(this.state);
    this.methods = new EnvDeviceMethods(this.state);
    this.socket = new EnvSocketServer({ socketPath: deps.socketPath, platform: deps.platform, agentVersion: deps.agentVersion, handle: this.commands.handle, log: this.state.log });
  }

  /** Starts the socket and the grant checks. */
  async start(): Promise<void> {
    await this.socket.listen();
    const every = this.deps.grantCheckMs ?? GRANT_CHECK_MS;
    if (every > 0) {
      this.timer = setInterval(() => this.checkGrants(), every);
      this.timer.unref();
    }
  }

  /** Ends every grant without a message (nothing outlives the process) and closes the socket. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.state.relay.cancelAll();
    await this.socket.close();
  }

  // EnvLinkHandler -----------------------------------------------------------

  bind(port: EnvLinkPort): void {
    this.port = port;
  }

  async handleLink(peer: EnvPeer, method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.methods.handle(peer, method, params);
  }

  peerGone(peer: EnvPeer): void {
    this.state.relay.peerGone(peer);
    if (!this.port.peers().some((other) => other !== peer && other.deviceId === peer.deviceId)) this.state.joins.deviceGone(peer.deviceId);
  }

  deviceUnpaired(deviceId: string): void {
    this.state.declared.delete(deviceId);
    this.state.grants.endFromDevice(deviceId);
  }

  // EnvAgentControl ----------------------------------------------------------

  grants(): EnvGrant[] {
    return this.state.grants.list();
  }

  endGrant(grantId: string): boolean {
    return this.state.grants.end(grantId, 'ended-on-computer');
  }

  endAllGrants(reason: EnvGrantEndReason): void {
    this.state.grants.endAll(reason);
  }

  /**
   * The periodic check: expiry, a clock jump (sleep when no desktop app said so), a granted set
   * file that changed on disk, and expired own-device joins.
   */
  checkGrants(): void {
    const { grants } = this.state;
    grants.tick();
    for (const granted of grants.grantedFiles()) grants.fileChanged(granted.path, this.hashOnDisk(granted.path));
    this.state.joins.expire();
  }

  private hashOnDisk(filePath: string): string | null {
    const known = this.state.registry.atPath(filePath);
    const location = known ? setFileLocation(known.repoRoot, known.path) : null;
    if (!location) return null;
    try {
      const text = readSetFile(location);
      return text === null ? null : envFileHash(text);
    } catch (err) {
      if (err instanceof WorkTreeError) return null;
      throw err;
    }
  }

  private grantsChanged(grants: EnvGrant[], ended?: { grantId: string; setId: string; reason: EnvGrantEndReason }): void {
    sendToWatching(this.port, 'env.grants.changed', ended ? { grants, ended } : { grants });
    this.deps.onEvent?.(ended ? { type: 'env.grants.changed', grants, ended } : { type: 'env.grants.changed', grants });
    if (ended) this.state.log(`env: a 15-minute grant ended (${ended.reason})`);
  }

  private activity(entry: Omit<EnvActivityEntry, 'id' | 'at'>): void {
    this.deps.onEvent?.({ type: 'env.activity', entry: { ...entry, id: this.nextActivityId++, at: this.state.now() } });
  }
}
