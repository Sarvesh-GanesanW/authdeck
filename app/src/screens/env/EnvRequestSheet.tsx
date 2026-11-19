/**
 * A computer asking for a set: run and pull (Allow for 15 minutes, the default; Allow once;
 * Deny), push (a signed change: Sign change or Deny), create and join-keys (Approve or Deny).
 * AuthHost shows it over any screen the moment the request arrives. While the vault is locked it
 * shows only who asks, with Unlock and Deny; Deny needs no unlock. A file that failed this
 * device's check offers only Deny. Closing it without an answer denies.
 *
 * Push is a SecureSheet: "Show new values" draws the values the computer sent.
 */
import { Platform, View } from 'react-native';
import { useEffect, useState } from 'react';

import type { EnvChangeView, EnvRequestAnswer, EnvRequestView } from '../../auth/envContract';
import { ENV_REVEAL_MS } from '../../auth/envContract';
import { deviceUnlockWords } from '../../auth/engine/lockWords';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { SecureSheet } from '../../ui/SecureSheet';
import { Sheet, SHORT_WINDOW } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { Notice, plainError, useSecondsLeft } from '../authflows/parts';
import { showDone } from '../vault/feedback';
import { ButtonRow, ChangeList, FactTable } from './parts';
import { useEnv } from './source';
import { type PersonNameStep, usePersonNameStep } from './steps';
import {
  answeredWords,
  endedWords,
  lockedRequestText,
  PUSH_PENDING,
  PUSH_SIGNS_SHOWN,
  pushSource,
  type RequestButton,
  requestEnds,
  requestSheet,
  requestTitle,
} from './view';

/** The answers that label this person to others, so need their name. */
const NAMED_KINDS: ReadonlySet<EnvRequestView['kind']> = new Set(['create', 'join-keys']);

type Stage = { kind: 'ask' } | { kind: 'busy'; answer: EnvRequestAnswer | 'unlock' } | { kind: 'signed'; changes: EnvChangeView[] | null };

export function EnvRequestSheet({ request, onClose }: { request: EnvRequestView; onClose(): void }) {
  const env = useEnv();
  const vault = useVault();
  const [stage, setStage] = useState<Stage>({ kind: 'ask' });
  const [error, setError] = useState<string | null>(null);
  const secondsLeft = useSecondsLeft(request.expiresAt);
  const pending = env.incoming.some((r) => r.id === request.id);
  const asking = stage.kind === 'ask';
  // Gone: answered on another device, ran out, or the command stopped, while this sheet was asking.
  const gone = asking && (!pending || secondsLeft === 0);
  const SheetKind = request.kind === 'push' ? SecureSheet : Sheet;
  // Creating a set or joining one labels this person to others: their name is asked once, here.
  const name = usePersonNameStep(env, stage.kind === 'ask');
  const nameStep = NAMED_KINDS.has(request.kind) ? name : null;

  const answer = async (choice: EnvRequestAnswer) => {
    setStage({ kind: 'busy', answer: choice });
    setError(null);
    try {
      // With app lock on, the engine asks for the device's unlock inside answer(); cancelling it
      // rejects with a sentence, shown below while the sheet stays open.
      if (choice !== 'deny') await nameStep?.save();
      const result = await env.answer(request.id, choice);
      if (choice === 'deny') haptics.warning();
      else haptics.success();
      if (request.kind === 'push' && choice === 'approve') {
        setStage({ kind: 'signed', changes: result.changes });
        return;
      }
      showDone(answeredWords(request, choice));
      onClose();
    } catch (e) {
      haptics.error();
      setError(plainError(e, "The answer didn't reach the computer. Check that it's online, then try again."));
      setStage({ kind: 'ask' });
    }
  };

  const unlock = async () => {
    setStage({ kind: 'busy', answer: 'unlock' });
    setError(null);
    try {
      await vault.unlock();
    } catch (e) {
      setError(plainError(e, "The vault didn't open. Try again, or deny the request."));
    } finally {
      setStage({ kind: 'ask' });
    }
  };

  const ended = env.ended.find((e) => e.id === request.id) ?? null;
  const closeEnded = () => {
    if (ended) env.dismissEnded(ended.id);
    onClose();
  };

  // Closing without an answer turns the request down rather than leaving the computer waiting.
  const dismiss = () => {
    if (asking && !gone) void answer('deny');
    else if (gone) closeEnded();
    else onClose();
  };

  const busyWith = stage.kind === 'busy' ? stage.answer : null;
  const screen = useScreen();
  const view = gone
    ? goneView(request, endedWords(ended, request), closeEnded)
    : stage.kind === 'signed'
      ? signedView(request, stage.changes, onClose)
      : request.needsUnlock
        ? lockedView(request, secondsLeft, busyWith, () => void unlock(), () => void answer('deny'))
        : askView(request, secondsLeft, busyWith, (a) => void answer(a), nameStep);

  // In a short window a fixed footer leaves no room to read the request, so the buttons scroll after it.
  const inline = screen.height < SHORT_WINDOW;
  return (
    <SheetKind visible onClose={dismiss} title={view.title} subtitle={view.subtitle} maxWidth={560} footer={inline ? undefined : view.footer}>
      {view.body}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {inline ? view.footer : null}
    </SheetKind>
  );
}

