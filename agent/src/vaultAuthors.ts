/**
 * Which paired device (link device) sent each vault identity's lines to this computer, per vault.
 * A device removed from a vault is then also unpaired here: a stolen phone that is still paired
 * could otherwise go on pressing keys and running commands on this computer.
 *
 * Kept in the agent's home folder, never in the vault folder, which other computers sync.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isId } from './vault/entry';

const FILE_NAME = 'vault-authors.json';
const FILE_VERSION = 1;
/** Far more than MAX_VAULTS vaults of 256 identities each take. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Paired device ids are the app's own text, at most this long (link/handshakes.ts). */
const MAX_LINK_DEVICE_ID_LENGTH = 200;
/** Vaults remembered; a device that keeps making new vaults can't grow the file without end. */
export const MAX_VAULTS = 1024;

type Authors = Map<string, Map<string, string>>;

function isLinkDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LINK_DEVICE_ID_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The stored map, keeping only well-formed vault ids, identity ids and link device ids. */
function parseAuthors(text: string): Authors {
  const stored: unknown = JSON.parse(text);
  const authors: Authors = new Map();
  if (!isRecord(stored) || stored.v !== FILE_VERSION || !isRecord(stored.vaults)) return authors;
  for (const [vaultId, identities] of Object.entries(stored.vaults)) {
    if (!isId(vaultId) || !isRecord(identities) || authors.size >= MAX_VAULTS) continue;
    const byIdentity = new Map<string, string>();
    for (const [identity, linkDevice] of Object.entries(identities)) {
      if (isId(identity) && isLinkDeviceId(linkDevice)) byIdentity.set(identity, linkDevice);
    }
    authors.set(vaultId, byIdentity);
  }
  return authors;
}

function serializeAuthors(authors: Authors): string {
  const vaults: Record<string, Record<string, string>> = {};
  for (const [vaultId, byIdentity] of authors) vaults[vaultId] = Object.fromEntries(byIdentity);
  return `${JSON.stringify({ v: FILE_VERSION, vaults })}\n`;
}

export class VaultAuthors {
  private constructor(
    private readonly file: string,
    private readonly authors: Authors,
    private readonly log: (line: string) => void,
  ) {}

  /**
   * Loads `<home>/vault-authors.json`. A missing file is an empty map; a damaged or oversized one
   * is logged and replaced on the next write: the worst that costs is a removal that says
   * "unpair it in AuthDeck Agent" instead of unpairing by itself.
   */
  static load(home: string, log: (line: string) => void): VaultAuthors {
    const file = path.join(home, FILE_NAME);
    let authors: Authors = new Map();
    try {
      if (fs.existsSync(file)) {
        if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('the file is too large');
        authors = parseAuthors(fs.readFileSync(file, 'utf8'));
      }
    } catch (err) {
      log(`Could not read ${file} (${(err as Error).message}); devices removed from a vault will be unpaired again once they send a change through this computer.`);
    }
    return new VaultAuthors(file, authors, log);
  }

  /** The paired device that last sent lines of `identity` in this vault, if any. */
  linkDeviceOf(vaultId: string, identity: string): string | undefined {
    return this.authors.get(vaultId)?.get(identity);
  }

  /** Notes that `linkDevice` sent lines of these identities. Writes the file only when something changed. */
  record(vaultId: string, identities: Iterable<string>, linkDevice: string): void {
    if (!isId(vaultId) || !isLinkDeviceId(linkDevice)) return;
    let byIdentity = this.authors.get(vaultId);
    if (!byIdentity) {
      if (this.authors.size >= MAX_VAULTS) return;
      byIdentity = new Map();
      this.authors.set(vaultId, byIdentity);
    }
    let changed = false;
    for (const identity of identities) {
      if (!isId(identity) || byIdentity.get(identity) === linkDevice) continue;
      byIdentity.set(identity, linkDevice);
      changed = true;
    }
    if (changed) this.save();
  }

  private save(): void {
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, serializeAuthors(this.authors), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.file);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      // The map stays right in memory; only a restart before the next good write forgets it.
      this.log(`Could not save ${this.file}: ${(err as Error).message}`);
    }
  }
}
