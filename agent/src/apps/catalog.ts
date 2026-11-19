import type { AppEntry } from '../protocol';
import { byName, type InstalledApp } from './types';

export type AppScanner = () => Promise<InstalledApp[]>;

/** Cached list of installed apps. Scans are shared: concurrent callers wait for the same scan. */
export class AppCatalog {
  private apps: InstalledApp[] = [];
  private byId = new Map<string, InstalledApp>();
  private scanning: Promise<void> | null = null;
  private scannedOnce = false;

  constructor(
    private readonly scanner: AppScanner,
    private readonly onChange: () => void = () => {},
  ) {}

  /** Rescans; calls onChange when the list differs from the previous scan (not on the first one). */
  rescan(): Promise<void> {
    this.scanning ??= this.scanner()
      .then((found) => {
        const next = [...found].sort(byName);
        const changed = this.scannedOnce && fingerprint(next) !== fingerprint(this.apps);
        this.apps = next;
        this.byId = new Map(next.map((app) => [app.entry.id, app]));
        this.scannedOnce = true;
        if (changed) this.onChange();
      })
      .finally(() => {
        this.scanning = null;
      });
    return this.scanning;
  }

  async list(refresh = false): Promise<AppEntry[]> {
    if (refresh || !this.scannedOnce) await this.rescan();
    else if (this.scanning) await this.scanning;
    return this.apps.map((app) => app.entry);
  }

  /** Looks an app up by id, waiting for the first scan if it is still running. */
  async get(id: string): Promise<InstalledApp | undefined> {
    if (!this.scannedOnce) await (this.scanning ?? this.rescan());
    return this.byId.get(id);
  }

  /** Current apps without waiting (used by focus polling). */
  snapshot(): readonly InstalledApp[] {
    return this.apps;
  }
}

function fingerprint(apps: readonly InstalledApp[]): string {
  return apps.map((app) => `${app.entry.id}\u0000${app.entry.name}`).join('\n');
}
