import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import packageJson from '../package.json';
import { runBackgroundCommand } from './actions/background';
import type { BuildContext, PlatformActions } from './actions/context';
import { linuxActions } from './actions/linux';
import { macActions } from './actions/mac';
import { ActionRunner } from './actions/runner';
import { windowsActions } from './actions/windows';
import { AppCatalog, type AppScanner } from './apps/catalog';
import { scanLinuxApps } from './apps/linux';
import { scanMacApps } from './apps/mac';
import { scanWindowsApps } from './apps/windows';
import { bannerText, lanAddresses } from './banner';
import { sendableFocus } from './resultLimits';
import {
  AGENT_LOCK_WAIT_MS,
  authdeckHome,
  generatePairSecret,
  generatePin,
  loadConfig,
  loadLinkKey,
  updateConfig,
  watchConfig,
  type AgentConfig,
  type ShellPreference,
  type TerminalPreference,
} from './config';
import { describePlan } from './plan';
import type { AgentEventListener } from './events';
import { EnvAgent } from './env/envAgent';
import { envSocketPath, type EnvAgentControl, type EnvAgentEventListener } from './envSocketContract';
import { DryRunExecutor, PlanExecutor } from './executor';
import { macHostAppName } from './failures';
import { FocusTracker, createFocusProbe, focusSupported } from './focus';
import { currentPlatform, type HostContext } from './host';
import { LinuxIconResolver } from './icons/linux';
import { IconService } from './icons/service';
import { PAIRING_WINDOW_MS, Pairing, type PairingWindow } from './pairing';
import { WinHelper } from './platform/winHelper';
import { ENV_FEATURE, PROTOCOL_VERSION, type AgentInfo, type Platform } from './protocol';
import { AgentServer, type ServerDeps } from './server';
import { createToolLookup } from './which';
import { VaultAuthors } from './vaultAuthors';
import { personalVaultRoot, VaultStore } from './vaultStore';
import { VaultWatcher } from './vaultWatcher';

export const AGENT_VERSION: string = packageJson.version;

const RESCAN_INTERVAL_MS = 10 * 60 * 1000;
const RUN_SCRIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A pairing window that could not be closed when it ran out is tried again after this long. */
const WINDOW_RETRY_MS = 2000;

const PLATFORM_ACTIONS: Record<Platform, PlatformActions> = { macos: macActions, windows: windowsActions, linux: linuxActions };

export interface AgentOptions {
  port?: number;
  dryRun: boolean;
  /** Receives structured events alongside the log lines. */
  onEvent?: AgentEventListener;
  /** The app macOS asks permission for, when the agent runs inside one (the desktop app). */
  hostAppName?: string;
  /** Told when a device retired a vault on this computer; the desktop app shows a notification. The log has a line either way. */
  onVaultRetired?: ServerDeps['onVaultRetired'];
  /** Env activity and grant changes, for the desktop app's Activity list and grant banner. */
  onEnvEvent?: EnvAgentEventListener;
}

export interface RunningAgent {
  port: number;
  stop: () => Promise<void>;
  /** Opens pairing for 10 minutes with a new PIN and QR secret (again, if it was open). */
  openPairing: () => PairingWindow;
  /** Closes pairing; the PIN and QR code shown no longer work. */
  closePairing: () => void;
  /** The open pairing window with its PIN and QR secret, or null while pairing is closed. */
  pairingWindow: () => PairingWindow | null;
  /** Unpairs one device and cuts off its connections. Returns false when it was not paired. */
  revokeDevice: (deviceId: string) => boolean;
  connectedDeviceIds: () => Set<string>;
  /** Saves the preference and uses it for the next command. */
  setTerminal: (terminal: TerminalPreference) => void;
  setShell: (shell: ShellPreference) => void;
  /** Saves the shared folder for team vaults (null to stop using one) and watches it. */
  setTeamFolder: (folder: string | null) => void;
  /** Env sets: open grants, End now, and ending every grant on lock or sleep. Inert when env sets couldn't start. */
  env: EnvAgentControl;
}

/** What RunningAgent.env does when env sets couldn't start: there are never any grants. */
const ENV_OFF: EnvAgentControl = { grants: () => [], endGrant: () => false, endAllGrants: () => {} };

function currentUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return 'user';
  }
}

/**
 * Starts env sets (the registry and the local socket). On failure the agent runs without them,
 * says why in the log, and doesn't list ENV_FEATURE.
 */
async function startEnv(home: string, options: AgentOptions, log: (line: string) => void): Promise<EnvAgent | null> {
  let env: EnvAgent;
  try {
    env = new EnvAgent({ home, socketPath: envSocketPath(home, process.platform, currentUserName()), platform: process.platform, agentVersion: AGENT_VERSION, log, onEvent: options.onEnvEvent });
    await env.start();
  } catch (err) {
    log(`Env sets are off: ${(err as Error).message}`);
    return null;
  }
  return env;
}

function loginShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function scannerFor(host: HostContext): AppScanner {
  switch (host.platform) {
    case 'macos':
      return () => scanMacApps(host.home);
    case 'windows':
      return scanWindowsApps;
    case 'linux':
      return () => scanLinuxApps(host);
  }
}

/** Terminal scripts written for Windows terminal windows are only needed for a moment. */
function removeOldRunScripts(dir: string): void {
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > RUN_SCRIPT_MAX_AGE_MS) fs.rmSync(file);
    } catch {
      // Still in use or already gone.
    }
  }
}

export async function startAgent(options: AgentOptions, log: (line: string) => void = console.log): Promise<RunningAgent> {
  const home = authdeckHome();
  const config = loadConfig(home);
  const port = options.port ?? config.port;
  // launchd starts the agent without SHELL; commands should still get the user's login shell.
  const env = { ...process.env, SHELL: process.env.SHELL || loginShell() };
  const emit: AgentEventListener = options.onEvent ?? (() => {});
  const host: HostContext = { platform: currentPlatform(), home: os.homedir(), env, hasTool: createToolLookup(env) };
  // Kept in step with agent.json by the config watch below, so a renamed computer gives the same
  // name in discovery, the handshake and the QR code, and /hello never reads the file.
  let computerName = config.name;
  const agentInfo: AgentInfo = {
    agentId: config.agentId,
    get name() {
      return computerName;
    },
    platform: host.platform,
    version: AGENT_VERSION,
    protocol: PROTOCOL_VERSION,
  };

  let server: AgentServer | null = null;
  const catalog = new AppCatalog(scannerFor(host), () => server?.broadcast('apps.changed', {}));
  const winHelper = host.platform === 'windows' ? new WinHelper(home) : null;
  const scratchDir = path.join(home, 'run');
  removeOldRunScripts(scratchDir);
  const ctx: BuildContext = { ...host, terminal: config.terminal, shell: config.shell, scratchDir, newId: () => crypto.randomUUID() };

  const runner = new ActionRunner({
    ctx,
    actions: PLATFORM_ACTIONS[host.platform],
    catalog,
    executor: options.dryRun ? new DryRunExecutor(log) : new PlanExecutor({ hostAppName: options.hostAppName ?? macHostAppName(env), winHelper }),
    runBackground: options.dryRun
      ? async (shell, cwd, timeoutSec) => {
          const [line] = describePlan([{ kind: 'run', cmd: shell.cmd, args: shell.args, purpose: 'run the command', failure: 'plain' }]);
          log(`  [dry-run] ${line}  (in ${cwd}, timeout ${timeoutSec} s)`);
          return { exitCode: 0, output: '' };
        }
      : runBackgroundCommand,
    log,
  });

  const focusDeps = { platform: host.platform, env: host.env, hasTool: host.hasTool, apps: () => catalog.snapshot(), winHelper };
  let focusErrorLogged = false;
  const focus = new FocusTracker(
    createFocusProbe(focusDeps),
    (info) => server?.broadcast('focus', sendableFocus(info)),
    focusSupported(focusDeps),
    (err) => {
      if (focusErrorLogged) return;
      focusErrorLogged = true;
      log(`Could not read the focused app (further errors hidden): ${(err as Error).message}`);
    },
  );

  const envAgent = await startEnv(home, options, log);
  if (envAgent) agentInfo.features = [ENV_FEATURE];

  const linkKey = loadLinkKey(home);
  let shownWindow: string | null = null;
  let windowTimer: NodeJS.Timeout | null = null;
  // Tells the host about a changed window once, whoever changed it, and closes it when it runs out.
  const pairingMaybeChanged = () => {
    const window = pairing.window();
    const key = JSON.stringify(window);
    if (key === shownWindow) return;
    shownWindow = key;
    if (windowTimer) clearTimeout(windowTimer);
    windowTimer = window ? setTimeout(() => expireWindow(window.closesAt), Math.max(0, window.closesAt - Date.now())) : null;
    windowTimer?.unref();
    emit({ type: 'pairing.changed' });
  };
  // Runs in a timer: a failure is logged and tried again shortly, never thrown.
  const expireWindow = (closesAt: number) => {
    try {
      pairing.expireWindow(closesAt);
    } catch (err) {
      log(`Could not close pairing when it ran out: ${(err as Error).message}. Trying again.`);
      windowTimer = setTimeout(() => expireWindow(closesAt), WINDOW_RETRY_MS);
      windowTimer.unref();
    }
  };
  // The agent never waits long for agent.json: a write that can't get the lock fails at once.
  // agent.json as last read or written. The pairing check before every request reads this, not the
  // file: this process's writes land here at once, other processes' through the watch below.
  let cachedConfig = config;
  const update = (change: (config: AgentConfig) => void) => (cachedConfig = updateConfig(home, change, AGENT_LOCK_WAIT_MS));
  const pairing = new Pairing({
    load: () => loadConfig(home),
    update,
    cached: () => cachedConfig,
    refresh: () => {
      cachedConfig = loadConfig(home);
      computerName = cachedConfig.name;
    },
    newPin: generatePin,
    newPairSecret: generatePairSecret,
    onPairingChanged: pairingMaybeChanged,
  });
  // A PIN or QR code shown before this start never works again.
  pairing.closeWindow();
  let teamFolder = config.teamFolder ? path.resolve(config.teamFolder) : null;
  const vaults = new VaultStore({ personal: personalVaultRoot(home), team: () => teamFolder }, log);
  const vaultWatcher = new VaultWatcher({
    roots: () => vaults.watchRoots().map((r) => r.root),
    onChange: (vaultId) => server?.broadcast('vault.changed', { vaultId }),
    log,
  });
  // Cut it off first: even if agent.json can't be written right now, it is out at once.
  const revokeDevice = (deviceId: string): boolean => {
    server?.disconnectDevice(deviceId);
    if (!pairing.revoke(deviceId)) return false;
    envAgent?.deviceUnpaired(deviceId);
    emit({ type: 'device.revoked', deviceId });
    return true;
  };
  server = new AgentServer({
    agentInfo,
    port,
    home: host.home,
    platform: host.platform,
    pairing,
    linkKey,
    catalog,
    icons: new IconService(path.join(home, 'icons'), host.platform === 'linux' ? new LinuxIconResolver(host.env, host.home) : null),
    runner,
    focus,
    vaults,
    vaultAuthors: VaultAuthors.load(home, log),
    unpairDevice: (deviceId) => {
      const deviceName = cachedConfig.devices.find((d) => d.deviceId === deviceId)?.deviceName ?? 'A device';
      return revokeDevice(deviceId) ? { deviceName } : null;
    },
    onVaultRetired: options.onVaultRetired,
    log,
    emit,
    env: envAgent ?? undefined,
  });
  let boundPort: number;
  try {
    boundPort = await server.listen();
  } catch (err) {
    await envAgent?.stop();
    throw err;
  }
  // A setup step that throws after this point must not leave the port bound with no agent behind it.
  let stopWatchingConfig: () => void = () => {};
  try {
    vaultWatcher.start();
    // `devices --revoke-all` and `pair` from a terminal write agent.json; act on them right away.
    stopWatchingConfig = watchConfig(home, () => {
      try {
        cachedConfig = loadConfig(home);
        computerName = cachedConfig.name;
        for (const deviceId of server.dropUnpaired()) {
          envAgent?.deviceUnpaired(deviceId);
          emit({ type: 'device.revoked', deviceId });
        }
        pairingMaybeChanged();
      } catch (err) {
        // agent.json mid-change or unreadable: the next change, or the keepalive check, catches up.
        log(`Could not read the changed agent.json: ${(err as Error).message}`);
      }
    });
    const addresses = lanAddresses(os.networkInterfaces());
    log(bannerText({ name: loadConfig(home).name, version: AGENT_VERSION, port: boundPort, addresses, dryRun: options.dryRun, linkKey: linkKey.public }));
    emit({ type: 'listening', port: boundPort, hosts: addresses });
  } catch (err) {
    stopWatchingConfig();
    vaultWatcher.stop();
    await envAgent?.stop();
    await server.close().catch(() => {});
    throw err;
  }

  const scan = () =>
    catalog.rescan().catch((err: Error) => log(`Could not list installed apps: ${err.message}`));
  void scan().then(() => log(`Found ${catalog.snapshot().length} apps.`));
  const rescanTimer = setInterval(() => void scan(), RESCAN_INTERVAL_MS);
  rescanTimer.unref();

  return {
    port: boundPort,
    stop: async () => {
      clearInterval(rescanTimer);
      if (windowTimer) clearTimeout(windowTimer);
      stopWatchingConfig();
      vaultWatcher.stop();
      winHelper?.stop();
      await envAgent?.stop();
      await server.close();
    },
    openPairing: () => pairing.openWindow(PAIRING_WINDOW_MS),
    closePairing: () => pairing.closeWindow(),
    pairingWindow: () => pairing.window(),
    revokeDevice,
    connectedDeviceIds: () => server.connectedDeviceIds(),
    setTerminal: (terminal) => {
      update((latest) => (latest.terminal = terminal));
      ctx.terminal = terminal;
    },
    setShell: (shell) => {
      update((latest) => (latest.shell = shell));
      ctx.shell = shell;
    },
    setTeamFolder: (folder) => {
      teamFolder = folder ? path.resolve(folder) : null;
      update((latest) => {
        if (teamFolder) latest.teamFolder = teamFolder;
        else delete latest.teamFolder;
      });
      vaultWatcher.start();
    },
    env: envAgent ?? ENV_OFF,
  };
}
