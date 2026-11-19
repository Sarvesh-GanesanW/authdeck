/**
 * A crash canary for connecting. Reading a computer's answer happens in native code before
 * JavaScript can check it, so a hostile answer could close AuthDeck, and an automatic reconnect
 * would close it again on every launch. So before AuthDeck opens a session or pairing connection
 * on a phone, a mark naming that address is saved; once the handshake there finishes or fails
 * cleanly, the address leaves the mark.
 *
 * A launch that finds an address still in the mark counts a strike against it; when the launch
 * before had already struck it (two launches in a row closed while connecting there), the address
 * is held: no connection is made to it until the person chooses Connect, or for HOLD_EXPIRY_MS.
 * One strike is not enough because a swipe from the app switcher or the system closing AuthDeck
 * in the background also leaves a mark. Addresses probed by a network sweep are never marked, and
 * a launch that closed while a sweep ran counts no strikes at all: any swept address could have
 * been the cause.
 *
 * Away from the foreground the mark names no connections: a swipe from the app switcher or the
 * system closing AuthDeck there is not a close while connecting. Back in the foreground, any
 * connection still under way is named again.
 *
 * Saving the mark can fail (storage full): the connection goes ahead unguarded and a warning shows.
 * Nothing here ever stops every connection.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

export const CONNECT_CANARY_KEY = 'authdeck-connect-canary-v1';
/** A held address is let go after this long; a strike older than this no longer counts. */
export const HOLD_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Shown when the mark can't be saved, once per launch. */
export const STORAGE_WARNING = "AuthDeck couldn't save its connection notes. Storage may be full.";

interface ConnectCanaryState {
  /** Addresses AuthDeck kept closing while connecting to: not contacted until released. */
  held: string[];
  /** The notice about held addresses is showing (cleared by Not now, shown again on a refusal). */
  noticeShown: boolean;
  /** A mark could not be saved, so connections go ahead without one; cleared by OK. */
  storageWarning: boolean;
}

export const useConnectCanary = create<ConnectCanaryState>(() => ({ held: [], noticeShown: false, storageWarning: false }));

type MarkStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

/** What a launch leaves saved for the next one. Hosts go in Maps: a host string may be "__proto__". */
export interface Mark {
  /** Held addresses, with when each was held. */
  held: Map<string, number>;
  /** Addresses the launch before this one closed while connecting to, with when that was found. */
  strikes: Map<string, number>;
  /** Session and pairing connections under way. */
  connecting: string[];
  /** A sweep is under way. */
  sweeping: boolean;
}

const MARK_VERSION = 2;

const emptyMark = (): Mark => ({ held: new Map(), strikes: new Map(), connecting: [], sweeping: false });

/** A connection to a held address, refused before anything is sent. */
export class HeldHostError extends Error {
  constructor(readonly host: string) {
    super(`AuthDeck closed while connecting to ${host} on two launches in a row.`);
    this.name = 'HeldHostError';
  }
}

const isHost = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function readDated(value: unknown): Map<string, number> {
  const dated = new Map<string, number>();
  if (!Array.isArray(value)) return dated;
  for (const entry of value) {
    if (Array.isArray(entry) && isHost(entry[0]) && Number.isFinite(entry[1])) dated.set(entry[0], entry[1] as number);
  }
  return dated;
}

/**
 * A saved mark; anything unreadable is an empty one. A plain list is the first version's mark,
 * which named the addresses being connected to (swept ones included): read as connections under way.
 */
export function readMark(raw: string | null): Mark {
  if (raw === null) return emptyMark();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyMark();
  }
  if (Array.isArray(parsed)) return { ...emptyMark(), connecting: [...new Set(parsed.filter(isHost))] };
  if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== MARK_VERSION) return emptyMark();
  const saved = parsed as Record<string, unknown>;
  return {
    held: readDated(saved.held),
    strikes: readDated(saved.strikes),
    connecting: Array.isArray(saved.connecting) ? [...new Set(saved.connecting.filter(isHost))] : [],
    sweeping: saved.sweeping === true,
  };
}

/** The mark as saved, or '' when it names nothing. */
export function writeMark(mark: Mark): string {
  if (mark.held.size === 0 && mark.strikes.size === 0 && mark.connecting.length === 0 && !mark.sweeping) return '';
  return JSON.stringify({ v: MARK_VERSION, held: [...mark.held], strikes: [...mark.strikes], connecting: mark.connecting, sweeping: mark.sweeping });
}

/** Within HOLD_EXPIRY_MS of `now`, either way: a clock set far back or forward lets the entry go. */
const isRecent = (at: number, now: number): boolean => Math.abs(now - at) < HOLD_EXPIRY_MS;

/**
 * What this launch holds and strikes, from the previous launch's mark: old holds and strikes
 * expire; an address the previous launch closed while connecting to is held if it was already
 * struck, else struck. A launch that closed during a sweep strikes nothing, and its own carried
 * strikes lapse, since that launch was not one that closed while connecting.
 */
export function afterLaunch(previous: Mark, now: number): { held: Map<string, number>; strikes: Map<string, number> } {
  const held = new Map([...previous.held].filter(([, at]) => isRecent(at, now)));
  const strikes = new Map<string, number>();
  if (previous.sweeping) return { held, strikes };
  for (const host of previous.connecting) {
    if (held.has(host)) continue;
    const struck = previous.strikes.get(host);
    if (struck !== undefined && isRecent(struck, now)) held.set(host, now);
    else strikes.set(host, now);
  }
  return { held, strikes };
}

