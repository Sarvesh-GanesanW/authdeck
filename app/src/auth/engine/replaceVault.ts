/**
 * "I don't have my phrase" (solo vaults). A solo vault's phrase can only be replaced with the
 * current one (a recovery.set the recovery identity signs), so a person who never kept the first
 * phrase gets a new vault instead: a new solo vault holding every account of the old one, with a
 * new phrase, after which the old vault is retired. The vault rules are unchanged; this is a new
 * vault, not a change to the old one.
 *
 * Order, so a stop at any point leaves at least one vault that opens:
 * 1. buildReplacement: the new vault's lines and phrase, in memory only. Nothing is sent and the
 *    old vault is untouched until the new words are checked.
 * 2. After the check, the engine saves the new lines (as the new vault's local logs) and a record
 *    "old replaced by new", then runs finishReplacement.
 * 3. finishReplacement sends the lines, reads the new folder back and checks it holds them and
 *    every account of the old vault (topping up, as new lines saved before they go, any account
 *    the old vault changed since), and only then switches this device to the new vault.
 * 4. Then the computer sets the old folder aside (vault.retire, signed by this device as the old
 *    vault's device; it keeps it 30 days and tells its user) and this device forgets its old
 *    copy; the record goes last. A stop anywhere before that is finished on the next start or
 *    sync, on the same computer only.
 * Pure apart from the steps it is given, so every stop point is testable.
 */
import type { RandomBytes } from '../../vault/bytes';
import type { DeviceKeys } from '../../vault/crypto';
import { afterOwnEntry, buildAccountDelete, buildAccountPut, createVault } from '../../vault/build';
import { entryHash, serializeEntry, type SignedEntry } from '../../vault/entry';
import { openVault, type AccountRecord, type OpenAccount } from '../../vault/open';
import { buildRecoverySetFromPhrase, generateRecoveryPhrase } from '../../vault/recovery';
import type { VaultState } from '../../vault/replay';
import type { LocalLogs } from './sync';

/** Stored while a replacement is under way: the old vault was replaced by the new one. */
export interface VaultReplacement {
  oldVaultId: string;
  newVaultId: string;
  /** The computer the new words were confirmed with: the run finishes only there. */
  agentId: string;
}

export const NOT_READ_BACK = "The new vault on the computer doesn't read back as it was sent, so the old vault is kept. AuthDeck tries again on the next sync.";
const NOT_SOLO = 'Only a vault kept on one device can be replaced without its phrase.';

type Replay = (vaultId: string, logs: LocalLogs) => VaultState;

/** The new solo vault's lines (create, phrase, every account) and its phrase. Nothing is stored or sent. */
export function buildReplacement(input: {
  device: DeviceKeys;
  name: string;
  deviceName: string;
  accounts: readonly OpenAccount[];
  random: RandomBytes;
  time: number;
  replay: Replay;
}): { vaultId: string; lines: string[]; phrase: string[] } {
  const { device, random, time, replay } = input;
  const created = createVault({ founder: device, kind: 'solo', name: input.name, deviceName: input.deviceName, random, time });
  const founded = replay(created.vaultId, { [device.deviceId]: [serializeEntry(created.entry)] });
  const phrase = generateRecoveryPhrase(random);
  const set = buildRecoverySetFromPhrase(founded, device, { phrase, currentKey: created.key, random, time });
  created.key.fill(0);
  const lines = [created.entry, set.entry].map(serializeEntry);
  const state = replay(created.vaultId, { [device.deviceId]: lines });
  const copies = accountChanges(state, device, set.newKey, input.accounts, {}, random, time);
  set.newKey.fill(0);
  return { vaultId: created.vaultId, lines: [...lines, ...copies.map(serializeEntry)], phrase: phrase.split(' ') };
}

/** Puts for every account `want` holds that `have` lacks or holds differently, and deletes for the rest of `have`. */
function accountChanges(
  state: VaultState,
  device: DeviceKeys,
  currentKey: Uint8Array,
  want: readonly OpenAccount[],
  have: Readonly<Record<string, OpenAccount>>,
  random: RandomBytes,
  time: number,
): SignedEntry[] {
  const built: SignedEntry[] = [];
  let draft = state;
  const add = (entry: SignedEntry) => {
    built.push(entry);
    draft = afterOwnEntry(draft, entry);
  };
  const wanted = new Set<string>();
  for (const account of want) {
    wanted.add(account.id);
    const held = Object.hasOwn(have, account.id) ? have[account.id] : undefined;
    if (!held || !sameRecord(held.record, account.record)) add(buildAccountPut(draft, device, { account: account.id, record: account.record, currentKey, random, time }));
  }
  for (const id of Object.keys(have)) if (!wanted.has(id)) add(buildAccountDelete(draft, device, { account: id, time }));
  return built;
}

