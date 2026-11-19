/** Picks the page a key moves to. */
import { View } from 'react-native';

import type { Page } from '../../state/model';
import { PressBlock } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';

export function MoveKeySheet({
  visible,
  keyLabel,
  pages,
  fromPageId,
  onPick,
  onClose,
}: {
  visible: boolean;
  keyLabel: string;
  pages: Page[];
  fromPageId: string;
  onPick: (pageId: string) => void;
  onClose: () => void;
}) {
  const cw = useColorway();
  return (
    <Sheet visible={visible} onClose={onClose} title={`Move ${keyLabel || 'key'}`} subtitle="It goes into the first empty slot on that page." maxWidth={520}>
      <View style={{ gap: 8 }}>
        {pages
          .filter((p) => p.id !== fromPageId)
          .map((p) => {
            const used = p.slots.filter(Boolean).length;
            const full = used >= p.slots.length;
            return (
              <PressBlock
                key={p.id}
                tone={cw.control}
                onPress={() => onPick(p.id)}
                accessibilityLabel={`Move to ${p.name}`}
                style={{ minHeight: 64 }}
                contentStyle={{ paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12 }}
              >
                <View style={{ flex: 1 }}>
                  <Text weight="medium">{p.name || 'Untitled'}</Text>
                  <Text variant="caption" tone="dim">
                    {full ? `Full, so a slot is added (${used} keys)` : `${used} of ${p.slots.length} slots used`}
                  </Text>
                </View>
                <Glyph name="chevron-right" size={24} color={cw.textFaint} />
              </PressBlock>
            );
          })}
      </View>
    </Sheet>
  );
}
