/**
 * Taking over a set whose owner's phone is lost: the owner's 12-word recovery phrase makes this
 * phone the owner. A SecureSheet, since it takes the phrase; the words live only in its state.
 */
import { useState } from 'react';
import { View } from 'react-native';

import type { EnvApi, EnvSetView } from '../../auth/envContract';
import { haptics } from '../../lib/haptics';
import { PrimaryButton } from '../../ui/controls';
import { SecureSheet } from '../../ui/SecureSheet';
import { Text } from '../../ui/Text';
import { Notice, plainError } from '../authflows/parts';
import { usePhraseEntry } from '../authflows/phraseEntry';
import { envSheets, useEnvSheets } from './sheetState';
import { useEnv } from './source';
import { takeOverRotate } from './view';

export function BecomeOwnerSheet() {
  const env = useEnv();
  const open = useEnvSheets((s) => s.becomeOwner);
  const setId = useEnvSheets((s) => s.setId);
  const set = setId ? (env.detail(setId)?.set ?? null) : null;
  return (
    <SecureSheet visible={open && set !== null} onClose={() => envSheets.setBecomeOwner(false)} title="Become owner" subtitle={set?.name} maxWidth={720}>
      {open && set ? <BecomeOwnerBody env={env} set={set} /> : null}
    </SecureSheet>
  );
}

function BecomeOwnerBody({ env, set }: { env: EnvApi; set: EnvSetView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entry = usePhraseEntry({ editable: !busy });

  const take = async () => {
    setBusy(true);
    setError(null);
    try {
      const { removed, rotate } = await env.becomeOwner(set.id, entry.words);
      haptics.success();
      entry.clear();
      envSheets.setBecomeOwner(false);
      envSheets.showRotate(takeOverRotate(set.name, removed, rotate));
    } catch (e) {
      haptics.error();
      setError(plainError(e, `This phone couldn't become the owner of ${set.name}. Check the words, then try again.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Text tone="dim">
        {`For a set whose owner's phone is lost. Type the owner's 12-word recovery phrase in order, or paste it. It signs a new member list that makes this phone the owner of ${set.name} and takes every other device out; they ask to join again, and the old owner's phone can't change who is in it.`}
      </Text>
      {entry.fields}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Notice tone="warn">{`Commit ${set.file} on ${set.computerName} afterwards so the other members get the new owner.`}</Notice>
      <View style={{ gap: 14 }}>
        {entry.suggestions}
        <PrimaryButton icon="key" label={busy ? 'Checking' : 'Become owner'} busy={busy} disabled={!entry.ready} onPress={() => void take()} />
      </View>
    </>
  );
}