export function sameRecord(a: AccountRecord, b: AccountRecord): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof AccountRecord)[]);
  return [...keys].every((key) => a[key] === b[key]);
}

/** What finishReplacement needs from the engine; each step may throw (offline, a stop), and the record stays. */
export interface ReplaceSteps {
  /** The vault this device uses now. */
  current(): string | null;
  /** The computer connected now, or null. */
  agentId(): string | null;
  /** The old vault's accounts and this device's keys while the old vault is open here; null while it is locked. */
  openOld(): { device: DeviceKeys; accounts: readonly OpenAccount[] } | null;
  /** The new vault's lines kept on this device (its local log). */
  loadLines(vaultId: string): Promise<string[]>;
  saveLines(vaultId: string, lines: string[]): Promise<void>;
  /** vault.append in batches; lines the folder already holds change nothing. */
  send(vaultId: string, lines: string[]): Promise<void>;
  /** The whole folder; empty when the computer has none. */
  read(vaultId: string): Promise<LocalLogs>;
  replay: Replay;
  /** Makes the new vault this device's vault, from the folder just read. */
  adopt(vaultId: string, logs: LocalLogs, state: VaultState): Promise<void>;
  /** vault.retire for the old vault; a folder already gone counts as retired. Throws unless the computer answered a well-formed success. */
  retireOnComputer(oldVaultId: string, newVaultId: string): Promise<void>;
  /** Forgets this device's copy of a vault (logs and keys), never the device keys. */
  forgetLocal(vaultId: string): Promise<void>;
  /** Saves the record, or removes it (null). */
  save(record: VaultReplacement | null): Promise<void>;
  random: RandomBytes;
  now(): number;
}

/**
 * Carries a saved replacement as far as it can go. 'waiting' when it needs the old vault open
 * (it is locked); throws, keeping the record, when a step fails.
 */
export async function finishReplacement(record: VaultReplacement, steps: ReplaceSteps): Promise<'done' | 'waiting'> {
  const current = steps.current();
  // Only on the computer the new words were confirmed with: another computer holds neither the new vault nor that request.
  if (current !== null && (current === record.oldVaultId || current === record.newVaultId) && steps.agentId() !== record.agentId) return 'waiting';
  if (current === record.oldVaultId) {
    const old = steps.openOld();
    if (!old) return 'waiting';
    await moveToNew(record, old, steps);
  } else if (current !== record.newVaultId) {
    // This device uses neither any more (say it forgot the vault): nothing is deleted.
    await steps.save(null);
    return 'done';
  }
  await steps.retireOnComputer(record.oldVaultId, record.newVaultId);
  await steps.forgetLocal(record.oldVaultId);
  await steps.save(null);
  return 'done';
}

/** Sends the new vault, checks it reads back with every old account, then switches to it. */
async function moveToNew(record: VaultReplacement, old: { device: DeviceKeys; accounts: readonly OpenAccount[] }, steps: ReplaceSteps): Promise<void> {
  const { newVaultId } = record;
  const { device } = old;
  // As built, then once more if the old vault changed since (a top-up); a third round is spare.
  for (let round = 0; round < 3; round++) {
    const lines = await steps.loadLines(newVaultId);
    if (lines.length === 0) throw new Error(NOT_READ_BACK);
    await steps.send(newVaultId, lines);
    const logs = await steps.read(newVaultId);
    const state = steps.replay(newVaultId, logs);
    if (!holdsLines(state, logs, device.deviceId, lines)) throw new Error(NOT_READ_BACK);
    if (state.kind !== 'solo') throw new Error(NOT_SOLO);
    const opened = openVault(state, device);
    try {
      if (opened.readOnly !== null) throw new Error(NOT_READ_BACK);
      const topUp = accountChanges(state, device, opened.currentKey, old.accounts, opened.accounts, steps.random, steps.now());
      if (topUp.length === 0) {
        await steps.adopt(newVaultId, logs, state);
        return;
      }
      // Kept before they go, so a stop resends these same bytes and never signs another line at their seq.
      await steps.saveLines(newVaultId, [...lines, ...topUp.map(serializeEntry)]);
    } finally {
      Object.values(opened.keys).forEach((key) => key.fill(0));
    }
  }
  throw new Error(NOT_READ_BACK);
}

/** The folder holds this device's lines as sent, and every one of them applied. */
function holdsLines(state: VaultState, logs: LocalLogs, deviceId: string, lines: readonly string[]): boolean {
  const folder = Object.hasOwn(logs, deviceId) ? logs[deviceId]! : [];
  if (folder.length < lines.length || lines.some((line, i) => folder[i] !== line)) return false;
  const applied = new Set(state.history.filter((h) => h.status === 'applied').map((h) => h.hash));
  return lines.every((line) => applied.has(entryHash(JSON.parse(line) as SignedEntry)));
}
