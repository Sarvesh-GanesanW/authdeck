/**
 * Builds what screens see (VaultSnapshot) from the engine's state. Pure; holds no secrets beyond
 * what it is handed and returns none.
 */
import type { DeviceView, VaultSnapshot, VaultWarning } from '../contract';
import { fromBase64Url } from '../../vault/bytes';
import type { Rejection } from '../../vault/chain';
import { keyWords } from '../../vault/crypto';
import type { OpenVault } from '../../vault/open';
import { prevKeyProblems } from '../../vault/prevKeyCheck';
import type { VaultState } from '../../vault/replay';
import { findBadSeals, judgeSealProof, type BadSeal, type SealProof, type SealVerdicts } from '../../vault/sealProof';
import { sortAccounts, toAccountView } from './accounts';
import { listCaughtChanges } from './caught';
import { listVoidedChanges } from './voided';
import { buildHistory } from './history';
import type { VaultPrefs } from './localCopy';
import type { LocalLogs } from './sync';

export interface SnapshotInput {
  loaded: boolean;
  prefs: VaultPrefs;
  state: VaultState | null;
  /** Set while the vault is open. */
  open: OpenVault | null;
  thisDevice: string | null;
  folderRejections: Rejection[];
  readAt: number;
  /** A checked solo phrase change the computer doesn't hold yet. */
  phrasePending?: boolean;
  /** A replacement vault ("I don't have my phrase") is still being saved to the computer. */
  replacing?: boolean;
  rollbackWarning: string | null;
  lockAt: number | null;
  computerName: string | null;
  computerOnline: boolean;
  /** Device -> the time on its latest valid beacon. */
  heardAt: Record<string, number>;
  /** Devices proven to have signed two histories. */
  forked: ReadonlySet<string>;
  warnings: VaultWarning[];
  secretsPaused: boolean;
  /** Who removed this device, as a sentence (removed.ts), or null while it is in the vault. */
  removed: string | null;
  /** This removed device holds a removal of its own remover that the computer hasn't taken yet (removed.ts). */
  heldRemoval: boolean;
  /** App lock is on and this device can't prompt any more (appLock.ts), or null. */
  appLockBlocked?: string | null;
  /** The local copy of the logs, which holds the caught changes' lines. */
  logs: LocalLogs;
  /** Caught changes re-applied or dismissed on this device. */
  handledCaught: ReadonlySet<string>;
  /** Seal proofs from the folder and this device (sealProof.ts); only those that hold are shown. None when absent. */
  sealProofs?: readonly SealProof[];
  /** Seal verdicts already reached, kept by the engine across replays. */
  sealVerdicts?: SealVerdicts;
}

/** When each device was added: its vault.create or first applied device.add. */
function addedTimes(state: VaultState): Map<string, number> {
  const times = new Map<string, number>();
  for (const item of state.history) {
    if (item.status !== 'applied' || !item.subject) continue;
    if ((item.kind === 'vault.create' || item.kind === 'device.add') && !times.has(item.subject)) times.set(item.subject, item.time);
  }
  return times;
}

/** The later of its beacon and its latest applied change, both by its own clock. */
function lastHeard(state: VaultState, heardAt: Record<string, number>, deviceId: string): number | null {
  const times = [heardAt[deviceId], state.appliedHeads[deviceId]?.time].filter((t): t is number => t !== undefined);
  return times.length === 0 ? null : Math.max(...times);
}

export function deviceViews(
  state: VaultState,
  open: OpenVault,
  thisDevice: string | null,
  heardAt: Record<string, number> = {},
  forked: ReadonlySet<string> = new Set(),
): DeviceView[] {
  const added = addedTimes(state);
  return Object.values(state.members)
    .filter((m) => !m.removed)
    .map((m) => ({
      id: m.deviceId,
      name: open.deviceNames[m.deviceId] ?? 'Unnamed device',
      keyWords: keyWords(fromBase64Url(m.ed)).join(' '),
      thisDevice: m.deviceId === thisDevice,
      role: m.role,
      addedAt: added.get(m.deviceId) ?? 0,
      lastHeardAt: lastHeard(state, heardAt, m.deviceId),
      signedTwoHistories: forked.has(m.deviceId),
    }))
    .sort((a, b) => Number(b.thisDevice) - Number(a.thisDevice) || a.addedAt - b.addedAt);
}

