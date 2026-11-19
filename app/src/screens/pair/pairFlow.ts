/**
 * The pairing flow without React: which computer is picked, the PIN typed so far, a pairing link
 * waiting to be checked, and a changed key waiting for a decision. usePairFlow binds it to React.
 *
 * Three rules it keeps: a link (QR code or deep link) never pairs until the person confirms the
 * computer it names; whether a pairing is saved, asked about or refused is decided by the trust
 * rule (net/trust.ts, through savePairing), and only the person can answer a question it asks;
 * and only a pairing the person is still waiting for switches the active computer.
 */
import { haptics } from '../../lib/haptics';
import { PairingCancelled, RequestError } from '../../net/client';
import type { PairLink } from '../../net/discovery';
import { isSameComputerName } from '../../net/trust';
import {
  KeyChangedError,
  NameMismatchError,
  PIN_LENGTH,
  type PairProblem,
  type PairResult,
  type PairTarget,
  type SaveChoice,
  type SavedConflict,
  describePairError,
  keyChangeWords,
  pairByLink,
  pairByPin,
  savePairing,
  targetFromLink,
} from './pairing';

/** A pairing that could be mistaken for a saved computer, waiting for a decision. */
export interface KeyChange {
  /** The saved computer's name. */
  name: string;
  conflict: SavedConflict;
  /** The question, in full. */
  message: string;
  savedWords: string;
  newWords: string;
  result: PairResult;
}

export interface PairFlowState {
  target: PairTarget | null;
  pin: string;
  busy: boolean;
  paired: boolean;
  problem: PairProblem | null;
  /** Bumped on a wrong PIN so the slots shake once. */
  shakeTick: number;
  /** A pairing link waiting for the person to check the computer it names. */
  offeredLink: PairLink | null;
  /** A pairing waiting for the person to accept or refuse a changed key. */
  keyChange: KeyChange | null;
}

export interface PairFlowDeps {
  /** `signal` aborts when the person leaves the pairing: the remaining addresses are not tried. */
  pairByPin: (target: PairTarget, pin: string, signal?: AbortSignal) => Promise<PairResult>;
  pairByLink: (link: PairLink, repairAgentId: string | null, signal?: AbortSignal) => Promise<PairResult>;
  save: (result: PairResult, choice: SaveChoice) => string;
  /** Called once a pairing is saved, with the computer's name. */
  onPaired: (name: string) => void;
}

const INITIAL: Omit<PairFlowState, 'target'> = { pin: '', busy: false, paired: false, problem: null, shakeTick: 0, offeredLink: null, keyChange: null };

export class PairFlowController {
  private state: PairFlowState;
  private readonly listeners = new Set<() => void>();
  private readonly deps: PairFlowDeps;
  /** Ignores answers to a request the person has since walked away from. */
  private attempt = 0;
  /** Stops the address sweep of the pairing in flight once the person walks away from it. */
  private inFlight: AbortController | null = null;
  /** The link being paired with, so an unreachable computer can be tried again. */
  private retryLink: PairLink | null = null;

  /** The saved computer whose Re-pair opened this flow: a QR code scanned here for it re-pairs it. */
  private readonly repairing: PairTarget | null;

  /** `notice` is shown until the person starts typing, e.g. that the computer unpaired this device. */
  constructor(initial: PairTarget | null, deps: Pick<PairFlowDeps, 'onPaired'> & Partial<PairFlowDeps>, notice: PairProblem | null = null) {
    this.state = { ...INITIAL, target: initial, problem: notice };
    this.repairing = initial?.startedFrom === 'saved' ? initial : null;
    this.deps = { pairByPin, pairByLink, save: savePairing, ...deps };
  }

  getState = (): PairFlowState => this.state;

