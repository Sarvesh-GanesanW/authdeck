/**
 * Bounded model of a solo vault (0.3.0): one device plus the recovery phrase R. Only R adds a
 * device (a restore: R's device.add, the new phone's hello, R's key.rotate), which cuts every
 * earlier device; only R changes the phrase; a device writes only its hello, account lines and
 * device.rename.
 *
 * Attackers, mixed:
 * - the thief holds the old phone F, with its keys and its stale copy: it signs any line kind on
 *   its copy or on the folder, forks itself, signs garbage and bad seals, and sends through the
 *   agent, writes straight into the folder, or holds lines back and releases them later;
 * - a phrase thief holds the old phrase R1 and acts once the owner has set a new one;
 * - a hostile computer withholds honest sends, rolls folder logs back, re-encodes lines, and adds
 *   junk lines, fork proofs and seal proofs.
 *
 * The honest owner uses the phone it holds (puts, deletes, renames, syncs), restores onto a new
 * phone with the current phrase at any point (twice at most), and may set a new phrase.
 * Invariants S1–S7 are in SOLO_INVARIANTS.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAccountDelete, buildAccountPut, buildDeviceAdd, buildDeviceHello, buildDeviceRemove, buildDeviceRename, buildKeyRotate, createVault, newAccountId } from '../../src/vault/build';
import { buildRecoverySetFromPhrase, recoveryKeysFromPhrase } from '../../src/vault/recovery';
import { entryHash, entrySignatureValid, serializeEntry, signEntry, type SignedEntry } from '../../src/vault/entry';
import { replayVault, type VaultState } from '../../src/vault/replay';
import { AppendRefused, planAppend } from '../../src/vault/logs';
import { openVault } from '../../src/vault/open';
import { keyCheck, type DeviceKeys } from '../../src/vault/crypto';
import { fromBase64Url, toBase64Url } from '../../src/vault/bytes';
import { findForks } from '../../src/vault/rollback';
import { VerifyCache, type ForkProof } from '../../src/vault/chain';
import type { SealProof } from '../../src/vault/sealProof';
import { vaultFeatures } from '../../src/vault/features';
import { ModelContext, seededRandom } from './context';

// ---------------------------------------------------------------- invariants

export const SOLO_INVARIANTS: Record<string, string> = {
  S1: 'One device: in every replay (the folder and the honest phone\'s copy) at most one non-recovery device is active (joined, not removed, not cut off, not forked).',
  S2: 'Only the phrase adds a device: every applied device.add is a restore signed by a recovery identity; its key.rotate (the add\'s seq + 1) is sealed only to the new device and R, or, while that rotate is missing, the vault needs a fresh key; every earlier device is cut.',
  S3: 'Device lines are limited: only device.hello, account.put, account.delete and device.rename by a device ever apply; every other kind by a device is refused by planAppend and rejected by replay, and the two agree on every line offered.',
  S4: 'The old phone is shut out: a restore with the current phrase always builds and is taken, whatever F did; afterwards every account applied in what R had seen stays (or an honest delete removed it), the restored phone reads it, F and every earlier device open no key from the rotate on, nothing F signs past its cut applies (its account lines are caught), and F, its forks, proofs and junk change nothing.',
  S5: 'Old phrases are dead: after a phrase change lands, the old phrase can\'t restore, sign an applied line past the change, or open the key from the change on.',
  S6: 'Copies converge: the same lines replay to the same state whatever the order of the logs or their bytes, and the honest phone\'s copy agrees with the folder on what both hold.',
  S8: 'The phrase never dies: after any mix of attacker moves (R double-signs included), whoever holds the phrase that is current in the folder can restore (the agent takes it and the new phone opens the key), and every copy agrees on which phrase is current.',
  S9: 'Deletes by the thief come back (review P3): an account the stolen phone deleted before the restore is, once the restore lands, still there, or its delete is marked for review (caught or voided) so the restored phone is offered it back.',
  S7: 'The computer can\'t sign: every applied line was signed by its author (an honest device, R, or a thief holding keys). A restore built on a rolled-back folder is reported with what it loses.',
};

export interface SoloViolation {
  invariant: keyof typeof SOLO_INVARIANTS | 'S7r';
  summary: string;
}

// ---------------------------------------------------------------- world

export interface SoloBounds {
  maxSteps: number;
  maxPuts: number;
  maxRestores: number;
  maxPhraseChanges: number;
  maxThief: number;
  maxPhraseThief: number;
  maxComputer: number;
  /** R double-signs: a second line of the current phrase at R's last seq (a restore from a second device, or a phrase change retried). */
  maxRFork: number;
  /** Which attackers take part. */
  thief: boolean;
  phraseThief: boolean;
  computer: boolean;
  /** Thief line kinds tried. */
  thiefKinds: readonly ThiefKind[];
}

export type ThiefKind = 'put' | 'delete' | 'rename' | 'add' | 'rotate' | 'recoverySet' | 'remove' | 'garbage' | 'badSeal' | 'fork' | 'forkProof' | 'truncate';
/** truncate: the thief, writing the folder, replaces the last line of F's log there with junk (its own log: it holds the keys and the folder). */
export const THIEF_KINDS: readonly ThiefKind[] = ['put', 'delete', 'rename', 'add', 'rotate', 'recoverySet', 'remove', 'garbage', 'badSeal', 'fork', 'forkProof', 'truncate'];
export type Delivery = 'agent' | 'direct' | 'hold';

export type SoloOp =
  | { t: 'put' }
  | { t: 'delete'; account: string }
  | { t: 'rename' }
  | { t: 'sync' }
  /** The owner restores onto a new phone with the current phrase, on what the folder holds. */
  | { t: 'restore' }
  /** The owner sets a new phrase (signed by the current R, on the honest phone's copy). */
  | { t: 'phrase' }
  | { t: 'steal' }
  | { t: 'thief'; kind: ThiefKind; basis: 'stale' | 'folder'; delivery: Delivery; target?: string }
  | { t: 'thiefRelease' }
  /** The old phrase R1 (stolen) once a new one is set: a restore onto its own phone, or a phrase change. */
  | { t: 'oldPhrase'; kind: 'restore' | 'phrase'; delivery: 'agent' | 'direct' }
  | { t: 'withhold' }
  | { t: 'computerRelease' }
  | { t: 'rollback'; label: string }
  | { t: 'reencode'; label: string }
  | { t: 'junkLine'; label: string }
  | { t: 'junkProof' }
  /** The owner tries a restore on another install; the computer keeps it (refused or never written). */
  | { t: 'keepRestore'; attempts?: number }
  /** Weeks later the computer writes a kept restore attempt straight into the folder (and the fork proof, where it collides). */
  | { t: 'writeKept'; best?: boolean }
  /**
   * R signs two lines at one seq: someone holding the current phrase (the owner's second device,
   * a retried phrase change, or a phrase thief) signs a restore onto Y or a phrase change to RZ on
   * the folder without R's last line. `direct`: it replaces that line in the folder, and the proof
   * is published; `proof`: only the proof is published, the folder keeps its line.
   */
  | {
      t: 'rFork';
      kind: 'restore' | 'phrase' | 'retry';
      delivery: 'direct' | 'proof';
      /** Grind: sign GRIND_TRIES versions (other times) and keep the one with the lowest hash, below the folder's version if it can. */
      grind?: boolean;
      /** Chain: also sign R's next line on its own version (a key.rotate whose prev is it), to look built on. */
      chain?: boolean;
      /** Old: the holder of the old phrase forks the owner's phrase change itself, at its seq, even after the new phrase has lines. */
      old?: boolean;
      /** Stale (with old): the old-phrase restore is built on the folder as it stood before the owner's phrase change (before P's ack). */
      stale?: boolean;
    };

interface Restore {
  device: string;
  phrase: string;
  /** Accounts applied in the state the restore was built on. */
  base: string[];
  /** Lines (label:seq) the honest phone had that the folder didn't, when the restore was built: what rolling back lost. */
  lost: string[];
  addHash: string;
  rotateHash: string;
  step: number;
  /** The post-adopt ack: once a folder read shows the restore applied and winning, the phone writes a device.rename; a restore that lost first is redone on the winner. */
  settled?: 'acked' | 'redone' | 'superseded';
  /** The phone that made it: a redo on the same phone keeps the first attempt's label here. */
  phone: string;
  /** Its three lines (add, hello, rotate), resent while the folder lacks them. */
  texts: string[];
}

export interface SoloWorld {
  readonly ctx: ModelContext;
  readonly vaultId: string;
  readonly bounds: SoloBounds;
  /** Every line each identity signed, in signing order (a fork shows as two lines at one seq). */
  signed: Record<string, string[]>;
  /** The folder: label -> texts. */
  folder: Record<string, string[]>;
  forks: ForkProof[];
  seals: SealProof[];
  /** The honest phone and its copy (canonical texts), with how many of its own lines are sent. */
  active: string;
  copy: Record<string, string[]>;
  sent: number;
  /** Honest lines the computer swallowed: label -> texts. */
  held: Record<string, string[]>;
  withholdNext: boolean;
  stolen: boolean;
  /** The thief's copy (stale, from the theft) and F's log as the thief holds it. */
  thiefCopy: Record<string, string[]>;
  thiefLog: string[];
  thiefHeld: boolean;
  /** The newest vault key F held when stolen, and the key the old phrase held when it was replaced (base64url). */
  thiefKey: string | null;
  oldPhraseKey: string | null;
  /** Hashes of the owner's phrase changes, and of P's acks of them. */
  phraseSets: string[];
  /** The folder as it stood just before each owner phrase change was offered (by the set's hash). */
  prePhrase: Record<string, Record<string, string[]>>;
  acks: string[];
  /** Restore attempts from the owner's other installs the computer kept instead of writing (texts by label), to write in later. */
  kept: { label: string; text: string; seq: number }[][];
  /** Hashes of the R lines (device.add) of every kept attempt, written in or not. */
  keptAdds: string[];
  /** The computer replaced or removed lines of R or of the phone in use that the folder held (a rewind). */
  rewound: boolean;
  phrase: string;
  phraseChanges: number;
  restores: Restore[];
  accounts: string[];
  deleted: string[];
  counters: { puts: number; thief: number; phraseThief: number; computer: number; rFork: number };
  /** Hashes of every line some key holder signed. */
  hashes: string[];
  /** Hashes signed by the old phrase after the owner replaced it. */
  oldPhraseLines: string[];
  /** Hashes the thief signed with F's keys after the theft. */
  thiefLines: string[];
  notes: SoloViolation[];
  trace: SoloOp[];
}

const DEVICE_LABELS = ['D1', 'D2', 'D3'];
export const GRIND_TRIES = 16;
const PHRASE_LABELS = ['R1', 'R2', 'R3'];
const TIME0 = 2_000_000;

function cloneWorld(w: SoloWorld): SoloWorld {
  const logs = (r: Record<string, string[]>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [...v]]));
  return {
    ...w,
    signed: logs(w.signed),
    folder: logs(w.folder),
    forks: [...w.forks],
    seals: [...w.seals],
    copy: logs(w.copy),
    held: logs(w.held),
    thiefCopy: logs(w.thiefCopy),
    thiefLog: [...w.thiefLog],
    restores: w.restores.map((r) => ({ ...r })),
    phraseSets: [...w.phraseSets],
    prePhrase: { ...w.prePhrase },
    acks: [...w.acks],
    kept: w.kept.map((k) => [...k]),
    keptAdds: [...w.keptAdds],
    rewound: w.rewound,
    accounts: [...w.accounts],
    deleted: [...w.deleted],
    counters: { ...w.counters },
    hashes: [...w.hashes],
    oldPhraseLines: [...w.oldPhraseLines],
    thiefLines: [...w.thiefLines],
    notes: [...w.notes],
    trace: [...w.trace],
  };
}

