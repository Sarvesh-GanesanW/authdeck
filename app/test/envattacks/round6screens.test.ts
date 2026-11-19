// Security review of env sets (0.4), round 6, screens. A static proof of concept (this suite has no
// renderer) plus a check of what it leaks: it fails while the weakness is there and passes once fixed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { wordChoices } from '../../src/screens/env/view';

const STEPS = path.resolve(process.cwd(), 'src/screens/env/steps.tsx');
const WORDS = ['harbor', 'velvet', 'quarry', 'mosaic', 'lantern', 'ember'];

function secure(n: number): number {
  const one = new Uint32Array(1);
  globalThis.crypto.getRandomValues(one);
  return one[0]! % n;
}

describe('ENV-27: the six-word pick deals new wrong words on every Start over and every opening, so the real word is the one that repeats', () => {
  it('what two deals have in common gives every word away (how the leak works, with the dealing as steps.tsx does it)', () => {
    // A listener who hears nothing: open, see three words, Start over (or close and reopen), see three more.
    const guessed = WORDS.map((_, index) => {
      const first = wordChoices(WORDS, index, wordlist, secure);
      const second = wordChoices(WORDS, index, wordlist, secure);
      const common = first.filter((w) => second.includes(w));
      return common.length === 1 ? common[0] : null;
    });
    // Two fresh deals from 2048 words share only the real word (a decoy repeats about 1 time in 500).
    assert.ok(guessed.filter((w, i) => w === WORDS[i]).length >= 5);
  });

  it('steps.tsx keeps one deal per request for its life: not re-dealt per round, not drawn fresh at each mount', () => {
    const source = fs.readFileSync(STEPS, 'utf8');
    const hook = source.slice(source.indexOf('export function useSixWordCheck'));
    const perRound = /\[key, words\?\.join\(' '\), round\]/.test(hook) || /,\s*round\s*\]/.test(hook);
    const perMount = /useMemo\([\s\S]{0,200}wordChoices\([^)]*securePick\)/.test(hook);
    assert.deepEqual(
      { perRound, perMount },
      { perRound: false, perMount: false },
      'each Start over and each opening of the sheet deals new decoys while the real word stays: comparing two deals shows it without hearing anything',
    );
  });
});
