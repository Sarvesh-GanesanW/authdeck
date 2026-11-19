/**
 * Header controls: voxel blocks that all share one height so the bar reads as a single
 * row (48 on tablets, 44 on phones), with one gap between them.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { PressBlock } from '../../ui/controls';
import { Glyph, type GlyphName } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { VOXEL } from '../../ui/voxel';

export function headerMetrics(compact: boolean) {
  return {
    control: compact ? 44 : 48,
    gap: 12,
    margin: compact ? 12 : 24,
    icon: 24,
  };
}

export function HeaderButton({
  label,
  icon,
  onPress,
  compact,
  iconOnly,
  accessibilityLabel,
  children,
  shrink,
}: {
  label: string;
  icon?: GlyphName;
  onPress: () => void;
  compact: boolean;
  /** Square button showing only the icon; `label` becomes the accessibility label. */
  iconOnly?: boolean;
  accessibilityLabel?: string;
  /** Custom content instead of the label. */
  children?: ReactNode;
  /** Allow the button to shrink (long computer names on phones). */
  shrink?: boolean;
}) {
  const cw = useColorway();
  const m = headerMetrics(compact);
  return (
    <PressBlock
      tone={cw.control}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? label}
      style={{
        height: m.control,
        minWidth: m.control,
        width: iconOnly ? m.control : undefined,
        flexShrink: shrink ? 1 : 0,
      }}
      contentStyle={{
        paddingHorizontal: iconOnly ? 0 : compact ? 14 : 18,
        paddingBottom: VOXEL,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      {children ?? (
        <>
          {icon ? <Glyph name={icon} size={m.icon} color={cw.text} /> : null}
          {iconOnly ? null : (
            <Text weight="medium" numberOfLines={1}>
              {label}
            </Text>
          )}
        </>
      )}
    </PressBlock>
  );
}

/** The accent "Done" block at header height. */
export function HeaderAccentButton({ label, onPress, compact }: { label: string; onPress: () => void; compact: boolean }) {
  const cw = useColorway();
  const tone = cw.caps.a;
  const m = headerMetrics(compact);
  return (
    <PressBlock
      tone={tone}
      onPress={onPress}
      accessibilityLabel={label}
      style={{ height: m.control }}
      contentStyle={{ paddingHorizontal: compact ? 18 : 22, paddingBottom: VOXEL, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text weight="semibold" color={tone.legend}>
        {label}
      </Text>
    </PressBlock>
  );
}

/** Spacer that pushes the following controls to the right edge; `onWidth` reports the room it takes. */
export function Fill({ onWidth }: { onWidth?: (width: number) => void }) {
  return <View style={{ flex: 1 }} onLayout={onWidth ? (e) => onWidth(e.nativeEvent.layout.width) : undefined} />;
}
