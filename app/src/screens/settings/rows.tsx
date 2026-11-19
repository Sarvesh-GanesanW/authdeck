/** Grouped rows for settings: a sunken well of rows with voxel-thick separators. */
import { Children, Fragment, type ReactNode } from 'react';
import { View } from 'react-native';

import { Switch } from '../../ui/controls';
import { Well } from '../../ui/Panel';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { VOXEL } from '../../ui/voxel';

/** Separators are half a voxel thick, indented to the row text. */
const SEPARATOR = { height: VOXEL / 2, indent: 18 };

export function Section({ title, footer, children }: { title: string; footer?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 9 }}>
      <Text variant="label" tone="dim" accessibilityRole="header" style={{ paddingHorizontal: 4 }}>
        {title}
      </Text>
      {children}
      {footer ? (
        <Text variant="caption" tone="faint" style={{ paddingHorizontal: 4 }}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A sunken well of rows. It uses surfaceAlt rather than the plate colour so the sunken
 * switch tracks inside it still read.
 */
export function Group({ children }: { children: ReactNode }) {
  const cw = useColorway();
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <Well color={cw.surfaceAlt} steps={2} style={{ paddingTop: VOXEL }}>
      {rows.map((row, i) => (
        <Fragment key={i}>
          {i > 0 ? <View style={{ height: SEPARATOR.height, backgroundColor: cw.line, marginLeft: SEPARATOR.indent }} /> : null}
          {row}
        </Fragment>
      ))}
    </Well>
  );
}

export function Row({ label, detail, children }: { label: string; detail?: string; children?: ReactNode }) {
  const { compact } = useScreen();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: compact ? 54 : 60, paddingHorizontal: 18, paddingVertical: 10 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text weight="semibold">{label}</Text>
        {detail ? (
          <Text variant="caption" tone="dim">
            {detail}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** Label on the left, a value on the right (read-only facts). */
export function ValueRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Row label={label}>
      <Text variant={mono ? 'mono' : 'body'} tone="dim" numberOfLines={1} selectable style={{ flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Text>
    </Row>
  );
}

export function SwitchRow({ label, detail, value, onChange }: { label: string; detail?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label} detail={detail}>
      <Switch label={label} value={value} onChange={onChange} />
    </Row>
  );
}
