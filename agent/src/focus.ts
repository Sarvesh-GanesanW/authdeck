import fs from 'node:fs/promises';
import path from 'node:path';
import { tokenizeExec } from './apps/desktopFile';
import type { InstalledApp } from './apps/types';
import { linuxSession } from './host';
import type { WinHelper } from './platform/winHelper';
import type { FocusInfo, Platform } from './protocol';
import { runProcess } from './proc';

const FOCUS_POLL_MS = 1000;
const PROBE_TIMEOUT_MS = 3000;
const UNSUPPORTED_FOCUS: FocusInfo = { supported: false, appId: null, name: '' };
const UNKNOWN_FOCUS: FocusInfo = { supported: true, appId: null, name: '' };

export interface MacFrontApp {
  name: string;
  bundleId: string | null;
  bundlePath: string | null;
}

/** Parses `lsappinfo info -only name -only bundlepath -only bundleid <ASN>`. */
export function parseLsappinfo(output: string): MacFrontApp {
  return {
    name: /^"((?:[^"\\]|\\.)*)"/m.exec(output.trim())?.[1] ?? '',
    bundleId: /bundleID="([^"]*)"/.exec(output)?.[1] ?? null,
    bundlePath: /bundle path="([^"]*)"/.exec(output)?.[1] ?? null,
  };
}

export function matchMacApp(apps: readonly InstalledApp[], front: MacFrontApp): FocusInfo {
  const app =
    apps.find((a) => a.platform === 'macos' && front.bundlePath !== null && a.bundlePath === front.bundlePath) ??
    apps.find((a) => a.platform === 'macos' && front.bundleId !== null && a.bundleId === front.bundleId);
  return { supported: true, appId: app?.entry.id ?? null, name: app?.entry.name ?? front.name };
}

async function macFocus(apps: readonly InstalledApp[]): Promise<FocusInfo> {
  const front = await runProcess('lsappinfo', ['front'], { timeoutMs: PROBE_TIMEOUT_MS });
  const asn = front.stdout.trim();
  if (front.exitCode !== 0 || asn === '' || asn.includes('NULL')) return UNKNOWN_FOCUS;
  const info = await runProcess('lsappinfo', ['info', '-only', 'name', '-only', 'bundlepath', '-only', 'bundleid', asn], { timeoutMs: PROBE_TIMEOUT_MS });
  return matchMacApp(apps, parseLsappinfo(info.stdout));
}

export interface WindowsFrontApp {
  exe: string | null;
  aumid: string | null;
  name: string;
}

export function matchWindowsApp(apps: readonly InstalledApp[], front: WindowsFrontApp): FocusInfo {
  const exe = front.exe?.toLowerCase() ?? null;
  const app =
    apps.find((a) => a.platform === 'windows' && a.kind === 'aumid' && front.aumid !== null && a.aumid.toLowerCase() === front.aumid.toLowerCase()) ??
    apps.find((a) => a.platform === 'windows' && a.kind === 'lnk' && exe !== null && a.targetPath.toLowerCase() === exe);
  return { supported: true, appId: app?.entry.id ?? null, name: app?.entry.name ?? front.name };
}

async function windowsFocus(apps: readonly InstalledApp[], helper: WinHelper): Promise<FocusInfo> {
  const response = await helper.request({ op: 'foreground' });
  if (!response.ok) return UNKNOWN_FOCUS;
  return matchWindowsApp(apps, { exe: response.exe ?? null, aumid: response.aumid ?? null, name: response.name ?? '' });
}

