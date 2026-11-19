/**
 * What the agent remembers about env sets between runs, in <AuthDeck folder>/env/projects.json
 * (owner-only): the set files it has seen in working trees (it learns them from the CLI), and per
 * set the head it last accepted, so a file rolled back to an older member list or value is refused.
 * Never values, never keys.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { nextEnvTrust, type EnvTrust, type EnvVerifiedSet } from '../envcore';

export const REGISTRY_VERSION = 1;
/** Working trees are forgotten oldest first past this many set files; accepted heads are never forgotten. */
export const MAX_KNOWN_SET_FILES = 512;

/** One set file in one working tree. A set cloned twice is two of these. */
export interface KnownSetFile {
  path: string;
  repoRoot: string;
  /** The origin remote, credentials removed ("github.com/acme/api"). */
  remote: string | null;
  setId: string;
  name: string;
  lastReleaseAt: number | null;
  /** When the CLI last named it; the oldest go first past MAX_KNOWN_SET_FILES. */
  seenAt: number;
}

interface RegistryData {
  v: typeof REGISTRY_VERSION;
  files: KnownSetFile[];
  heads: Record<string, EnvTrust>;
}

export class RegistryUnreadable extends Error {
  constructor(file: string, detail: string) {
    super(`${file} can't be read (${detail}). Env sets stay off so a rolled-back set file can't slip through; move the file aside to start over.`);
    this.name = 'RegistryUnreadable';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKnownSetFile(value: unknown): value is KnownSetFile {
  return (
    isObject(value) &&
    typeof value.path === 'string' &&
    typeof value.repoRoot === 'string' &&
    (value.remote === null || typeof value.remote === 'string') &&
    typeof value.setId === 'string' &&
    typeof value.name === 'string' &&
    (value.lastReleaseAt === null || typeof value.lastReleaseAt === 'number') &&
    typeof value.seenAt === 'number'
  );
}

function isTrust(setId: string, value: unknown): value is EnvTrust {
  return isObject(value) && isObject(value.head) && value.head.set === setId && isObject(value.header);
}

export class ProjectRegistry {
  private constructor(
    private readonly file: string,
    private data: RegistryData,
  ) {}

  /** Reads the registry, or starts an empty one. Throws RegistryUnreadable rather than forget accepted heads. */
  static load(file: string): ProjectRegistry {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new ProjectRegistry(file, { v: REGISTRY_VERSION, files: [], heads: {} });
      throw new RegistryUnreadable(file, (err as NodeJS.ErrnoException).code ?? 'read failed');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new RegistryUnreadable(file, 'not JSON');
    }
    if (!isObject(value) || value.v !== REGISTRY_VERSION) throw new RegistryUnreadable(file, 'unknown version');
    if (!Array.isArray(value.files) || !value.files.every(isKnownSetFile)) throw new RegistryUnreadable(file, 'malformed working trees');
    if (!isObject(value.heads) || !Object.entries(value.heads).every(([setId, trust]) => isTrust(setId, trust))) throw new RegistryUnreadable(file, 'malformed heads');
    return new ProjectRegistry(file, value as unknown as RegistryData);
  }

  files(): readonly KnownSetFile[] {
    return this.data.files;
  }

  find(filePath: string, setId: string): KnownSetFile | null {
    return this.data.files.find((known) => known.path === filePath && known.setId === setId) ?? null;
  }

  atPath(filePath: string): KnownSetFile | null {
    return this.data.files.find((known) => known.path === filePath) ?? null;
  }

  /**
   * Notes a set file the CLI named (or a device created). A different set at a known path replaces
   * it. True when the list of sets changed (devices are told to read it again).
   */
  learn(entry: Omit<KnownSetFile, 'lastReleaseAt' | 'seenAt'>, now: number): boolean {
    const existing = this.atPath(entry.path);
    const changed = !existing || existing.setId !== entry.setId || existing.name !== entry.name || existing.repoRoot !== entry.repoRoot || existing.remote !== entry.remote;
    const kept = existing && existing.setId === entry.setId ? existing.lastReleaseAt : null;
    this.data.files = this.data.files.filter((known) => known.path !== entry.path);
    this.data.files.push({ ...entry, lastReleaseAt: kept, seenAt: now });
    if (this.data.files.length > MAX_KNOWN_SET_FILES) {
      this.data.files.sort((a, b) => a.seenAt - b.seenAt);
      this.data.files.splice(0, this.data.files.length - MAX_KNOWN_SET_FILES);
    }
    this.save();
    return changed;
  }

  noteRelease(filePath: string, at: number): void {
    const known = this.atPath(filePath);
    if (!known) return;
    known.lastReleaseAt = at;
    this.save();
  }

  trust(setId: string): EnvTrust | null {
    return this.data.heads[setId] ?? null;
  }

  /** Remembers a file verifyEnvFile accepted against trust(setId), so nothing older is accepted after it. */
  accept(verified: EnvVerifiedSet): void {
    const setId = verified.file.header.set;
    const previous = this.trust(setId);
    const next = nextEnvTrust(previous, verified);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    this.data.heads[setId] = next;
    this.save();
  }

  private save(): void {
    const folder = path.dirname(this.file);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.data)}\n`, { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temp, this.file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}
