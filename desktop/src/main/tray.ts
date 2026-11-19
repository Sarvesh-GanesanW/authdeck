import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { grantTrayLines, liveGrants } from '../shared/envView';
import { clockTime } from '../renderer/format';
import type { ViewState } from '../shared/state';

export interface TrayActions {
  open: () => void;
  pair: () => void;
  setStartAtSignIn: (enabled: boolean) => void;
  /** Ends every open env grant, as End all in the window does. */
  endGrants: () => void;
  quit: () => void;
}

/** macOS menus use title case; Windows and Linux menus use sentence case. */
const LABELS = {
  macos: { pair: 'Pair a Device…', startAtSignIn: 'Start When I Sign In', endGrant: 'End Grant Now', endGrants: 'End All Grants' },
  other: { pair: 'Pair a device…', startAtSignIn: 'Start when I sign in', endGrant: 'End grant now', endGrants: 'End all grants' },
};

function agentLine(state: ViewState): string {
  switch (state.agent.state) {
    case 'starting':
      return 'AuthDeck Agent is starting';
    case 'running':
      return 'AuthDeck Agent is running';
    case 'port-in-use':
      return `AuthDeck Agent is stopped: port ${state.agent.port} is in use`;
    case 'failed':
      return 'AuthDeck Agent could not start';
  }
}

function deviceLines(state: ViewState): string[] {
  if (state.devices.length === 0) return ['No devices paired yet'];
  const connected = state.devices.filter((device) => device.connected);
  if (connected.length === 0) return ['No devices connected'];
  return connected.map((device) => `${device.deviceName} connected`);
}

function trayImage(resources: string, isMac: boolean): Electron.NativeImage {
  if (!isMac) return nativeImage.createFromPath(path.join(resources, 'tray.png'));
  const image = nativeImage.createFromPath(path.join(resources, 'trayTemplate.png'));
  image.setTemplateImage(true);
  return image;
}

export class AgentTray {
  private readonly tray: Tray;
  private readonly isMac: boolean;

  constructor(
    resources: string,
    platform: ViewState['platform'],
    private readonly actions: TrayActions,
  ) {
    this.isMac = platform === 'macos';
    this.tray = new Tray(trayImage(resources, this.isMac));
    this.tray.setToolTip('AuthDeck Agent');
    // On macOS a click opens the menu; on Windows a click opens the window and right-click the menu.
    if (!this.isMac) this.tray.on('click', () => this.actions.open());
  }

  /** A live grant shows in the tooltip and as status lines, with an item to end it. */
  update(state: ViewState): void {
    const labels = this.isMac ? LABELS.macos : LABELS.other;
    const now = Date.now();
    const grantLines = grantTrayLines(state.grants, now, clockTime);
    const status = [agentLine(state), ...deviceLines(state), ...grantLines].map((label): MenuItemConstructorOptions => ({ label, enabled: false }));
    const openGrants = liveGrants(state.grants, now).length;
    const endGrants: MenuItemConstructorOptions[] = openGrants > 0 ? [{ label: openGrants === 1 ? labels.endGrant : labels.endGrants, click: this.actions.endGrants }] : [];
    this.tray.setToolTip(grantLines.length > 0 ? `AuthDeck Agent: ${grantLines.join(', ')}` : 'AuthDeck Agent');
    const template: MenuItemConstructorOptions[] = [
      ...status,
      ...endGrants,
      { type: 'separator' },
      { label: 'Open AuthDeck Agent', click: this.actions.open },
      { label: labels.pair, click: this.actions.pair },
      { type: 'separator' },
      { label: labels.startAtSignIn, type: 'checkbox', checked: state.startAtSignIn, click: (item) => this.actions.setStartAtSignIn(item.checked) },
      { type: 'separator' },
      { label: 'Quit AuthDeck Agent', accelerator: this.isMac ? 'Command+Q' : undefined, click: this.actions.quit },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
