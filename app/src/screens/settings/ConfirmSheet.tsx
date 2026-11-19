/** A yes/no question in a sheet. Works the same on every platform (Alert does nothing on the web). */
import { useState } from 'react';
import { View } from 'react-native';

import { haptics } from '../../lib/haptics';
import { GhostButton } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** Destructive actions are drawn in the danger colour. */
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmSheet({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  // Keep showing the last question while the sheet animates away.
  const [shown, setShown] = useState(request);
  if (request && request !== shown) setShown(request);
  return (
    <Sheet
      visible={!!request}
      onClose={onClose}
      title={shown?.title}
      maxWidth={520}
      footer={
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <GhostButton grow label="Cancel" onPress={onClose} />
          <GhostButton
            grow
            danger={shown?.danger}
            label={shown?.confirmLabel ?? 'OK'}
            onPress={() => {
              if (!request) return;
              if (request.danger) haptics.warning();
              request.onConfirm();
              onClose();
            }}
          />
        </View>
      }
    >
      <Text tone="dim">{shown?.message}</Text>
    </Sheet>
  );
}
