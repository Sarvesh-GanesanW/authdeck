/**
 * The wrong words the six-word check offers, dealt once per request. Kept apart from the hook so
 * it can be tested without a renderer.
 */
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { wordChoices } from './view';

/** A whole number below n from the secure random source (Math.random only where there is none). */
function securePick(n: number): number {
  const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (!crypto?.getRandomValues) return Math.floor(Math.random() * n);
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const one = new Uint32Array(1);
  do crypto.getRandomValues(one);
  while (one[0]! >= limit);
  return one[0]! % n;
}

/**
 * One deal per request for its whole life: the wrong words for each of the six steps, and the
 * wrong picks so far. A new deal per attempt or per opening would give the real words away (the
 * one that repeats), so it survives closing and reopening; an app restart clears it.
 */
export interface Deal {
  steps: string[][];
  misses: number;
  /** Set the moment a wrong word is picked, before the screen redraws: no pick counts until Try again. */
  stopped: boolean;
}

const deals = new Map<string, Deal>();

/** Two wrong picks end the check: the first offers Try again with the same deal. */
export const WORD_TRIES = 2;

/** The deal for a request and these exact words: words that change get a new deal (and a fresh start). */
export function dealFor(key: string, words: string[]): { id: string; deal: Deal } {
  const id = `${key}\n${words.join(' ')}`;
  let deal = deals.get(id);
  if (!deal) {
    deal = { steps: words.map((_, index) => wordChoices(words, index, wordlist, securePick)), misses: 0, stopped: false };
    deals.set(id, deal);
  }
  return { id, deal };
}
