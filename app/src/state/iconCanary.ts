/**
 * A crash canary for computer icons. Icons are decoded by native code, where a failure closes the
 * app instead of reaching the JS crash screen, and cached icons draw on launch before anything
 * connects: one bad icon would close AuthDeck on every start. So before an icon first draws in a
 * launch, a mark naming its computer is saved; once the icons that were drawing have drawn, the
 * mark is cleared. A launch that finds the mark still set knows AuthDeck closed while drawing that
 * computer's icons, and shows placeholders for them until the person clears them.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

export const ICON_CANARY_KEY = 'authdeck-icon-canary-v1';
/** The mark stays this long after the last icon reports drawn, for a crash on the frame after. */
export const SETTLE_MS = 750;
/** An icon that never reports (no load event) counts as drawn after this long. */
export const DRAW_TIMEOUT_MS = 10_000;

interface CanaryState {
  /** False until the mark the previous launch left has been read; nothing draws before. */
  checked: boolean;
  /** Computers whose icons were drawing when AuthDeck last closed: placeholders until cleared. */
  hidden: string[];
  /** Computers the saved mark names in this launch: their icons may draw. */
  armed: string[];
}

export const useIconCanary = create<CanaryState>(() => ({ checked: false, hidden: [], armed: [] }));

type MarkStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

/** The agent ids in a saved mark; anything unreadable names none. */
function readMark(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export class IconCanary {
  /** Icons drawing now, by the icon object the live store holds. */
  private readonly pending = new Map<object, ReturnType<typeof setTimeout>>();
  /** Icons that drew in this launch; they draw again without the mark. */
  private readonly drawn = new WeakSet<object>();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Mark writes, one at a time and in order. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: MarkStorage = AsyncStorage,
    private readonly settleMs = SETTLE_MS,
    private readonly drawTimeoutMs = DRAW_TIMEOUT_MS,
  ) {}

  /** Reads the previous launch's mark, once per launch. Returns the computers whose icons stay hidden. */
  async check(): Promise<string[]> {
    if (useIconCanary.getState().checked) return useIconCanary.getState().hidden;
    let hidden: string[];
    try {
      hidden = readMark(await this.storage.getItem(ICON_CANARY_KEY));
    } catch {
      hidden = [];
    }
    useIconCanary.setState({ checked: true, hidden });
    return hidden;
  }

  hasDrawn(icon: object): boolean {
    return this.drawn.has(icon);
  }

  /** `icon` of `agentId`'s is about to draw: the mark names the computer before it may. */
  begin(agentId: string, icon: object): void {
    if (this.drawn.has(icon) || this.pending.has(icon)) return;
    this.pending.set(
      icon,
      setTimeout(() => this.finish(icon), this.drawTimeoutMs),
    );
    this.cancelSettle();
    this.queue(async () => {
      const { armed, hidden } = useIconCanary.getState();
      if (armed.includes(agentId)) return;
      const next = [...armed, agentId];
      // A mark that could not be saved protects nothing, so the icon keeps its placeholder.
      await this.storage.setItem(ICON_CANARY_KEY, JSON.stringify([...hidden, ...next]));
      useIconCanary.setState({ armed: next });
    });
  }

  /** The icon drew (or failed to decode, which also did not crash). */
  finish(icon: object): void {
    const timer = this.pending.get(icon);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pending.delete(icon);
    this.drawn.add(icon);
    this.settleWhenIdle();
  }

  /** The icon left the screen before it drew. */
  abandon(icon: object): void {
    const timer = this.pending.get(icon);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pending.delete(icon);
    this.settleWhenIdle();
  }

  /** "Clear this computer's icons": its icons may draw again, under the mark like any other. */
  clear(agentId: string): Promise<void> {
    return this.queue(async () => {
      const { armed, hidden } = useIconCanary.getState();
      const stillHidden = hidden.filter((id) => id !== agentId);
      await this.saveMark([...stillHidden, ...armed]);
      useIconCanary.setState({ hidden: stillHidden });
    });
  }

  private settleWhenIdle(): void {
    if (this.pending.size > 0) return;
    this.cancelSettle();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.queue(async () => {
        if (this.pending.size > 0) return;
        // Disarmed before the mark is removed, not after: an icon that begins while the removal
        // is in flight must not draw on the old arming. Its own write, queued behind this one,
        // saves the mark again before it may draw.
        useIconCanary.setState({ armed: [] });
        await this.saveMark(useIconCanary.getState().hidden);
      });
    }, this.settleMs);
  }

  private cancelSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private saveMark(ids: string[]): Promise<void> {
    return ids.length === 0 ? this.storage.removeItem(ICON_CANARY_KEY) : this.storage.setItem(ICON_CANARY_KEY, JSON.stringify(ids));
  }

  private queue(write: () => Promise<void>): Promise<void> {
    // A failed write leaves the state as it was; the next write starts from there.
    this.writes = this.writes.then(write).catch(() => undefined);
    return this.writes;
  }
}

export const iconCanary = new IconCanary();
