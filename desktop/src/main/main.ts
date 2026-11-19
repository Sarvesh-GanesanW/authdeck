import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, nativeTheme, powerMonitor, shell, systemPreferences, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import type { RunningAgent } from '../../../agent/src/agent';
import { authdeckHome } from '../../../agent/src/config';
import { currentPlatform } from '../../../agent/src/host';
import { IPC, showsPairing, type AnchorRect, type CliPathState, type ViewState } from '../shared/state';
import { AgentHost } from './agentHost';
import { CliPathCancelled, CliPathError, cliPathState, installCli, refreshCli, removeCli } from './cliPath';
import { cliLayout, cliSystem } from './cliPathSystem';
import { applyCommandRunner, commandRunner } from './commandRunner';
import { PairingSync, type PairingControl } from './pairingSync';
import { endGrantsOnLockAndSleep } from './powerEvents';
import { isStartAtSignInEnabled, setStartAtSignIn, startedHidden } from './startAtSignIn';
import { AgentTray } from './tray';

const platform = currentPlatform();
const isMac = platform === 'macos';
const resources = path.join(__dirname, 'resources');
const ACCESSIBILITY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const WINDOW_BACKGROUND = { dark: '#22262E', light: '#D9D3C5' };

let window: BrowserWindow | null = null;
let tray: AgentTray | null = null;
let quitting = false;
let pairingRequested = false;
let needsAccessibility = false;
let cliPath: CliPathState | null = null;
const cli = cliLayout(platform);
const pairingSync = new PairingSync((message) => console.error(message));

const host = new AgentHost(authdeckHome(), app.getName(), (event) => {
  if (event?.type === 'device.paired') pairingRequested = false;
  publishState();
});

function viewState(): ViewState {
  const config = host.config();
  return {
    platform,
    version: app.getVersion(),
    computerName: config.name,
    agent: host.agentStatus(),
    devices: host.devices(),
    activity: host.recentActivity(),
    grants: host.openGrants(),
    cliPath,
    startAtSignIn: isStartAtSignInEnabled(platform),
    commandRunner: commandRunner(platform, config),
    needsAccessibility,
    pairingRequested,
  };
}

function publishState(): void {
  const state = viewState();
  if (pairingRequested && state.devices.length === 0) pairingRequested = false;
  if (syncPairingWindow(state)) return;
  const webContents = window?.webContents;
  if (webContents && !webContents.isDestroyed()) webContents.send(IPC.state, state);
  tray?.update(state);
}

function windowOnScreen(): boolean {
  return !!window && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
}

function pairingControl(agent: RunningAgent): PairingControl {
  return { isOpen: () => agent.pairingWindow() !== null, open: () => void agent.openPairing(), close: () => agent.closePairing() };
}

/** Returns true when it changed the pairing window; the agent's event then publishes the new state. */
function syncPairingWindow(state: ViewState): boolean {
  const agent = host.running;
  return agent ? pairingSync.sync(pairingControl(agent), windowOnScreen(), showsPairing(state)) : false;
}

function openPairingAgain(): void {
  const agent = host.running;
  if (agent) pairingSync.openAgain(pairingControl(agent), windowOnScreen());
}

function checkAccessibility(): void {
  needsAccessibility = isMac && !systemPreferences.isTrustedAccessibilityClient(false);
}

function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 760,
    height: 600,
    minWidth: 680,
    minHeight: 500,
    show: false,
    title: 'AuthDeck Agent',
    backgroundColor: windowBackground(),
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 20, y: 20 } } : {}),
    icon: isMac ? undefined : path.join(resources, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.webContents.on('will-navigate', (event) => event.preventDefault());
  created.on('focus', () => {
    checkAccessibility();
    host.refreshAddresses();
    publishState();
    // The command may have been removed or replaced from a terminal meanwhile.
    void readCliPath();
  });
  // Hiding the window closes pairing; showing the pairing view again opens a new one.
  created.on('show', () => publishState());
  created.on('hide', () => publishState());
  created.on('minimize', () => publishState());
  created.on('restore', () => publishState());
  created.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    created.hide();
    if (isMac) app.dock?.hide();
  });
  created.on('closed', () => {
    if (window === created) window = null;
  });
  void created.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return created;
}