interface SheetView {
  title: string;
  subtitle?: string;
  body: React.ReactNode;
  footer: React.ReactNode;
}

function askView(
  request: EnvRequestView,
  secondsLeft: number,
  busy: EnvRequestAnswer | 'unlock' | null,
  onAnswer: (answer: EnvRequestAnswer) => void,
  nameStep: PersonNameStep | null,
): SheetView {
  const model = requestSheet(request);
  const ends = requestEnds(secondsLeft);
  return {
    title: model.title,
    subtitle: model.from ? `${model.from}\n${ends}` : ends,
    body: (
      <>
        {model.facts.length > 0 ? <FactTable facts={model.facts} /> : null}
        {request.kind === 'push' ? <PushChanges request={request} changes={request.changes} /> : null}
        {model.warning ? (
          <Notice tone={model.warning.tone === 'danger' ? 'danger' : 'warn'}>
            <Text variant="label" weight="semibold">
              {model.warning.title}
            </Text>
            <Text variant="caption" tone="dim">
              {model.warning.text}
            </Text>
          </Notice>
        ) : null}
        {model.notes.map((note) => (
          <Text key={note} variant="caption" tone="dim">
            {note}
          </Text>
        ))}
        {nameStep?.field}
      </>
    ),
    footer: (
      <View style={{ gap: 12 }}>
        <AnswerButtons buttons={model.buttons} busy={busy} onAnswer={onAnswer} approveReady={nameStep?.ready ?? true} />
        {model.footnote ? (
          <Text variant="caption" tone="faint">
            {model.footnote}
          </Text>
        ) : null}
      </View>
    ),
  };
}

/**
 * run and pull: the main answer on its own row, Allow once and Deny under it. The others: Deny,
 * then the main answer, side by side. Deny alone when the file failed its check.
 */
function AnswerButtons({
  buttons,
  busy,
  onAnswer,
  approveReady,
}: {
  buttons: RequestButton[];
  busy: EnvRequestAnswer | 'unlock' | null;
  onAnswer: (a: EnvRequestAnswer) => void;
  /** Off until a missing name is typed: everything but Deny waits for it. */
  approveReady: boolean;
}) {
  const draw = (button: RequestButton) =>
    button.primary ? (
      <PrimaryButton
        key={button.answer}
        icon={button.answer === 'grant' ? 'clock' : 'check'}
        label={button.label}
        busy={busy === button.answer}
        disabled={busy !== null || (button.answer !== 'deny' && !approveReady)}
        onPress={() => onAnswer(button.answer)}
      />
    ) : (
      <GhostButton
        key={button.answer}
        danger={button.answer === 'deny'}
        label={busy === button.answer ? `${button.label}…` : button.label}
        disabled={busy !== null}
        onPress={() => onAnswer(button.answer)}
      />
    );
  const [first, ...rest] = buttons;
  if (first?.primary && rest.length > 0) {
    return (
      <View style={{ gap: 12 }}>
        {draw(first)}
        <ButtonRow>{rest.map(draw)}</ButtonRow>
      </View>
    );
  }
  return <ButtonRow>{buttons.map(draw)}</ButtonRow>;
}