function keysOf(w: SoloWorld, label: string): DeviceKeys {
  return label.startsWith('R') ? w.ctx.recovery(label, w.vaultId).keys : w.ctx.device(label);
}

function idOf(w: SoloWorld, label: string): string {
  return keysOf(w, label).deviceId;
}

function labelOf(w: SoloWorld, id: string): string {
  return w.ctx.labelOf(id);
}

function toIds(w: SoloWorld, logs: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [label, texts] of Object.entries(logs)) if (texts.length > 0) out[idOf(w, label)] = texts;
  return out;
}

function toLabels(w: SoloWorld, logs: Record<string, readonly string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, texts] of Object.entries(logs)) out[labelOf(w, id)] = [...texts];
  return out;
}

const cache = new VerifyCache();
const replays = new Map<string, VaultState>();

function digest(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('base64');
}

function replayOf(w: SoloWorld, logs: Record<string, string[]>, proofs = true): VaultState {
  const ids = toIds(w, logs);
  const forks = proofs ? w.forks : [];
  const seals = proofs ? w.seals : [];
  const key = digest([w.vaultId, ids, forks, seals]);
  const hit = replays.get(key);
  if (hit) return hit;
  if (replays.size > 20_000) replays.clear();
  const state = replayVault(w.vaultId, ids, { cache, ...(forks.length ? { forks } : {}), ...(seals.length ? { sealProofs: seals } : {}) } as Parameters<typeof replayVault>[2]);
  replays.set(key, state);
  return state;
}

function canonical(text: string): string {
  try {
    return serializeEntry(JSON.parse(text) as SignedEntry);
  } catch {
    return text;
  }
}

function hashOfText(text: string): string | null {
  try {
    return entryHash(JSON.parse(text) as SignedEntry);
  } catch {
    return null;
  }
}

function folderState(w: SoloWorld): VaultState {
  return replayOf(w, w.folder);
}

function copyState(w: SoloWorld): VaultState {
  return replayOf(w, w.copy);
}

/** The key `label` opens for the vault's current epoch (keyCheck-matched), or null; `readOnly` allows the fallback. */
function heldKey(state: VaultState, keys: DeviceKeys, readOnly = false): Uint8Array | null {
  try {
    const opened = openVault(state, keys) as { currentKey?: Uint8Array; epoch?: number; readOnly?: string | null };
    const key = opened.currentKey ?? null;
    if (!key) return null;
    if (opened.readOnly && !readOnly) return null;
    const epoch = opened.epoch ?? state.epoch;
    if (state.keyChecks[epoch] !== undefined && keyCheck(key, state.vaultId, epoch) !== state.keyChecks[epoch]) return null;
    return key;
  } catch {
    return null;
  }
}

function statusOf(state: VaultState, hash: string): { status: string; caught: boolean } {
  const h = state.history.find((x) => x.hash === hash);
  return h ? { status: h.status, caught: !!h.caught } : { status: 'absent', caught: false };
}

function stepTime(w: SoloWorld): number {
  return TIME0 + w.trace.length * 1000;
}

function randomFor(w: SoloWorld, op: SoloOp, salt = ''): ReturnType<typeof seededRandom> {
  return seededRandom(`${w.ctx.seed}/solo/${w.trace.length}/${JSON.stringify(op)}/${salt}`);
}

function note(w: SoloWorld, invariant: SoloViolation['invariant'], summary: string): void {
  w.notes.push({ invariant, summary });
}

function signedBy(w: SoloWorld, label: string, entry: SignedEntry): string {
  const text = serializeEntry(entry);
  (w.signed[label] ??= []).push(text);
  w.hashes.push(entryHash(entry));
  return text;
}

export function newSoloWorld(ctx: ModelContext, bounds: SoloBounds): SoloWorld {
  const founder = ctx.device('F');
  const created = createVault({ founder, kind: 'solo', name: 'Home', deviceName: 'Phone', random: seededRandom(`${ctx.seed}/solo/create`), time: TIME0 - 2000 });
  const vaultId = created.vaultId;
  const w: SoloWorld = {
    ctx,
    vaultId,
    bounds,
    signed: {},
    folder: {},
    forks: [],
    seals: [],
    active: 'F',
    copy: {},
    sent: 0,
    held: {},
    withholdNext: false,
    stolen: false,
    thiefCopy: {},
    thiefLog: [],
    thiefHeld: false,
    thiefKey: null,
    oldPhraseKey: null,
    phraseSets: [],
    prePhrase: {},
    acks: [],
    kept: [],
    keptAdds: [],
    rewound: false,
    phrase: 'R1',
    phraseChanges: 0,
    restores: [],
    accounts: [],
    deleted: [],
    counters: { puts: 0, thief: 0, phraseThief: 0, computer: 0, rFork: 0 },
    hashes: [],
    oldPhraseLines: [],
    thiefLines: [],
    notes: [],
    trace: [],
  };
  const createText = signedBy(w, 'F', created.entry);
  const state0 = replayOf(w, { F: [createText] });
  const set = buildRecoverySetFromPhrase(state0, founder, { phrase: ctx.recovery('R1', vaultId).phrase, currentKey: created.key, random: seededRandom(`${ctx.seed}/solo/phrase`), time: TIME0 - 1000 });
  const setText = signedBy(w, 'F', set.entry);
  w.folder = { F: [createText, setText] };
  w.copy = { F: [createText, setText] };
  w.sent = 2;
  return w;
}

// ---------------------------------------------------------------- honest moves

/** The honest phone's unsent lines go through the agent (or the computer swallows them). */
function sendHonest(w: SoloWorld): void {
  const own = w.copy[w.active] ?? [];
  const unsent = own.slice(w.sent);
  if (unsent.length === 0) return;
  w.sent = own.length;
  if (w.withholdNext) {
    w.withholdNext = false;
    (w.held[w.active] ??= []).push(...unsent);
    return;
  }
  offer(w, w.active, unsent.map((t) => JSON.parse(t) as SignedEntry), 'honest');
}

/**
 * Offers `entries` to the honest agent on the folder: on success the folder becomes the plan's
 * logs. Checks that planAppend and replay agree on each line (S3).
 */
function offer(w: SoloWorld, who: string, entries: SignedEntry[], by: 'honest' | 'thief' | 'phraseThief' | 'restore' | 'repair', extra: { repair?: boolean; proof?: Record<string, { seq: number; hash: string }> } = {}): boolean {
  const ids = toIds(w, w.folder);
  let accepted = false;
  let reason = '';
  let planLogs: Record<string, readonly string[]> | null = null;
  try {
    const plan = planAppend(w.vaultId, ids, entries, { cache, ...extra, ...(w.forks.length ? { forks: w.forks } : {}), ...(w.seals.length ? { sealProofs: w.seals } : {}) });
    accepted = true;
    planLogs = plan.logs as Record<string, readonly string[]>;
  } catch (err) {
    if (!(err instanceof AppendRefused || (err instanceof Error && err.constructor.name === 'AppendRefused'))) throw err;
    reason = (err as Error).message;
  }
  // What replay says to the same lines forced in.
  const forced: Record<string, string[]> = Object.fromEntries(Object.entries(w.folder).map(([k, v]) => [k, [...v]]));
  for (const e of entries) {
    const label = labelOf(w, e.author);
    const log = (forced[label] ??= []);
    if (e.seq <= log.length) log.splice(e.seq, log.length - e.seq, serializeEntry(e));
  }
  const after = replayOf(w, forced);
  // Agreement is judged only for lines that extend the folder's logs, on a folder the computer left alone.
  const extends_ = (() => {
    const len: Record<string, number> = Object.fromEntries(Object.entries(w.folder).map(([k, v]) => [k, v.length]));
    for (const e of entries) {
      const l = labelOf(w, e.author);
      if (e.seq !== (len[l] ?? 0)) return false;
      len[l] = e.seq + 1;
    }
    return !computerTouched(w);
  })();
  for (const e of entries) {
    const h = entryHash(e);
    const st = statusOf(after, h);
    const deviceLine = !labelOf(w, e.author).startsWith('R');
    const founding = labelOf(w, e.author) === 'F' && (e.seq === 0 || (e.seq === 1 && e.kind === 'recovery.set'));
    const forbidden = deviceLine && !founding && !DEVICE_KINDS.has(e.kind);
    // A write-back of the very line the folder holds (another encoding of it) adds nothing.
    const held = w.folder[labelOf(w, e.author)]?.[e.seq];
    const already = held !== undefined && canonical(held) === serializeEntry(e);
    if (forbidden && accepted && !already) note(w, 'S3', `the agent took ${labelOf(w, e.author)}#${e.seq} ${e.kind}, a kind a device may not write`);
    if (forbidden && st.status === 'applied') note(w, 'S3', `replay applies ${labelOf(w, e.author)}#${e.seq} ${e.kind}, a kind a device may not write`);
    if (!extends_) continue;
    if (!accepted && st.status === 'applied' && (by === 'honest' || by === 'restore')) note(w, 'S3', `the agent refused ${labelOf(w, e.author)}#${e.seq} ${e.kind} (${reason}) but replay applies it`);
    if (!accepted && st.status === 'applied' && (by === 'thief' || by === 'phraseThief')) note(w, 'S3', `the agent refused the attacker's ${labelOf(w, e.author)}#${e.seq} ${e.kind} (${reason}) but replay of the same lines applies it`);
  }
  if (by === 'restore' && !accepted) note(w, computerTouched(w) ? 'S7r' : 'S4', `the agent refused the owner's restore with ${w.phrase}: ${reason}`);
  if (by === 'honest' && !accepted) w.notes.push(...[]);
  if (accepted && planLogs) w.folder = toLabels(w, planLogs);
  return accepted;
}

const DEVICE_KINDS = new Set(['device.hello', 'account.put', 'account.delete', 'device.rename']);

/** The honest phone reads the folder: lines that extend its copy are adopted (canonical); a different line at a seq it holds yields a fork proof. */
function readFolder(w: SoloWorld): void {
  const before = copyState(w);
  const folder = folderState(w);
  try {
    const found = findForks(toIds(w, w.copy), before, toIds(w, w.folder), folder);
    for (const p of found) {
      // One proof per identity, as the folder's forks/ holds; a stored proof that doesn't verify is replaced (the agent's writeFork).
      const at = w.forks.findIndex((f) => f.deviceId === p.deviceId);
      if (at < 0) w.forks.push(p);
      else if (!proofValid(w, w.forks[at]!)) w.forks[at] = p;
    }
  } catch {
    /* no proof */
  }
  for (const [label, texts] of Object.entries(w.folder)) {
    if (label === w.active) continue;
    // R's lines live in the folder (the phrase keeps no copy); after a fork of R the proofs carry the other version.
    if (label.startsWith('R')) {
      const valid = texts.map(canonical);
      let n = 0;
      while (n < valid.length && validLine(w, label, valid[n]!)) n++;
      w.copy[label] = valid.slice(0, n);
      continue;
    }
    const mine = w.copy[label] ?? [];
    const theirs = texts.map(canonical);
    const prefix = mine.every((t, i) => theirs[i] === undefined || theirs[i] === t);
    if (prefix && theirs.length > mine.length) w.copy[label] = theirs.filter((t) => hashOfText(t) !== null);
  }
}

/**
 * Writes back lines the folder lost or holds re-encoded, up to what this phone holds (planAppend
 * with repair and the remembered head as proof), one log at a time.
 */
