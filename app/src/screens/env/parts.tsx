/** Pieces the env screens share: set rows, fact tables, variable and member rows, sub-headings. */
import { Children, type ReactNode } from 'react';
import { View } from 'react-native';

import type { EnvChangeView, EnvMemberView } from '../../auth/envContract';
import { GhostButton, IconButton, PressBlock } from '../../ui/controls';
import { Glyph, type GlyphName } from '../../ui/Icon';
import { Well } from '../../ui/Panel';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { RaisedFace, VOXEL } from '../../ui/voxel';
import { fonts } from '../../theme/type';
import { Tag, Tile } from '../vault/parts';
import { changeLine, type LineTone, LOADS_CODE_LINE, memberDetail } from './view';

/** Rows sit on a raised block whose front face is one voxel tall (as the vault's ItemRow). */
const ROW_PAD = { top: 12, bottom: 12, left: 14, right: 12 };
/** GhostButton's small height: rows holding one are this tall inside their padding. */
const SMALL_BUTTON = 44;

export function useLineColor(): (tone: LineTone) => string {
  const cw = useColorway();
  return (tone) => ({ ok: cw.ok, warning: cw.run, danger: cw.dangerText, dim: cw.textDim })[tone];
}

/** A raised row: tile, title, lines under it, something at the end. Pressable when given onPress. */
export function EnvRow({
  icon,
  iconColor,
  title,
  mono,
  lines,
  trailing,
  onPress,
  accessibilityLabel,
  warning,
  action,
}: {
  icon?: GlyphName;
  iconColor?: string;
  title: string;
  /** Set the title in the code face, for variable names. */
  mono?: boolean;
  lines: { text: string; color?: string; selectable?: boolean; numberOfLines?: number }[];
  trailing?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Marks the title with the warning sign (a name that changes how programs start). */
  warning?: boolean;
  /** A button under the lines, inside the row: the one thing to do about it. Not for pressable rows. */
  action?: ReactNode;
}) {
  const cw = useColorway();
  const content = (
    <>
      {icon ? <Tile icon={icon} color={iconColor} /> : null}
      {/* At least a small button's height, so rows with and without one line up. */}
      <View style={{ flex: 1, minWidth: 0, minHeight: SMALL_BUTTON, justifyContent: 'center', gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {warning ? <Glyph name="square-alert" size={18} color={cw.run} /> : null}
          <Text weight="semibold" numberOfLines={1} style={[{ flexShrink: 1 }, mono ? { fontFamily: fonts.plex.semibold } : null]}>
            {title}
          </Text>
        </View>
        {lines.map((line, i) => (
          <Text key={i} variant="caption" color={line.color ?? cw.textDim} selectable={line.selectable} numberOfLines={line.numberOfLines}>
            {line.text}
          </Text>
        ))}
        {action ? <View style={{ alignItems: 'flex-start', marginTop: 10 }}>{action}</View> : null}
      </View>
      {trailing}
    </>
  );
  const rowStyle = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 14,
    paddingTop: ROW_PAD.top,
    paddingLeft: ROW_PAD.left,
    paddingRight: ROW_PAD.right,
  };
  if (onPress) {
    return (
      <PressBlock tone={cw.control} onPress={onPress} accessibilityLabel={accessibilityLabel ?? title} contentStyle={[rowStyle, { paddingBottom: ROW_PAD.bottom }]}>
        {content}
      </PressBlock>
    );
  }
  return (
    <View style={[rowStyle, { paddingBottom: ROW_PAD.bottom + VOXEL }]} accessible={!trailing} accessibilityLabel={accessibilityLabel}>
      <RaisedFace tone={cw.control} shadow={cw.shadow} />
      {content}
    </View>
  );
}

/** A heading inside a sheet, with an action on the right: "Variables · 12   + Add". */
export function SubHeading({ title, action, accessory }: { title: string; action?: { label: string; icon: GlyphName; onPress: () => void }; accessory?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}>
      <Text variant="subhead" accessibilityRole="header" style={{ flex: 1 }}>
        {title}
      </Text>
      {accessory}
      {action ? <GhostButton small icon={action.icon} label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

/** Label and value pairs in a sunken box: "Command   npm run dev". */
export function FactTable({ facts }: { facts: { label: string; value: string }[] }) {
  const cw = useColorway();
  return (
    <Well steps={2} style={{ paddingTop: 6 + VOXEL, paddingBottom: 6, paddingHorizontal: 16 }}>
      {facts.map((fact, i) => (
        <View
          key={fact.label}
          accessible
          accessibilityLabel={`${fact.label}: ${fact.value}`}
          style={{ flexDirection: 'row', gap: 14, paddingVertical: 10, borderTopWidth: i === 0 ? 0 : VOXEL / 2, borderTopColor: cw.line }}
        >
          <Text variant="caption" tone="dim" style={{ width: 96, paddingTop: 1 }}>
            {fact.label}
          </Text>
          <Text variant="label" style={{ flex: 1, minWidth: 0, fontFamily: fonts.plex.medium }}>
            {fact.value}
          </Text>
        </View>
      ))}
    </Well>
  );
}

/** A push's diff: one line per name, marked + ~ −, with the new value when shown. */
export function ChangeList({ changes, source, values }: { changes: EnvChangeView[]; source: string | null; values?: Record<string, string | null> }) {
  const cw = useColorway();
  const markColor = { add: cw.ok, change: cw.run, remove: cw.dangerText };
  return (
    <Well steps={2} style={{ paddingTop: 4 + VOXEL, paddingBottom: 4, paddingHorizontal: 16 }}>
      {changes.map((change, i) => {
        const line = changeLine(change, source);
        const value = values?.[change.name];
        return (
          <View
            key={change.name}
            accessible
            accessibilityLabel={`${change.name}: ${line.words}${change.loadsCode ? `. ${LOADS_CODE_LINE}` : ''}`}
            style={{ flexDirection: 'row', gap: 12, paddingVertical: 10, borderTopWidth: i === 0 ? 0 : VOXEL / 2, borderTopColor: cw.line }}
          >
            <Text weight="semibold" color={markColor[change.change]} style={{ width: 14, textAlign: 'center' }}>
              {line.mark}
            </Text>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {change.loadsCode ? <Glyph name="square-alert" size={16} color={cw.run} /> : null}
                <Text variant="label" weight="semibold" style={{ flexShrink: 1, fontFamily: fonts.plex.semibold }}>
                  {line.name}
                </Text>
              </View>
              <Text variant="caption" tone="dim">
                {line.words}
              </Text>
              {change.loadsCode ? (
                <Text variant="caption" color={cw.run}>
                  {LOADS_CODE_LINE}
                </Text>
              ) : null}
              {value ? (
                <Text variant="caption" selectable numberOfLines={4} style={{ fontFamily: fonts.plex.medium }}>
                  {value}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </Well>
  );
}

/** A member device: who, which device, since when, its role; Remove for the owner. */
export function MemberRow({ member, onRemove }: { member: EnvMemberView; onRemove?: () => void }) {
  return (
    <EnvRow
      icon={member.form === 'tablet' ? 'tablet' : 'phone'}
      title={member.label}
      lines={[{ text: memberDetail(member) }]}
      accessibilityLabel={`${member.label}, ${memberDetail(member)}, ${member.role}`}
      trailing={
        onRemove ? (
          <GhostButton small danger label="Remove" onPress={onRemove} />
        ) : (
          <Tag label={member.role} />
        )
      }
    />
  );
}

/** Six key words in two lines of three, large enough to read out over a call. */
export function SixWords({ words, label }: { words: string[]; label: string }) {
  const lines = [words.slice(0, 3).join(' '), words.slice(3).join(' ')];
  return (
    <Well steps={2} style={{ paddingTop: 14 + VOXEL, paddingBottom: 16, paddingHorizontal: 18, gap: 6 }}>
      <View accessible accessibilityLabel={`${label}: ${words.join(' ')}`} style={{ gap: 6 }}>
        <Text variant="caption" tone="dim">
          {label}
        </Text>
        {lines.map((line) => (
          <Text key={line} variant="lead" weight="semibold" selectable>
            {line}
          </Text>
        ))}
      </View>
    </Well>
  );
}

/** The eye at the end of a variable row. */
export function RevealButton({ shown, name, onPress, disabled }: { shown: boolean; name: string; onPress: () => void; disabled?: boolean }) {
  return <IconButton icon={shown ? 'eye-off' : 'eye'} label={shown ? `Hide ${name}` : `Show ${name}`} onPress={onPress} disabled={disabled} />;
}

/** Buttons side by side at equal widths, whatever their labels. */
export function ButtonRow({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      {Children.toArray(children).map((child, i) => (
        <View key={i} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0 }}>
          {child}
        </View>
      ))}
    </View>
  );
}
