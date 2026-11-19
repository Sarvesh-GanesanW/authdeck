/**
 * The "Asking Pixel 8 to release them… waiting 0:12" line. On a terminal it counts up in place;
 * elsewhere (a pipe, a log) it is written once per change in the devices asked, without a clock.
 */
import type { EnvSocketProgress } from '../envSocketContract';
import { elapsed, listWords } from './words';

const TICK_MS = 1000;
const CLEAR_LINE = '\r\x1b[2K';

/** What the line says, given who is being asked. */
export type WaitingWords = (devices: string) => string;

export interface WaitingWording {
  words: WaitingWords;
  /** Who is waited on while no device has connected yet. */
  nobody: string;
  /** Before the clock: "waiting 0:12" or just "0:06", as the design's transcripts have it. */
  clockLabel: string;
}

export const WAITING: Record<'release' | 'push' | 'create' | 'join', WaitingWording> = {
  release: { words: (who) => `Asking ${who} to release them…`, nobody: 'a member device', clockLabel: 'waiting ' },
  push: { words: (who) => `Asking ${who} to sign the change…`, nobody: 'a member device', clockLabel: 'waiting ' },
  create: { words: (who) => `Waiting for ${who} to create the set…`, nobody: 'your phone or tablet', clockLabel: '' },
  join: { words: (who) => `Waiting for ${who} to make its keys…`, nobody: 'your phone or tablet', clockLabel: '' },
};

export interface WaitingStream {
  write(text: string): unknown;
  isTTY?: boolean;
}

export class WaitingLine {
  private text: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly stream: WaitingStream,
    private readonly wording: WaitingWording,
    private readonly startedAt: number,
    private readonly now: () => number,
  ) {}

  /** Called for each progress line; the first one also starts the clock. */
  update(progress: EnvSocketProgress): void {
    const who = progress.devices.length > 0 ? listWords(progress.devices) : this.wording.nobody;
    const text = this.wording.words(who);
    if (text === this.text) return;
    const first = this.text === null;
    this.text = text;
    if (!this.stream.isTTY) {
      this.stream.write(`${text}\n`);
      return;
    }
    if (!first) this.stream.write('\n');
    this.draw();
    this.timer ??= setInterval(() => this.draw(), TICK_MS);
  }

  /** Leaves the last line as it stands (with its clock on a terminal) and ends it. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.text !== null && this.stream.isTTY) {
      this.draw();
      this.stream.write('\n');
    }
    this.text = null;
  }

  private draw(): void {
    this.stream.write(`${CLEAR_LINE}${this.text} ${this.wording.clockLabel}${elapsed(this.now() - this.startedAt)}`);
  }
}