function showWindow(): void {
  // Tray clicks, second launches and dock clicks can still arrive while the app shuts down.
  if (quitting) return;
  if (!window || window.isDestroyed()) window = createWindow();
  const shown = window;
  if (isMac) void app.dock?.show();
  if (shown.webContents.isLoading()) shown.once('ready-to-show', () => shown.show());
  else shown.show();
  shown.focus();
}

function showPairing(): void {
  pairingRequested = true;
  publishState();
  showWindow();
}

function quit(): void {
  quitting = true;
  app.quit();
}

function changeStartAtSignIn(enabled: boolean): void {
  setStartAtSignIn(platform, enabled);
  publishState();
}

async function confirmUnpair(deviceId: string): Promise<void> {
  const device = host.devices().find((d) => d.deviceId === deviceId);
  const agent = host.running;
  if (!device || !agent) return;
  const options = {
    type: 'warning' as const,
    buttons: ['Unpair', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Unpair ${device.deviceName}?`,
    detail: 'It disconnects now and needs the PIN to connect again.',
  };
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (response !== 0) return;
  try {
    agent.revokeDevice(deviceId);
  } catch (err) {
    const failure = {
      type: 'error' as const,
      message: `Could not unpair ${device.deviceName}`,
      detail: `${(err as Error).message}\n\nIt is still paired. Try again in a moment.`,
    };
    if (window) await dialog.showMessageBox(window, failure);
    else await dialog.showMessageBox(failure);
  }
  publishState();
}

function chooseCommandRunner(anchor: AnchorRect): void {
  const agent = host.running;
  const runner = commandRunner(platform, host.config());
  if (!window || !agent || !runner) return;
  const items: MenuItemConstructorOptions[] = runner.choices.map((choice) => ({
    label: choice.label,
    type: 'radio',
    checked: choice.value === runner.current,
    click: () => {
      applyCommandRunner(agent, platform, choice.value);
      publishState();
    },
  }));
  Menu.buildFromTemplate(items).popup({ window, x: Math.round(anchor.left), y: Math.round(anchor.bottom) });
}

async function readCliPath(): Promise<void> {
  if (!cli) return;
  try {
    cliPath = await cliPathState(cli, cliSystem);
  } catch (err) {
    console.error(`Could not tell whether the authdeck command is on the PATH: ${(err as Error).message}`);
    cliPath = null;
  }
  publishState();
}

async function showError(message: string, detail: string): Promise<void> {
  const options = { type: 'error' as const, message, detail };
  if (window) await dialog.showMessageBox(window, options);
  else await dialog.showMessageBox(options);
}

async function changeCliPath(change: typeof installCli, failure: string): Promise<void> {
  if (!cli) return;
  try {
    await change(cli, cliSystem);
  } catch (err) {
    if (!(err instanceof CliPathCancelled)) {
      const detail = err instanceof CliPathError ? `${err.message}\n\n${err.hint}` : `${(err as Error).message}\n\nTry again in a moment.`;
      await showError(failure, detail);
    }
  }
  await readCliPath();
}

/** macOS menus use title case; Windows and Linux menus use sentence case. */
const CLI_MENU = {
  macos: { install: 'Put the authdeck Command on Your PATH', fix: 'Point It at This Copy of AuthDeck Agent', remove: 'Remove It from Your PATH' },
  other: { install: 'Put the authdeck command on your PATH', fix: 'Point it at this copy of AuthDeck Agent', remove: 'Remove it from your PATH' },
};

function cliPathMenu(state: CliPathState): MenuItemConstructorOptions[] {
  const labels = isMac ? CLI_MENU.macos : CLI_MENU.other;
  const install = (label: string): MenuItemConstructorOptions => ({ label, click: () => void changeCliPath(installCli, 'Could not put the authdeck command on your PATH') });
  const remove: MenuItemConstructorOptions = { label: labels.remove, click: () => void changeCliPath(removeCli, 'Could not remove the authdeck command') };
  const note = (label: string): MenuItemConstructorOptions => ({ label, enabled: false });
  switch (state.state) {
    case 'absent':
      return [install(labels.install)];
    case 'installed':
      return state.onPath
        ? [note(`On your PATH: ${state.location}`), remove]
        : [note(`In ${path.dirname(state.location)}, which isn't on your PATH yet.`), note('Sign out and in again, or add it in your shell profile.'), remove];
    case 'stale':
      return [note(`${state.location} runs another copy of AuthDeck Agent.`), install(labels.fix), remove];
    case 'taken':
      return [note(`${state.location} belongs to another program.`), note('Remove or rename it, then try again.')];
  }
}

function chooseCliPath(anchor: AnchorRect): void {
  if (!window || !cliPath) return;
  Menu.buildFromTemplate(cliPathMenu(cliPath)).popup({ window, x: Math.round(anchor.left), y: Math.round(anchor.bottom) });
}

function registerIpc(): void {
  ipcMain.on(IPC.ready, () => publishState());
  ipcMain.on(IPC.openPairing, () => openPairingAgain());
  ipcMain.on(IPC.copyAddress, () => {
    const status = host.agentStatus();
    if (status.state === 'running' && status.hosts[0]) clipboard.writeText(`${status.hosts[0]}:${status.port}`);
  });
  ipcMain.on(IPC.unpair, (_event, deviceId: string) => void confirmUnpair(deviceId));
  ipcMain.on(IPC.setPairingRequested, (_event, requested: boolean) => {
    pairingRequested = requested;
    publishState();
  });
  ipcMain.on(IPC.setStartAtSignIn, (_event, enabled: boolean) => changeStartAtSignIn(enabled));
  ipcMain.on(IPC.chooseCommandRunner, (_event, anchor: AnchorRect) => chooseCommandRunner(anchor));
  ipcMain.on(IPC.openAccessibilitySettings, () => void shell.openExternal(ACCESSIBILITY_SETTINGS_URL));
  ipcMain.on(IPC.retryStart, () => void host.start());
  ipcMain.on(IPC.endGrant, (_event, grantId: string) => host.endGrant(grantId));
  ipcMain.on(IPC.endAllGrants, () => host.endAllGrants('ended-on-computer'));
  ipcMain.on(IPC.chooseCliPath, (_event, anchor: AnchorRect) => chooseCliPath(anchor));
}

function setApplicationMenu(): void {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', (event) => {
    if (!host.running) return;
    event.preventDefault();
    // A second app.quit() from here is ignored on some quit paths (SIGTERM), so exit directly.
    void host.stop().finally(() => app.exit(0));
  });
  nativeTheme.on('updated', () => {
    if (window && !window.isDestroyed()) window.setBackgroundColor(windowBackground());
  });

  void app.whenReady().then(() => {
    setApplicationMenu();
    registerIpc();
    checkAccessibility();
    tray = new AgentTray(resources, platform, {
      open: showWindow,
      pair: showPairing,
      setStartAtSignIn: changeStartAtSignIn,
      endGrants: () => host.endAllGrants('ended-on-computer'),
      quit,
    });
    endGrantsOnLockAndSleep(powerMonitor, (reason) => host.endAllGrants(reason));
    if (startedHidden(platform)) {
      // Loaded but not shown, so opening it from the tray is instant.
      window = createWindow();
      if (isMac) app.dock?.hide();
    } else {
      showWindow();
    }
    void host.start();
    if (cli) {
      void refreshCli(cli, cliSystem)
        .catch((err: unknown) => console.error(`Could not update the authdeck command on the PATH: ${(err as Error).message}`))
        .finally(() => void readCliPath());
    }
  });
}
