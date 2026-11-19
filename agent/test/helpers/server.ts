import crypto from 'node:crypto';
import type { ActionRunner } from '../../src/actions/runner';
import { AppCatalog } from '../../src/apps/catalog';
import type { AgentConfig } from '../../src/config';
import type { AgentEvent } from '../../src/events';
import type { FocusTracker } from '../../src/focus';
import type { IconService } from '../../src/icons/service';
import { generateLinkKey, type LinkKeyPair } from '../../src/link/keys';
import { Pairing } from '../../src/pairing';
import { PROTOCOL_VERSION, type RunParams } from '../../src/protocol';
import { AgentServer, type ServerDeps } from '../../src/server';
import { toBase64Url } from '../../src/vault/bytes';
import type { VaultAuthors } from '../../src/vaultAuthors';
import type { VaultStore } from '../../src/vaultStore';
import { LinkedDevice, newDeviceKey, pairByQr, random } from './link';

export const TEST_PIN = '123456';

/** Old name kept for the tests that import it: a paired device with an open channel. */
export type TestClient = LinkedDevice;

const newSecret = () => toBase64Url(crypto.randomBytes(16));

/** A config as the agent writes it on first run, with pairing open for as long as a test runs. */
export function testConfig(name = 'Mac'): AgentConfig {
  return { agentId: 'agent', name, port: 0, pin: TEST_PIN, pairSecret: newSecret(), pairingOpenUntil: Number.MAX_SAFE_INTEGER, devices: [], terminal: 'Terminal' };
}

/** Pairing over an in-memory config, with every PIN and QR change recorded. */
/**
 * An in-memory Pairing. A pairing closes the window; with `stayOpen` (the default) it opens again
 * at once, as if someone opened pairing for each device, so tests can pair several.
 */
export function testPairing(initial: AgentConfig, now?: () => number, { stayOpen = true }: { stayOpen?: boolean } = {}) {
  let config = structuredClone(initial);
  let pins = 0;
  const pairing = new Pairing({
    load: () => structuredClone(config),
    update: (change) => {
      const updated = structuredClone(config);
      change(updated);
      const paired = updated.pairingOpenUntil === 0 && config.pairingOpenUntil !== 0 && JSON.stringify(updated.devices) !== JSON.stringify(config.devices);
      if (stayOpen && paired) updated.pairingOpenUntil = initial.pairingOpenUntil;
      config = structuredClone(updated);
      return updated;
    },
    newPin: () => String(100000 + ++pins),
    newPairSecret: newSecret,
    now,
  });
  return { pairing, config: () => config, setConfig: (next: AgentConfig) => (config = structuredClone(next)) };
}

export const agentLinkKey = (): LinkKeyPair => generateLinkKey(random);

export interface TestServer {
  server: AgentServer;
  port: number;
  linkKey: LinkKeyPair;
  config: () => AgentConfig;
  events: AgentEvent[];
  logLines: string[];
  /** Pairs the device with this id by QR code (the same key each time for one id); its channel stays open. */
  connect: (deviceId: string) => Promise<TestClient>;
  advance: (ms: number) => void;
}

/**
 * An agent server on a free port with a fake clock; `runner` and `vaults` default to stubs. With
 * `vaultAuthors`, a removal through it unpairs devices the way agent.ts wires it.
 */
export async function startTestServer(deps: { runner?: ActionRunner; vaults?: VaultStore; vaultAuthors?: VaultAuthors; onVaultRetired?: ServerDeps['onVaultRetired'] }): Promise<TestServer> {
  let now = 1_000_000;
  const events: AgentEvent[] = [];
  const logLines: string[] = [];
  const catalog = new AppCatalog(async () => []);
  await catalog.rescan();
  const linkKey = agentLinkKey();
  const store = testPairing(testConfig());
  const server = new AgentServer({
    agentInfo: { agentId: 'agent', name: 'Mac', platform: 'macos', version: '0.0.0', protocol: PROTOCOL_VERSION },
    port: 0,
    home: '/Users/ada',
    platform: 'macos',
    pairing: store.pairing,
    linkKey,
    catalog,
    icons: {} as IconService,
    runner: deps.runner ?? ({ run: async (_params: RunParams) => ({ durationMs: 1 }) } as unknown as ActionRunner),
    focus: { clientConnected() {}, clientDisconnected() {}, current: async () => ({ supported: false, appId: null, name: '' }) } as unknown as FocusTracker,
    vaults: deps.vaults ?? ({} as VaultStore),
    vaultAuthors: deps.vaultAuthors,
    unpairDevice: (deviceId) => {
      const deviceName = store.config().devices.find((d) => d.deviceId === deviceId)?.deviceName ?? 'A device';
      server.disconnectDevice(deviceId);
      return store.pairing.revoke(deviceId) ? { deviceName } : null;
    },
    onVaultRetired: deps.onVaultRetired,
    log: (line) => logLines.push(line),
    emit: (event) => events.push(event),
    now: () => now,
  });
  const port = await server.listen();
  // One key per device id: pairing an id again with a new key would unpair its open connections.
  const deviceKeys = new Map<string, LinkKeyPair>();
  const keyFor = (deviceId: string) => deviceKeys.get(deviceId) ?? deviceKeys.set(deviceId, newDeviceKey()).get(deviceId)!;
  const connect = (deviceId: string) => pairByQr(port, linkKey.public, store.config().pairSecret, keyFor(deviceId), { deviceId, deviceName: deviceId });
  return { server, port, linkKey, config: store.config, events, logLines, connect, advance: (ms) => (now += ms) };
}