/** Last result per replay, so a snapshot rebuilt for the same vault doesn't open every epoch again. */
const prevKeyCache = new WeakMap<VaultState, { open: OpenVault; warnings: VaultWarning[] }>();

/**
 * Key changes whose copy of the previous key doesn't open on this device, which holds both keys:
 * devices that join later can't read older accounts. Names the device that wrote each.
 */
export function prevKeyWarnings(state: VaultState, open: OpenVault, logs: LocalLogs): VaultWarning[] {
  const cached = prevKeyCache.get(state);
  if (cached?.open === open) return cached.warnings;
  const warnings = prevKeyProblems(state, open.keys, logs).map((problem): VaultWarning => {
    const writer = open.deviceNames[problem.author] ?? 'Unnamed device';
    return {
      id: `prev-key-${problem.hash}`,
      kind: 'prev-key',
      text: `${writer} changed the vault key with a copy of the previous key that doesn't open. Devices that join from now on can't read accounts last changed before that. If you don't trust ${writer}, remove it; then change those accounts again so new devices can read them.`,
      deviceId: problem.author,
    };
  });
  prevKeyCache.set(state, { open, warnings });
  return warnings;
}

const NO_SEAL_PROOFS: readonly SealProof[] = [];

/** Last result per replay, like prevKeyCache: judging seals takes a scalar multiplication each. */
const badSealCache = new WeakMap<VaultState, { open: OpenVault; proofs: readonly SealProof[]; seals: BadSeal[] }>();

/**
 * Bad seals this device knows of: the ones it finds wrong itself, holding their key, and the
 * ones a valid proof shows (made by their recipient, here or on another device). Once each.
 */
export function knownBadSeals(state: VaultState, open: OpenVault, logs: LocalLogs, proofs: readonly SealProof[], verdicts: SealVerdicts): BadSeal[] {
  const cached = badSealCache.get(state);
  if (cached?.open === open && cached.proofs === proofs) return cached.seals;
  const byId = new Map<string, BadSeal>();
  for (const seal of findBadSeals(state, logs, open.keys, verdicts)) byId.set(`${seal.hash}:${seal.to}`, seal);
  for (const proof of proofs) {
    const id = `${proof.entry}:${proof.to}`;
    if (byId.has(id)) continue;
    const judged = judgeSealProof(state, logs, proof);
    if (judged.ok) byId.set(id, { hash: judged.hash, author: judged.author, seq: judged.seq, to: judged.to, epoch: judged.epoch });
  }
  const seals = [...byId.values()];
  badSealCache.set(state, { open, proofs, seals });
  return seals;
}

/** A bad seal in the change that made the current key: someone in the vault can't read new secrets. */
export function badSealAtCurrentKey(state: VaultState, seals: readonly BadSeal[]): boolean {
  return seals.some((seal) => seal.epoch === state.epoch);
}

function recipientName(state: VaultState, open: OpenVault, thisDevice: string | null, id: string): string {
  if (id === thisDevice) return 'this device';
  if (id === state.recovery?.deviceId) return 'the recovery phrase';
  return open.deviceNames[id] ?? 'Unnamed device';
}

/**
 * One warning per entry holding bad seals: who wrote it, whom the key that doesn't open was
 * given to, and what follows. Neutral: it says what the vault shows, not why.
 */
export function badSealWarnings(state: VaultState, open: OpenVault, thisDevice: string | null, seals: readonly BadSeal[]): VaultWarning[] {
  const byEntry = new Map<string, BadSeal[]>();
  for (const seal of seals) byEntry.set(seal.hash, [...(byEntry.get(seal.hash) ?? []), seal]);
  return [...byEntry.entries()].map(([hash, group]): VaultWarning => {
    const { author } = group[0]!;
    const writer = open.deviceNames[author] ?? 'Unnamed device';
    const names = group.map((seal) => recipientName(state, open, thisDevice, seal.to)).join(', ');
    const approval = state.history.find((h) => h.hash === hash)?.kind === 'device.add';
    const what = approval
      ? `${writer} approved ${names} with a copy of the vault key that does not open.`
      : `${writer} changed the vault key, and the copy it gave ${names} does not open, so ${group.length === 1 ? 'it' : 'they'} can't read accounts saved after that.`;
    const here =
      group.some((seal) => seal.to === thisDevice) && open.readOnly !== null
        ? ' This device shows codes as of the last key it could open; it can remove a device, but not change accounts.'
        : '';
    const next = group.some((seal) => seal.epoch === state.epoch) ? ' An admin device that holds the key makes a fresh one by itself.' : '';
    return { id: `bad-seal-${hash}`, kind: 'bad-seal', text: `${what}${here}${next} If you don't trust ${writer}, remove it.`, deviceId: author };
  });
}

