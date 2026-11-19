/**
 * Recovery-phrase helpers for the screens: autocomplete, paste splitting and the three-word
 * check. Only the public BIP-39 word list is used here; nothing touches a secret.
 */
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { unknownPhraseWords } from '../../vault/recovery';

export const PHRASE_LENGTH = 12;
/** How many words the user types back to prove they wrote the phrase down. */
export const CHECK_COUNT = 3;
const MAX_SUGGESTIONS = 4;

/** Lower case, trimmed: how phrase words are compared. */
export function normalizeWord(text: string): string {
  return text.trim().toLowerCase();
}

/** Words from the list that start with what was typed; empty once the word is complete. */
export function suggestWords(typed: string): string[] {
  const prefix = normalizeWord(typed);
  if (!prefix) return [];
  const matches = wordlist.filter((w) => w.startsWith(prefix)).slice(0, MAX_SUGGESTIONS);
  return matches.length === 1 && matches[0] === prefix ? [] : matches;
}

export function isKnownWord(word: string): boolean {
  const w = normalizeWord(word);
  return w !== '' && unknownPhraseWords(w).length === 0;
}

/** Splits pasted text into words: any spaces, new lines, commas or numbering between them. */
export function splitPhrase(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** Three distinct word positions (0-based), in order, for the check step. */
export function pickCheckPositions(random: () => number = Math.random): number[] {
  const positions = new Set<number>();
  while (positions.size < CHECK_COUNT) positions.add(Math.floor(random() * PHRASE_LENGTH));
  return [...positions].sort((a, b) => a - b);
}

/** "word 3", "words 3 and 8", "words 2, 5 and 9" (from 0-based positions); `start` capitalises it. */
export function describePositions(positions: number[], start = false): string {
  const numbers = positions.map((p) => String(p + 1));
  const text = numbers.length === 1 ? `word ${numbers[0]}` : `words ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
  return start ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
