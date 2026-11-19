import os from 'node:os';
import { Notification } from 'electron';
import { startAgent, type RunningAgent } from '../../../agent/src/agent';
import { lanAddresses, pairUrl } from '../../../agent/src/banner';
import { carryOverLegacyHome, loadConfig, loadLinkKey, type AgentConfig } from '../../../agent/src/config';
import { linkKeyWords } from '../../../agent/src/link/keys';
import type { EnvAgentEvent } from '../../../agent/src/envSocketContract';
import type { AgentEvent } from '../../../agent/src/events';
import { openPairingWindow } from '../../../agent/src/pairing';
import { PortInUseError } from '../../../agent/src/server';
import { GrantTracker, envActivityItem, type DesktopEndReason } from '../shared/envView';
import type { ActivityItem, ActivityOutcome, AgentStatus, DeviceView, EnvGrant } from '../shared/state';
import { envControl, withEnvEvents } from './envBridge';
import { qrImage } from './qr';

const ACTIVITY_LIMIT = 50;

/** A phone set a vault on this computer aside (vault.retire): the user hears of it even with the window closed. */
function vaultRetiredText(info: { deviceName: string | null; keptUntil: number }): string {
  const until = new Date(info.keptUntil).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return `Your AuthDeck vault was replaced from ${info.deviceName ?? 'a paired device'}. The old backup is kept until ${until}.`;
}

function notifyVaultRetired(info: { deviceName: string | null; keptUntil: number }): void {
  if (!Notification.isSupported()) return;
  new Notification({ title: 'AuthDeck', body: vaultRetiredText(info) }).show();
}

/** Runs the agent in this process and keeps what the window and tray show about it. */
export class AgentHost {
  private agent: RunningAgent | null = null;
  private status: AgentStatus = { state: 'starting' };
  private activity: ActivityItem[] = [];
  private readonly grants = new GrantTracker();

  constructor(
    private readonly home: string,
    private readonly hostAppName: string,
    /** Called after every change; `event` is set when an agent event caused it. */
    private readonly onChange: (event?: AgentEvent) => void,
  ) {}

  get running(): RunningAgent | null {
    return this.agent;
  }

  async start(): Promise<void> {
    this.status = { state: 'starting' };
    try {
      // Before the first onChange, which reads (and would otherwise create) the config.
      carryOverLegacyHome();
      this.onChange();
      const options = { dryRun: false, hostAppName: this.hostAppName, onEvent: (event: AgentEvent) => this.handle(event), onVaultRetired: notifyVaultRetired };
      this.agent = await startAgent(withEnvEvents(options, (event) => this.handleEnv(event)), (line) => console.log(line));
      this.grants.update(envControl(this.agent)?.grants() ?? [], undefined, Date.now());
    } catch (err) {
      this.status = err instanceof PortInUseError ? { state: 'port-in-use', port: err.port } : { state: 'failed', message: (err as Error).message };
    }
    this.onChange();
  }

  async stop(): Promise<void> {
    await this.agent?.stop();
    this.agent = null;
    this.grants.clear();
  }

  config(): AgentConfig {
    return loadConfig(this.home);
  }

  agentStatus(): AgentStatus {
    return this.status;
  }

  recentActivity(): ActivityItem[] {
    return this.activity;
  }

  openGrants(): EnvGrant[] {
    return this.grants.grants;
  }

  /** End now in the window or the tray; the agent tells the device that allowed it. */
  endGrant(grantId: string): void {
    envControl(this.agent)?.endGrant(grantId);
  }

  /** End all in the window or the tray, or the computer locked or went to sleep. */
  endAllGrants(reason: DesktopEndReason): void {
    envControl(this.agent)?.endAllGrants(reason);
  }

  devices(): DeviceView[] {
    const connected = this.agent?.connectedDeviceIds() ?? new Set<string>();
    return this.config().devices.map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      form: device.form,
      connected: connected.has(device.deviceId),
      lastSeenAt: device.lastSeenAt,
      needsRepair: device.linkKey === undefined,
    }));
  }

  /** Re-reads the network so the QR code follows a change of Wi-Fi. */
  refreshAddresses(): void {
    if (this.status.state !== 'running') return;
    this.showRunning(this.status.port, lanAddresses(os.networkInterfaces()));
  }

  private showRunning(port: number, hosts: string[]): void {
    const config = this.config();
    // The agent made the key before it started listening; this only reads it.
    const linkKey = loadLinkKey(this.home).public;
    const window = openPairingWindow(config, Date.now());
    const pairing = window
      ? { pin: window.pin, qr: qrImage(pairUrl({ name: config.name, port, hosts, linkKey, pairSecret: window.pairSecret })), closesAt: window.closesAt }
      : null;
    this.status = { state: 'running', port, hosts, keyWords: linkKeyWords(linkKey), pairing };
  }

  private addActivity(items: ActivityItem[]): void {
    this.activity = [...items, ...this.activity].slice(0, ACTIVITY_LIMIT);
  }

  private handleEnv(event: EnvAgentEvent): void {
    switch (event.type) {
      case 'env.activity':
        this.addActivity([envActivityItem(event.entry)]);
        break;
      case 'env.grants.changed':
        this.addActivity(this.grants.update(event.grants, event.ended, Date.now()));
        break;
    }
    this.onChange();
  }

  private handle(event: AgentEvent): void {
    switch (event.type) {
      case 'listening':
        this.showRunning(event.port, event.hosts);
        break;
      case 'pairing.changed':
        if (this.status.state === 'running') this.showRunning(this.status.port, this.status.hosts);
        break;
      case 'action.started': {
        this.addActivity([{ kind: 'action', id: event.actionId, at: event.at, title: event.title, detail: event.detail, outcome: { state: 'running' } }]);
        break;
      }
      case 'action.finished': {
        const outcome: ActivityOutcome = event.ok
          ? { state: 'done', durationMs: event.durationMs, exitCode: event.exitCode }
          : { state: 'failed', durationMs: event.durationMs, failure: event.failure };
        this.activity = this.activity.map((item) => (item.kind === 'action' && item.id === event.actionId ? { ...item, outcome } : item));
        break;
      }
      case 'device.paired':
      case 'device.connected':
      case 'device.disconnected':
      case 'device.revoked':
        break;
    }
    this.onChange(event);
  }
}
