/**
 * The recovery phrase: shown once, then three of its words typed back. Used by the first-run
 * intro (after the vault is made) and from the vault screen's "Make a new phrase".
 * The phrase lives only in component state and is dropped when the surface closes.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';

import type { SurfaceProps } from '../../auth/contract';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { GhostButton, LinkButton, PrimaryButton } from '../../ui/controls';
import { Text } from '../../ui/Text';
import { useScreen } from '../../ui/theme';
import { ConfirmSheet, type ConfirmRequest } from '../settings/ConfirmSheet';
import { PHRASE_NOT_ON_COMPUTER } from '../settings/AuthenticatorSection';
import { CAN_BLOCK_SCREEN_CAPTURE } from '../../ui/SecureSheet';
import { FlowSheet, type FlowView, Notice, PhraseWords, plainError, Suggestions, WordField } from './parts';
import { usePhraseEntry } from './phraseEntry';
import { vaultFeatures } from '../../vault/features';
import { deviceUnlockWords } from '../../auth/engine/lockWords';
import { CHECK_COUNT, describePositions, normalizeWord, pickCheckPositions, suggestWords } from './phrase';

/** Where the phrase steps sit in the flow that shows them. */
export interface StepNumbers {
  show: number;
  check: number;
  total: number;
}

const REPLACE_STEPS: StepNumbers = { show: 1, check: 2, total: 2 };
/** Solo: the current phrase is step 1. */
const SOLO_STEPS: StepNumbers = { show: 2, check: 3, total: 3 };

/**
 * Opened from the vault screen: confirms, makes a new phrase, then shows and checks it. In a solo
 * vault (0.3.0) only the current phrase can make a new one, so its 12 words are typed first; the
 * change goes out once the new words are checked. Without them ("I don't have my phrase"), the
 * device's own prompt makes a new vault with every account instead, and the old one is deleted
 * once the new one is saved on the computer.
 */
