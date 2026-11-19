/**
 * Steps several env sheets share: asking for the person's name once (inside the first create,
 * join or approval, before the action), and the six-word check both sides of a teammate's join do.
 */
import { useState } from 'react';
import { View } from 'react-native';

import type { EnvApi } from '../../auth/envContract';
import { haptics } from '../../lib/haptics';
import { Field, GhostButton } from '../../ui/controls';
import { Text } from '../../ui/Text';
import { Notice } from '../authflows/parts';
import { Hint } from '../vault/parts';
import { LAST_TRY, PERSON_NAME_HINT, PERSON_NAME_MAX, personNameReady, WORD_COUNT, WORD_MISMATCH, wordStepQuestion } from './view';
import { dealFor, WORD_TRIES } from './wordDeal';

export interface PersonNameStep {
  /** The field, while the name is still missing; null once it is set. */
  field: React.ReactNode;
  /** The action may go ahead: the name is set, or a usable one is typed. */
  ready: boolean;
  /** Saves the typed name if it is missing; rejects with setPersonName's sentence. */
  save(): Promise<void>;
}

export function usePersonNameStep(env: Pick<EnvApi, 'personName' | 'setPersonName'>, editable = true): PersonNameStep {
  const [name, setName] = useState('');
  if (env.personName !== null) return { field: null, ready: true, save: async () => undefined };
  return {
    field: (
      <View style={{ gap: 8 }}>
        <Field
          label="Your name"
          value={name}
          onChangeText={setName}
          placeholder="Maya Rao"
          maxLength={PERSON_NAME_MAX}
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          editable={editable}
        />
        <Hint>{PERSON_NAME_HINT}</Hint>
      </View>
    ),
    ready: personNameReady(name),
    save: () => env.setPersonName(name.trim()),
  };
}

export interface WordCheck {
  view: React.ReactNode;
  /** All six words were picked right, in order. */
  matched: boolean;
  /** The last pick was wrong and a try is left: the check waits for Try again. */
  wrong: boolean;
  /** Every try was used up with a wrong pick: the request has to end (decline or cancel). */
  ended: boolean;
}

/**
 * The listener picks each of the speaker's six words in order, from three: the real one and two
 * other BIP-39 words. The words themselves are never drawn, so they have to be heard; one word
 * alone (11 bits) could be ground against public keys, all six can't. The wrong words are dealt
 * once per request (see Deal). A wrong pick stops the check: Try again starts over from word 1
 * with the same deal, and a second wrong pick ends it for good (`ended`); the caller then ends
 * the request.
 */
export function useSixWordCheck(words: string[] | null, label: string, key: string, options: { mismatchText?: string } = {}): WordCheck {
  const dealt = words ? dealFor(key, words) : null;
  const [dealId, setDealId] = useState(dealt?.id ?? '');
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState('');
  const [, setMisses] = useState(0);
  // The words changed under the check (a new owner key, say): start again from word 1.
  if (dealt && dealt.id !== dealId) {
    setDealId(dealt.id);
    setStep(0);
    setPicked('');
  }
  if (!words || !dealt) return { view: null, matched: true, wrong: false, ended: false };
  const { deal } = dealt;
  const ended = deal.misses >= WORD_TRIES;
  const done = step >= WORD_COUNT;
  // From the deal, so a check closed after a wrong pick opens again on Try again.
  const wrong = !ended && deal.stopped;
  const pick = (word: string) => {
    // A second tap in the same frame as a wrong one (before the buttons disable) counts for nothing.
    if (deal.stopped) return;
    if (word === words[step]) {
      haptics.tick();
      setStep(step + 1);
      setPicked('');
    } else {
      haptics.error();
      deal.stopped = true;
      deal.misses += 1;
      setMisses(deal.misses);
      setPicked(word);
    }
  };
  const tryAgain = () => {
    deal.stopped = false;
    setStep(0);
    setPicked('');
  };
  if (ended) return { view: null, matched: false, wrong: false, ended: true };
  const question = done ? '' : wordStepQuestion(step, label);
  return {
    view: done ? (
      <Notice tone="ok" icon="check">{`All ${WORD_COUNT} words match.`}</Notice>
    ) : (
      <View style={{ gap: 10 }}>
        <Text variant="label" weight="semibold">
          {question}
        </Text>
        <View accessibilityRole="radiogroup" accessibilityLabel={question} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {deal.steps[step]!.map((word) =>
            // A wrong pick reads as wrong (danger, with a cross), never as a selected answer.
            word === picked ? (
              <GhostButton key={word} small danger icon="close" label={word} onPress={() => undefined} />
            ) : (
              <GhostButton key={word} small label={word} disabled={wrong} onPress={() => pick(word)} />
            ),
          )}
        </View>
        {wrong ? <Notice tone="danger">{`${options.mismatchText ?? WORD_MISMATCH} ${LAST_TRY}`}</Notice> : null}
        {wrong ? (
          <View style={{ alignItems: 'flex-start' }}>
            <GhostButton icon="reload" label="Try again" onPress={tryAgain} />
          </View>
        ) : null}
      </View>
    ),
    matched: done,
    wrong,
    ended: false,
  };
}