/** WM_CLASS from `xprop -id <wid> WM_CLASS`: `WM_CLASS(STRING) = "code", "Code"` -> ["code", "Code"]. */
export function parseWmClass(output: string): string[] {
  return [...output.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
}

export interface LinuxFrontWindow {
  wmClass: string[];
  exeName: string | null;
}

export function matchLinuxApp(apps: readonly InstalledApp[], front: LinuxFrontWindow): FocusInfo {
  const classes = front.wmClass.map((c) => c.toLowerCase());
  const linuxApps = apps.filter((a): a is Extract<InstalledApp, { platform: 'linux' }> => a.platform === 'linux');
  const execName = (a: (typeof linuxApps)[number]) => path.basename(tokenizeExec(a.desktop.exec)[0] ?? '').toLowerCase();
  const app =
    linuxApps.find((a) => a.desktop.startupWMClass !== null && classes.includes(a.desktop.startupWMClass.toLowerCase())) ??
    linuxApps.find((a) => classes.includes(execName(a))) ??
    linuxApps.find((a) => front.exeName !== null && execName(a) === front.exeName.toLowerCase());
  const fallbackName = front.wmClass[1] ?? front.wmClass[0] ?? front.exeName ?? '';
  return { supported: true, appId: app?.entry.id ?? null, name: app?.entry.name ?? fallbackName };
}

async function linuxFocus(apps: readonly InstalledApp[]): Promise<FocusInfo> {
  const active = await runProcess('xdotool', ['getactivewindow'], { timeoutMs: PROBE_TIMEOUT_MS });
  const windowId = active.stdout.trim();
  if (active.exitCode !== 0 || !/^\d+$/.test(windowId)) return UNKNOWN_FOCUS;
  const [pidOutcome, classOutcome] = await Promise.all([
    runProcess('xdotool', ['getwindowpid', windowId], { timeoutMs: PROBE_TIMEOUT_MS }),
    runProcess('xprop', ['-id', windowId, 'WM_CLASS'], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null),
  ]);
  const pid = pidOutcome.stdout.trim();
  const exe = /^\d+$/.test(pid) ? await fs.readlink(`/proc/${pid}/exe`).catch(() => null) : null;
  return matchLinuxApp(apps, { wmClass: classOutcome ? parseWmClass(classOutcome.stdout) : [], exeName: exe ? path.basename(exe) : null });
}

export interface FocusProbeDeps {
  platform: Platform;
  env: NodeJS.ProcessEnv;
  hasTool: (name: string) => boolean;
  apps: () => readonly InstalledApp[];
  winHelper: WinHelper | null;
}

/** Whether this session can see the focused app at all. */
export function focusSupported(deps: Pick<FocusProbeDeps, 'platform' | 'env' | 'hasTool'>): boolean {
  if (deps.platform !== 'linux') return true;
  return linuxSession(deps.env) === 'x11' && deps.hasTool('xdotool');
}

export function createFocusProbe(deps: FocusProbeDeps): () => Promise<FocusInfo> {
  return async () => {
    if (!focusSupported(deps)) return UNSUPPORTED_FOCUS;
    switch (deps.platform) {
      case 'macos':
        return macFocus(deps.apps());
      case 'windows':
        return windowsFocus(deps.apps(), deps.winHelper!);
      case 'linux':
        return linuxFocus(deps.apps());
    }
  };
}

/** Polls the focused app while at least one client is connected and reports changes. */
export class FocusTracker {
  private clients = 0;
  private timer: NodeJS.Timeout | null = null;
  private last: FocusInfo | null = null;
  private polling = false;

  constructor(
    private readonly probe: () => Promise<FocusInfo>,
    private readonly broadcast: (info: FocusInfo) => void,
    private readonly canPoll: boolean,
    private readonly onError: (err: unknown) => void,
  ) {}

  async current(): Promise<FocusInfo> {
    try {
      return await this.probe();
    } catch (err) {
      this.onError(err);
      return UNKNOWN_FOCUS;
    }
  }

  clientConnected(): void {
    this.clients += 1;
    if (this.clients === 1 && this.canPoll) this.timer = setInterval(() => void this.poll(), FOCUS_POLL_MS);
  }

  clientDisconnected(): void {
    this.clients = Math.max(0, this.clients - 1);
    if (this.clients === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.last = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const info = await this.current();
      if (!this.last || info.appId !== this.last.appId || info.name !== this.last.name || info.supported !== this.last.supported) {
        this.last = info;
        this.broadcast(info);
      }
    } finally {
      this.polling = false;
    }
  }
}
