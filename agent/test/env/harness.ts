/**
 * Env tests: a real agent server and env agent on a free port and a temp socket and AuthDeck
 * folder, a git working tree with a set file, fake phones over the real link, and a raw socket
 * client standing in for the `authdeck` command. Never the real socket, ~/.authdeck or 47474.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { ActionRunner } from '../../src/actions/runner';
import { AppCatalog } from '../../src/apps/catalog';
import { EnvAgent } from '../../src/env/envAgent';
import type { GrantClock } from '../../src/env/grants';
import {
  createEnvSet,
  envFileHash,
  newEnvTransferKey,
  openEnvDataKey,
  openEnvSealedValues,
  openEnvValues,
  parseEnvFile,
  sealEnvValues,
  type CreatedEnvSet,
  type EnvPlainValue,
  type EnvSetFile,
} from '../../src/envcore';
import { ENV_SOCKET_VERSION, type EnvAgentEvent, type EnvSocketMethod } from '../../src/envSocketContract';
import type { AgentEvent } from '../../src/events';
import type { FocusTracker } from '../../src/focus';
import type { IconService } from '../../src/icons/service';
import type { EnvSealedValues } from '../../src/envcore/types';
import { ENV_FEATURE, PROTOCOL_VERSION, type EnvComputerRequest } from '../../src/protocol';
import { AgentServer } from '../../src/server';
import { fromBase64Url, toBase64Url } from '../../src/vault/bytes';
import { generateDeviceKeys, type DeviceKeys } from '../../src/vault/crypto';
import type { VaultStore } from '../../src/vaultStore';
import { newDeviceKey, pairByQr, type LinkedDevice } from '../helpers/link';
import { agentLinkKey, testConfig, testPairing } from '../helpers/server';

export const random = (length: number) => new Uint8Array(crypto.randomBytes(length));
export const T0 = 1_763_000_000_000;

export const VALUES: EnvPlainValue[] = [
  { name: 'DATABASE_URL', value: 'postgres://maya@db/acme' },
  { name: 'STRIPE_SECRET_KEY', value: 'sk_test_51Pq8eKz0' },
];

const temps: string[] = [];
/** Short, so the socket path stays under the platform's limit. */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-'));
  temps.push(dir);
  return fs.realpathSync(dir);
}
export function removeTemps(): void {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '2026-11-18T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-18T10:00:00Z' } });
}

/** A set made by `owner` (a phone's keys), as the phone would. */
export interface TestSet extends CreatedEnvSet {
  owner: DeviceKeys;
  setId: string;
  name: string;
}

export function makeSet(name = 'acme-api', values: EnvPlainValue[] = VALUES, owner = generateDeviceKeys(random)): TestSet {
  const created = createEnvSet({ name, owner, ownerLabel: 'Maya Rao · Pixel 8', ownerForm: 'phone', recovery: null, values, time: T0, random });
  return { ...created, owner, setId: created.file.header.set, name };
}

/** A git working tree with the set file committed. */
export interface Repo {
  root: string;
  setPath: string;
  relPath: string;
}

