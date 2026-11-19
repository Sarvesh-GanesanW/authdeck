/// <reference types="node" />
/**
 * Test doubles for the env engine: an agent session that keeps set files in memory and answers
 * env.* as AuthDeck Agent does, an in-memory store, and the vault's lock. Import '../native'
 * before this file.
 */
import { addEnvMember, createEnvSet, envFileHash, verifyEnvFile, writeEnvFile, type EnvJoinRequestFile, type EnvSetFile } from '../../src/envcore';
import type { EnvAnswer, EnvComputerRequest, EnvEventMessage, EnvGrant, EnvJoinRequestEntry, EnvMethod, EnvMethods } from '../../src/protocol';
import { RequestError } from '../../src/net/client';
import { generateDeviceKeys, type DeviceKeys } from '../../src/vault/crypto';
import type { RandomBytes } from '../../src/vault/bytes';
import { EnvEngine } from '../../src/auth/env/engine';
import type { EnvComputer, EnvHost, EnvPrefs, EnvRecoveryPublic, EnvStore, StoredEnvSet } from '../../src/auth/env/host';
import { seededRandom } from '../helpers';

export const AGENT_ID = 'agent-1';
export const COMPUTER: EnvComputer = { agentId: AGENT_ID, name: 'MacBook Pro', hasEnv: true };
export const OLD_COMPUTER: EnvComputer = { agentId: AGENT_ID, name: 'MacBook Pro', hasEnv: false };
export const REPO = '/Users/maya/acme-api';

interface FakeSet {
  setId: string;
  name: string;
  path: string;
  text: string;
  requests: EnvJoinRequestEntry[];
  /** Every version written, oldest first. */
  history: string[];
}

/** AuthDeck Agent, as far as the phone can tell: set files on disk, requests, grants. */
export class FakeAgent {
  readonly sets = new Map<string, FakeSet>();
  /** When set, env.history.read fails with this sentence, as the agent does for a shallow or partial clone. */
  historyRefusal: string | null = null;
  readonly calls: { method: EnvMethod; params: unknown }[] = [];
  readonly answers = new Map<string, EnvAnswer>();
  pending: EnvComputerRequest[] = [];
  grants: EnvGrant[] = [];
  /** Runs before a write is checked: a test can change the file there and make the write a conflict. */
  beforeWrite: ((set: FakeSet) => void) | null = null;
  private seq = 0;

  pathFor(name: string): string {
    return `${REPO}/.authdeck/${name}.env`;
  }

  put(setId: string, name: string, text: string): FakeSet {
    const existing = this.sets.get(setId);
    const set: FakeSet = existing ?? { setId, name, path: this.pathFor(name), text, requests: [], history: [] };
    set.text = text;
    set.history.push(text);
    this.sets.set(setId, set);
    return set;
  }

