/**
 * A teammate checking the owner's six words for one of this phone's join requests: the owner
 * reads them out and the teammate picks each one. The sixth right pick confirms the words; "They
 * don't match", or a second wrong pick, cancels the request, so the set is never taken from it.
 */
import { useEffect, useState } from 'react';

import type { EnvOwnRequestView } from '../../auth/envContract';
import { haptics } from '../../lib/haptics';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { Sheet, SHORT_WINDOW } from '../../ui/Sheet';
import { useScreen } from '../../ui/theme';
import { Text } from '../../ui/Text';
import { Notice, plainError } from '../authflows/parts';
import { envSheets, useEnvSheets } from './sheetState';
import { useEnv } from './source';
import { useSixWordCheck } from './steps';
import { ownerWords } from './view';

export function OwnerWordsSheet() {
  const env = useEnv();
  const setId = useEnvSheets((s) => s.ownerWordsSetId);
  const request = env.ownRequests.find((r) => r.setId === setId) ?? null;
  // Keep drawing the last request while the sheet slides away (or after it was cancelled).
  const [shown, setShown] = useState<EnvOwnRequestView | null>(request);
  if (request && request !== shown) setShown(request);
  // Each opening starts a fresh check, even for the same request.
  const [lastSetId, setLastSetId] = useState(setId);
  const [openings, setOpenings] = useState(0);
  if (setId !== lastSetId) {
    setLastSetId(setId);
    if (setId) setOpenings((n) => n + 1);
  }
  if (!shown) return null;
  return <CheckSheet key={`${shown.setId}:${openings}`} visible={setId === shown.setId} request={shown} onClose={() => envSheets.checkOwnerWords(null)} />;
}

type Step = { kind: 'checking' } | { kind: 'cancelled' };

function CheckSheet({ visible, request, onClose }: { visible: boolean; request: EnvOwnRequestView; onClose(): void }) {
  const env = useEnv();
  const screen = useScreen();
  const [step, setStep] = useState<Step>({ kind: 'checking' });
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const words = ownerWords(request.ownerLabel);
  const shown = request.ownerKeyWords;
  const check = useSixWordCheck(shown, request.ownerLabel, request.setId, { mismatchText: words.wrongWord });

  const confirm = async () => {
    setBusy('confirm');
    setError(null);
    try {
      // The words the check asked about go back: if the owner's changed meanwhile, this is refused.
      await env.confirmOwnerWords(request.setId, shown);
      haptics.success();
      onClose();
    } catch (e) {
      haptics.error();
      setError(plainError(e, `That didn't reach ${request.computerName}. Try again.`));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy('cancel');
    setError(null);
    try {
      await env.cancelOwnRequest(request.setId);
      haptics.error();
      setStep({ kind: 'cancelled' });
    } catch (e) {
      setError(plainError(e, "The request wasn't cancelled. Try again."));
    } finally {
      setBusy(null);
    }
  };

  // The sixth right pick confirms; a failure stays on screen with Try again.
  useEffect(() => {
    if (check.matched) void confirm();
  }, [check.matched]);
  // A second wrong pick ends the check for good: the request is cancelled.
  useEffect(() => {
    if (check.ended && step.kind === 'checking') void cancel();
  }, [check.ended]);

  const cancelled = step.kind === 'cancelled';
  const footer = cancelled ? (
    <GhostButton label="Close" onPress={onClose} />
  ) : check.ended ? (
    error ? <GhostButton danger label="Cancel the request" disabled={busy !== null} onPress={() => void cancel()} /> : null
  ) : check.matched ? (
    error ? <PrimaryButton icon="check" label="Try again" busy={busy === 'confirm'} disabled={busy !== null} onPress={() => void confirm()} /> : null
  ) : (
    <GhostButton danger label={busy === 'cancel' ? 'Cancelling…' : "They don't match"} disabled={busy !== null} onPress={() => void cancel()} />
  );
  // In a short window a fixed footer leaves no room for the picks, so it scrolls after them.
  const inline = screen.height < SHORT_WINDOW;
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={words.check}
      subtitle={`${request.setName} · from ${request.computerName}`}
      maxWidth={560}
      footer={inline ? undefined : footer}
    >
      {cancelled ? (
        <>
          <Notice tone="danger">{words.mismatch}</Notice>
          <Text tone="dim">{`The request is cancelled, so this phone won't take ${request.setName} from it.`}</Text>
        </>
      ) : (
        <>
          <Text tone="dim">{words.ask}</Text>
          {check.view}
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </>
      )}
      {inline ? footer : null}
    </Sheet>
  );
}
