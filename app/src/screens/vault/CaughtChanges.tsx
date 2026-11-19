/**
 * Account changes made while two devices removed each other (a symmetric conflict). They were not
 * applied; the person picks which to make again here, or dismisses them. Nothing is applied by itself.
 */
import { useState } from 'react';
import { View } from 'react-native';

import type { CaughtChangeView } from '../../auth/contract';
import { useVault } from '../../auth/useVault';
import { GhostButton, Press, PrimaryButton } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { Well } from '../../ui/Panel';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { VOXEL } from '../../ui/voxel';
import { showFailure } from './feedback';
import { caughtDetail, initialCaughtSelection } from './caughtReview';
import { plural } from './format';
import { Alert } from './parts';

/** True when every change listed is one a restore's removed device made (CaughtChangeView.origin). */
const allFromRestore = (changes: readonly CaughtChangeView[]) => changes.length > 0 && changes.every((c) => c.origin === 'restore');

/** The banner above the open vault, and the review sheet it opens. */
export function CaughtChangesNotice({ changes }: { changes: CaughtChangeView[] }) {
  const [reviewing, setReviewing] = useState(false);
  const count = plural(changes.length, 'account change');
  const title = allFromRestore(changes)
    ? `Your old phone made ${count} before the restore`
    : `${count} ${changes.length === 1 ? 'was' : 'were'} made while your devices disagreed`;
  return (
    <>
      <Alert title={title} tone="warning">
        <View style={{ alignItems: 'flex-start', marginTop: 8 }}>
          <GhostButton small label="Review them" onPress={() => setReviewing(true)} />
        </View>
      </Alert>
      <CaughtChangesSheet visible={reviewing} changes={changes} onClose={() => setReviewing(false)} />
    </>
  );
}

function CaughtChangesSheet({ visible, changes, onClose }: { visible: boolean; changes: CaughtChangeView[]; onClose: () => void }) {
  const vault = useVault();
  // Nothing starts ticked: each caught change may be a thief's, so the person picks every one.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(initialCaughtSelection);
  const [busy, setBusy] = useState(false);
  const selected = changes.filter((c) => chosen.has(c.id));
  const toggle = (id: string) =>
    setChosen((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  /** Re-applies or dismisses `ids`; closes once nothing is left to review. */
  const act = async (work: (ids: string[]) => Promise<void>, ids: string[], failure: string) => {
    setBusy(true);
    try {
      await work(ids);
      setChosen(initialCaughtSelection());
      if (ids.length === changes.length) onClose();
    } catch (e) {
      showFailure(failure, e);
    } finally {
      setBusy(false);
    }
  };
  const reapply = () =>
    void act(
      (ids) => vault.reapplyCaughtChanges(ids),
      selected.map((c) => c.id),
      'Could not make the changes again',
    );
  // With nothing ticked, Dismiss hides the whole list.
  const dismiss = () =>
    void act(
      (ids) => vault.dismissCaughtChanges(ids),
      (selected.length > 0 ? selected : changes).map((c) => c.id),
      'Could not dismiss the changes',
    );
  const fromRestore = allFromRestore(changes);
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={fromRestore ? 'Changes your old phone made before the restore' : 'Changes made while your devices disagreed'}
      maxWidth={600}
      footer={
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <PrimaryButton label={fromRestore ? 'Bring back selected' : 'Re-apply selected'} busy={busy} disabled={selected.length === 0 || selected.some((c) => !c.canReapply)} onPress={reapply} />
          <GhostButton label={selected.length > 0 ? 'Dismiss selected' : 'Dismiss all'} disabled={busy} onPress={dismiss} />
        </View>
      }
    >
      {fromRestore ? (
        <Text tone="dim">
          The restore took your old phone out of the vault. Before that, it deleted or changed the accounts below. Whoever had the phone may have made these
          changes, and none is ticked. Bring back the ones you didn't make: each account is written again as it was, as a change from this device.
        </Text>
      ) : (
      <Text tone="dim">
        Two devices removed each other at the same time, so both are out. Each change below was made by a device after it was removed, so none was applied, and
        none is ticked. Someone else may have made them under that device's name: re-apply only the ones you recognise. They are made again as changes from this
        device.
      </Text>
      )}
      <View style={{ gap: 12 }}>
        {changes.map((change) => (
          <CaughtRow key={change.id} change={change} checked={chosen.has(change.id)} onToggle={() => toggle(change.id)} />
        ))}
      </View>
    </Sheet>
  );
}

function CaughtRow({ change, checked, onToggle }: { change: CaughtChangeView; checked: boolean; onToggle: () => void }) {
  const cw = useColorway();
  const { author, detail } = caughtDetail(change);
  return (
    <Press
      onPress={onToggle}
      scaleTo={0.98}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={`${change.text}, by ${author}, ${change.madeAfter}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingTop: 12 + VOXEL, paddingBottom: 12 }}
    >
      <Well color={cw.surfaceAlt} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      <Glyph name={checked ? 'checkbox-on' : 'checkbox'} size={24} color={checked ? cw.focus : cw.textFaint} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text weight="semibold" numberOfLines={1}>
          {change.text}
        </Text>
        <Text variant="caption" tone="dim">
          {detail}
        </Text>
      </View>
    </Press>
  );
}
