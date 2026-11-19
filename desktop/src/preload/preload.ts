import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DesktopApi, type ViewState } from '../shared/state';

const api: DesktopApi = {
  onState(listener) {
    ipcRenderer.on(IPC.state, (_event, state: ViewState) => listener(state));
    ipcRenderer.send(IPC.ready);
  },
  openPairing: () => ipcRenderer.send(IPC.openPairing),
  copyAddress: () => ipcRenderer.send(IPC.copyAddress),
  unpair: (deviceId) => ipcRenderer.send(IPC.unpair, deviceId),
  setPairingRequested: (requested) => ipcRenderer.send(IPC.setPairingRequested, requested),
  setStartAtSignIn: (enabled) => ipcRenderer.send(IPC.setStartAtSignIn, enabled),
  chooseCommandRunner: (anchor) => ipcRenderer.send(IPC.chooseCommandRunner, anchor),
  openAccessibilitySettings: () => ipcRenderer.send(IPC.openAccessibilitySettings),
  retryStart: () => ipcRenderer.send(IPC.retryStart),
  endGrant: (grantId) => ipcRenderer.send(IPC.endGrant, grantId),
  endAllGrants: () => ipcRenderer.send(IPC.endAllGrants),
  chooseCliPath: (anchor) => ipcRenderer.send(IPC.chooseCliPath, anchor),
};

contextBridge.exposeInMainWorld('authdeck', api);
