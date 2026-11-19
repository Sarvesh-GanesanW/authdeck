import fs from 'node:fs';
import path from 'node:path';
import { isId } from './vault/entry';

const DEBOUNCE_MS = 300;
const POLL_MS = 3000;

export interface VaultWatcherOptions {
  /** Folders that hold vault folders (the personal root and the team folder). */
  roots: () => string[];
  /** Called once per changed vault after changes settle. */
  onChange: (vaultId: string) => void;
  log: (line: string) => void;
}

/** The vault id a changed path belongs to: the first path segment under the root. */
function vaultIdOf(relative: string | null): string | null {
  if (!relative) return null;
  const first = relative.split(/[\\/]/)[0];
  return first && isId(first) ? first : null;
}

/** Snapshot of a root's vault files (name, size, mtime) for the polling fallback. */
function signature(root: string): Map<string, string> {
  const result = new Map<string, string>();
  let vaults: string[] = [];
  try {
    vaults = fs.readdirSync(root).filter(isId);
  } catch {
    return result;
  }
  for (const vaultId of vaults) {
    const logDir = path.join(root, vaultId, 'log');
    let parts: string[] = [];
    try {
      parts = fs.readdirSync(logDir).sort().map((name) => {
        const stat = fs.statSync(path.join(logDir, name));
        return `${name}:${stat.size}:${stat.mtimeMs}`;
      });
    } catch {
      // The vault folder is being created or removed; the next poll sees it.
    }
    result.set(vaultId, parts.join('|'));
  }
  return result;
}

/**
 * Watches vault folders for changes that sync tools (Dropbox, iCloud, Syncthing, Git…) bring in,
 * and reports which vault changed. Uses recursive fs.watch where the platform has it, else polls.
 */
export class VaultWatcher {
  private watchers: fs.FSWatcher[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private signatures = new Map<string, Map<string, string>>();

  constructor(private readonly options: VaultWatcherOptions) {}

  /** (Re)starts watching the current roots; call again after the team folder changes. */
  start(): void {
    this.stop();
    const pollRoots: string[] = [];
    for (const root of this.options.roots()) {
      try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => this.changed(vaultIdOf(filename ? String(filename) : null)));
        watcher.on('error', (err) => {
          this.options.log(`Stopped watching ${root} (${err.message}); checking it every ${POLL_MS / 1000} s instead.`);
          watcher.close();
          this.startPolling([root]);
        });
        this.watchers.push(watcher);
      } catch {
        pollRoots.push(root);
      }
    }
    if (pollRoots.length > 0) this.startPolling(pollRoots);
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.signatures.clear();
  }

  private startPolling(roots: string[]): void {
    for (const root of roots) this.signatures.set(root, signature(root));
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      for (const [root, before] of this.signatures) {
        const now = signature(root);
        for (const vaultId of new Set([...before.keys(), ...now.keys()])) if (before.get(vaultId) !== now.get(vaultId)) this.changed(vaultId);
        this.signatures.set(root, now);
      }
    }, POLL_MS);
    this.pollTimer.unref();
  }

  private changed(vaultId: string | null): void {
    if (!vaultId) return;
    clearTimeout(this.pending.get(vaultId));
    const timer = setTimeout(() => {
      this.pending.delete(vaultId);
      this.options.onChange(vaultId);
    }, DEBOUNCE_MS);
    timer.unref();
    this.pending.set(vaultId, timer);
  }
}