export function makeRepo(set: TestSet, commit = true): Repo {
  const root = path.join(tempDir(), 'acme');
  fs.mkdirSync(path.join(root, '.authdeck'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'maya@example.com');
  git(root, 'config', 'user.name', 'Maya');
  git(root, 'config', 'commit.gpgsign', 'false');
  const relPath = `.authdeck/${set.name}.env`;
  const setPath = path.join(root, '.authdeck', `${set.name}.env`);
  fs.writeFileSync(setPath, set.text);
  if (commit) {
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', `Add ${set.name}`);
  }
  return { root, setPath, relPath };
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

export interface TestClock extends GrantClock {
  wall: number;
  mono: number;
  /** Both clocks move: time passing while awake. */
  advance(ms: number): void;
}

export function testClock(): TestClock {
  const clock = {
    wall: T0,
    mono: 0,
    now: () => clock.wall,
    monotonic: () => clock.mono,
    advance: (ms: number) => {
      clock.wall += ms;
      clock.mono += ms;
    },
  };
  return clock;
}

export interface TestAgent {
  server: AgentServer;
  env: EnvAgent;
  port: number;
  home: string;
  socketPath: string;
  clock: TestClock;
  events: AgentEvent[];
  envEvents: EnvAgentEvent[];
  logLines: string[];
  /** Pairs (once per id) and connects a phone; with `members`, it calls env.watch. */
  phone(deviceId: string, members?: string[]): Promise<LinkedDevice>;
  unpair(deviceId: string): void;
  stop(): Promise<void>;
}

export async function startEnvAgent(options: { requestTtlMs?: number; withEnv?: boolean; home?: string } = {}): Promise<TestAgent> {
  const clock = testClock();
  const events: AgentEvent[] = [];
  const envEvents: EnvAgentEvent[] = [];
  const logLines: string[] = [];
  const home = options.home ?? tempDir();
  const socketPath = path.join(home, 'agent.sock');
  const env = new EnvAgent({
    home,
    socketPath,
    platform: process.platform,
    agentVersion: '0.4.0-test',
    log: (line) => logLines.push(line),
    onEvent: (event) => envEvents.push(event),
    clock,
    random,
    requestTtlMs: options.requestTtlMs ?? 5_000,
    grantCheckMs: 0,
  });
  const withEnv = options.withEnv ?? true;
  if (withEnv) await env.start();
  const catalog = new AppCatalog(async () => []);
  await catalog.rescan();
  const linkKey = agentLinkKey();
  const store = testPairing(testConfig());
  const server: AgentServer = new AgentServer({
    agentInfo: { agentId: 'agent', name: 'Mac', platform: 'macos', version: '0.4.0', protocol: PROTOCOL_VERSION, ...(withEnv ? { features: [ENV_FEATURE] } : {}) },
    port: 0,
    home: '/Users/maya',
    platform: 'macos',
    pairing: store.pairing,
    linkKey,
    catalog,
    icons: {} as IconService,
    runner: { run: async () => ({ durationMs: 1 }) } as unknown as ActionRunner,
    focus: { clientConnected() {}, clientDisconnected() {}, current: async () => ({ supported: false, appId: null, name: '' }) } as unknown as FocusTracker,
    vaults: {} as VaultStore,
    unpairDevice: () => null,
    log: (line) => logLines.push(line),
    emit: (event) => events.push(event),
    now: () => clock.wall,
    env: withEnv ? env : undefined,
  });
  const port = await server.listen();
  const keys = new Map<string, ReturnType<typeof newDeviceKey>>();
  const keyFor = (id: string) => keys.get(id) ?? keys.set(id, newDeviceKey()).get(id)!;
  return {
    server,
    env,
    port,
    home,
    socketPath,
    clock,
    events,
    envEvents,
    logLines,
    phone: async (deviceId, members) => {
      const device = await pairByQr(port, linkKey.public, store.config().pairSecret, keyFor(deviceId), { deviceId, deviceName: deviceId });
      if (members) {
        const watched = await device.request('env.watch', { members });
        if (!watched.ok) throw new Error(`env.watch failed: ${JSON.stringify(watched.error)}`);
      }
      return device;
    },
    unpair: (deviceId) => {
      server.disconnectDevice(deviceId);
      store.pairing.revoke(deviceId);
      server.dropUnpaired();
      // What agent.ts does after a revoke.
      events.push({ type: 'device.revoked', deviceId });
      env.deviceUnpaired(deviceId);
    },
    stop: async () => {
      await env.stop();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// The command's side of the socket
// ---------------------------------------------------------------------------

export interface SocketCall {
  lines: any[];
  /** The reply line (the last), once the agent closes. */
  reply: Promise<any>;
  /** Resolves once a progress line naming at least `count` devices arrived. */
  progress(count?: number): Promise<any>;
  /** Ctrl-C: closes the connection. */
  close(): void;
}

export function callSocket(socketPath: string, method: EnvSocketMethod | string, params: unknown, extra: Record<string, unknown> = {}): SocketCall {
  const socket = net.createConnection(socketPath);
  const lines: any[] = [];
  let buffered = '';
  const id = crypto.randomUUID();
  socket.on('connect', () => socket.write(`${JSON.stringify({ v: ENV_SOCKET_VERSION, id, method, params, ...extra })}\n`));
  socket.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      lines.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
  const reply = new Promise<any>((resolve, reject) => {
    socket.on('close', () => resolve(lines[lines.length - 1] ?? null));
    socket.on('error', reject);
  });
  return {
    lines,
    reply,
    progress: async (count = 0) => {
      for (let tries = 0; tries < 250; tries++) {
        const found = lines.find((line) => line.progress && line.progress.devices.length >= count);
        if (found) return found;
        await sleep(20);
      }
      throw new Error(`no progress line with ${count} devices: ${JSON.stringify(lines)}`);
    },
    close: () => socket.destroy(),
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the nth (0-based) event of a name on a phone. */
export async function nthEvent(device: LinkedDevice, name: string, n = 0): Promise<any> {
  for (let tries = 0; tries < 250; tries++) {
    const found = device.events.filter((e) => e.event === name);
    if (found.length > n) return found[n]!.data;
    await sleep(20);
  }
  throw new Error(`No ${name} event #${n}; got ${device.events.map((e) => e.event).join(', ')}`);
}

/** What `authdeck env run` sends. */
export function releaseParams(repo: Repo, text: string, oneTimeKey: Uint8Array, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'run',
    project: { repoRoot: repo.root, remote: 'https://maya:ghp_secret@github.com/acme/api.git', path: repo.setPath },
    file: text,
    command: ['npm', 'run', 'dev'],
    cwd: repo.root,
    startedIn: 'Terminal · zsh',
    target: null,
    oneTimeKey: toBase64Url(oneTimeKey),
    invocation: 'authdeck env run -- npm run dev',
    ...overrides,
  };
}

/** A one-time key, as the command makes. */
export const oneTimeKey = () => newEnvTransferKey(random);

/** The phone's side of Allow: its values, sealed to the request's key. */
export function phoneRelease(set: TestSet, request: EnvComputerRequest & { oneTimeKey: string; grantKey: string }, scope: 'once' | 'grant', file: EnvSetFile = set.file): { kind: 'release'; scope: 'once' | 'grant'; values: EnvSealedValues; source: { rev: number; fileHash: string } } {
  const dataKey = openEnvDataKey(file.header, set.owner);
  const values = openEnvValues(file, dataKey);
  const recipient = fromBase64Url(scope === 'once' ? request.oneTimeKey : request.grantKey);
  return { kind: 'release', scope, values: sealEnvValues(values, { set: set.setId, request: request.requestId }, recipient, random), source: { rev: file.header.rev, fileHash: envFileHash(set.text) } };
}

export function openReleased(result: { values: EnvSealedValues; requestId: string }, setId: string, key: ReturnType<typeof oneTimeKey>): EnvPlainValue[] {
  return openEnvSealedValues(result.values, { set: setId, request: result.requestId }, key);
}

export function parsed(text: string): EnvSetFile {
  const result = parseEnvFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.problem));
  return result.parsed.file;
}