function lockedView(request: EnvRequestView, secondsLeft: number, busy: EnvRequestAnswer | 'unlock' | null, onUnlock: () => void, onDeny: () => void): SheetView {
  const words = lockedRequestText(deviceUnlockWords(Platform.OS));
  return {
    title: requestTitle(request),
    subtitle: requestEnds(secondsLeft),
    body: <LockedNote title={words.title} text={words.text} />,
    footer: (
      <View style={{ gap: 12 }}>
        <ButtonRow>
          <GhostButton danger label={busy === 'deny' ? 'Deny…' : 'Deny'} disabled={busy !== null} onPress={onDeny} />
          <PrimaryButton icon="unlock" label="Unlock" busy={busy === 'unlock'} disabled={busy !== null} onPress={onUnlock} />
        </ButtonRow>
        <Text variant="caption" tone="faint">
          After you unlock, this sheet shows the request, with the same time left.
        </Text>
      </View>
    ),
  };
}

function LockedNote({ title, text }: { title: string; text: string }) {
  const cw = useColorway();
  return (
    <View style={{ gap: 10 }}>
      <Glyph name="lock" size={36} color={cw.focus} />
      <Text variant="subhead">{title}</Text>
      <Text tone="dim">{text}</Text>
    </View>
  );
}

function goneView(request: EnvRequestView, words: { title: string; text: string }, onClose: () => void): SheetView {
  return {
    title: words.title,
    subtitle: requestTitle(request),
    body: <Text tone="dim">{words.text}</Text>,
    footer: <GhostButton label="Close" onPress={onClose} />,
  };
}

function signedView(request: EnvRequestView, changes: EnvChangeView[] | null, onClose: () => void): SheetView {
  return {
    title: answeredWords(request, 'approve'),
    subtitle: `From ${request.command}`,
    body: (
      <>
        <PushChanges request={request} changes={changes} />
        <Text variant="caption" tone="dim">
          {`Teammates get it when ${request.computerName} commits and pushes ${request.file ?? "the set's file"}.`}
        </Text>
      </>
    ),
    footer: <PrimaryButton label="Done" onPress={onClose} />,
  };
}

/** A push's diff by name, once this device has worked it out, with its new values on request. */
function PushChanges({ request, changes }: { request: EnvRequestView; changes: EnvChangeView[] | null }) {
  const env = useEnv();
  const [showValues, setShowValues] = useState(false);

  // Shown values hide themselves, as revealed values do in a set.
  useEffect(() => {
    if (!showValues) return;
    const timer = setTimeout(() => setShowValues(false), ENV_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [showValues]);

  if (!changes) {
    return (
      <Text variant="caption" tone="dim">
        {PUSH_PENDING}
      </Text>
    );
  }
  if (changes.length === 0) return <Text tone="dim">Nothing changes: the computer's file already matches.</Text>;
  const values = showValues ? Object.fromEntries(changes.map((c) => [c.name, env.pushedValue(request.id, c.name)])) : undefined;
  const hasValues = changes.some((c) => c.change !== 'remove');
  return (
    <View style={{ gap: 12 }}>
      <ChangeList changes={changes} source={pushSource(request.command)} values={values} />
      {hasValues ? (
        <View style={{ alignItems: 'flex-start' }}>
          <GhostButton small icon={showValues ? 'eye-off' : 'eye'} label={showValues ? 'Hide new values' : 'Show new values'} onPress={() => setShowValues((v) => !v)} />
        </View>
      ) : null}
      <Text variant="caption" tone="dim">
        {PUSH_SIGNS_SHOWN}
      </Text>
    </View>
  );
}
