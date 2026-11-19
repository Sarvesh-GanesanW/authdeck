/**
 * Typing the 12 words of a recovery phrase: autocomplete, paste all at once, and the words that
 * aren't on the list flagged. Shared by restoring, unlocking with the phrase and, in a solo vault,
 * proving the current phrase before a new one is made. The words live only in component state.
 */
import * as Clipboard from 'expo-clipboard';
import { type ReactNode, useRef, useState } from 'react';
import { type TextInputInstance, View } from 'react-native';

import { GhostButton } from '../../ui/controls';
import { useScreen } from '../../ui/theme';
import { Notice, Suggestions, WordField } from './parts';
import { describePositions, isKnownWord, normalizeWord, PHRASE_LENGTH, splitPhrase, suggestWords } from './phrase';

const EMPTY = Array.from({ length: PHRASE_LENGTH }, () => '');

export interface PhraseEntry {
  /** The words as typed, normalized. */
  words: string[];
  /** Every field holds a word from the list. */
  ready: boolean;
  /** The fields, paste and clear, and the note on unknown words. */
  fields: ReactNode;
  /** The suggestions for the field being typed in, for the footer. */
  suggestions: ReactNode;
  clear(): void;
  /** Set by the entry itself (empty clipboard); the screen shows its own errors too. */
  error: string | null;
}

export function usePhraseEntry({ editable }: { editable: boolean }): PhraseEntry {
  const [words, setWords] = useState<string[]>(EMPTY);
  const [focused, setFocused] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<(TextInputInstance | null)[]>([]);

  const focus = (i: number) => inputs.current[i]?.focus();

  /** Puts pasted or typed words in place from `start`; a full phrase always starts at word 1. */
  const fill = (start: number, incoming: string[]) => {
    const from = incoming.length === PHRASE_LENGTH ? 0 : start;
    setWords((w) => w.map((v, i) => (i >= from && i < from + incoming.length ? incoming[i - from]! : v)));
    setError(null);
    const next = Math.min(from + incoming.length, PHRASE_LENGTH - 1);
    if (incoming.length > 1 || next !== start) focus(next);
  };

  const onType = (i: number, text: string) => {
    const parts = splitPhrase(text);
    const endsWord = /[^a-zA-Z]$/.test(text);
    if (parts.length > 1 || (parts.length === 1 && endsWord)) {
      fill(i, parts);
      return;
    }
    setWords((w) => w.map((v, j) => (j === i ? text : v)));
    setError(null);
  };

  const pasteAll = async () => {
    const parts = splitPhrase(await Clipboard.getStringAsync());
    if (parts.length === 0) {
      setError('There are no words on the clipboard. Copy your 12 words, then paste again.');
      return;
    }
    fill(0, parts.slice(0, PHRASE_LENGTH));
  };

  const clear = () => {
    setWords(EMPTY);
    setError(null);
    focus(0);
  };

  const pick = (word: string) => {
    if (focused === null) return;
    setWords((w) => w.map((v, j) => (j === focused ? word : v)));
    if (focused < PHRASE_LENGTH - 1) focus(focused + 1);
  };

  // The word being typed is flagged only once no list word can start with it.
  const unknown = words.flatMap((w, i) => (isMistyped(w, i === focused) ? [i] : []));
  const filled = words.every((w) => normalizeWord(w) !== '');

  return {
    words: words.map(normalizeWord),
    ready: filled && words.every(isKnownWord),
    clear,
    error,
    suggestions: <Suggestions words={focused === null ? [] : suggestWords(words[focused]!)} onPick={pick} />,
    fields: (
      <>
        <WordGrid words={words} unknown={unknown} editable={editable} inputs={inputs} onType={onType} onFocus={setFocused} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <GhostButton small label="Paste all 12" icon="clipboard" onPress={() => void pasteAll()} />
          <GhostButton small label="Clear" icon="close" onPress={clear} />
        </View>
        {unknown.length > 0 ? (
          <Notice tone="danger">{`${describePositions(unknown, true)} ${unknown.length === 1 ? "isn't" : "aren't"} in the recovery word list. Check the spelling against your paper.`}</Notice>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </>
    ),
  };
}

/** The 12 fields in columns that read like the paper: 1–6 then 7–12 on phones, three columns on tablets. */
function WordGrid({
  words,
  unknown,
  editable,
  inputs,
  onType,
  onFocus,
}: {
  words: string[];
  unknown: number[];
  editable: boolean;
  inputs: React.RefObject<(TextInputInstance | null)[]>;
  onType: (i: number, text: string) => void;
  onFocus: (i: number) => void;
}) {
  const { compact } = useScreen();
  const columnCount = compact ? 2 : 3;
  const perColumn = PHRASE_LENGTH / columnCount;
  const columns = Array.from({ length: columnCount }, (_, c) => Array.from({ length: perColumn }, (_, r) => c * perColumn + r));
  return (
    <View style={{ flexDirection: 'row', gap: compact ? 10 : 14 }}>
      {columns.map((column, c) => (
        <View key={c} style={{ flex: 1, minWidth: 0, gap: compact ? 10 : 12 }}>
          {column.map((i) => (
            <WordField
              key={i}
              ref={(el) => {
                inputs.current[i] = el;
              }}
              number={i + 1}
              flagged={unknown.includes(i)}
              editable={editable}
              value={words[i]}
              onChangeText={(t) => onType(i, t)}
              onFocus={() => onFocus(i)}
              returnKeyType={i < PHRASE_LENGTH - 1 ? 'next' : 'done'}
              onSubmitEditing={() => inputs.current[i + 1]?.focus()}
              submitBehavior={i < PHRASE_LENGTH - 1 ? 'submit' : 'blurAndSubmit'}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function isMistyped(word: string, typing: boolean): boolean {
  const w = normalizeWord(word);
  if (w === '' || isKnownWord(w)) return false;
  return !typing || suggestWords(w).length === 0;
}
