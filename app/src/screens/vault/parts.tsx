/** Building blocks shared by the vault screens: sunken sections, raised rows, tiles, tags and alerts. */
import type { ReactNode } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';

import { PressBlock } from '../../ui/controls';
import { Glyph, type GlyphName } from '../../ui/Icon';
import { Well } from '../../ui/Panel';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { RaisedFace, Shape, SunkenFace, VOXEL } from '../../ui/voxel';
import { headerMetrics } from '../deck/HeaderButton';

/** Space between rows inside a section, and between a section's parts. */
export const SECTION_GAP = 12;
/** Rows sit on a raised block whose front face is one voxel tall. */
const ROW_PAD = { top: 12, bottom: 12 + VOXEL, left: 14, right: 12 };
const TILE_SIZE = 40;
/** Alerts are the warning colour laid thinly over the section; the top lip gets a second coat. */
const ALERT_TINT = 0.16;

/** A sunken section (Accounts, Trusted devices, History), with a heading when given a title. */
export function SectionWell({
  title,
  accessory,
  children,
  style,
}: {
  title?: string;
  /** Sits at the right end of the heading row. */
  accessory?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const cw = useColorway();
  const { compact } = useScreen();
  return (
    <Well
      color={cw.plate}
      steps={2}
      style={[{ paddingTop: (compact ? 18 : 22) + VOXEL, paddingHorizontal: compact ? 14 : 20, paddingBottom: compact ? 14 : 16, gap: SECTION_GAP }, style]}
    >
      {title ? <SectionHeading title={title} accessory={accessory} /> : null}
      {children}
    </Well>
  );
}

/** A heading inside a section, with an optional accessory on the right. */
export function SectionHeading({ title, accessory, style }: { title: string; accessory?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 28 }, style]}>
      <Text variant="heading" accessibilityRole="header" style={{ flex: 1 }}>
        {title}
      </Text>
      {accessory}
    </View>
  );
}

export function Hint({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style}>
      <Text variant="caption" tone="dim">
        {children}
      </Text>
    </View>
  );
}

/** A small sunken square holding an icon. */
export function Tile({ icon, color }: { icon: GlyphName; color?: string }) {
  const cw = useColorway();
  return (
    <View style={{ width: TILE_SIZE, height: TILE_SIZE, alignItems: 'center', justifyContent: 'center', paddingTop: VOXEL }}>
      <SunkenFace color={cw.surfaceAlt} lip={cw.lip} />
      <Glyph name={icon} size={24} color={color ?? cw.text} />
    </View>
  );
}

/** A short fact at the end of a row: "6 digits, 30 s". */
export function Tag({ label }: { label: string }) {
  const cw = useColorway();
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3 }}>
      <Shape steps={1} color={cw.surfaceAlt} />
      <Text variant="caption" weight="medium" tone="dim" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

interface ItemRowProps {
  icon: GlyphName;
  iconColor?: string;
  title: string;
  titleColor?: string;
  detail?: string;
  /** Cut the detail to this many lines; it wraps freely when not set. */
  detailLines?: number;
  /** A short line in the danger colour under the detail, for something to act on. */
  warning?: string;
  /** Tag, button or anything else at the right end. */
  trailing?: ReactNode;
  /** Makes the whole row a button. */
  onPress?: () => void;
  accessibilityLabel?: string;
}

function ItemRowContent({ icon, iconColor, title, titleColor, detail, detailLines, warning, trailing }: ItemRowProps) {
  const cw = useColorway();
  return (
    <>
      <Tile icon={icon} color={iconColor} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text weight="semibold" color={titleColor} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text variant="caption" tone="dim" numberOfLines={detailLines}>
            {detail}
          </Text>
        ) : null}
        {warning ? (
          <Text variant="caption" weight="medium" color={cw.dangerText}>
            {warning}
          </Text>
        ) : null}
      </View>
      {trailing}
    </>
  );
}

const rowContentStyle: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 14,
  paddingTop: ROW_PAD.top,
  paddingBottom: ROW_PAD.bottom,
  paddingLeft: ROW_PAD.left,
  paddingRight: ROW_PAD.right,
};

/** A raised row with a tile, a title, a detail line and something at the end. */
export function ItemRow(props: ItemRowProps) {
  const cw = useColorway();
  if (props.onPress) {
    return (
      <PressBlock
        tone={cw.control}
        onPress={props.onPress}
        accessibilityLabel={props.accessibilityLabel ?? props.title}
        contentStyle={[rowContentStyle, { paddingBottom: ROW_PAD.bottom - VOXEL }]}
      >
        <ItemRowContent {...props} />
      </PressBlock>
    );
  }
  return (
    <View style={rowContentStyle}>
      <RaisedFace tone={cw.control} shadow={cw.shadow} />
      <ItemRowContent {...props} />
    </View>
  );
}

/** A tinted box for things that need attention: a rejected change, a rollback. */
export function Alert({ title, children, tone = 'danger' }: { title: string; children?: ReactNode; tone?: 'danger' | 'warning' }) {
  const cw = useColorway();
  const ink = tone === 'danger' ? cw.dangerText : cw.run;
  return (
    <View accessibilityRole="alert" style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 16 }}>
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: ALERT_TINT }}>
        <Shape steps={1} color={ink} />
      </View>
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: VOXEL, opacity: ALERT_TINT }}>
        <Shape steps={1} color={ink} bottom={false} />
      </View>
      <Glyph name="square-alert" size={24} color={ink} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text weight="semibold" color={ink}>
          {title}
        </Text>
        {typeof children === 'string' ? (
          <Text variant="caption" color={ink} style={{ opacity: 0.85 }}>
            {children}
          </Text>
        ) : (
          children
        )}
      </View>
    </View>
  );
}

/** A square status light and its words: "Chain verified". */
export function StatusLight({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ width: 10, height: 10, backgroundColor: color }} />
      <Text variant="caption" weight="medium" color={color}>
        {label}
      </Text>
    </View>
  );
}

/** The amber header block with an icon: "Add account". Same height as the other header buttons. */
export function HeaderAccentIconButton({ label, icon, onPress, compact }: { label: string; icon: GlyphName; onPress: () => void; compact: boolean }) {
  const cw = useColorway();
  const tone = cw.caps.a;
  const m = headerMetrics(compact);
  return (
    <PressBlock
      tone={tone}
      onPress={onPress}
      accessibilityLabel={label}
      style={{ height: m.control }}
      contentStyle={{
        paddingHorizontal: compact ? 14 : 18,
        paddingBottom: VOXEL,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <Glyph name={icon} size={m.icon} color={tone.legend} />
      <Text weight="semibold" color={tone.legend} numberOfLines={1}>
        {label}
      </Text>
    </PressBlock>
  );
}

/** A centred message for an empty list or an empty screen. */
export function EmptyNote({ icon, title, children }: { icon: GlyphName; title: string; children?: ReactNode }) {
  const cw = useColorway();
  return (
    <View style={{ alignItems: 'center', gap: 10, paddingVertical: 24, paddingHorizontal: 12 }}>
      <Glyph name={icon} size={36} color={cw.textFaint} />
      <Text weight="semibold" center>
        {title}
      </Text>
      {children}
    </View>
  );
}
