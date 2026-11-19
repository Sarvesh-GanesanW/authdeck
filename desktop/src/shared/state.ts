import type { ActionFailure } from '../../../agent/src/events';
import type { DeviceForm, EnvGrant, Platform } from '../../../agent/src/protocol';

export type { EnvGrant, Platform };

export type AgentStatus =
  | { state: 'starting' }
  | { state: 'running'; port: number; hosts: string[]; keyWords: string[]; pairing: PairingView | null }
  | { state: 'port-in-use'; port: number }
  | { state: 'failed'; message: string };

/** The open pairing window: its PIN and QR code work until `closesAt` (ms since the epoch). */
export interface PairingView {
  pin: string;
  qr: QrImage;
  closesAt: number;
}

/** A QR code as one SVG path over a size × size grid. */
export interface QrImage {
  size: number;
  path: string;
}

export interface DeviceView {
  deviceId: string;
  deviceName: string;
  /** Unknown for devices paired by an older app. */
  form?: DeviceForm;
  connected: boolean;
  lastSeenAt: string;
  /** Paired before the connection was encrypted; it cannot connect until it pairs again. */
  needsRepair: boolean;
}

export type ActivityOutcome =
  | { state: 'running' }
  | { state: 'done'; durationMs: number; exitCode?: number }
  | { state: 'failed'; durationMs: number; failure: ActionFailure };

export interface ActivityEntry {
  id: number;
  at: number;
  title: string;
  detail: string;
  outcome: ActivityOutcome;
}

/** A row about env sets: the words come from the agent, or from the desktop app for a grant that ended. */
export interface EnvActivityRow {
  at: number;
  title: string;
  detail: string;
  outcome: { text: string; tone: 'ok' | 'warn' | 'bad' | 'idle' };
}

/** One line of the Activity list: an action a device ran, or an env set request, answer or grant end. */
export type ActivityItem = ({ kind: 'action' } & ActivityEntry) | ({ kind: 'env' } & EnvActivityRow);

/**
 * The `authdeck` command on the PATH. `location` is the file or folder it lives in.
 * stale: ours, but for another copy of the app (it was moved). taken: another program's file.
 * Linux only: `onPath` is false while ~/.local/bin is not on the PATH yet.
 */
export type CliPathState =
  | { state: 'absent'; location: string }
  | { state: 'installed'; location: string; onPath: boolean }
  | { state: 'stale'; location: string }
  | { state: 'taken'; location: string };

export interface CommandRunnerChoice {
  value: string;
  label: string;
}

/** Where `command` keys run: the macOS terminal app or the Windows shell. Null on Linux. */
export interface CommandRunner {
  current: string;
  choices: CommandRunnerChoice[];
}

export interface ViewState {
  platform: Platform;
  version: string;
  computerName: string;
  agent: AgentStatus;
  devices: DeviceView[];
  activity: ActivityItem[];
  /** Open env grants on this computer, soonest to end first. */
  grants: EnvGrant[];
  /** Null when this build has no `authdeck` command to offer. */
  cliPath: CliPathState | null;
  startAtSignIn: boolean;
  commandRunner: CommandRunner | null;
  needsAccessibility: boolean;
  /** The person asked to pair another device while some are already paired. */
  pairingRequested: boolean;
}

/** Devices that can connect: those paired before the link was encrypted must pair again. */
export function usableDevices(state: ViewState): number {
  return state.devices.filter((device) => !device.needsRepair).length;
}

/** Whether the window shows the pairing view (no device can connect yet, or one was asked for). */
export function showsPairing(state: ViewState): boolean {
  return state.agent.state === 'running' && (usableDevices(state) === 0 || state.pairingRequested);
}

export interface AnchorRect {
  left: number;
  bottom: number;
}

/** What the preload script exposes to the window as `window.authdeck`. */
export interface DesktopApi {
  onState(listener: (state: ViewState) => void): void;
  /** Opens pairing again with a new PIN and QR code. */
  openPairing(): void;
  copyAddress(): void;
  unpair(deviceId: string): void;
  setPairingRequested(requested: boolean): void;
  setStartAtSignIn(enabled: boolean): void;
  chooseCommandRunner(anchor: AnchorRect): void;
  openAccessibilitySettings(): void;
  retryStart(): void;
  /** End now: ends one env grant and tells the device that allowed it. */
  endGrant(grantId: string): void;
  endAllGrants(): void;
  /** Opens the menu that puts the `authdeck` command on the PATH or removes it. */
  chooseCliPath(anchor: AnchorRect): void;
}

export const IPC = {
  state: 'authdeck:state',
  ready: 'authdeck:ready',
  openPairing: 'authdeck:open-pairing',
  copyAddress: 'authdeck:copy-address',
  unpair: 'authdeck:unpair',
  setPairingRequested: 'authdeck:set-pairing-requested',
  setStartAtSignIn: 'authdeck:set-start-at-sign-in',
  chooseCommandRunner: 'authdeck:choose-command-runner',
  openAccessibilitySettings: 'authdeck:open-accessibility-settings',
  retryStart: 'authdeck:retry-start',
  endGrant: 'authdeck:end-grant',
  endAllGrants: 'authdeck:end-all-grants',
  chooseCliPath: 'authdeck:choose-cli-path',
} as const;