function repairFolder(w: SoloWorld): void {
  for (const [label, mine] of Object.entries(w.copy)) {
    const upTo = label === w.active ? w.sent : mine.length;
    const theirs = w.folder[label] ?? [];
    let from = 0;
    while (from < upTo && theirs[from] === mine[from]) from++;
    if (from >= upTo) continue;
    // A different line there (canonically) is a fork, not a loss.
    // A different valid line is a fork, not a loss, unless its identity is cut or removed: then the pinned line is written back.
    // An R line past a forked seq that doesn't chain on the version that counts doesn't count either (A1.2): the app resends its own.
    const unchained = label.startsWith('R') && theirs[from] !== undefined && folderState(w).chains[idOf(w, label)]?.[from] !== hashOfText(theirs[from]!);
    if (theirs[from] !== undefined && canonical(theirs[from]!) !== mine[from] && validLine(w, label, theirs[from]!) && !isOutIn(w, label) && !unchained) continue;
    const entries = mine.slice(from, upTo).map((t) => JSON.parse(t) as SignedEntry);
    const last = entries[entries.length - 1]!;
    offer(w, label, entries, 'repair', { repair: true, proof: { [idOf(w, label)]: { seq: last.seq, hash: entryHash(last) } } });
  }
}

/** Two different lines of one identity at one seq, both validly signed by it. */
function proofValid(w: SoloWorld, p: ForkProof): boolean {
  const label = labelOf(w, p.deviceId);
  try {
    const [a, b] = p.lines.map((t) => JSON.parse(t) as SignedEntry);
    return !!a && !!b && a.author === p.deviceId && b.author === p.deviceId && a.seq === p.seq && b.seq === p.seq && entryHash(a) !== entryHash(b) && validLine(w, label, p.lines[0]) && validLine(w, label, p.lines[1]);
  } catch {
    return false;
  }
}

function validLine(w: SoloWorld, label: string, text: string): boolean {
  try {
    return entrySignatureValid(JSON.parse(text) as SignedEntry, keysOf(w, label).edPublic);
  } catch {
    return false;
  }
}

function isOutIn(w: SoloWorld, label: string): boolean {
  const st = copyState(w);
  const id = idOf(w, label);
  return st.cutoffs[id] !== undefined || st.members[id]?.removed === true;
}

function honestKey(w: SoloWorld, readOnly = false): { state: VaultState; key: Uint8Array } | null {
  const state = copyState(w);
  const key = heldKey(state, keysOf(w, w.active), readOnly);
  return key ? { state, key } : null;
}

function appendOwn(w: SoloWorld, entry: SignedEntry): void {
  const text = signedBy(w, w.active, entry);
  (w.copy[w.active] ??= []).push(text);
}

function phoneUsable(w: SoloWorld): boolean {
  return !(w.stolen && w.active === 'F');
}

/**
 * The engine after a restore: on the first folder read that shows its restore applied and winning
 * it writes the post-adopt ack (a device.rename); if the restore lost before that ack landed, it
 * redoes the restore on top of the winner (a new phone identity, the same phrase).
 */
function adoptRestore(w: SoloWorld): void {
  const r = w.restores.find((x) => x.device === w.active && !x.settled);
  if (!r) return;
  const folder = folderState(w);
  const add = JSON.parse(r.texts[0]!) as SignedEntry;
  const at = folder.chains[add.author]?.[add.seq];
  const hello = folder.history.find((h) => h.author === idOf(w, r.device) && h.kind === 'device.hello');
  if (at === r.addHash && hello?.status === 'applied') {
    const actor = honestKey(w);
    if (!actor) return;
    r.settled = 'acked';
    appendOwn(w, buildDeviceRename(actor.state, keysOf(w, w.active), { device: idOf(w, w.active), name: `Phone ${r.device}`, currentKey: actor.key, random: randomFor(w, { t: 'sync' }, `ack-${r.device}`), time: stepTime(w) }));
    sendHonest(w);
    return;
  }
  if (at === r.addHash) return;
  if (at === undefined) {
    // The folder lacks the restore: a warning and a resend, never a redo.
    offer(w, r.phrase, r.texts.map((t) => JSON.parse(t) as SignedEntry), 'restore');
    readFolder(w);
    return;
  }
  // Another version of R's line counts there. One of this phone's own attempts: adopt it.
  const winner = folder.history.find((h) => h.hash === at);
  const mine = winner?.kind === 'device.add' && winner.subject ? w.restores.find((x) => x.phone === r.phone && idOf(w, x.device) === winner.subject) : undefined;
  if (mine) {
    r.settled = 'superseded';
    delete mine.settled;
    w.active = mine.device;
    w.copy = Object.fromEntries(Object.entries(w.folder).map(([k, v]) => [k, v.map(canonical)]));
    w.sent = w.copy[mine.device]?.length ?? 0;
    return;
  }
  // A different device won: redo on top of the winner, never on a folder behind what this phone remembers.
  if (lostByRollback(w).length > 0) return;
  r.settled = 'redone';
  if (w.restores.length >= DEVICE_LABELS.length) return;
  restoreNow(w, { t: 'restore' }, `redo-${r.device}`, r.phone);
}

function restoreNow(w: SoloWorld, op: SoloOp, salt = '', phone?: string): boolean {
  const device = DEVICE_LABELS[w.restores.length]!;
  const state = folderState(w);
  // Someone else's phrase is current (an R double-sign by another holder won): the owner doesn't hold it.
  if (state.recovery && ['RX', 'RY', 'RZ'].includes(labelOf(w, state.recovery.deviceId))) return false;
  // The owner holds every phrase it made: it restores with whichever is current in the folder.
  const current = state.recovery ? labelOf(w, state.recovery.deviceId) : w.phrase;
  if (PHRASE_LABELS.indexOf(current) >= 0 && PHRASE_LABELS.indexOf(current) <= PHRASE_LABELS.indexOf(w.phrase)) w.phrase = current;
  const phrase = w.ctx.recovery(w.phrase, w.vaultId);
  const lost = lostByRollback(w);
  const built = restoreLines(w, state, phrase.phrase, keysOf(w, device), randomFor(w, op, salt));
  if ('error' in built) {
    note(w, computerTouched(w) ? 'S7r' : 'S4', `the owner's restore with ${w.phrase} can't be built on the folder: ${built.error}${lost.length > 0 ? ` (the folder lacks ${lost.join(', ')})` : ''}`);
    return true;
  }
  for (const [label, e] of [[w.phrase, built.lines[0]!], [device, built.lines[1]!], [w.phrase, built.lines[2]!]] as const) signedBy(w, label, e);
  const ok = offer(w, w.phrase, built.lines, 'restore');
  w.restores.push({ device, phrase: w.phrase, base: Object.keys(state.accounts), lost, addHash: entryHash(built.lines[0]!), rotateHash: entryHash(built.lines[2]!), step: w.trace.length, phone: phone ?? device, texts: built.lines.map(serializeEntry) });
  if (lost.length > 0) note(w, 'S7r', `the restore was built on a folder rolled back or withheld by the computer: it lacks ${lost.join(', ')}`);
  if (!ok) return true;
  // The new phone: its copy is the folder.
  w.active = device;
  w.copy = Object.fromEntries(Object.entries(w.folder).map(([k, v]) => [k, v.map(canonical)]));
  w.sent = w.copy[device]?.length ?? 0;
  // Its key opens to the keyCheck.
  if (!heldKey(copyState(w), keysOf(w, device))) note(w, 'S4', `the restored phone ${device} holds no key that matches the keyCheck`);
  return true;
}

const HONEST: { [K in SoloOp['t']]?: (w: SoloWorld, op: Extract<SoloOp, { t: K }>) => boolean } = {
  put: (w, op) => {
    if (!phoneUsable(w) || w.counters.puts >= w.bounds.maxPuts) return false;
    const actor = honestKey(w);
    if (!actor || actor.state.needsFreshKey) return false;
    const random = randomFor(w, op);
    const account = newAccountId(random);
    appendOwn(w, buildAccountPut(actor.state, keysOf(w, w.active), { account, record: RECORD, currentKey: actor.key, random, time: stepTime(w) }));
    w.accounts.push(account);
    w.counters.puts++;
    sendHonest(w);
    return true;
  },
  delete: (w, op) => {
    if (!phoneUsable(w) || !w.accounts.includes(op.account) || w.deleted.includes(op.account)) return false;
    const state = copyState(w);
    if (!state.accounts[op.account]) return false;
    appendOwn(w, buildAccountDelete(state, keysOf(w, w.active), { account: op.account, time: stepTime(w) }));
    w.deleted.push(op.account);
    sendHonest(w);
    return true;
  },
  rename: (w, op) => {
    if (!phoneUsable(w)) return false;
    const actor = honestKey(w);
    if (!actor) return false;
    appendOwn(w, buildDeviceRename(actor.state, keysOf(w, w.active), { device: idOf(w, w.active), name: `Phone ${w.trace.length}`, currentKey: actor.key, random: randomFor(w, op), time: stepTime(w) }));
    sendHonest(w);
    return true;
  },
  sync: (w) => {
    if (!phoneUsable(w)) return false;
    const before = digest([w.folder, w.copy, w.sent, w.forks.length]);
    sendHonest(w);
    repairFolder(w);
    readFolder(w);
    adoptRestore(w);
    return digest([w.folder, w.copy, w.sent, w.forks.length]) !== before;
  },
  restore: (w, op) => {
    if (w.restores.length >= w.bounds.maxRestores) return false;
    return restoreNow(w, op);
  },
  phrase: (w, op) => {
    if (!phoneUsable(w) || w.phraseChanges >= w.bounds.maxPhraseChanges) return false;
    // R signs on what the folder holds (the phrase keeps no copy; the app reads the folder first).
    readFolder(w);
    const state = folderState(w);
    // The app offers a phrase change only on a phone still in the vault (a restore that took it out shows it removed).
    const me = idOf(w, w.active);
    if (state.cutoffs[me] !== undefined || !state.members[me] || state.members[me]!.removed) return false;
    // The app never signs an R line on a folder behind this phone's remembered heads (review 9, Q1).
    if (lostByRollback(w).length > 0) return false;
    const old = w.ctx.recovery(w.phrase, w.vaultId);
    if (state.recovery?.deviceId !== old.keys.deviceId) return false;
    const key = heldKey(state, old.keys, true);
    if (!key) return false;
    const next = PHRASE_LABELS[PHRASE_LABELS.indexOf(w.phrase) + 1]!;
    let entry: SignedEntry;
    try {
      entry = buildRecoverySetFromPhrase(state, old.keys, { phrase: w.ctx.recovery(next, w.vaultId).phrase, currentKey: key, random: randomFor(w, op), time: stepTime(w) }).entry;
    } catch {
      return false;
    }
    signedBy(w, w.phrase, entry);
    w.phraseSets.push(entryHash(entry));
    w.prePhrase[entryHash(entry)] = Object.fromEntries(Object.entries(w.folder).map(([k, v]) => [k, [...v]]));
    w.oldPhraseKey = toBase64Url(key);
    // P's ack: the phone in hand names the new R line in seen (a device.rename, sent with it).
    const batch: SignedEntry[] = [entry];
    try {
      const ids = toIds(w, w.copy);
      const rid = old.keys.deviceId;
      const withSet = { ...ids, [rid]: [...((toIds(w, w.folder)[rid] ?? []).slice(0, entry.seq)), serializeEntry(entry)] };
      const st2 = replayVault(w.vaultId, withSet, { cache, ...(w.forks.length ? { forks: w.forks } : {}) });
      const k2 = heldKey(st2, keysOf(w, w.active), true);
      if (k2) {
        const ack = buildDeviceRename(st2, keysOf(w, w.active), { device: idOf(w, w.active), name: `Phone ${w.trace.length}`, currentKey: k2, random: randomFor(w, op, 'ack'), time: stepTime(w) });
        appendOwn(w, ack);
        w.acks.push(entryHash(ack));
        if (w.withholdNext) {
          // The computer withholds P's ack: the set goes in, the ack stays with the computer.
          w.withholdNext = false;
          w.sent = w.copy[w.active]!.length;
          (w.held[w.active] ??= []).push(serializeEntry(ack));
        } else {
          batch.push(ack);
          w.sent = w.copy[w.active]!.length;
        }
      }
    } catch {
      /* no ack */
    }
    const ok = offer(w, w.phrase, batch, 'honest');
    if (!ok) {
      note(w, computerTouched(w) ? 'S7r' : 'S5', `the owner's phrase change by ${w.phrase} was refused`);
      return true;
    }
    w.phrase = next;
    w.phraseChanges++;
    readFolder(w);
    return true;
  },
};