export class ConnectCanary {
  /** Connections under way, by address (several may share one). */
  private readonly connecting = new Map<string, number>();
  /** When each held address was held; the held list itself is useConnectCanary's. */
  private heldAt = new Map<string, number>();
  private strikes = new Map<string, number>();
  /** Sweeps under way. */
  private sweeps = 0;
  private checked: Promise<void> | null = null;
  /** Mark writes, one at a time and in order. */
  private writes: Promise<void> = Promise.resolve();
  private saved = '';
  private storageWarned = false;
  /** In the foreground; when not, the mark names no connections under way. */
  private foreground = true;

  constructor(
    private readonly storage: MarkStorage = AsyncStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Reads the previous launch's mark, once per launch; every connection waits for it, so none can
   * overwrite the mark before it is read. A mark that can't be read holds nothing.
   */
  check(): Promise<void> {
    this.checked ??= (async () => {
      let previous = emptyMark();
      try {
        const raw = await this.storage.getItem(CONNECT_CANARY_KEY);
        previous = readMark(raw);
        this.saved = raw ?? '';
      } catch {
        // Unreadable: nothing is held, and the next write replaces whatever is there.
      }
      const { held, strikes } = afterLaunch(previous, this.now());
      this.heldAt = held;
      this.strikes = strikes;
      useConnectCanary.setState({ held: [...held.keys()], noticeShown: held.size > 0 });
    })();
    return this.checked;
  }

  isHeld(host: string): boolean {
    return useConnectCanary.getState().held.includes(host);
  }

  /**
   * Runs `connect` (the TCP connect and the handshake of a session or pairing) under the mark:
   * `host` is in the saved mark before it starts, and leaves it once `connect` settles. A held host
   * is refused with a HeldHostError and the notice shows again. When the mark can't be saved, the
   * connection goes ahead anyway and the storage warning shows.
   */
  async guard<T>(host: string, connect: () => Promise<T>): Promise<T> {
    await this.check();
    if (this.isHeld(host)) {
      this.showNotice();
      throw new HeldHostError(host);
    }
    this.connecting.set(host, (this.connecting.get(host) ?? 0) + 1);
    await this.saveMark();
    try {
      return await connect();
    } finally {
      this.leave(host);
    }
  }

  /**
   * Runs a network sweep with the mark saying so, so a launch that closes during it holds nothing.
   * The swept addresses themselves are never marked.
   */
  async duringSweep<T>(sweep: () => Promise<T>): Promise<T> {
    await this.check();
    this.sweeps++;
    await this.saveMark();
    try {
      return await sweep();
    } finally {
      this.sweeps--;
      void this.saveMark();
    }
  }

  /**
   * Connect: `host` may be contacted again. It keeps one strike, so closing while connecting to it
   * once more holds it again on the next launch.
   */
  async release(host: string): Promise<void> {
    await this.check();
    this.heldAt.delete(host);
    this.strikes.set(host, this.now());
    useConnectCanary.setState((s) => ({ held: s.held.filter((h) => h !== host) }));
    if (useConnectCanary.getState().held.length === 0) this.hideNotice();
    await this.saveMark();
  }

  /** The app came to the foreground (true) or left it (false): connections under way join or leave the mark. */
  setForeground(foreground: boolean): void {
    if (foreground === this.foreground) return;
    this.foreground = foreground;
    void this.saveMark();
  }

  /** Not now: the held addresses stay held; the notice goes until something asks for one. */
  hideNotice(): void {
    useConnectCanary.setState({ noticeShown: false });
  }

  /** Something the person did needs a held address: the notice offers Connect again. */
  showNotice(): void {
    if (useConnectCanary.getState().held.length > 0) useConnectCanary.setState({ noticeShown: true });
  }

  /** OK on the storage warning. It does not come back this launch. */
  dismissStorageWarning(): void {
    useConnectCanary.setState({ storageWarning: false });
  }

  private leave(host: string): void {
    const count = (this.connecting.get(host) ?? 1) - 1;
    if (count > 0) this.connecting.set(host, count);
    else this.connecting.delete(host);
    // A mark left behind only counts a strike on the next launch; it is never in the way now.
    void this.saveMark();
  }

  /** The mark from the state now. Held addresses come from useConnectCanary, which tests and Connect change. */
  private currentMark(): Mark {
    const now = this.now();
    for (const host of useConnectCanary.getState().held) if (!this.heldAt.has(host)) this.heldAt.set(host, now);
    return {
      held: new Map(useConnectCanary.getState().held.map((host) => [host, this.heldAt.get(host)!])),
      strikes: this.strikes,
      connecting: this.foreground ? [...this.connecting.keys()] : [],
      sweeping: this.sweeps > 0,
    };
  }

  /**
   * Saves the mark from the state when the write runs, after the writes before it. Never rejects:
   * a write that fails shows the storage warning, and the next write starts from the state it finds.
   */
  private saveMark(): Promise<void> {
    const write = this.writes.then(async () => {
      const next = writeMark(this.currentMark());
      if (next === this.saved) return;
      try {
        if (next === '') await this.storage.removeItem(CONNECT_CANARY_KEY);
        else await this.storage.setItem(CONNECT_CANARY_KEY, next);
        this.saved = next;
      } catch {
        this.warnStorage();
      }
    });
    this.writes = write;
    return write;
  }

  private warnStorage(): void {
    if (this.storageWarned) return;
    this.storageWarned = true;
    useConnectCanary.setState({ storageWarning: true });
  }
}

export const connectCanary = new ConnectCanary();

/** The notice's words for the held addresses. */
export function heldNotice(held: string[]): string {
  const SHOWN = 3;
  const named = held.slice(0, SHOWN).join(', ');
  const more = held.length > SHOWN ? ` and ${held.length - SHOWN} more` : '';
  return `AuthDeck closed while connecting to ${named}${more}. Connect again?`;
}