  request<M extends EnvMethod>(method: M, params: EnvMethods[M]['params']): Promise<EnvMethods[M]['result']> {
    this.calls.push({ method, params });
    try {
      return Promise.resolve(this.answer(method, params as never) as EnvMethods[M]['result']);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  methods(): EnvMethod[] {
    return this.calls.map((c) => c.method);
  }

  private find(setId: string): FakeSet {
    const set = this.sets.get(setId);
    if (!set) throw new RequestError('not_found', 'No such set.', undefined, true);
    return set;
  }

  private answer(method: EnvMethod, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'env.watch':
        return { requests: this.pending, grants: this.grants };
      case 'env.sets.list':
        return { sets: [...this.sets.values()].map((s) => this.summary(s)) };
      case 'env.file.read': {
        const set = this.find(params.setId as string);
        return { file: set.text, fileHash: envFileHash(set.text), commits: set.text.split('\n').map(() => null), requests: set.requests };
      }
      case 'env.file.write': {
        const set = this.find(params.setId as string);
        this.beforeWrite?.(set);
        if (envFileHash(set.text) !== params.baseHash) throw new RequestError('conflict', 'The file changed.', undefined, true);
        const remove = (params.removeRequests as string[] | undefined) ?? [];
        set.requests = set.requests.filter((r) => !remove.includes(r.path));
        if (typeof params.file === 'string') this.put(set.setId, set.name, params.file);
        return { fileHash: envFileHash(set.text) };
      }
      case 'env.history.read': {
        const set = this.find(params.setId as string);
        if (this.historyRefusal) throw new RequestError('failed', this.historyRefusal, undefined, true);
        const commits = set.history.map((file, i) => ({ commit: `c${String(i).padStart(39, '0')}`, time: 1000 + i, author: 'Maya', subject: `change ${i}`, file })).reverse();
        const start = params.before ? commits.findIndex((c) => c.commit === params.before) + 1 : 0;
        const page = commits.slice(start, start + 2);
        return { commits: page, more: start + 2 < commits.length };
      }
      case 'env.request.answer': {
        const id = params.requestId as string;
        if (!this.pending.some((r) => r.requestId === id)) throw new RequestError('not_found', 'That request ended.', undefined, true);
        this.answers.set(id, params.answer as EnvAnswer);
        this.pending = this.pending.filter((r) => r.requestId !== id);
        return {};
      }
      case 'env.join.request':
        return { requestId: `join-${++this.seq}`, expiresAt: Date.now() + 300_000 };
      default:
        return {};
    }
  }

  private summary(set: FakeSet) {
    const verified = verifyEnvFile(set.text, null);
    const file = verified.ok ? verified.set.file : null;
    return {
      setId: set.setId,
      name: set.name,
      path: set.path,
      repoRoot: REPO,
      remote: 'github.com/acme/api',
      fileHash: envFileHash(set.text),
      rev: file?.header.rev ?? 0,
      epoch: file?.header.epoch ?? 0,
      variables: file ? file.values.filter((v) => v.box !== null).length : 0,
      members: file?.header.members.length ?? 0,
      joinRequests: set.requests.length,
      headCommit: null,
      uncommitted: false,
      problem: verified.ok ? null : { problem: verified.problem, commit: null },
      lastReleaseAt: null,
    };
  }

  addJoinRequest(setId: string, request: EnvJoinRequestFile, text: string): void {
    this.find(setId).requests.push({ path: `.authdeck/requests/${request.member}.json`, text, commit: 'abc1234' });
  }
}

export class MemoryStore implements EnvStore {
  prefs: EnvPrefs = { memberId: null, ownRequests: [], personName: null };
  readonly sets = new Map<string, StoredEnvSet>();
  identity: DeviceKeys | null = null;
  readonly keys = new Map<string, Record<number, Uint8Array>>();

