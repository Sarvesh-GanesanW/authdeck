// Runs the real app engine in Node against a computer backed by the real agent VaultStore in a
// temp folder (from the review-7 PoC harness). Native packages resolve to test stubs. Hooks let a
// scenario play a hostile computer: refuse or drop an append. One engine per process, so each
// scenario runs in its own process (engineScenarios.test.ts).
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = path.dirname(TEST);
const AGENT = path.join(path.dirname(APP), 'agent');
const NATIVE = new Set(['expo', 'react-native', '@react-native-async-storage/async-storage', 'expo-crypto', 'expo-network', 'expo-device', 'expo-haptics', 'expo-clipboard', 'expo-linking', 'expo-camera', 'expo-audio', 'expo-keep-awake', 'expo-screen-capture', 'expo-splash-screen', 'expo-status-bar', 'expo-system-ui', 'expo-sharing', 'expo-document-picker', 'expo-blur', 'expo-font']);
const stub = (name: string) => pathToFileURL(path.join(TEST, 'stubs', name)).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'expo-file-system') return { url: stub('fileSystem.cjs'), format: 'commonjs', shortCircuit: true };
    if (specifier === 'expo-secure-store') return { url: stub('securestore.cjs'), format: 'commonjs', shortCircuit: true };
    if (specifier === 'expo-local-authentication') return { url: stub('localauth.cjs'), format: 'commonjs', shortCircuit: true };
    if (NATIVE.has(specifier)) return { url: stub('native.cjs'), format: 'commonjs', shortCircuit: true };
    return next(specifier, context);
  },
});

const imp = (p: string) => import(pathToFileURL(p).href);
export const engineMod = await imp(path.join(APP, 'src/auth/engine/engine.ts'));
const { connection } = await imp(path.join(APP, 'src/net/connection.ts'));
const { RequestError } = await imp(path.join(APP, 'src/net/client.ts'));
const { useLive } = await imp(path.join(APP, 'src/state/live.ts'));
const { useEngineVault } = await imp(path.join(APP, 'src/auth/engine/store.ts'));
const { VaultStore } = await imp(path.join(AGENT, 'src/vaultStore.ts'));
const { AgentError } = await imp(path.join(AGENT, 'src/errors.ts'));
export const core = {
  recovery: await imp(path.join(APP, 'src/vault/recovery.ts')),
  replay: await imp(path.join(APP, 'src/vault/replay.ts')),
  entry: await imp(path.join(APP, 'src/vault/entry.ts')),
  open: await imp(path.join(APP, 'src/vault/open.ts')),
  build: await imp(path.join(APP, 'src/vault/build.ts')),
};
/** The agent's vault test helpers (MemoryVault, soloRestoreLines). */
export const helpers = await imp(path.join(AGENT, 'test/helpers/vault.ts'));
export const actions = engineMod.engineActions;
/** The secure-store stub's backing map, to start a second install (a new phone) over empty storage. */
export const secureStub = (await imp(path.join(TEST, 'stubs/securestore.cjs'))).default ?? (await imp(path.join(TEST, 'stubs/securestore.cjs')));
/** A second launch of the real engine, as another phone (its own module instance). */
export const engineAs = (tag: string) => import(`${pathToFileURL(path.join(APP, 'src/auth/engine/engine.ts')).href}?phone=${tag}`);
export const AGENT_ID = 'test-agent-1';

export interface Hooks {
  /** Before each vault.append reaches the store: 'refuse' answers bad_request without storing, 'drop' stores nothing and answers ok. */
  beforeAppend?: (entries: any[]) => 'pass' | 'refuse' | 'drop';
  /** Seal proofs served on vault.forks.read besides the stored ones. */
  extraSealProofs?: any[];
}