const RECORD = { issuer: 'model', label: 'solo', secret: 'JBSWY3DPEHPK3PXP', type: 'totp' as const, algorithm: 'SHA1' as const, digits: 6, period: 30, counter: 0 };

/** The three lines of a restore, as restoreLines() in vaultSolo.test.ts builds them. */
function restoreLines(w: SoloWorld, state: VaultState, phrase: string, phone: DeviceKeys, random: ReturnType<typeof seededRandom>, recoveryKeys?: DeviceKeys, keyOverride?: Uint8Array): { lines: SignedEntry[] } | { error: string } {
  try {
    const recovery = recoveryKeys ?? recoveryKeysFromPhrase(phrase, w.vaultId);
    if (!recoveryKeys && state.recovery?.deviceId !== recovery.deviceId) throw new Error('not the current phrase');
    const opened = (() => {
      try {
        return openVault(state, recovery) as { currentKey: Uint8Array; epoch?: number };
      } catch (err) {
        if (keyOverride) return { currentKey: keyOverride };
        throw err;
      }
    })();
    if (keyOverride && !heldKey(state, recovery, true)) opened.currentKey = keyOverride;
    const add = buildDeviceAdd(state, recovery, { device: { deviceId: phone.deviceId, edPublic: phone.edPublic, xPublic: phone.xPublic }, role: 'admin', name: 'New phone', currentKey: opened.currentKey, ...(opened.epoch !== undefined ? { epoch: opened.epoch } : {}), random, time: stepTime(w) });
    const ids = toIds(w, w.folder);
    // R's log as the state counts it: after a proven fork of R, the winning version (maybe only in a proof) in place of the folder's.
    const texts = new Map<string, string>();
    for (const t of [...Object.values(w.folder).flat(), ...w.forks.flatMap((f) => f.lines)]) {
      const h = hashOfText(t);
      if (h) texts.set(h, t);
    }
    const counted = (state.chains[recovery.deviceId] ?? []).map((h) => texts.get(h)).filter((t): t is string => t !== undefined);
    const base = counted.length >= add.seq ? counted : ids[recovery.deviceId] ?? [];
    const withAdd = { ...ids, [recovery.deviceId]: [...base.slice(0, add.seq), serializeEntry(add)] };
    const opts = { cache, ...(w.forks.length ? { forks: w.forks } : {}) };
    const hello = buildDeviceHello(replayVault(w.vaultId, withAdd, opts), phone, stepTime(w), entryHash(add));
    const withHello = { ...withAdd, [phone.deviceId]: [serializeEntry(hello)] };
    const rotate = buildKeyRotate(replayVault(w.vaultId, withHello, opts), recovery, { currentKey: opened.currentKey, random, time: stepTime(w) });
    return { lines: [add, hello, rotate.entry] };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Lines the honest phone holds (canonical) that the folder lacks: what a restore on the folder would lose. */
/** Whether the computer has altered the folder (rolled back, withheld, re-encoded or junk): honest failures then count as availability (S7r). */
function computerTouched(w: SoloWorld): boolean {
  // Junk lines and proofs are not meddling: anyone who writes the folder (the thief too) can plant them, and S4 must hold.
  return w.rewound || Object.keys(w.held).length > 0 || Object.values(w.folder).some((log) => log.some((t) => t !== canonical(t))) || w.trace.some((op) => op.t === 'rollback' || op.t === 'reencode' || op.t === 'withhold');
}

function lostByRollback(w: SoloWorld): string[] {
  if (!phoneUsableForLoss(w)) return [];
  const out: string[] = [];
  for (const [label, texts] of Object.entries(w.copy)) {
    const folder = (w.folder[label] ?? []).map(canonical);
    // Missing (rolled back, withheld) or unreadable there; a different valid line is a fork, not a loss.
    for (let i = 0; i < texts.length; i++) if ((folder[i] === undefined || (folder[i] !== texts[i] && !validLine(w, label, w.folder[label]![i]!))) && (label !== w.active || i < w.sent)) out.push(`${label}#${i}`);
  }
  return out;
}

function phoneUsableForLoss(w: SoloWorld): boolean {
  return w.active !== 'F' || !w.stolen;
}

// ---------------------------------------------------------------- attackers

function thiefBasis(w: SoloWorld, basis: 'stale' | 'folder', upTo?: number): { logs: Record<string, string[]>; state: VaultState } {
  const logs = Object.fromEntries(Object.entries(basis === 'stale' ? w.thiefCopy : w.folder).map(([k, v]) => [k, [...v]]));
  logs.F = w.thiefLog.slice(0, upTo ?? w.thiefLog.length);
  return { logs, state: replayOf(w, logs, basis === 'folder') };
}

function thiefLine(w: SoloWorld, op: Extract<SoloOp, { t: 'thief' }>): SignedEntry[] | null {
  const F = keysOf(w, 'F');
  const random = randomFor(w, op);
  const time = stepTime(w);
  const fork = op.kind === 'fork';
  if (fork && w.thiefLog.length < 3) return null;
  const { state } = thiefBasis(w, op.basis, fork ? w.thiefLog.length - 1 : undefined);
  const key = heldKey(state, F, true) ?? (() => { try { return openVault(state, F).currentKey; } catch { return null; } })() ?? (w.thiefKey ? fromBase64Url(w.thiefKey) : null);
  try {
    switch (op.kind) {
      case 'put':
      case 'fork':
        if (!key) return null;
        return [buildAccountPut(state, F, { account: newAccountId(random), record: { ...RECORD, issuer: 'thief' }, currentKey: key, random, time: fork ? time + 1 : time })];
      case 'delete': {
        const account = w.accounts.find((a) => state.accounts[a]);
        return account ? [buildAccountDelete(state, F, { account, time })] : null;
      }
      case 'rename':
        if (!key) return null;
        return [buildDeviceRename(state, F, { device: idOf(w, 'F'), name: 'stolen', currentKey: key, random, time })];
      case 'add': {
        if (!key) return null;
        const X = keysOf(w, 'X');
        const add = buildDeviceAdd(state, F, { device: { deviceId: X.deviceId, edPublic: X.edPublic, xPublic: X.xPublic }, role: 'admin', name: 'X', currentKey: key, random, time });
        const ids = toIds(w, thiefBasis(w, op.basis).logs);
        ids[F.deviceId] = [...(ids[F.deviceId] ?? []), serializeEntry(add)];
        const hello = buildDeviceHello(replayVault(w.vaultId, ids, { cache }), X, time, entryHash(add));
        return [add, hello];
      }
      case 'rotate':
        if (!key) return null;
        return [buildKeyRotate(state, F, { currentKey: key, random, time }).entry];
      case 'recoverySet':
        if (!key) return null;
        return [buildRecoverySetFromPhrase(state, F, { phrase: w.ctx.recovery('RX', w.vaultId).phrase, currentKey: key, random, time }).entry];
      case 'remove': {
        if (!key) return null;
        const target = op.target === 'R' ? state.recovery?.deviceId : idOf(w, op.target ?? w.active);
        if (!target || target === F.deviceId) return null;
        return [buildDeviceRemove(state, F, { device: target, currentKey: key, random, time }).entry];
      }
      case 'garbage': {
        if (!key) return null;
        const put = buildAccountPut(state, F, { account: newAccountId(random), record: { ...RECORD, issuer: 'garbage' }, currentKey: key, random, time });
        return [{ ...put, sig: toBase64Url(random(64)) }];
      }
      case 'badSeal': {
        if (!key) return null;
        const real = buildKeyRotate(state, F, { currentKey: key, random, time }).entry;
        const other = buildKeyRotate(state, F, { currentKey: key, random, time }).entry;
        const keys = { ...(real.body as { keys: Record<string, unknown> }).keys };
        const otherKeys = (other.body as { keys: Record<string, unknown> }).keys;
        for (const id of Object.keys(keys)) if (id !== F.deviceId) keys[id] = otherKeys[id];
        const { sig: _s, ...unsigned } = real;
        return [signEntry({ ...unsigned, body: { ...unsigned.body, keys } as typeof unsigned.body }, F)];
      }
      case 'forkProof':
      case 'truncate':
        return null;
    }
  } catch {
    return null;
  }
}

const ATTACK: { [K in SoloOp['t']]?: (w: SoloWorld, op: Extract<SoloOp, { t: K }>) => boolean } = {
  steal: (w) => {
    if (!w.bounds.thief || w.stolen || !(w.signed.F?.length)) return false;
    w.stolen = true;
    // The thief has F's copy if F is the phone in use; else the copy F had when it was replaced (none kept: the folder as F last read it is not modelled, so the stale copy is F's own log).
    w.thiefCopy = w.active === 'F' ? Object.fromEntries(Object.entries(w.copy).map(([k, v]) => [k, [...v]])) : { F: [...(w.signed.F ?? [])] };
    w.thiefLog = [...(w.active === 'F' ? w.copy.F ?? [] : w.signed.F ?? [])];
    const key = heldKey(replayOf(w, w.thiefCopy, false), keysOf(w, 'F'), true);
    w.thiefKey = key ? toBase64Url(key) : null;
    return true;
  },
  thief: (w, op) => {
    if (!w.stolen || w.counters.thief >= w.bounds.maxThief) return false;
    if (op.kind === 'truncate') {
      const log = w.folder.F ?? [];
      if (log.length <= 2) return false;
      const last = JSON.parse(log[log.length - 1]!) as SignedEntry;
      w.folder.F = [...log.slice(0, -1), serializeEntry({ ...last, time: last.time + 1, sig: toBase64Url(randomFor(w, op)(64)) })];
      w.counters.thief++;
      return true;
    }
    if (op.kind === 'forkProof') {
      // The thief publishes a proof of its own fork: two versions of its last line.
      if (w.thiefLog.length < 3 || w.forks.some((f) => f.deviceId === idOf(w, 'F'))) return false;
      const seq = w.thiefLog.length - 1;
      const last = JSON.parse(w.thiefLog[seq]!) as SignedEntry;
      const { sig: _s, ...unsigned } = last;
      const second = signEntry({ ...unsigned, time: unsigned.time + 7 }, keysOf(w, 'F'));
      w.hashes.push(entryHash(second));
      w.thiefLines.push(entryHash(second));
      w.forks.push({ deviceId: idOf(w, 'F'), seq, lines: [w.thiefLog[seq]!, serializeEntry(second)] });
      w.counters.thief++;
      return true;
    }
    const entries = thiefLine(w, op);
    if (!entries) return false;
    w.counters.thief++;
    const fLines = entries.filter((e) => e.author === idOf(w, 'F'));
    if (op.kind === 'fork') w.thiefLog = w.thiefLog.slice(0, -1);
    for (const e of entries) {
      const label = labelOf(w, e.author);
      if (op.kind !== 'garbage') {
        w.hashes.push(entryHash(e));
        if (label === 'F') w.thiefLines.push(entryHash(e));
      }
      if (label === 'F') w.thiefLog.push(serializeEntry(e));
      else (w.signed[label] ??= []).push(serializeEntry(e));
    }
    if (op.delivery === 'hold') {
      w.thiefHeld = true;
      return true;
    }
    if (op.delivery === 'agent' && !w.thiefHeld) {
      offer(w, 'F', entries, 'thief');
      return true;
    }
    writeThiefDirect(w, entries.filter((e) => !fLines.includes(e)));
    return true;
  },
  thiefRelease: (w) => {
    if (!w.thiefHeld) return false;
    writeThiefDirect(w, []);
    return true;
  },
  oldPhrase: (w, op) => {
    if (!w.bounds.phraseThief || w.phraseChanges === 0 || w.counters.phraseThief >= w.bounds.maxPhraseThief) return false;
    const R1 = keysOf(w, 'R1');
    const state = folderState(w);
    const random = randomFor(w, op);
    let entries: SignedEntry[];
    if (op.kind === 'restore') {
      const built = restoreLines(w, state, '', keysOf(w, 'Y'), random, R1, w.oldPhraseKey ? fromBase64Url(w.oldPhraseKey) : undefined);
      if ('error' in built) return false;
      entries = built.lines;
    } else {
      const key = heldKey(state, R1, true) ?? (() => { try { return openVault(state, R1).currentKey; } catch { return null; } })() ?? (w.oldPhraseKey ? fromBase64Url(w.oldPhraseKey) : null);
      if (!key) return false;
      try {
        entries = [buildRecoverySetFromPhrase(state, R1, { phrase: w.ctx.recovery('RY', w.vaultId).phrase, currentKey: key, random, time: stepTime(w) }).entry];
      } catch {
        return false;
      }
    }
    w.counters.phraseThief++;
    for (const e of entries) {
      w.hashes.push(entryHash(e));
      if (e.author === R1.deviceId) w.oldPhraseLines.push(entryHash(e));
      (w.signed[labelOf(w, e.author)] ??= []).push(serializeEntry(e));
    }
    if (op.delivery === 'agent') offer(w, 'R1', entries, 'phraseThief');
    else for (const e of entries) writeDirect(w, labelOf(w, e.author), serializeEntry(e), e.seq);
    return true;
  },
  rFork: (w, op) => {
    if (w.counters.rFork >= (w.bounds.maxRFork ?? 0)) return false;
    const folder = folderState(w);
    let rid = folder.recovery?.deviceId;
    if (!rid) return false;
    let forkSeq: number | undefined;
    if (op.old) {
      const set = [...folder.history].reverse().find((h) => w.phraseSets.includes(h.hash) && h.status === 'applied');
      if (!set) return false;
      rid = set.author;
      forkSeq = set.seq;
    }
    // A current phrase with no line yet: fork the phrase change that made it current (a refused-and-retried change).
    if (!op.old && !(w.folder[labelOf(w, rid)]?.length)) {
      const set = [...folder.history].reverse().find((h) => h.kind === 'recovery.set' && h.status === 'applied' && labelOf(w, h.author).startsWith('R'));
      if (!set) return false;
      rid = set.author;
    }
    const label = labelOf(w, rid);
    const log = w.folder[label];
    if (!log || log.length === 0) return false;
    const R = keysOf(w, label);
    const at = forkSeq ?? log.length - 1;
    const stale = op.stale && op.old ? w.prePhrase[hashOfText(log[at]!) ?? ''] : undefined;
    if (op.stale && !stale) return false;
    const basisLogs = { ...(stale ?? w.folder), [label]: log.slice(0, at) };
    if (basisLogs[label]!.length === 0) delete basisLogs[label];
    const state = replayOf(w, basisLogs);
    if (state.recovery?.deviceId !== rid) return false;
    let entry!: SignedEntry;
    let extra: SignedEntry[] = [];
    const tries = op.grind ? GRIND_TRIES : 1;
    const folderHash = hashOfText(log[at]!) ?? '';
    for (let attempt = 0; attempt < tries; attempt++) {
    const random = randomFor(w, op, `try${attempt}`);
    let tryEntry: SignedEntry;
    let tryExtra: SignedEntry[] = [];
    try {
      const key = heldKey(state, R, true) ?? openVault(state, R).currentKey;
      // retry: the owner's phrase change signed again (same new phrase, new randomness); phrase: someone else's new phrase RZ.
      if (op.kind === 'phrase' || op.kind === 'retry') {
        const next = op.kind === 'retry' ? (w.phraseChanges > 0 && labelOf(w, rid) !== w.phrase ? w.phrase : null) : 'RZ';
        if (!next) return false;
        tryEntry = buildRecoverySetFromPhrase(state, R, { phrase: w.ctx.recovery(next, w.vaultId).phrase, currentKey: key, random, time: stepTime(w) + 1 + attempt }).entry;
      }
      else {
        const saved = w.folder;
        w.folder = basisLogs;
        const built = restoreLines(w, state, '', keysOf(w, 'Y'), random, R, key);
        w.folder = saved;
        if ('error' in built) return false;
        tryEntry = built.lines[0]!;
        tryExtra = built.lines.slice(1);
      }
    } catch {
      return false;
    }
    if (attempt === 0 || entryHash(tryEntry) < entryHash(entry)) {
      entry = tryEntry;
      extra = tryExtra;
    }
    if (op.grind && entryHash(entry) < folderHash) break;
    }
    if (entryHash(entry) === hashOfText(log[at]!)) return false;
    if (op.chain && extra.length === 0) {
      try {
        const ids = toIds(w, basisLogs);
        const withEntry = { ...ids, [rid]: [...(ids[rid] ?? []), serializeEntry(entry)] };
        const st2 = replayVault(w.vaultId, withEntry, { cache });
        const key2 = heldKey(st2, R, true);
        if (key2) extra = [buildKeyRotate(st2, R, { currentKey: key2, random: randomFor(w, op, 'chain'), time: stepTime(w) + 50 }).entry];
      } catch {
        /* nothing to chain */
      }
    }
    w.counters.rFork++;
    if (op.kind === 'retry') w.phraseSets.push(entryHash(entry));
    for (const e of [entry, ...extra]) {
      w.hashes.push(entryHash(e));
      (w.signed[labelOf(w, e.author)] ??= []).push(serializeEntry(e));
    }
    const slot = w.forks.findIndex((f) => f.deviceId === rid);
    const proof = { deviceId: rid, seq: entry.seq, lines: [log[at]!, serializeEntry(entry)] as [string, string] };
    if (slot < 0) w.forks.push(proof);
    else if (!proofValid(w, w.forks[slot]!)) w.forks[slot] = proof;
    if (op.delivery === 'direct') {
      w.rewound = true;
      w.folder[label] = [...log.slice(0, at), serializeEntry(entry)];
      // The rest of the restore (Y's hello, R's rotate) as far as it chains.
      for (const e of extra) writeDirect(w, labelOf(w, e.author), serializeEntry(e), e.seq);
    }
    return true;
  },
  keepRestore: (w, op) => {
    if (!w.bounds.computer || w.kept.length > 0 || w.counters.computer >= w.bounds.maxComputer) return false;
    const state = folderState(w);
    const current = state.recovery ? labelOf(w, state.recovery.deviceId) : null;
    if (!current || !PHRASE_LABELS.includes(current)) return false;
    const attempts = op.attempts ?? 1;
    for (let i = 0; i < attempts; i++) {
      const built = restoreLines(w, state, w.ctx.recovery(current, w.vaultId).phrase, keysOf(w, w.keptAdds.length === 0 ? 'Q' : `Q${w.keptAdds.length + 1}`), randomFor(w, op, `q${i}`), keysOf(w, current));
      if ('error' in built) return false;
      w.kept.push(built.lines.map((e) => ({ label: labelOf(w, e.author), text: serializeEntry(e), seq: e.seq })));
      w.keptAdds.push(entryHash(built.lines[0]!));
      for (const e of built.lines) w.hashes.push(entryHash(e));
    }
    w.counters.computer++;
    return true;
  },
  writeKept: (w, op) => {
    if (op.best) {
      // The computer picks the kept attempt whose add hashes lowest, replaces R's log from its seq with
      // its lines, writes its hello, and publishes the fork proof against the line it displaced.
      if (w.kept.length === 0) return false;
      const addHash = (k: { text: string }[]) => hashOfText(k[0]!.text) ?? '';
      const pick = [...w.kept].sort((a, b) => (addHash(a) < addHash(b) ? -1 : 1))[0]!;
      w.kept = [];
      const [add] = pick;
      const rLog = w.folder[add!.label] ?? [];
      const displaced = rLog[add!.seq];
      if (displaced && canonical(displaced) !== add!.text) {
        const rid = idOf(w, add!.label);
        const proof = { deviceId: rid, seq: add!.seq, lines: [displaced, add!.text] as [string, string] };
        const slot = w.forks.findIndex((f) => f.deviceId === rid);
        if (slot < 0) w.forks.push(proof);
        else if (!proofValid(w, w.forks[slot]!)) w.forks[slot] = proof;
      }
      if (rLog.length > add!.seq) w.rewound = true;
      w.folder[add!.label] = rLog.slice(0, add!.seq);
      for (const line of pick) {
        if (line.label === add!.label) w.folder[line.label] = [...w.folder[line.label]!.slice(0, line.seq), line.text];
        else writeDirect(w, line.label, line.text, line.seq);
      }
      return true;
    }
    const kept = w.kept.shift();
    if (!kept) return false;
    for (const line of kept) {
      const existing = w.folder[line.label]?.[line.seq];
      if (existing && canonical(existing) !== line.text && validLine(w, line.label, existing) && !w.forks.some((f) => f.deviceId === idOf(w, line.label) && proofValid(w, f))) {
        w.forks.push({ deviceId: idOf(w, line.label), seq: line.seq, lines: [existing, line.text] });
      }
      if (!existing) writeDirect(w, line.label, line.text, line.seq);
    }
    return true;
  },
  withhold: (w) => {
    if (!w.bounds.computer || w.withholdNext || w.counters.computer >= w.bounds.maxComputer) return false;
    w.withholdNext = true;
    w.counters.computer++;
    return true;
  },
  computerRelease: (w) => {
    const labels = Object.keys(w.held);
    if (labels.length === 0) return false;
    for (const label of labels) for (const text of w.held[label]!) {
      const e = JSON.parse(text) as SignedEntry;
      writeDirect(w, label, text, e.seq);
    }
    w.held = {};
    return true;
  },
  rollback: (w, op) => {
    if (!w.bounds.computer || w.counters.computer >= w.bounds.maxComputer) return false;
    const log = w.folder[op.label];
    if (!log || log.length <= (op.label === 'F' ? 2 : 0)) return false;
    w.folder[op.label] = log.slice(0, -1);
    if (w.folder[op.label]!.length === 0) delete w.folder[op.label];
    w.counters.computer++;
    return true;
  },
  reencode: (w, op) => {
    // The computer, or the thief writing the folder, re-encodes any log (device or R) with whitespace.
    if (!(w.bounds.computer || w.stolen) || w.counters.computer >= w.bounds.maxComputer) return false;
    const log = w.folder[op.label];
    if (!log || log.every((t) => t !== canonical(t))) return false;
    w.folder[op.label] = log.map((t) => (t === canonical(t) ? JSON.stringify(JSON.parse(t), null, 1) : t));
    w.counters.computer++;
    return true;
  },
  junkLine: (w, op) => {
    if (!w.bounds.computer || w.counters.computer >= w.bounds.maxComputer) return false;
    const log = w.folder[op.label];
    if (!log || log.length === 0) return false;
    // The last line again with the next seq and another time: same signature, so it doesn't verify.
    const last = JSON.parse(log[log.length - 1]!) as SignedEntry;
    w.folder[op.label] = [...log, serializeEntry({ ...last, seq: last.seq + 1, time: last.time + 1, prev: entryHash(last) } as SignedEntry)];
    w.counters.computer++;
    return true;
  },
  junkProof: (w) => {
    if (!w.bounds.computer || w.counters.computer >= w.bounds.maxComputer) return false;
    // A fork proof whose second line is the first with a garbage signature, and a seal proof of random bytes against the newest key change.
    const random = seededRandom(`${w.ctx.seed}/junk/${w.trace.length}`);
    const target = w.folder[w.active]?.length ? w.active : 'F';
    const first = w.folder[target]![w.folder[target]!.length - 1]!;
    const parsed = JSON.parse(first) as SignedEntry;
    w.forks.push({ deviceId: idOf(w, target), seq: parsed.seq, lines: [first, serializeEntry({ ...parsed, time: parsed.time + 1, sig: toBase64Url(random(64)) })] });
    const keyChange = Object.values(w.folder).flat().map((t) => JSON.parse(t) as SignedEntry).filter((e) => e.kind === 'key.rotate' || e.kind === 'recovery.set').at(-1);
    if (keyChange) w.seals.push({ entry: entryHash(keyChange), to: idOf(w, w.active), proof: toBase64Url(random(96)) });
    w.counters.computer++;
    return true;
  },
};

function writeDirect(w: SoloWorld, label: string, text: string, seq: number): void {
  const log = [...(w.folder[label] ?? [])];
  if (seq > log.length) return;
  if (seq < log.length && (label.startsWith('R') || (label === w.active && phoneUsable(w)))) w.rewound = true;
  log.splice(seq, log.length - seq, text);
  w.folder[label] = log;
}

/** The thief writes F's log as it holds it (a fork replaces the folder's version) and its puppet's lines. */
function writeThiefDirect(w: SoloWorld, others: SignedEntry[]): void {
  w.folder.F = [...w.thiefLog];
  for (const e of others) writeDirect(w, labelOf(w, e.author), serializeEntry(e), e.seq);
  w.thiefHeld = false;
}

// ---------------------------------------------------------------- apply

export function applySoloOp(world: SoloWorld, op: SoloOp): SoloWorld | null {
  const next = cloneWorld(world);
  const handler = (HONEST[op.t] ?? ATTACK[op.t]) as ((w: SoloWorld, op: SoloOp) => boolean) | undefined;
  if (!handler) return null;
  let ok: boolean;
  try {
    ok = handler(next, op);
  } catch (err) {
    note(next, 'S4', `model error on ${op.t}: ${(err as Error).message}`);
    ok = true;
  }
  if (!ok) return null;
  next.trace.push(op);
  return next;
}

export function runSolo(ctx: ModelContext, bounds: SoloBounds, ops: readonly SoloOp[]): SoloWorld | null {
  let w: SoloWorld | null = newSoloWorld(ctx, bounds);
  for (const op of ops) {
    w = applySoloOp(w, op);
    if (!w) return null;
  }
  return w;
}

export function candidateSoloOps(w: SoloWorld): SoloOp[] {
  const b = w.bounds;
  if (w.trace.length >= b.maxSteps) return [];
  const ops: SoloOp[] = [{ t: 'put' }, { t: 'sync' }, { t: 'rename' }, { t: 'restore' }, { t: 'phrase' }];
  for (const account of w.accounts) if (!w.deleted.includes(account)) ops.push({ t: 'delete', account });
  if (b.thief) {
    ops.push({ t: 'steal' }, { t: 'thiefRelease' });
    if (w.stolen) {
      for (const kind of b.thiefKinds) {
        if (kind === 'forkProof' || kind === 'truncate') {
          ops.push({ t: 'thief', kind, basis: 'stale', delivery: 'direct' });
          continue;
        }
        const targets = kind === 'remove' ? [w.active, 'R'] : [undefined];
        for (const basis of ['stale', 'folder'] as const) for (const delivery of ['agent', 'direct', 'hold'] as const) for (const target of targets) ops.push({ t: 'thief', kind, basis, delivery, ...(target ? { target } : {}) });
      }
    }
  }
  if (b.phraseThief && w.phraseChanges > 0) for (const kind of ['restore', 'phrase'] as const) for (const delivery of ['agent', 'direct'] as const) ops.push({ t: 'oldPhrase', kind, delivery });
  if ((b.maxRFork ?? 0) > 0) {
    for (const kind of ['restore', 'phrase', 'retry'] as const) for (const delivery of ['direct', 'proof'] as const) ops.push({ t: 'rFork', kind, delivery });
    // An old-phrase holder racing the phrase change: grinds for the lowest hash and chains on its own version.
    for (const kind of ['restore', 'phrase'] as const) for (const delivery of ['direct', 'proof'] as const) ops.push({ t: 'rFork', kind, delivery, grind: true, chain: true });
    // The old phrase's holder signs a restore at the seq of the owner's phrase change, grinds it, and writes it plus a proof.
    if (w.phraseSets.length > 0) for (const chain of [false, true]) ops.push({ t: 'rFork', kind: 'restore', delivery: 'direct', grind: true, chain, old: true });
    if (w.phraseSets.length > 0) ops.push({ t: 'rFork', kind: 'restore', delivery: 'direct', grind: true, old: true, stale: true });
  }
  if (b.computer) {
    ops.push({ t: 'withhold' }, { t: 'computerRelease' }, { t: 'junkProof' }, { t: 'keepRestore' }, { t: 'keepRestore', attempts: 8 }, { t: 'writeKept' }, { t: 'writeKept', best: true });
    for (const label of Object.keys(w.folder)) ops.push({ t: 'rollback', label }, { t: 'junkLine', label });
  }
  if (b.computer || w.stolen) for (const label of Object.keys(w.folder)) ops.push({ t: 'reencode', label });
  return ops;
}

// ---------------------------------------------------------------- checks

function activeDevices(w: SoloWorld, state: VaultState): string[] {
  return Object.values(state.members)
    .filter((m) => m.joined && !m.removed && state.cutoffs[m.deviceId] === undefined && state.forked[m.deviceId] === undefined && !labelOf(w, m.deviceId).startsWith('R'))
    .map((m) => labelOf(w, m.deviceId));
}

function projection(state: VaultState): string {
  const active = Object.values(state.members).filter((m) => m.joined && !m.removed && state.cutoffs[m.deviceId] === undefined).map((m) => m.deviceId).sort();
  return JSON.stringify({ active, recovery: state.recovery?.deviceId ?? null, epoch: state.epoch, keyChecks: state.keyChecks, needsFreshKey: state.needsFreshKey, accounts: Object.fromEntries(Object.entries(state.accounts).map(([k, v]) => [k, v.hash]).sort()) });
}

/** The honest phone syncs twice: sends, repairs what the folder lost, reads, publishes fork proofs. */
export function settle(world: SoloWorld): SoloWorld {
  let w = world;
  for (let i = 0; i < 2; i++) {
    const next = cloneWorld(w);
    if (phoneUsable(next)) HONEST.sync!(next, { t: 'sync' });
    w = next;
  }
  return w;
}

function outcomeChecks(w: SoloWorld): SoloViolation[] {
  const out: SoloViolation[] = [];
  const folder = folderState(w);
  // S4 (P1): a restore the owner adopted never loses its seq to an attempt the owner made on another install that the computer kept and wrote in later.
  // Someone else holding the phrase changed it (an R double-sign): the owner is out by design, and S8 covers the phrase.
  const ownPhrase = !folder.recovery || PHRASE_LABELS.includes(labelOf(w, folder.recovery.deviceId));
  for (const r of ownPhrase ? w.restores : []) {
    // Adopted: the new phone's hello is in the folder. Lost: it no longer applies and R's add for it doesn't either.
    const hello = folder.history.find((h) => h.author === idOf(w, r.device) && h.kind === 'device.hello');
    if (!hello || hello.status === 'applied' || statusOf(folder, r.addHash).status === 'applied') continue;
    // The engine redoes a restore that lost before its post-adopt ack: the owner is fine when a later restore of theirs counts.
    if (w.restores.some((x) => x.step > r.step && statusOf(folder, x.addHash).status === 'applied')) continue;
    const rival = folder.history.find((h) => h.status === 'applied' && w.keptAdds.includes(h.hash) && h.kind === 'device.add');
    if (rival && rival.seq === (w.signed[r.phrase] ?? []).map((t) => JSON.parse(t) as SignedEntry).find((e) => entryHash(e) === r.addHash)?.seq) {
      out.push({ invariant: 'S4', summary: `the restore onto ${r.device} that the owner adopted lost ${r.phrase}#${rival.seq} to a kept attempt onto ${rival.subject ? labelOf(w, rival.subject) : 'another install'} the computer wrote in later` });
    }
  }
  // S4 after the last restore that landed in the folder
  const landed = [...w.restores].reverse().find((r) => statusOf(folder, r.addHash).status === 'applied');
  // A later restore by someone else holding the phrase (an R double-sign) takes over: the owner's phone is then cut like F, and S8 covers the phrase.
  const lastAdd = [...folder.history].reverse().find((h) => h.kind === 'device.add' && h.status === 'applied' && labelOf(w, h.author).startsWith('R'));
  if (landed && (!lastAdd || lastAdd.hash === landed.addHash)) {
    const rotated = statusOf(folder, landed.rotateHash).status === 'applied';
    const cut = folder.cutoffs[idOf(w, 'F')];
    for (const h of folder.history) {
      if (h.author !== idOf(w, 'F') || !w.thiefLines.includes(h.hash)) continue;
      if (cut !== undefined && h.seq <= cut) continue;
      if (h.status === 'applied') out.push({ invariant: 'S4', summary: `after the restore onto ${landed.device}, the thief's F#${h.seq} ${h.kind} applies` });
      else if (h.kind.startsWith('account.') && !h.caught && h.status === 'rejected' && cut !== undefined) out.push({ invariant: 'S4', summary: `after the restore onto ${landed.device}, the thief's F#${h.seq} ${h.kind} past the cut is rejected but not caught` });
    }
    // S9 (P3): what the thief deleted before the cut is offered back.
    for (const h of folder.history) {
      if (h.kind !== 'account.delete' || h.author !== idOf(w, 'F') || !w.thiefLines.includes(h.hash) || !h.subject) continue;
      if (folder.accounts[h.subject] || h.caught || h.voided || h.restoreReview) continue;
      out.push({ invariant: 'S9', summary: `account a${w.accounts.indexOf(h.subject) + 1}, deleted by the stolen phone (F#${h.seq}, ${h.status}) before the restore onto ${landed.device}, is gone and its delete is not offered for review` });
    }
    // Accounts R had seen stay, unless an honest delete removed them; the restored phone reads them.
    const later = w.restores.filter((r) => r.step > landed.step);
    if (later.length === 0) {
      const readable = (() => {
        try {
          return new Set(Object.keys(openVault(folder, keysOf(w, w.active)).accounts));
        } catch {
          return new Set<string>();
        }
      })();
      for (const account of landed.base) {
        if (w.deleted.includes(account) && !folder.accounts[account]) continue;
        if (!folder.accounts[account]) out.push({ invariant: 'S4', summary: `account ${w.accounts.indexOf(account) >= 0 ? `a${w.accounts.indexOf(account) + 1}` : account.slice(0, 6)}, applied in what ${landed.phrase} saw when restoring onto ${landed.device}, is gone` });
        else if (w.active === landed.device && !readable.has(account)) out.push({ invariant: 'S4', summary: `the restored phone ${landed.device} can't read account a${w.accounts.indexOf(account) + 1}` });
      }
    }
    if (rotated) {
      for (const label of ['F', ...DEVICE_LABELS.slice(0, w.restores.indexOf(landed))]) {
        if (heldKey(folder, keysOf(w, label), false)) out.push({ invariant: 'S4', summary: `after the restore onto ${landed.device} rotated the key, the cut device ${label} still opens the current key` });
      }
    }
    // F, its forks, proofs and junk change nothing: the folder without the thief's lines past the cut and without F proofs.
    if (w.stolen) {
      const honestF = new Set((w.signed.F ?? []).map((t) => hashOfText(t)));
      const folderF = w.folder.F ?? [];
      let keepF = 0;
      while (keepF < folderF.length && honestF.has(hashOfText(folderF[keepF]!))) keepF++;
      const stripped = Object.fromEntries(Object.entries(w.folder).map(([k, v]) => [k, k === 'F' ? v.slice(0, keepF) : k === 'X' ? [] : v]));
      const plain = { ...w, forks: w.forks.filter((f) => f.deviceId !== idOf(w, 'F')), seals: w.seals.filter((s) => !w.thiefLines.includes(s.entry)) } as SoloWorld;
      const clean = replayOf(plain, stripped);
      if (projection(clean) !== projection(folder) && statusOf(clean, landed.addHash).status === 'applied') out.push({ invariant: 'S4', summary: `the thief's lines and proofs change the state after the restore onto ${landed.device}: ${firstDiff(clean, folder)}` });
    }
  }

  // S5 after a phrase change
  // The owner's phrase change, made on its own phone that still syncs, is never lost to another version signed with the old phrase.
  if (phoneUsable(w) && w.phraseSets.length > 0 && !w.phraseSets.some((h) => statusOf(folder, h).status === 'applied')) {
    const sets = Object.values(w.signed).flat().map((t) => JSON.parse(t) as SignedEntry).filter((e) => w.phraseSets.includes(entryHash(e)));
    const mine = sets[sets.length - 1];
    const rival = mine ? folder.history.find((h) => h.author === mine.author && h.seq === mine.seq && h.status === 'applied' && !w.phraseSets.includes(h.hash)) : undefined;
    if (rival) out.push({ invariant: 'S5', summary: `the owner's phrase change ${labelOf(w, mine!.author)}#${mine!.seq} lost to ${w.keptAdds.includes(rival.hash) ? `a restore attempt the owner signed before the change, kept by the computer and written over it (a ${rival.kind})` : `another version signed with the old phrase (a ${rival.kind})`}, even after the owner's phone synced${w.acks.length ? ' and could repair its ack' : ''}` });
  }
  // Only once the owner's change counts in the folder (it can lose an R fork at its seq, and then never landed).
  if (w.phraseChanges > 0 && folder.recovery?.deviceId !== idOf(w, 'R1') && w.phraseSets.some((h) => statusOf(folder, h).status === 'applied')) {
    for (const h of w.oldPhraseLines) if (statusOf(folder, h).status === 'applied') out.push({ invariant: 'S5', summary: `the old phrase R1's line ${h.slice(0, 8)} (signed after the change) applies` });
    if (heldKey(folder, keysOf(w, 'R1'), false)) out.push({ invariant: 'S5', summary: 'the old phrase R1 still opens the current key' });
  }

  // S8: the phrase never dies.
  const rid = folder.recovery?.deviceId;
  if (!rid) out.push({ invariant: 'S8', summary: 'the folder has no current phrase' });
  else {
    const holder = labelOf(w, rid);
    const R = keysOf(w, holder);
    const phone = w.ctx.device('Z9');
    const built = restoreLines(w, folder, '', phone, seededRandom(`${w.ctx.seed}/s8/${w.trace.length}`), R);
    if ('error' in built) out.push({ invariant: 'S8', summary: `the holder of the current phrase ${holder} can't build a restore: ${built.error}` });
    else {
      try {
        const plan = planAppend(w.vaultId, toIds(w, w.folder), built.lines, { cache, ...(w.forks.length ? { forks: w.forks } : {}), ...(w.seals.length ? { sealProofs: w.seals } : {}) });
        if (!heldKey(plan.state as VaultState, phone)) out.push({ invariant: 'S8', summary: `a restore with the current phrase ${holder} is taken but the new phone opens no key that matches the keyCheck` });
      } catch (err) {
        out.push({ invariant: 'S8', summary: `the agent refuses a restore with the current phrase ${holder}: ${(err as Error).message}` });
      }
    }
    if (phoneUsable(w)) {
      const copy = copyState(w);
      if (copy.recovery?.deviceId !== rid) out.push({ invariant: 'S8', summary: `${w.active}'s copy says the current phrase is ${copy.recovery ? labelOf(w, copy.recovery.deviceId) : 'none'}, the folder ${holder}` });
    }
    const reversed = replayOf(w, Object.fromEntries(Object.entries(w.folder).reverse()));
    if (reversed.recovery?.deviceId !== rid) out.push({ invariant: 'S8', summary: `the folder replayed in another log order has phrase ${reversed.recovery ? labelOf(w, reversed.recovery.deviceId) : 'none'}, not ${holder}` });
  }
  return out;
}

export function checkSolo(w: SoloWorld): SoloViolation[] {
  const out: SoloViolation[] = [...w.notes];
  const folder = folderState(w);
  const states: [string, VaultState][] = [['the folder', folder]];
  if (phoneUsable(w)) states.push([`${w.active}'s copy`, copyState(w)]);

  // S1
  for (const [where, state] of states) {
    const active = activeDevices(w, state);
    if (active.length > 1) out.push({ invariant: 'S1', summary: `${where} has ${active.length} active devices: ${active.join(', ')}` });
  }

  // S2, S3, S7 on every applied line
  const recoveryIds = new Set(PHRASE_LABELS.concat(['RX', 'RY', 'RZ']).map((l) => idOf(w, l)));
  const signed = new Set(w.hashes);
  for (const [where, state] of states) {
    for (const h of state.history) {
      if (h.status !== 'applied') continue;
      const label = labelOf(w, h.author);
      if (!signed.has(h.hash)) out.push({ invariant: 'S7', summary: `${where} applies ${label}#${h.seq} ${h.kind}, which no key holder signed` });
      if (!recoveryIds.has(h.author) && h.kind !== 'vault.create' && !(h.kind === 'recovery.set' && label === 'F' && h.seq === 1) && !DEVICE_KINDS.has(h.kind)) out.push({ invariant: 'S3', summary: `${where} applies ${label}#${h.seq} ${h.kind}, a kind a device may not write` });
      if (h.kind === 'device.add') {
        if (!recoveryIds.has(h.author)) {
          out.push({ invariant: 'S2', summary: `${where} applies a device.add by ${label}, not a recovery identity` });
          continue;
        }
        const log = state.chains[h.author] ?? [];
        const rotateHash = log[h.seq + 1];
        const rotate = rotateHash ? state.history.find((x) => x.hash === rotateHash) : undefined;
        if (!rotate || rotate.status !== 'applied') {
          // A later restore, or a later key change by a recovery identity, settles the key.
          const later = state.history.some((x) => (x.kind === 'device.add' || x.kind === 'key.rotate' || x.kind === 'recovery.set') && x.status === 'applied' && recoveryIds.has(x.author) && x !== h && state.history.indexOf(x) > state.history.indexOf(h));
          if (!state.needsFreshKey && !later) out.push({ invariant: 'S2', summary: `${where}: ${label}#${h.seq} restore applies without its key.rotate, and the vault doesn't need a fresh key` });
        } else {
          const text = Object.values(w.folder).flat().concat(Object.values(w.copy).flat()).find((t) => hashOfText(t) === rotateHash);
          const body = text ? ((JSON.parse(text) as SignedEntry).body as { keys?: Record<string, unknown> }) : undefined;
          const added = h.subject;
          const extra = Object.keys(body?.keys ?? {}).filter((id) => id !== added && !recoveryIds.has(id));
          if (extra.length > 0) out.push({ invariant: 'S2', summary: `${where}: the restore's key.rotate ${label}#${h.seq + 1} is also sealed to ${extra.map((id) => labelOf(w, id)).join(', ')}` });
        }
      }
    }
  }

  // S4, S5 on the folder; after the computer meddled, once the honest phone has synced (repairing what it holds).
  // What persists after the honest phone repaired is reported under S7r (the rollback exception) with what it loses.
  if (computerTouched(w)) out.push(...outcomeChecks(settle(w)).map((v) => ({ invariant: 'S7r' as const, summary: `with the computer rolling back, withholding or re-encoding, ${v.invariant} fails even after the honest phone repaired what it holds: ${v.summary}` })));
  // Judged once the honest phone has synced (sent, repaired, read): a gap it can fill is not a loss.
  else out.push(...outcomeChecks(settle(w)));
  // Strict under any computer: the phone never shows itself restored, or its new phrase saved, while the folder has it out.
  {
    const s = settle(w);
    // A phone whose lines the folder lacks warns (checkRollback): only a silent phone counts.
    // The app also remembers every chain's head it read (checkRollback in engine.ts sync): a head that changed or went back warns.
    const seen = phoneUsable(w) ? copyState(w).chains : {};
    const after = folderState(s).chains;
    const headsHold = Object.entries(seen).every(([id, chain]) => chain.length === 0 || (after[id] ?? [])[chain.length - 1] === chain[chain.length - 1]);
    if (phoneUsable(s) && lostByRollback(s).length === 0 && headsHold) {
      const me = idOf(s, s.active);
      const f = folderState(s);
      const c = copyState(s);
      const inState = (st: VaultState) => !!st.members[me] && !st.members[me]!.removed && st.cutoffs[me] === undefined;
      if (inState(c) && !inState(f)) out.push({ invariant: 'S4', summary: `${s.active} still reads itself in the vault after syncing, but the folder has it out` });
      const current = f.recovery ? labelOf(s, f.recovery.deviceId) : null;
      if (s.phraseChanges > 0 && current !== s.phrase && c.recovery && labelOf(s, c.recovery.deviceId) === s.phrase) out.push({ invariant: 'S5', summary: `${s.active} still shows the new phrase ${s.phrase} saved after syncing, but the folder's current phrase is ${current ?? 'none'}` });
    }
  }

  // S6: log order and bytes
  const reversed = Object.fromEntries(Object.entries(w.folder).reverse());
  const r = replayOf(w, reversed);
  if (projection(r) !== projection(folder)) out.push({ invariant: 'S6', summary: `the folder replays differently with its logs in another order: ${firstDiff(folder, r)}` });
  if (phoneUsable(w)) {
    const copy = copyState(w);
    const same = Object.entries(w.copy).every(([l, t]) => JSON.stringify(t) === JSON.stringify((w.folder[l] ?? []).map(canonical))) && Object.keys(w.folder).every((l) => w.copy[l]);
    const canonicalFolder = replayOf(w, Object.fromEntries(Object.entries(w.folder).map(([k, v]) => [k, v.map(canonical)])));
    if (same && projection(copy) !== projection(canonicalFolder)) out.push({ invariant: 'S6', summary: `${w.active}'s copy holds the folder's lines but replays differently: ${firstDiff(canonicalFolder, copy)}` });
  }
  return dedupe(out);
}

function firstDiff(a: VaultState, b: VaultState): string {
  const pa = JSON.parse(projection(a)) as Record<string, unknown>;
  const pb = JSON.parse(projection(b)) as Record<string, unknown>;
  for (const k of Object.keys(pa)) if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) return `${k}: ${JSON.stringify(pa[k])} vs ${JSON.stringify(pb[k])}`;
  return 'history only';
}

function dedupe(v: SoloViolation[]): SoloViolation[] {
  const seen = new Set<string>();
  return v.filter((x) => {
    const k = `${x.invariant}|${x.summary}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- search

export interface SoloFound {
  violation: SoloViolation;
  ops: SoloOp[];
  bounds: SoloBounds;
  seed: string;
}

export interface SoloStats {
  visited: number;
  distinct: number;
  tried: number;
  refused: number;
  byInvariant: Record<string, number>;
  seconds: number;
  cutShort: boolean;
}

function signature(w: SoloWorld): string {
  return digest([w.folder, w.copy, w.sent, w.held, w.withholdNext, w.stolen, w.thiefCopy, w.thiefLog, w.thiefHeld, w.phrase, w.forks, w.seals, w.active, w.restores.length, w.counters, w.deleted, w.notes]);
}

function record(found: Map<string, SoloFound>, stats: SoloStats, w: SoloWorld, keep: number): void {
  for (const v of checkSolo(w)) {
    stats.byInvariant[v.invariant] = (stats.byInvariant[v.invariant] ?? 0) + 1;
    const key = `${v.invariant}|${v.summary.replace(/[0-9a-f]{8}/g, '')}`;
    const count = [...found.keys()].filter((k) => k.startsWith(`${v.invariant}|`)).length;
    if (!found.has(key) && count < keep) found.set(key, { violation: v, ops: [...w.trace], bounds: w.bounds, seed: w.ctx.seed });
    else {
      const prev = found.get(key);
      if (prev && w.trace.length < prev.ops.length) found.set(key, { violation: v, ops: [...w.trace], bounds: w.bounds, seed: w.ctx.seed });
    }
  }
}

export function searchSoloExhaustive(seed: string, bounds: SoloBounds, timeLimit = Infinity, keep = 3): { found: SoloFound[]; stats: SoloStats } {
  vaultFeatures.multiDevice = false;
  const started = Date.now();
  const ctx = new ModelContext(seed);
  const stats: SoloStats = { visited: 0, distinct: 0, tried: 0, refused: 0, byInvariant: {}, seconds: 0, cutShort: false };
  const found = new Map<string, SoloFound>();
  const seen = new Set<string>();
  const stack: SoloWorld[] = [newSoloWorld(ctx, bounds)];
  while (stack.length > 0) {
    if ((Date.now() - started) / 1000 > timeLimit) {
      stats.cutShort = true;
      break;
    }
    const w = stack.pop()!;
    stats.visited++;
    const sig = signature(w);
    if (seen.has(sig)) continue;
    seen.add(sig);
    stats.distinct++;
    record(found, stats, w, keep);
    for (const op of candidateSoloOps(w)) {
      stats.tried++;
      const next = applySoloOp(w, op);
      if (!next) stats.refused++;
      else stack.push(next);
    }
  }
  stats.seconds = (Date.now() - started) / 1000;
  return { found: [...found.values()], stats };
}

export function searchSoloRandom(seed: string, bounds: SoloBounds, walks: number, timeLimit = Infinity, keep = 3): { found: SoloFound[]; stats: SoloStats } {
  vaultFeatures.multiDevice = false;
  const started = Date.now();
  const ctx = new ModelContext(seed);
  const stats: SoloStats = { visited: 0, distinct: 0, tried: 0, refused: 0, byInvariant: {}, seconds: 0, cutShort: false };
  const found = new Map<string, SoloFound>();
  const pick = seededRandom(`${seed}/walks`);
  for (let i = 0; i < walks; i++) {
    if ((Date.now() - started) / 1000 > timeLimit) {
      stats.cutShort = true;
      break;
    }
    let w = newSoloWorld(ctx, bounds);
    for (;;) {
      stats.visited++;
      const ops = candidateSoloOps(w);
      let moved = false;
      while (ops.length > 0) {
        const at = pick(2).reduce((a, b) => a * 256 + b, 0) % ops.length;
        const op = ops.splice(at, 1)[0]!;
        stats.tried++;
        const next = applySoloOp(w, op);
        if (!next) {
          stats.refused++;
          continue;
        }
        w = next;
        moved = true;
        break;
      }
      if (!moved) break;
      record(found, stats, w, keep);
    }
    stats.distinct++;
  }
  stats.seconds = (Date.now() - started) / 1000;
  return { found: [...found.values()], stats };
}

/** Drops ops one at a time while the same invariant still fails with the same kind of summary. */
export function minimiseSolo(f: SoloFound): SoloFound {
  vaultFeatures.multiDevice = false;
  const ctx = new ModelContext(f.seed);
  const shape = f.violation.summary.replace(/[0-9a-f]{6,}|#\d+|a\d+|D\d/g, '');
  const holds = (ops: SoloOp[]) => {
    const w = runSolo(ctx, f.bounds, ops);
    return w ? checkSolo(w).find((v) => v.invariant === f.violation.invariant && v.summary.replace(/[0-9a-f]{6,}|#\d+|a\d+|D\d/g, '') === shape) ?? null : null;
  };
  let ops = [...f.ops];
  let violation = f.violation;
  for (let i = ops.length - 1; i >= 0; i--) {
    const trial = [...ops.slice(0, i), ...ops.slice(i + 1)];
    const v = holds(trial);
    if (v) {
      ops = trial;
      violation = v;
    }
  }
  return { ...f, ops, violation };
}

// ---------------------------------------------------------------- report

export function describeSoloOp(op: SoloOp): string {
  switch (op.t) {
    case 'put': return 'The owner adds an account on the phone in hand (sent through the agent).';
    case 'delete': return 'The owner deletes an account on the phone in hand.';
    case 'rename': return 'The owner renames the phone in hand.';
    case 'sync': return 'The phone in hand syncs: sends what it holds back, reads the folder.';
    case 'restore': return 'The owner restores onto a new phone with the current phrase, on what the folder holds (R\'s device.add, the hello, R\'s key.rotate, through the agent).';
    case 'phrase': return 'The owner sets a new phrase (a recovery.set signed by the current R).';
    case 'steal': return 'The old phone F is stolen: the thief has its keys and its copy.';
    case 'thief': if (op.kind === 'truncate') return 'The thief, writing the folder, replaces the last line of F\'s log there with junk (same entry, garbage signature).';
      if (op.kind === 'forkProof') return 'The thief publishes a fork proof of its own last line (a second version it signs).';
      return `The thief signs ${op.kind === 'fork' ? 'a second version of F\'s last line (an account.put)' : op.kind === 'garbage' ? 'an account.put with a garbage signature' : op.kind === 'badSeal' ? 'a key.rotate whose key sealed to the others is another key' : `an F ${op.kind}${op.target ? ` of ${op.target}` : ''}`} on ${op.basis === 'stale' ? 'its stale copy' : 'the folder'} and ${op.delivery === 'agent' ? 'sends it through the agent' : op.delivery === 'direct' ? 'writes it straight into the folder' : 'holds it back'}.`;
    case 'thiefRelease': return 'The thief writes everything it held back straight into the folder.';
    case 'oldPhrase': return `Someone holding the old phrase R1 ${op.kind === 'restore' ? 'restores onto its own phone Y' : 'sets its own phrase'} and ${op.delivery === 'agent' ? 'sends it through the agent' : 'writes it straight into the folder'}.`;
    case 'withhold': return 'The computer swallows the next honest send (for a phrase change: P\'s ack of it).';
    case 'keepRestore': return `The owner tries ${op.attempts && op.attempts > 1 ? `${op.attempts} restores` : 'a restore'} with the current phrase on another install Q; the computer keeps ${op.attempts && op.attempts > 1 ? 'them' : 'it'} instead of writing ${op.attempts && op.attempts > 1 ? 'them' : 'it'}.`;
    case 'writeKept': return op.best ? 'Weeks later the computer takes the kept restore whose add hashes lowest, puts it in R\'s log in place of the line at its seq (and what followed), writes its hello, and publishes the fork proof.' : 'Weeks later the computer writes the kept restore attempt straight into the folder (with a fork proof where it collides).';
    case 'computerRelease': return 'The computer writes the honest lines it swallowed into the folder.';
    case 'rollback': return `The computer rolls ${op.label}'s log in the folder back by one line.`;
    case 'reencode': return `The computer re-encodes ${op.label}'s lines in the folder with whitespace.`;
    case 'junkLine': return `The computer appends a junk line (a copy with the next seq, signature not matching) to ${op.label}'s log.`;
    case 'junkProof': return 'The computer adds a junk fork proof and a junk seal proof.';
    case 'rFork': return `${op.kind === 'retry' ? 'The owner\'s phrase change is signed again (same new phrase)' : 'Someone holding the current phrase signs a second R line'} at ${op.old ? `the seq of the owner's phrase change (with the old phrase${op.stale ? ', on the folder as it stood before the change' : ''})` : 'R\'s last seq'}${op.grind ? ' (ground for the lowest hash' + (op.chain ? ', with R\'s next line chained on it' : '') + ')' : ''}: ${op.kind === 'restore' ? 'a restore onto its own phone Y' : op.kind === 'retry' ? 'a second recovery.set to the same phrase' : 'a phrase change to RZ'}, ${op.delivery === 'direct' ? 'replacing R\'s line in the folder, and publishes the fork proof' : 'and publishes only the fork proof'}.`;
  }
}

const modelDir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const agentDir = join(modelDir, '../..');

export function writeSoloCounterexamples(found: SoloFound[], dir: string, label: string): string[] {
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  const counts: Record<string, number> = {};
  for (const f of found) {
    const n = (counts[f.violation.invariant] = (counts[f.violation.invariant] ?? 0) + 1);
    const base = join(dir, `${label}-${f.violation.invariant}-${n}`);
    const w = runSolo(new ModelContext(f.seed), f.bounds, f.ops);
    const state = w ? folderState(w) : null;
    const story = [
      `# ${f.violation.invariant} violated: ${f.violation.summary}`,
      '',
      `**${f.violation.invariant}.** ${SOLO_INVARIANTS[f.violation.invariant === 'S7r' ? 'S7' : f.violation.invariant]}`,
      '',
      `**Run it:** \`cd agent && node --import tsx ${relative(agentDir, base)}.ts\``,
      '',
      '## What happened, in order',
      '',
      ...f.ops.map((op, i) => `${i + 1}. ${describeSoloOp(op)}`),
      '',
      '## The folder at the end, as replayVault decides it',
      '',
      ...(state && w ? state.history.map((h) => `- ${labelOf(w, h.author)}#${h.seq} ${h.kind}: ${h.status}${h.caught ? ' (caught)' : ''}${h.reason ? ` (${h.reason})` : ''}`) : ['(the scenario no longer builds)']),
      '',
    ].join('\n');
    writeFileSync(`${base}.md`, story);
    writeFileSync(`${base}.json`, `${JSON.stringify({ seed: f.seed, bounds: f.bounds, ops: f.ops, violation: f.violation }, null, 2)}\n`);
    const fromFixture = (target: string) => { const r = relative(dirname(base), target); return r.startsWith('.') ? r : `./${r}`; };
    writeFileSync(
      `${base}.ts`,
      [
        `// ${f.violation.invariant}: ${f.violation.summary}`,
        `import { ModelContext } from '${fromFixture(join(modelDir, 'context'))}';`,
        `import { checkSolo, runSolo } from '${fromFixture(join(modelDir, 'solo'))}';`,
        `import { vaultFeatures } from '${fromFixture(join(modelDir, '../../src/vault/features'))}';`,
        'vaultFeatures.multiDevice = false;',
        `const fixture = ${JSON.stringify({ seed: f.seed, bounds: f.bounds, ops: f.ops })};`,
        'const world = runSolo(new ModelContext(fixture.seed), fixture.bounds as never, fixture.ops as never);',
        "if (!world) throw new Error('the scenario no longer builds');",
        `const hit = checkSolo(world).filter((v) => v.invariant === ${JSON.stringify(f.violation.invariant)});`,
        "console.log(hit.length > 0 ? `FAIL ${hit.map((v) => v.summary).join('; ')}` : 'PASS (no longer violated)');",
        '',
      ].join('\n'),
    );
    paths.push(`${base}.md`);
  }
  return paths;
}

// ---------------------------------------------------------------- presets

export const SOLO_FAST: SoloBounds = {
  maxSteps: 5,
  maxPuts: 1,
  maxRestores: 1,
  maxPhraseChanges: 1,
  maxThief: 1,
  maxPhraseThief: 1,
  maxComputer: 1,
  maxRFork: 1,
  thief: true,
  phraseThief: true,
  computer: true,
  thiefKinds: THIEF_KINDS,
};

export const SOLO_DEEP: SoloBounds = {
  maxSteps: 10,
  maxPuts: 2,
  maxRestores: 2,
  maxPhraseChanges: 1,
  maxThief: 3,
  maxPhraseThief: 2,
  maxComputer: 2,
  maxRFork: 1,
  thief: true,
  phraseThief: true,
  computer: true,
  thiefKinds: THIEF_KINDS,
};

export function formatSoloStats(s: SoloStats): string {
  const inv = Object.entries(s.byInvariant).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
  return `states visited ${s.visited}, distinct ${s.distinct}; ops tried ${s.tried}, refused ${s.refused}; violating states by invariant: ${inv}; ${s.seconds.toFixed(1)} s${s.cutShort ? ' (cut short by the time limit)' : ''}`;
}
