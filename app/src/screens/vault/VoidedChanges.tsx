/**
 * Membership changes voided because their author was removed by a change it had not seen
 * (rule 1). Each is told in neutral words, since the folder can't tell an honest device that
 * hadn't heard of its removal from a removed device writing stale changes. Nothing is redone.
 */
import { View } from 'react-native';

import type { VoidedChangeView } from '../../auth/contract';
import { useVault } from '../../auth/useVault';
import { GhostButton } from '../../ui/controls';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { showFailure } from './feedback';
import { Alert } from './parts';

export function VoidedChangesNotice({ changes }: { changes: VoidedChangeView[] }) {
  const vault = useVault();
  const dismiss = (change: VoidedChangeView) => void vault.dismissVoidedChanges([change.id]).catch((e) => showFailure('Could not dismiss this', e));
  return (
    <>
      {changes.map((change) => (
        <Alert key={change.id} title={change.text} tone="warning">
          <View style={{ gap: 8, marginTop: 4, alignItems: 'flex-start' }}>
            {change.hint ? <AlertHint text={change.hint} /> : null}
            <GhostButton small label="Dismiss" onPress={() => dismiss(change)} />
          </View>
        </Alert>
      ))}
    </>
  );
}

/** The hint under a warning, in the warning's ink (as Alert sets plain-string children). */
function AlertHint({ text }: { text: string }) {
  const cw = useColorway();
  return (
    <Text variant="caption" color={cw.run} style={{ opacity: 0.85 }}>
      {text}
    </Text>
  );
}
