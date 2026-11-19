/** A set sheet's revealed value: one at a time, hidden after ENV_REVEAL_MS, ticking its countdown. */
import { useEffect, useRef, useState } from 'react';

import { type RevealedValue, RevealTimer } from './reveal';

export interface Reveal {
  shown: RevealedValue | null;
  /** Whole seconds until it hides. */
  secondsLeft: number | null;
  /** The name being read, before its value arrives. */
  loading: string | null;
  toggle(name: string, load: () => Promise<string>): Promise<void>;
}

export function useReveal(): Reveal {
  const [shown, setShown] = useState<RevealedValue | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const timer = useRef<RevealTimer | null>(null);
  timer.current ??= new RevealTimer(setShown);

  useEffect(() => () => timer.current?.dispose(), []);

  // Redraw each second while a value shows, for "Hides in 0:24".
  useEffect(() => {
    if (!shown) return;
    const tick = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(tick);
  }, [shown]);

  const toggle = async (name: string, load: () => Promise<string>) => {
    const reveal = timer.current!;
    if (reveal.shown?.name === name) {
      reveal.hide();
      return;
    }
    setLoading(name);
    try {
      await reveal.reveal(name, load);
    } finally {
      setLoading((current) => (current === name ? null : current));
    }
  };

  return { shown, secondsLeft: timer.current.secondsLeft(), loading, toggle };
}