function lastChange(state: VaultState | null): number | null {
  const times = state?.history.filter((h) => h.status === 'applied').map((h) => h.time) ?? [];
  return times.length === 0 ? null : Math.max(...times);
}

export function buildSnapshot(input: SnapshotInput): VaultSnapshot {
  const { prefs, state, open } = input;
  const status: VaultSnapshot['status'] = !input.loaded ? 'loading' : !prefs.vaultId ? 'none' : open ? 'open' : 'locked';
  const team = state?.kind === 'team' ? (open?.name ?? 'Team vault') : null;
  const isOpen = status === 'open' && state !== null && open !== null;
  return {
    status,
    name: open?.name ?? '',
    accounts: isOpen ? sortAccounts(Object.values(open.accounts)).map((a) => toAccountView(a, team)) : [],
    devices: isOpen ? deviceViews(state, open, input.thisDevice, input.heardAt, input.forked) : [],
    history: isOpen
      ? buildHistory({
          state,
          keys: open.keys,
          deviceNames: open.deviceNames,
          folderRejections: input.folderRejections,
          unreadable: open.rejected,
          readAt: input.readAt,
        })
      : [],
    // A removed device can't write, so it has nothing to re-apply.
    caughtChanges:
      isOpen && input.removed === null
        ? listCaughtChanges({
            state,
            logs: input.logs,
            keys: open.keys,
            deviceNames: open.deviceNames,
            accounts: open.accounts,
            handled: input.handledCaught,
          }).map((c) => c.view)
        : [],
    // Redone or dismissed voided changes share the caught-changes handled set (ids are entry hashes).
    voidedChanges: isOpen
      ? listVoidedChanges({ state, logs: input.logs, deviceNames: open.deviceNames, me: input.thisDevice, handled: input.handledCaught })
      : [],
    chainOk: input.folderRejections.length === 0 && input.rollbackWarning === null,
    rollbackWarning: input.rollbackWarning,
    recovery: {
      savedAt: prefs.recoverySavedAt,
      ...(input.phrasePending ? { pending: true } : {}),
      ...(input.replacing ? { finishing: true } : {}),
      ...(neverSet(state, input.thisDevice, prefs.recoverySavedAt) ? { neverSet: true } : {}),
    },
    storage: {
      computerName: input.computerName,
      path: prefs.vaultId ? prefs.folderPath : null,
      syncedAt: prefs.vaultId && input.readAt > 0 ? input.readAt : null,
    },
    lastChangeAt: lastChange(state),
    appLock: prefs.appLock,
    autoLockMs: prefs.autoLockMs,
    locksAt: isOpen ? input.lockAt : null,
    computerOnline: input.computerOnline,
    warnings: isOpen
      ? [
          ...input.warnings,
          ...prevKeyWarnings(state, open, input.logs),
          ...badSealWarnings(
            state,
            open,
            input.thisDevice,
            knownBadSeals(state, open, input.logs, input.sealProofs ?? NO_SEAL_PROOFS, input.sealVerdicts ?? new Map()),
          ),
        ]
      : // L2: a device that lost its place says so while locked too.
        input.warnings.filter((w) => w.kind === 'lost-own-line'),
    secretsPaused: input.secretsPaused || input.removed !== null,
    removed: input.removed,
    heldRemoval: input.heldRemoval,
    appLockBlocked: input.appLockBlocked ?? null,
  };
}

/**
 * A solo vault this device made whose phrase was never checked (setup stopped before the words
 * were shown or checked): nothing but this device opens it. A restored device was added by the
 * phrase, so it knows a phrase; it is never this.
 */
function neverSet(state: VaultState | null, self: string | null, savedAt: number | null): boolean {
  if (!state || !self || savedAt !== null || state.kind !== 'solo') return false;
  const member = Object.hasOwn(state.members, self) ? state.members[self]! : null;
  return member !== null && member.addedBy === self && member.removed !== true;
}
