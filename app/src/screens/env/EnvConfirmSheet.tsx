/**
 * A yes/no question for an env action that may fail: removing a member, deleting a variable or a
 * removed set. The action runs inside the sheet; when it rejects (the app-lock confirm was
 * cancelled, the computer is offline) its sentence shows here and the sheet stays open.
 */
import { useState } from 'react';

import { haptics } from '../../lib/haptics';
import { GhostButton } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { Notice, plainError } from '../authflows/parts';
import { ButtonRow } from './parts';
import { envSheets, useEnvSheets } from './sheetState';

export function EnvConfirmSheet() {
  const request = useEnvSheets((s) => s.confirm);
  // Keep showing the last question while the sheet animates away.
  const [shown, setShown] = useState(request);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (request && request !== shown) {
    setShown(request);
    setError(null);
  }
  const close = () => {
    if (!busy) envSheets.confirm(null);
  };

  const confirm = async () => {
    if (!request) return;
    if (request.danger) haptics.warning();
    setBusy(true);
    setError(null);
    try {
      await request.action();
      envSheets.confirm(null);
    } catch (e) {
      haptics.error();
      setError(plainError(e, `That didn't work. Try again.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible={!!request}
      onClose={close}
      title={shown?.title}
      maxWidth={520}
      footer={
        <ButtonRow>
          <GhostButton label="Cancel" disabled={busy} onPress={close} />
          <GhostButton danger={shown?.danger} label={busy ? `${shown?.confirmLabel ?? 'OK'}…` : (shown?.confirmLabel ?? 'OK')} disabled={busy} onPress={() => void confirm()} />
        </ButtonRow>
      }
    >
      <Text tone="dim">{shown?.message}</Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Sheet>
  );
}
