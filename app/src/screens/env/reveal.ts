/**
 * One revealed value at a time, hidden again after ENV_REVEAL_MS. Kept apart from React with an
 * injected clock, so the timing is tested on its own; useReveal (./useReveal) drives it on screen.
 */
import { ENV_REVEAL_MS } from '../../auth/envContract';

export interface RevealClock {
  now(): number;
  later(run: () => void, ms: number): () => void;
}

export const systemClock: RevealClock = {
  now: () => Date.now(),
  later(run, ms) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

export interface RevealedValue {
  name: string;
  value: string;
  hidesAt: number;
}

export class RevealTimer {
  private current: RevealedValue | null = null;
  private cancelHide: (() => void) | null = null;
  /** Bumped by every reveal and hide, so a value that arrives after it was superseded is dropped. */
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly onChange: (shown: RevealedValue | null) => void,
    private readonly clock: RevealClock = systemClock,
    private readonly revealMs: number = ENV_REVEAL_MS,
  ) {}

  get shown(): RevealedValue | null {
    return this.current;
  }

  /** Whole seconds until the value hides; null when nothing is shown. */
  secondsLeft(): number | null {
    if (!this.current) return null;
    return Math.max(0, Math.ceil((this.current.hidesAt - this.clock.now()) / 1000));
  }

  /**
   * Reads one value and shows it in place of any other. Rejects with load's error; a value that
   * arrives after another reveal, a hide or dispose is dropped, never shown.
   */
  async reveal(name: string, load: () => Promise<string>): Promise<void> {
    const ticket = ++this.generation;
    this.clear();
    const value = await load();
    if (ticket !== this.generation || this.disposed) return;
    this.current = { name, value, hidesAt: this.clock.now() + this.revealMs };
    this.cancelHide = this.clock.later(() => {
      if (ticket === this.generation) this.hide();
    }, this.revealMs);
    this.onChange(this.current);
  }

  hide(): void {
    this.generation++;
    this.clear();
  }

  /** On unmount: hides and ignores anything still loading. */
  dispose(): void {
    this.disposed = true;
    this.hide();
  }

  private clear(): void {
    this.cancelHide?.();
    this.cancelHide = null;
    if (!this.current) return;
    this.current = null;
    if (!this.disposed) this.onChange(null);
  }
}