  /**
   * The id a scanned QR code must answer with: the re-paired computer's, when the code names it.
   * A code for some other computer, scanned from the same screen, is an ordinary new pairing.
   */
  private repairIdFor(link: PairLink): string | null {
    const r = this.repairing;
    return r && isSameComputerName(link.name, r.name) ? r.agentId : null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  choose = (target: PairTarget | null): void => {
    this.attempt++;
    this.stopInFlight();
    this.retryLink = null;
    this.set({ target, pin: '', busy: false, problem: null });
  };

  typeDigit = (digit: string): void => {
    const { target, busy, paired, pin, problem } = this.state;
    if (!target || busy || paired || pin.length >= PIN_LENGTH) return;
    haptics.tick();
    const next = pin + digit;
    this.set({ pin: next, problem: problem?.kind === 'locked' ? problem : null });
    if (next.length === PIN_LENGTH) void this.submit(target, next, null);
  };

  backspace = (): void => {
    const { busy, paired, pin } = this.state;
    if (busy || paired || pin.length === 0) return;
    haptics.tick();
    this.set({ pin: pin.slice(0, -1) });
  };

  /** Fills the PIN from pasted text. Returns false when the text holds no 6-digit PIN. */
  pastePin = (text: string): boolean => {
    const { target, busy, paired } = this.state;
    const digits = /\b(\d{3})\s?(\d{3})\b/.exec(text);
    if (!target || busy || paired || !digits) return false;
    const code = digits[1]! + digits[2]!;
    this.set({ pin: code });
    void this.submit(target, code, null);
    return true;
  };

  /** Try the same PIN or link again (after the computer could not be reached). */
  retry = (): void => {
    const { target, busy, pin } = this.state;
    if (!target || busy) return;
    if (this.retryLink) void this.submit(target, '', this.retryLink);
    else if (pin.length === PIN_LENGTH) void this.submit(target, pin, null);
  };

  /** A link arrived (QR code or deep link): show the computer it names; nothing is sent yet. */
  offerLink = (link: PairLink): void => {
    this.attempt++;
    this.stopInFlight();
    this.retryLink = null;
    this.set({ offeredLink: link, busy: false, problem: null });
  };

  /** The person checked the offered computer and wants to pair with it. */
  confirmLink = (): void => {
    const link = this.state.offeredLink;
    if (!link || link.hosts.length === 0) return;
    const target = targetFromLink(link, this.repairIdFor(link));
    this.set({ offeredLink: null, target, pin: '' });
    void this.submit(target, '', link);
  };

  dismissLink = (): void => {
    if (this.state.offeredLink) this.set({ offeredLink: null });
  };

  /** The person chose to pair despite the conflict: save the pairing already in hand. */
  pairAnyway = (): void => {
    const change = this.state.keyChange;
    if (!change) return;
    this.set({ keyChange: null });
    this.save(change.result, change.conflict);
  };

  /** The person kept the saved computer: nothing is saved. */
  keepSaved = (): void => {
    const change = this.state.keyChange;
    if (!change) return;
    this.set({
      keyChange: null,
      pin: '',
      problem: { kind: 'other', title: `Did not pair with ${change.name}.`, detail: 'The computer saved on this device stays as it was.' },
    });
  };

  /** The pairing screen closed: a pairing in flight tries no further address. */
  leave = (): void => {
    this.attempt++;
    this.stopInFlight();
  };

  private stopInFlight(): void {
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private set(patch: Partial<PairFlowState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** Pairs with the PIN, or with the link's key and secret when `link` is given. */
  private async submit(to: PairTarget, pin: string, link: PairLink | null): Promise<void> {
    const id = ++this.attempt;
    this.stopInFlight();
    const sweep = new AbortController();
    this.inFlight = sweep;
    this.retryLink = link;
    this.set({ busy: true, problem: null });
    let result: PairResult;
    try {
      result = link ? await this.deps.pairByLink(link, this.repairIdFor(link), sweep.signal) : await this.deps.pairByPin(to, pin, sweep.signal);
    } catch (e) {
      if (id === this.attempt && !(e instanceof PairingCancelled)) this.fail(to, link, e);
      return;
    } finally {
      if (this.inFlight === sweep) this.inFlight = null;
    }
    if (id === this.attempt) this.save(result, undefined);
    else this.saveUnattended(result);
  }

  /**
   * Saves a pairing the person is waiting for: they chose this computer, so it becomes active.
   * `confirmed` is the conflict question they just answered, if any.
   */
  private save(result: PairResult, confirmed: SavedConflict | undefined): void {
    let name: string;
    try {
      name = this.deps.save(result, { confirmed, activate: true });
    } catch (e) {
      if (e instanceof NameMismatchError) {
        haptics.error();
        this.retryLink = null;
        this.set({ busy: false, problem: { kind: 'other', title: e.message, detail: e.detail } });
        return;
      }
      if (!(e instanceof KeyChangedError)) throw e;
      haptics.warning();
      this.set({ busy: false, keyChange: { ...keyChangeWords(e), result } });
      return;
    }
    haptics.success();
    this.set({ busy: false, paired: true });
    this.deps.onPaired(name);
  }

  /**
   * The computer said yes after the person moved on. Keep the pairing (the computer now trusts
   * this device) without switching to it, unless the trust rule refuses it or asks a question
   * nobody is there to answer.
   */
  private saveUnattended(result: PairResult): void {
    try {
      this.deps.save(result, { activate: false });
    } catch {
      // No one is waiting on this pairing: one that needs a question, or that could not be saved,
      // is dropped (the person can pair again), never thrown into a promise no one handles.
    }
  }

  private fail(to: PairTarget, link: PairLink | null, e: unknown): void {
    const problem = describePairError(e, to);
    haptics.error();
    if (problem.kind === 'bad_pin') {
      this.set({ busy: false, shakeTick: this.state.shakeTick + 1, pin: '', problem });
    } else if (link && e instanceof RequestError && e.code === 'unauthorized' && e.fromComputer) {
      // The computer refused this code (used, or its pairing screen is closed): retrying can't help.
      this.retryLink = null;
      this.set({ busy: false, problem: { kind: 'other', title: e.message, detail: e.hint ?? 'Scan the QR code the computer shows now, or type its PIN.' } });
    } else {
      this.set({ busy: false, problem, ...(problem.kind === 'locked' ? { pin: '' } : {}) });
    }
  }
}