export function bootComputer(tag: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `authdeck-engine-${tag}-`));
  const store = new VaultStore({ personal: path.join(home, 'vault'), team: () => null });
  const hooks: Hooks = {};
  const retires: any[] = [];
  const forkWrites: any[] = [];
  const call = (method: string, params: any): any => {
    switch (method) {
      case 'vault.list':
        return { vaults: store.list(), teamFolder: null };
      case 'vault.read':
        return store.read(params.vaultId, params.since);
      case 'vault.append': {
        const verdict = hooks.beforeAppend?.(params.entries) ?? 'pass';
        if (verdict === 'refuse') throw new RequestError('bad_request', 'The computer refused these entries.', undefined, true);
        if (verdict === 'drop') return { lengths: {} };
        const out = store.append(params.vaultId, params.entries, params.repair === true, params.proof);
        return { lengths: out.lengths };
      }
      case 'vault.beacons.read':
        return store.readBeacons(params.vaultId);
      case 'vault.beacons.write':
        return store.writeBeacon(params.vaultId, params.beacon);
      case 'vault.forks.read': {
        const read = store.readForks(params.vaultId);
        return { ...read, sealProofs: [...(read.sealProofs ?? []), ...(hooks.extraSealProofs ?? [])] };
      }
      case 'vault.forks.write':
        forkWrites.push(params);
        return params.sealProof !== undefined ? store.writeSealProof(params.vaultId, params.sealProof) : store.writeFork(params.vaultId, params.proof);
      case 'vault.retire': {
        retires.push(params);
        const out = store.retire(params.vaultId, params.request, AGENT_ID, 'Test phone');
        return { keptUntil: out.keptUntil };
      }
      default:
        throw new RequestError('bad_request', `unknown ${method}`, undefined, true);
    }
  };
  connection.request = async (method: string, params: any) => {
    try {
      return JSON.parse(JSON.stringify(call(method, params)));
    } catch (err: any) {
      if (err instanceof RequestError) throw err;
      if (err instanceof AgentError) throw new RequestError(err.code, err.message, err.hint, true);
      throw err;
    }
  };
  connection.onEvent = () => () => {};
  useLive.setState({ status: 'online', agent: { name: 'Laptop', agentId: AGENT_ID }, showToast: (t: any) => toasts.push(t.title) });
  const toasts: string[] = [];
  const logsOf = (vaultId: string): Record<string, string[]> =>
    Object.fromEntries(Object.entries(store.read(vaultId, {}).logs).map(([id, page]: [string, any]) => [id, page.lines]));
  const stateOf = (vaultId: string) => core.replay.replayVault(vaultId, logsOf(vaultId), { forks: store.readForks(vaultId).forks });
  // A hostile computer writing the folder directly (personal vaults live at <home>/vault/<vaultId>).
  const vaultDir = (vaultId: string) => path.join(home, 'vault', vaultId);
  const writeLog = (vaultId: string, deviceId: string, lines: string[]) => {
    fs.mkdirSync(path.join(vaultDir(vaultId), 'log'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir(vaultId), 'log', `${deviceId}.jsonl`), lines.map((l) => `${l}\n`).join(''));
  };
  const writeForkFile = (vaultId: string, proof: any) => {
    fs.mkdirSync(path.join(vaultDir(vaultId), 'forks'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir(vaultId), 'forks', `${proof.deviceId}.json`), `${JSON.stringify(proof)}\n`);
  };
  return { home, store, hooks, retires, forkWrites, toasts, logsOf, stateOf, writeLog, writeForkFile, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Toggles the link offline and online, which makes the engine sync. */
export async function syncNow(ms = 600) {
  useLive.setState({ status: 'offline' });
  await sleep(10);
  useLive.setState({ status: 'online' });
  await sleep(ms);
}

export function view() {
  return useEngineVault.getState();
}

export const recoveryIdOf = (words: string[], vaultId: string): string => core.recovery.recoveryKeysFromPhrase(words.join(' '), vaultId).deviceId;
export const message = (p: Promise<unknown>) => p.then((v) => v ?? 'ok', (e: Error) => `error: ${e.message}`);
