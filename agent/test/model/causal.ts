/**
 * Causality computed by the model from the signed lines alone (prev and seen, transitively),
 * independent of how replay.ts computes it.
 */
import { labelOfId, type Line, type World } from './world';

export class Causality {
  private readonly pasts = new Map<string, Readonly<Record<string, number>>>();

  constructor(private readonly world: World) {}

  /** For each label, the highest seq of its lines that `line` follows (its own earlier ones included). */
  past(line: Line): Readonly<Record<string, number>> {
    const cached = this.pasts.get(line.hash);
    if (cached) return cached;
    const out: Record<string, number> = {};
    const merge = (from: Readonly<Record<string, number>>) => {
      for (const [label, seq] of Object.entries(from)) out[label] = Math.max(out[label] ?? -1, seq);
    };
    if (line.seq > 0) {
      const prev = this.world.lines[line.label]![line.seq - 1]!;
      merge(this.past(prev));
      out[line.label] = Math.max(out[line.label] ?? -1, line.seq - 1);
    }
    for (const [deviceId, ref] of Object.entries(line.entry.seen)) {
      const label = labelOfId(this.world, deviceId);
      // A named hash the folder doesn't have at that seq (a fork, or slander) counts as having
      // seen the log up to the line before, which both versions share (docs, rule 2).
      const exact = this.world.lines[label]?.[ref.seq];
      const seq = exact && exact.hash !== ref.hash ? ref.seq - 1 : ref.seq;
      out[label] = Math.max(out[label] ?? -1, seq);
      const named = this.world.lines[label]?.[seq];
      if (named) merge(this.past(named));
    }
    this.pasts.set(line.hash, out);
    return out;
  }

  /** True when `a` had `b` in its causal past. */
  sees(a: Line, b: Line): boolean {
    if (a === b) return false;
    return (this.past(a)[b.label] ?? -1) >= b.seq;
  }

  /** Neither had seen the other. */
  concurrent(a: Line, b: Line): boolean {
    return a !== b && !this.sees(a, b) && !this.sees(b, a);
  }
}
