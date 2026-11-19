/**
 * A trusted device answering a join request: Answer, compare the six-digit code with the new
 * device, then Approve or Deny before the request runs out. Shown over the deck.
 */
import { useState } from 'react';
import { View } from 'react-native';

import type { JoinRequestView } from '../../auth/contract';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { KeyWords } from '../../ui/KeyWords';
import { Text } from '../../ui/Text';
import { CheckCode, FlowSheet, type FlowView, formatClock, Notice, plainError, useSecondsLeft } from './parts';

export function ApproveDialog({ request, onClose }: { request: JoinRequestView; onClose(): void }) {
  const vault = useVault();
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState<'answer' | 'approve' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const secondsLeft = useSecondsLeft(request.expiresAt);
  const name = request.deviceName;

  const run = async (step: 'answer' | 'approve', action: () => Promise<void>, fallback: string) => {
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

  const answer = async () => {
    const ok = await run('answer', () => vault.acceptJoinRequest(request.id), `Couldn't answer ${name}. Check that the computer is online, then try again.`);
    if (ok) setAnswered(true);
  };

  const approve = async () => {
    const ok = await run('approve', () => vault.approveJoin(request.id), `Couldn't add ${name}. Try again before the request ends.`);
    if (!ok) return;
    haptics.success();
    onClose();
  };

  const deny = () => {
    vault.denyJoin(request.id);
    onClose();
  };

  // Once answered, this device is the approver and the others have dropped the request,
  // so closing without a decision turns it down rather than leaving it hanging.
  const close = answered ? deny : onClose;

  const ends = (
    <Text variant="caption" tone="faint" center>
      The request ends in {formatClock(secondsLeft)}
    </Text>
  );

  const view: FlowView =
    secondsLeft === 0
      ? {
          title: `${name}'s request ended`,
          onClose,
          footer: <GhostButton label="Close" onPress={onClose} />,
          body: <Text tone="dim">Nobody approved it within five minutes, so {name} wasn't added. It can ask again.</Text>,
        }
      : !answered
        ? {
            title: `${name} wants to join your vault`,
            onClose: close,
            footer: (
              <View style={{ gap: 12 }}>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <GhostButton grow label="Deny" onPress={deny} />
                  <PrimaryButton grow label="Answer" busy={busy === 'answer'} onPress={() => void answer()} />
                </View>
                {ends}
              </View>
            ),
            body: (
              <>
                <Text tone="dim">Answer to show a check code here and on {name}. You approve only after comparing them.</Text>
                <RequestKeyWords request={request} />
                {error ? <Notice tone="danger">{error}</Notice> : null}
              </>
            ),
          }
        : {
            title: `${name} wants to join your vault`,
            onClose: close,
            footer: (
              <View style={{ gap: 12 }}>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <GhostButton grow label="Deny" onPress={deny} />
                  <PrimaryButton grow label="Approve" busy={busy === 'approve'} disabled={!request.code} onPress={() => void approve()} />
                </View>
                {ends}
              </View>
            ),
            body: (
              <>
                <Text tone="dim">{request.code ? `Check that ${name} shows this same code before you approve.` : `Waiting for ${name} to show its code…`}</Text>
                <RequestKeyWords request={request} />
                {request.code ? <CheckCode code={request.code} /> : null}
                <Notice tone="warn">Approve only devices you own. An approved device can see and use every code in the vault.</Notice>
                {error ? <Notice tone="danger">{error}</Notice> : null}
              </>
            ),
          };

  return <FlowSheet view={view} maxWidth={520} />;
}

/** The new device's key words, quietly, to compare with what it shows. */
function RequestKeyWords({ request }: { request: JoinRequestView }) {
  if (!request.keyWords) return null;
  return <KeyWords keyWords={request.keyWords} label={`${request.deviceName}'s key words`} />;
}