export function RecoverySetup({ onClose }: SurfaceProps) {
  const vault = useVault();
  const [made, setMade] = useState<{ phrase: string[]; flow: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const solo = !vaultFeatures.multiDevice;
  // A vault whose phrase was never shown and checked (setup interrupted) can only get one this way.
  const neverSet = solo && vault.recovery.neverSet === true;
  const [lost, setLost] = useState(neverSet);
  const hadPhrase = solo || vault.recovery.savedAt !== null;
  const steps = usePhraseSteps({ made, steps: solo ? SOLO_STEPS : REPLACE_STEPS, onClose, onDone: onClose });
  const current = usePhraseEntry({ editable: !busy });

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = lost ? await vault.replaceVaultWithoutPhrase() : await vault.newRecoveryPhrase(solo ? current.words : undefined);
      current.clear();
      setMade(next);
    } catch (e) {
      haptics.error();
      setError(plainError(e, "Couldn't make a new phrase. Check that the computer is online, then try again."));
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (toLost: boolean) => {
    setError(null);
    setLost(toLost);
  };

  const lostView: FlowView = {
    title: neverSet ? 'Set up your recovery phrase' : 'Make a new vault',
    subtitle: `Step 1 of ${SOLO_STEPS.total}`,
    onClose,
    footer: (
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <GhostButton grow label={neverSet ? 'Cancel' : 'Back'} onPress={() => (neverSet ? onClose() : switchTo(false))} />
        <PrimaryButton grow label={neverSet ? 'Continue' : 'Make new vault'} busy={busy} onPress={() => void make()} />
      </View>
    ),
    body: (
      <>
        {neverSet ? (
          <Text tone="dim">
            Setting up this vault stopped before its recovery phrase was shown and checked, so nothing can bring it back if this phone is lost. AuthDeck
            now makes the vault again with every account on this device, and gives you a new phrase to write down and check. The unfinished vault on the
            computer is set aside and deleted after 30 days.
          </Text>
        ) : (
          <Text tone="dim">
            Without the current words, AuthDeck makes a new vault with every account on this device, and a new phrase for it. Once you have checked the new
            words and the new vault is saved on the computer, this device forgets the old vault. The computer sets the old vault aside and keeps it for 30
            days, then deletes it. Until then, the old phrase can still restore the old vault.
          </Text>
        )}
        <Text tone="dim">
          {`Your device asks for ${deviceUnlockWords(Platform.OS)} first. Someone who gets past your phone's lock can already see every code, so this adds no new risk.`}
        </Text>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </>
    ),
  };

  const confirmView: FlowView = solo && lost ? lostView : solo
    ? {
        title: 'Make a new recovery phrase',
        subtitle: `Step 1 of ${SOLO_STEPS.total}`,
        onClose,
        footer: (
          <View style={{ gap: 14 }}>
            {current.suggestions}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <GhostButton grow label="Cancel" onPress={onClose} />
              <PrimaryButton grow label="Make new phrase" busy={busy} disabled={!current.ready} onPress={() => void make()} />
            </View>
          </View>
        ),
        body: (
          <>
            <Text tone="dim">
              Type your current 12 words first: only the current phrase can make a new one. The old words stop working once you have checked the new ones.
            </Text>
            {current.fields}
            <LinkButton label="I don't have my phrase" onPress={() => switchTo(true)} />
            {error ? <Notice tone="danger">{error}</Notice> : null}
          </>
        ),
      }
    : {
        title: hadPhrase ? 'Make a new recovery phrase?' : 'Make a recovery phrase',
        onClose,
        footer: (
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <GhostButton grow label="Cancel" onPress={onClose} />
            <PrimaryButton grow label="Make new phrase" busy={busy} onPress={() => void make()} />
          </View>
        ),
        body: (
          <>
            <Text tone="dim">
              {hadPhrase
                ? 'Your current 12 words stop working as soon as the new ones are made. Throw the old paper away once you have written down the new phrase.'
                : 'If every device is lost, 12 words and a copy of the vault folder bring your codes back. Have paper and a pen ready.'}
            </Text>
            {error ? <Notice tone="danger">{error}</Notice> : null}
          </>
        ),
      };

  return (
    <>
      <FlowSheet view={steps.view ?? confirmView} secure />
      {steps.overlay}
    </>
  );
}

/**
 * Shows the phrase, then asks for three of its words. Closing before the check asks first,
 * because the words can't be shown again. Returns null while there is no phrase yet.
 */
export function usePhraseSteps({ made, steps, onClose, onDone }: { made: { phrase: string[]; flow: string } | null; steps: StepNumbers; onClose: () => void; onDone: () => void }): {
  view: FlowView | null;
  overlay: ReactNode;
} {
  const vault = useVault();
  const { compact } = useScreen();
  const phrase = made?.phrase ?? null;
  const flow = made?.flow ?? null;
  // Closing the surface ends its flow: an unchecked phrase change or new vault is dropped.
  // Keyed on the flow alone: `vault` is a new object on each render.
  const endFlow = useRef(vault.endRecoveryFlow);
  endFlow.current = vault.endRecoveryFlow;
  useEffect(() => (flow ? () => endFlow.current(flow) : undefined), [flow]);
  const [stage, setStage] = useState<'show' | 'check' | 'saved' | 'pending'>('show');
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // Chosen once, so looking at the phrase again doesn't change which words are asked for.
  const [positions] = useState(() => pickCheckPositions());
  const [answers, setAnswers] = useState<string[]>(() => positions.map(() => ''));
  const [focused, setFocused] = useState<number | null>(null);
  const [wrong, setWrong] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overlay = <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />;
  if (!phrase) return { view: null, overlay };

  const askClose = () =>
    setConfirm({
      title: 'Stop without saving the phrase?',
      message: "These 12 words can't be shown again. You can make a new phrase later from the vault screen.",
      confirmLabel: 'Stop',
      danger: true,
      onConfirm: onClose,
    });

  const setAnswer = (i: number, text: string) => {
    setAnswers((a) => a.map((v, j) => (j === i ? text : v)));
    setWrong((w) => w.filter((p) => p !== positions[i]));
  };

  const check = async () => {
    const mismatched = positions.filter((p, i) => normalizeWord(answers[i]!) !== phrase[p]);
    setWrong(mismatched);
    if (mismatched.length > 0) {
      haptics.error();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { saved } = await vault.confirmRecoverySaved(flow!);
      haptics.success();
      setStage(saved ? 'saved' : 'pending');
    } catch (e) {
      haptics.error();
      setError(plainError(e, "The words were right, but saving that didn't work. Try again."));
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'show') {
    return {
      overlay,
      view: {
        title: 'Your recovery phrase',
        subtitle: `Step ${steps.show} of ${steps.total}`,
        onClose: askClose,
        footer: (
          <View style={{ gap: 12 }}>
            <PrimaryButton label="I've written them down" onPress={() => setStage('check')} />
            <Text variant="caption" tone="faint" center>
              Next, you'll type three of the words to check.
            </Text>
          </View>
        ),
        body: (
          <>
            <Text tone="dim">
              If every device is lost, these 12 words and a copy of the vault folder bring your codes back. Write them on paper and keep it somewhere safe.
            </Text>
            <PhraseWords words={phrase} />
            <Text variant="label" tone="dim">
              {`AuthDeck can't show these again or reset them.${CAN_BLOCK_SCREEN_CAPTURE ? ' Screenshots are blocked on this screen.' : ''}`}
            </Text>
          </>
        ),
      },
    };
  }

  if (stage === 'pending') {
    return {
      overlay,
      view: {
        title: 'Phrase checked',
        onClose: onDone,
        footer: <PrimaryButton label="Done" onPress={onDone} />,
        body: <Notice tone="warn">{PHRASE_NOT_ON_COMPUTER}</Notice>,
      },
    };
  }

  if (stage === 'saved') {
    return {
      overlay,
      view: {
        title: 'Recovery phrase saved',
        onClose: onDone,
        footer: <PrimaryButton label="Done" onPress={onDone} />,
        body: (
          <Notice tone="ok">Keep the paper somewhere safe, away from your devices. Anyone with these words and the vault folder can read your codes.</Notice>
        ),
      },
    };
  }

  const complete = answers.every((a) => normalizeWord(a) !== '');
  const suggestions = focused === null ? [] : suggestWords(answers[focused]!);
  return {
    overlay,
    view: {
      title: 'Check your phrase',
      subtitle: `Step ${steps.check} of ${steps.total}`,
      onClose: askClose,
      footer: (
        <View style={{ gap: 14 }}>
          <Suggestions words={suggestions} onPick={(w) => focused !== null && setAnswer(focused, w)} />
          <PrimaryButton label="Check words" disabled={!complete} busy={busy} onPress={() => void check()} />
        </View>
      ),
      body: (
        <>
          <Text tone="dim">Type these {CHECK_COUNT} words from your paper.</Text>
          <View style={{ gap: compact ? 12 : 14 }}>
            {positions.map((p, i) => (
              <WordField
                key={p}
                number={p + 1}
                flagged={wrong.includes(p)}
                placeholder={`Word ${p + 1}`}
                value={answers[i]}
                onChangeText={(t) => setAnswer(i, t)}
                onFocus={() => setFocused(i)}
                returnKeyType={i < positions.length - 1 ? 'next' : 'done'}
              />
            ))}
          </View>
          {wrong.length > 0 ? (
            <Notice tone="danger">
              <Text variant="label">
                {describePositions(wrong, true)} {wrong.length === 1 ? "isn't" : "aren't"} right. Check your paper, or look at the phrase again.
              </Text>
              <LinkButton label="Show the phrase again" onPress={() => setStage('show')} />
            </Notice>
          ) : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </>
      ),
    },
  };
}
