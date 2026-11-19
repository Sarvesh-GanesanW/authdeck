/**
 * Restore with the recovery phrase: 12 words (typed with autocomplete, or pasted at once), then
 * the vault is rebuilt from the folder on the paired computer and this device is added. Opened
 * while this device's vault is locked, the same words unlock it instead: for app lock on a device
 * that can no longer prompt (its screen lock was removed), so app lock never locks anyone out.
 */
import { useState } from 'react';
import { View } from 'react-native';

import type { SurfaceProps } from '../../auth/contract';
import { useAuthUi } from '../../auth/ui';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { vaultFeatures } from '../../vault/features';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { Text } from '../../ui/Text';
import { FlowSheet, type FlowView, Notice, plainError } from './parts';
import { usePhraseEntry } from './phraseEntry';

type Stage = 'enter' | 'restoring' | 'done';

export function RestoreFlow({ onClose }: SurfaceProps) {
  const vault = useVault();
  const open = useAuthUi((s) => s.open);
  const [stage, setStage] = useState<Stage>('enter');
  const [error, setError] = useState<string | null>(null);
  const [replacedAt, setReplacedAt] = useState<number | null>(null);
  // The computer doesn't show the restore yet: never called a success.
  const [warning, setWarning] = useState<string | null>(null);
  // A vault on this device that is locked: the phrase opens it rather than restoring.
  const [unlocking] = useState(() => vault.status === 'locked');
  const entry = usePhraseEntry({ editable: stage === 'enter' });
  const ready = entry.ready && (unlocking || vault.computerOnline);

  const restore = async () => {
    setStage('restoring');
    setError(null);
    try {
      if (unlocking) await vault.unlockWithPhrase(entry.words);
      else {
        const restored = await vault.restoreWithPhrase(entry.words);
        setReplacedAt(restored.replacedAt);
        setWarning(restored.warning);
      }
      haptics.success();
      entry.clear();
      if (unlocking) {
        open('vault');
        return;
      }
      setStage('done');
    } catch (e) {
      haptics.error();
      setError(
        plainError(
          e,
          unlocking
            ? "The vault didn't open. Check the words, then try again."
            : "The vault couldn't be restored. Check the words and that the computer is online, then try again.",
        ),
      );
      setStage('enter');
    }
  };

  const computer = vault.storage.computerName ?? 'your computer';
  // Closing the sheet mid-search stops it between vaults.
  const close = () => {
    if (stage === 'restoring' && !unlocking) vault.cancelRestore();
    onClose();
  };

  const view: FlowView =
    stage === 'done'
      ? {
          title: warning ? 'Not confirmed yet' : 'Your vault is back',
          onClose: close,
          footer: (
            <View style={{ gap: 12 }}>
              <PrimaryButton label="Make a new phrase" icon="key" onPress={() => open('recovery-setup')} />
              <GhostButton label="Open vault" onPress={() => open('vault')} />
            </View>
          ),
          body: (
            <>
              {warning !== null ? <Notice tone="warn">{warning}</Notice> : null}
              {replacedAt !== null ? (
                <Notice tone="warn">{`Replaced on ${new Date(replacedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}: a phone made a new vault in place of this one. It is back now; the new vault stays on that phone.`}</Notice>
              ) : null}
              {warning === null ? (
                <Text tone="dim">
                  {vaultFeatures.multiDevice
                    ? 'This device is now trusted in the vault, and your codes are here.'
                    : 'Your codes are on this device now. The device the vault was on before is out of it: anything it changes from now on is ignored, and it cannot read the accounts you add here.'}
                </Text>
              ) : null}
              <Notice tone="warn">
                {vaultFeatures.multiDevice
                  ? "Make a new recovery phrase now: the old one has been typed in and should be retired. Then remove any lost devices from the vault screen so they can't open it again."
                  : 'Make a new recovery phrase now: the old one has been typed in and should be retired. You will need the old words once more to make it.'}
              </Notice>
            </>
          ),
        }
      : {
          title: unlocking ? 'Unlock with recovery phrase' : 'Restore with recovery phrase',
          onClose: close,
          footer: (
            <View style={{ gap: 14 }}>
              {entry.suggestions}
              <PrimaryButton
                label={unlocking ? (stage === 'restoring' ? 'Unlocking' : 'Unlock') : stage === 'restoring' ? 'Restoring' : 'Restore vault'}
                busy={stage === 'restoring'}
                disabled={!ready}
                onPress={() => void restore()}
              />
            </View>
          ),
          body: (
            <>
              <Text tone="dim">
                {unlocking
                  ? "Type the 12 words of this vault's recovery phrase in order, or paste them all at once. They open the vault on this device; nothing is sent."
                  : `Type your 12 words in order, or paste them all at once. The vault folder on ${computer} is read to bring your codes back.`}
              </Text>
              {unlocking || vault.computerOnline ? null : (
                <Notice tone="warn">
                  {computer === 'your computer' ? 'Your computer' : computer} isn't connected. Restoring reads the vault folder on it, so connect it first.
                </Notice>
              )}
              {entry.fields}
              {stage === 'restoring' && !unlocking ? (
                <Notice tone="info" icon="hourglass">{`Reading the vault folder on ${computer}, checking its history and adding this device…`}</Notice>
              ) : null}
              {error ? <Notice tone="danger">{error}</Notice> : null}
            </>
          ),
        };

  return <FlowSheet view={view} maxWidth={720} secure />;
}