  async loadPrefs() {
    return this.prefs;
  }
  async savePrefs(prefs: EnvPrefs) {
    this.prefs = prefs;
  }
  async loadSets() {
    return { sets: [...this.sets.values()], damaged: [] };
  }
  async saveSet(set: StoredEnvSet) {
    this.sets.set(set.setId, structuredClone(set));
  }
  async deleteSet(setId: string) {
    this.sets.delete(setId);
    this.keys.delete(setId);
  }
  async loadIdentity() {
    return this.identity;
  }
  async saveIdentity(keys: DeviceKeys) {
    this.identity = keys;
  }
  async loadDataKeys(setId: string) {
    const keys = this.keys.get(setId) ?? {};
    return Object.fromEntries(Object.entries(keys).map(([e, k]) => [e, new Uint8Array(k)]));
  }
  async saveDataKeys(setId: string, keys: Record<number, Uint8Array>) {
    this.keys.set(setId, Object.fromEntries(Object.entries(keys).map(([e, k]) => [e, new Uint8Array(k)])));
  }
}

/** Vault id -> the devices of that vault (see FakeVault.isVaultDevice). */
const vaultDevices = new Map<string, Set<string>>();

/** Records `deviceId` as a device of vault `vaultId`, as that vault's log would. */
export function addVaultDevice(vaultId: string, deviceId: string): void {
  vaultDevices.set(vaultId, (vaultDevices.get(vaultId) ?? new Set<string>()).add(deviceId));
}

export class FakeVault {
  state: 'loading' | 'none' | 'locked' | 'open' = 'locked';
  confirms: string[] = [];
  /** When set, the device's own unlock is cancelled with this sentence. */
  cancel: string | null = null;
  constructor(readonly keys: DeviceKeys) {
    addVaultDevice(this.vault!, keys.deviceId);
  }
  status() {
    return this.state;
  }
  async deviceKeys() {
    return this.keys;
  }
  /** The vault's recovery identity, as the vault's phrase gives it; null until a phrase is set. */
  recoveryKeys: EnvRecoveryPublic | null = null;
  async recovery() {
    return this.recoveryKeys;
  }
  /** This phone's vault id; restoring the owner's vault gives the same one. */
  vault: string | null = 'AAAAAAAAAAAAAAAAAAAAAA';
  async vaultId() {
    return this.vault;
  }
  /**
   * Ever a device of this vault. Rigs that share a vault id share a vault, as a phone restored with
   * the phrase replays the lost phone's log: every rig's device is recorded under its vault id.
   */
  async isVaultDevice(deviceId: string) {
    return this.vault !== null && (vaultDevices.get(this.vault)?.has(deviceId) ?? false);
  }
  async confirm(reason: string) {
    this.confirms.push(reason);
    if (this.cancel) throw new Error(this.cancel);
    this.state = 'open';
  }
}

const engines: EnvEngine[] = [];

/** Stops every engine made since the last call (their timers would keep the test process alive). */
export function disposeAll(): void {
  engines.splice(0).forEach((engine) => engine.dispose());
}

export interface Rig {
  engine: EnvEngine;
  agent: FakeAgent;
  store: MemoryStore;
  vault: FakeVault;
  device: DeviceKeys;
  random: RandomBytes;
  clock: { now: number };
}

/** An engine on a phone with a vault, its computer online with env sets unless `computer` says otherwise. */
export async function rig(options: { historyBudgetBytes?: number; personName?: string | null; seed?: string; computer?: EnvComputer | null; open?: boolean; store?: MemoryStore; device?: DeviceKeys } = {}): Promise<Rig> {
  const random = seededRandom(options.seed ?? 'env');
  const device = options.device ?? generateDeviceKeys(random);
  const agent = new FakeAgent();
  const store = options.store ?? new MemoryStore();
  const vault = new FakeVault(device);
  const clock = { now: Date.now() };
  const host: EnvHost = {
    now: () => clock.now,
    random,
    link: { request: (method, params) => agent.request(method, params) },
    store,
    vault,
    device: { label: 'Pixel 8', form: 'phone' },
  };
  if (options.personName !== null && !options.store) store.prefs = { ...store.prefs, personName: options.personName ?? 'Maya Rao' };
  const engine = new EnvEngine(host, options.historyBudgetBytes);
  engines.push(engine);
  await engine.load();
  if (options.open !== false) {
    vault.state = 'open';
    await engine.vaultChanged();
  }
  if (options.computer !== null) await engine.computerChanged(options.computer ?? COMPUTER);
  return { engine, agent, store, vault, device, random, clock };
}

const base = (agent: FakeAgent, id: string) => ({
  requestId: id,
  repoRoot: REPO,
  remote: 'github.com/acme/api',
  askedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  path: agent.pathFor('acme-api'),
});

export function createRequest(agent: FakeAgent, id: string, values: { name: string; value: string }[]): EnvComputerRequest {
  return { ...base(agent, id), kind: 'create', setId: null, setName: 'acme-api', invocation: 'authdeck env init --from .env', source: '.env', values };
}

export function releaseRequest(
  agent: FakeAgent,
  id: string,
  setId: string,
  keys: { oneTime: Uint8Array; grant: Uint8Array },
  file?: string,
): EnvComputerRequest {
  const set = agent.sets.get(setId)!;
  const text = file ?? set.text;
  return {
    ...base(agent, id),
    kind: 'run',
    setId,
    setName: set.name,
    invocation: 'authdeck env run -- npm run dev',
    file: text,
    fileHash: envFileHash(text),
    command: ['npm', 'run', 'dev'],
    cwd: REPO,
    startedIn: 'Terminal · zsh',
    target: null,
    oneTimeKey: Buffer.from(keys.oneTime).toString('base64url'),
    grantKey: Buffer.from(keys.grant).toString('base64url'),
  };
}

export function pushRequest(agent: FakeAgent, id: string, setId: string, values: { name: string; value: string }[], prune: boolean): EnvComputerRequest {
  const set = agent.sets.get(setId)!;
  return {
    ...base(agent, id),
    kind: 'push',
    setId,
    setName: set.name,
    invocation: 'authdeck env push .env.local',
    file: set.text,
    fileHash: envFileHash(set.text),
    source: '.env.local',
    values,
    prune,
  };
}

export function joinKeysRequest(agent: FakeAgent, id: string, setId: string): EnvComputerRequest {
  const set = agent.sets.get(setId)!;
  return { ...base(agent, id), kind: 'join-keys', setId, setName: set.name, invocation: 'authdeck env init', file: set.text, fileHash: envFileHash(set.text) };
}

/** The agent sends a request to the phone, as env.request. */
export function ask(r: Rig, request: EnvComputerRequest): void {
  r.agent.pending.push(request);
  const message: EnvEventMessage<'env.request'> = { event: 'env.request', data: { request } };
  r.engine.handleEvent(message);
}

/**
 * This device joins a teammate's set the way a phone does: the computer has the file, the person
 * runs `authdeck env init` (join-keys, approved), compares the owner's words, and the owner's file
 * lists the device. A
 * file that lists the device with no such request is never taken (ENV-02b).
 */
export async function joinedThrough(r: Rig, setId: string, text: string, name = 'acme-api'): Promise<void> {
  r.agent.put(setId, name, text);
  await r.engine.computerChanged(COMPUTER);
  ask(r, joinKeysRequest(r.agent, `jk-${setId}`, setId));
  await r.engine.answer(`jk-${setId}`, 'approve');
  // The owner read out their six words and they matched.
  const shown = r.engine.snapshot().ownRequests.find((o) => o.setId === setId)?.ownerKeyWords ?? [];
  await r.engine.confirmOwnerWords(setId, shown);
}

/** Waits for the engine's background work (plans, syncs) to settle. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** Makes a set through the phone (create, approved) and returns its id. */
export async function createdSet(r: Rig, values = [{ name: 'API_KEY', value: 'sk_live_1' }, { name: 'DB_URL', value: 'postgres://db' }]): Promise<string> {
  ask(r, createRequest(r.agent, 'create-1', values));
  await r.engine.answer('create-1', 'approve');
  const created = r.agent.answers.get('create-1');
  if (created?.kind !== 'created') throw new Error('not created');
  const verified = verifyEnvFile(created.file, null);
  if (!verified.ok) throw new Error('created file refused');
  r.agent.put(verified.set.file.header.set, 'acme-api', created.file);
  return verified.set.file.header.set;
}

/** A set made by another device (`owner`), with `members` added: what a teammate's repo holds. */
export function externalSet(
  owner: DeviceKeys,
  random: RandomBytes,
  /** `setId`: the file claims another set's id (a forgery; see the end). */
  options: { setId?: string; members?: DeviceKeys[]; values?: { name: string; value: string }[]; recovery?: DeviceKeys | null; name?: string } = {},
): { setId: string; file: EnvSetFile; text: string; dataKey: Uint8Array } {
  const created = createEnvSet({
    name: options.name ?? 'acme-api',
    owner,
    ownerLabel: 'Ben Okafor · Pixel 9',
    ownerForm: 'phone',
    recovery: options.recovery ?? null,
    values: options.values ?? [{ name: 'API_KEY', value: 'sk_live_1' }],
    time: 1_000,
    random,
  });
  let file = created.file;
  for (const [i, member] of (options.members ?? []).entries()) {
    file = addEnvMember({
      file,
      owner,
      dataKeys: { [file.header.epoch]: created.dataKey },
      time: 2_000 + i,
      member: { edPublic: member.edPublic, xPublic: member.xPublic, label: `Member ${i} · Phone`, form: 'phone' },
    });
  }
  const text = writeEnvFile(file);
  if (!options.setId) return { setId: file.header.set, file, text, dataKey: created.dataKey };
  // A set someone made under another set's id: the id is the hash of the birth line, so this file
  // fails its own checks (header-unsigned) wherever it is read.
  const own = file.header.set;
  return { setId: options.setId, file: { ...file, header: { ...file.header, set: options.setId } }, text: text.split(own).join(options.setId), dataKey: created.dataKey };
}
