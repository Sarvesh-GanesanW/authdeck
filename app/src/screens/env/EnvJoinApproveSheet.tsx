/**
 * The owner approving someone into a set. A teammate's request came in a commit: check their
 * name and pick their six key words as they read them out, then Approve or Decline (which
 * deletes the request file). One of the person's own devices asks live: Answer, compare the 6-digit code on both screens, then Approve,
 * before the request runs out. Approving signs a new member list, so the vault must be open.
 */
import { Platform, View } from 'react-native';
import { useEffect, useState } from 'react';

import type { EnvJoinRequestView } from '../../auth/envContract';
import { deviceUnlockWords } from '../../auth/engine/lockWords';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { Sheet, SHORT_WINDOW } from '../../ui/Sheet';
import { useScreen } from '../../ui/theme';
import { Text } from '../../ui/Text';
import { CheckCode, Notice, plainError, useSecondsLeft } from '../authflows/parts';
import { showDone } from '../vault/feedback';
import { ButtonRow, EnvRow, SixWords } from './parts';
import { useEnv } from './source';
import { usePersonNameStep, useSixWordCheck } from './steps';
import { joinSheet, minutesSeconds, personName, WORDS_DECLINED } from './view';

/** The owner's own six words, read out so the teammate checks this side too. */
const READ_OUT = 'Read these to them';

type Busy = 'answer' | 'approve' | 'decline' | 'unlock' | null;

export function EnvJoinApproveSheet({ request, onClose }: { request: EnvJoinRequestView; onClose(): void }) {
  const env = useEnv();
  const vault = useVault();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const secondsLeft = useSecondsLeft(request.expiresAt);
  const set = env.sets.find((s) => s.id === request.setId) ?? null;
  const model = joinSheet(request, set?.computerName ?? null, set?.file ?? null);
  const ownDevice = request.via === 'own-device';
  const answered = ownDevice && request.code !== null;
  const ended = ownDevice && request.expiresAt !== null && secondsLeft === 0;
  const locked = request.needsUnlock;
  const name = usePersonNameStep(env, busy === null);
  const check = useSixWordCheck(ownDevice ? null : request.keyWords, request.label, request.id);

  const run = async (step: Exclude<Busy, null>, action: () => Promise<void>, fallback: string): Promise<boolean> => {
    setBusy(step);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      haptics.error();
      setError(plainError(e, fallback));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const who = ownDevice ? request.label : personName(request.label);
  const approve = async () => {
    const ok = await run(
      'approve',
      async () => {
        await name.save();
        await env.approveJoin(request.id);
      },
      `Couldn't add ${who}. Try again${ownDevice ? ' before the request ends' : ''}.`,
    );
    if (!ok) return;
    haptics.success();
    showDone(`Added ${who} to ${request.setName}`);
    onClose();
  };
  const decline = async () => {
    const ok = await run('decline', () => env.declineJoin(request.id), `Couldn't decline ${who}'s request. Try again.`);
    if (ok) onClose();
  };
  // A second wrong word ends the check for good: the request is declined, and the sheet says so.
  const [declined, setDeclined] = useState(false);
  const declineMismatch = async () => {
    const ok = await run('decline', () => env.declineJoin(request.id), `Couldn't decline ${who}'s request. Decline it before anything else.`);
    if (ok) setDeclined(true);
  };
  useEffect(() => {
    if (check.ended && !declined) void declineMismatch();
  }, [check.ended]);
  const answer = () =>
    void run(
      'answer',
      async () => {
        await name.save();
        await env.acceptOwnDeviceJoin(request.id);
      },
      `Couldn't answer ${who}. Check that the computer is online, then try again.`,
    );
  const unlock = () => void run('unlock', () => vault.unlock(), "The vault didn't open. Try again.");

  // Once this device answered an own device, the others have dropped the request: closing declines it.
  const close = answered && !ended ? () => void decline() : onClose;

  const body = declined ? (
    <Notice tone="danger">{WORDS_DECLINED}</Notice>
  ) : ended ? (
    <Text tone="dim">{`Nobody approved it within five minutes, so ${who} wasn't added. It can ask again.`}</Text>
  ) : (
    <>
      <EnvRow
        icon={request.form === 'tablet' ? 'tablet' : 'phone'}
        title={request.label}
        lines={[{ text: ownDevice ? 'Your other device · would join as a member' : 'Would join as a member' }]}
      />
      {locked ? (
        <Notice tone="info" icon="lock">{`The vault is locked. Unlock with ${deviceUnlockWords(Platform.OS)} to approve; Decline works without it.`}</Notice>
      ) : (
        <>
          <Text>{model.compare}</Text>
          {check.view}
          {request.ownerKeyWords ? <SixWords words={request.ownerKeyWords} label={READ_OUT} /> : null}
          {name.field}
        </>
      )}
      {answered && request.code ? <CheckCode code={request.code} large /> : null}
      <Text variant="caption" tone="dim">
        {model.effect}
      </Text>
      {ownDevice ? null : (
        <Text variant="caption" tone="dim">
          Decline deletes the request file.
        </Text>
      )}
      {ownDevice && request.expiresAt !== null ? (
        <Text variant="caption" tone="faint" center>
          {`The request ends in ${minutesSeconds(secondsLeft)}`}
        </Text>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </>
  );

  const main = locked ? (
    <PrimaryButton icon="unlock" label="Unlock" busy={busy === 'unlock'} disabled={busy !== null} onPress={unlock} />
  ) : ownDevice && !answered ? (
    <PrimaryButton label={model.approveLabel} busy={busy === 'answer'} disabled={busy !== null || !name.ready} onPress={answer} />
  ) : (
    <PrimaryButton icon="check" label={model.approveLabel} busy={busy === 'approve'} disabled={busy !== null || !check.matched || !name.ready} onPress={() => void approve()} />
  );
  const screen = useScreen();
  const footer = ended || declined ? (
    <GhostButton label="Close" onPress={onClose} />
  ) : (
    <ButtonRow>
      <GhostButton danger label={busy === 'decline' ? 'Declining…' : model.declineLabel} disabled={busy !== null} onPress={() => void decline()} />
      {main}
    </ButtonRow>
  );

  // In a short window a fixed footer leaves no room for the words, so the buttons scroll after them.
  const inline = screen.height < SHORT_WINDOW;
  return (
    <Sheet visible onClose={close} title={ended ? `${who}'s request ended` : model.title} subtitle={model.subtitle} maxWidth={560} footer={inline ? undefined : footer}>
      {body}
      {inline ? footer : null}
    </Sheet>
  );
}
