/**
 * The owner's review of values saved under an old key (an 'epoch' problem): keep them, encrypted
 * again under the current key, or remove them. Nothing is encrypted again without this review.
 * The names shown are the ones passed back, so a list that changed while the sheet was open is
 * refused; the sheet then shows the new list and asks again.
 */
import { useState } from 'react';

import type { EnvApi, EnvSetView } from '../../auth/envContract';
import { haptics } from '../../lib/haptics';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { Notice, plainError } from '../authflows/parts';
import { ButtonRow, EnvRow } from './parts';
import { envSheets, useEnvSheets } from './sheetState';
import { useEnv } from './source';
import { oldKeyRotate, oldKeyText } from './view';

/** The names under the old key, or none when the set has no such problem (any more). */
export function oldKeyNames(set: Pick<EnvSetView, 'problems'>): string[] {
  return set.problems.find((p) => p.kind === 'epoch')?.names ?? [];
}

export function OldKeySheet() {
  const env = useEnv();
  const open = useEnvSheets((s) => s.oldKey);
  const setId = useEnvSheets((s) => s.setId);
  const set = setId ? (env.detail(setId)?.set ?? null) : null;
  return (
    <Sheet visible={open && set !== null} onClose={() => envSheets.setOldKey(false)} title="Values under an old key" subtitle={set?.name} maxWidth={600}>
      {open && set ? <OldKeyBody env={env} set={set} /> : null}
    </Sheet>
  );
}

function OldKeyBody({ env, set }: { env: EnvApi; set: EnvSetView }) {
  const [busy, setBusy] = useState<'keep' | 'drop' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = oldKeyNames(set);

  const fix = async (keep: boolean) => {
    setBusy(keep ? 'keep' : 'drop');
    setError(null);
    try {
      // With app lock on this asks for the device's unlock; cancelling rejects with a sentence.
      const { rotate } = await env.fixOldKeyLines(set.id, keep, names);
      haptics.success();
      envSheets.setOldKey(false);
      envSheets.showRotate(oldKeyRotate(keep, names, rotate));
    } catch (e) {
      // Also when the list changed since it was shown: the sheet now shows the new one.
      haptics.error();
      setError(plainError(e, `${set.name} couldn't be fixed. Try again.`));
    } finally {
      setBusy(null);
    }
  };

  if (names.length === 0) {
    return <Text tone="dim">{`Nothing in ${set.name} is under an old key any more.`}</Text>;
  }
  return (
    <>
      <Text>{oldKeyText(names)}</Text>
      {names.map((name) => (
        <EnvRow key={name} icon="key" title={name} mono lines={[]} />
      ))}
      <Text variant="caption" tone="dim">
        Keep encrypts them again under the current key, so every member can read them. Remove takes them out of the set.
      </Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <ButtonRow>
        <GhostButton danger label={busy === 'drop' ? 'Removing…' : 'Remove them'} disabled={busy !== null} onPress={() => void fix(false)} />
        <PrimaryButton label={busy === 'keep' ? 'Keeping' : 'Keep them'} busy={busy === 'keep'} disabled={busy !== null} onPress={() => void fix(true)} />
      </ButtonRow>
    </>
  );
}
