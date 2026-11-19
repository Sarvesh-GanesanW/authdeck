// @ts-nocheck PoC script, run as is by the round-6 tests
// Helpers for live-store PoCs: a temp AUTHDECK-style home with a team folder and a VaultStore.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { VaultStore } = await import(new URL('../../../src/vaultStore.ts', import.meta.url).href);
export function tempStore(tag: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `authdeck-${tag}-`));
  fs.mkdirSync(path.join(home, 'team'));
  const warnings: string[] = [];
  const store = new VaultStore({ personal: path.join(home, 'vault'), team: () => path.join(home, 'team') }, (l: string) => warnings.push(l));
  const dir = (id: string) => path.join(home, 'team', id);
  /** Writes logs straight into the folder (as a synced folder would hold them). */
  const writeFolder = (id: string, logs: Record<string, string[]>) => {
    fs.mkdirSync(path.join(dir(id), 'log'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir(id), 'vault.json'), JSON.stringify({ v: 1, vaultId: id, kind: 'team' }));
    for (const [d, ls] of Object.entries(logs)) fs.writeFileSync(path.join(dir(id), 'log', `${d}.jsonl`), ls.join('\n') + '\n');
  };
  const readFolder = (id: string) => {
    const out: Record<string, string[]> = {};
    for (const f of fs.readdirSync(path.join(dir(id), 'log'))) if (f.endsWith('.jsonl')) out[f.slice(0, -6)] = fs.readFileSync(path.join(dir(id), 'log', f), 'utf8').split('\n').filter(Boolean);
    return out;
  };
  const cleanup = () => fs.rmSync(home, { recursive: true, force: true });
  return { home, store, dir, writeFolder, readFolder, cleanup, warnings };
}
