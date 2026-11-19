/** Small building blocks shared by the key editor and page settings. */
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import type { Platform } from '../../protocol';
import { useLive } from '../../state/live';
import { useStore } from '../../state/store';
import { Glyph, type GlyphName } from '../../ui/Icon';
import { Well as SunkenWell } from '../../ui/Panel';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { RaisedFace, SunkenFace, VOXEL } from '../../ui/voxel';
import { appNameFromId } from './actionModel';

const WELL_PAD = 16;
/** Front face of a raised card inside a well. */
const CARD_DEPTH = VOXEL;

/** Facts about the computer and page every action editor needs. */
export interface EditorEnv {
  agentId: string;
  platform: Platform;
  computerName: string;
  /** Page's project folder, if set. */
  pageCwd?: string;
}

const EnvContext = createContext<EditorEnv | null>(null);
export const EnvProvider = EnvContext.Provider;

export function useEnv(): EditorEnv {
  const env = useContext(EnvContext);
  if (!env) throw new Error('useEnv outside EnvProvider');
  return env;
}

/** Builds the editor environment for a computer and page from the store. */
export function useEditorEnv(agentId: string, pageCwd: string | undefined): EditorEnv | null {
  const platform = useStore((s) => s.computers.find((c) => c.agentId === agentId)?.platform);
  const computerName = useStore((s) => s.computers.find((c) => c.agentId === agentId)?.name);
  return useMemo(
    () => (platform && computerName !== undefined ? { agentId, platform, computerName, pageCwd } : null),
    [agentId, platform, computerName, pageCwd],
  );
}

/** True when the live session is with this computer and connected. */
export function useOnline(agentId: string): boolean {
  return useLive((s) => s.status === 'online' && s.agent?.agentId === agentId);
}

/** App name from the computer's list, or a readable guess from its id when the list is missing. */
export function useAppName(appId: string | undefined, fallback?: string): string {
  const name = useLive((s) => (appId ? s.apps?.find((a) => a.id === appId)?.name : undefined));
  if (!appId) return '';
  return name ?? (fallback || appNameFromId(appId));
}

export function Section({ label, children, gap = 12 }: { label?: string; children: ReactNode; gap?: number }) {
  return (
    <View style={{ gap }}>
      {label ? (
        <Text variant="label" tone="dim">
          {label}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/** A sunken block that groups related controls; `raised` makes a block that stands on it instead. */
export function Well({
  children,
  gap = 16,
  raised,
  accessibilityLabel,
}: {
  children: ReactNode;
  gap?: number;
  /** For a block inside another Well: a raised card, so it stands apart. */
  raised?: boolean;
  accessibilityLabel?: string;
}) {
  const cw = useColorway();
  if (raised) {
    return (
      <View accessibilityLabel={accessibilityLabel} style={{ padding: WELL_PAD, paddingBottom: WELL_PAD + CARD_DEPTH, gap }}>
        <RaisedFace tone={cw.float} steps={2} depth={CARD_DEPTH} shadow={cw.shadow} />
        {children}
      </View>
    );
  }
  return (
    <View accessibilityLabel={accessibilityLabel}>
      <SunkenWell style={{ padding: WELL_PAD, paddingTop: WELL_PAD + VOXEL, gap }}>{children}</SunkenWell>
    </View>
  );
}

/** A sunken groove between sections. */
export function Divider() {
  const cw = useColorway();
  return <View style={{ height: VOXEL / 2, backgroundColor: cw.lip }} />;
}

/**
 * The sunken frame of a text input with extras beside it (search icon, clear button).
 * Lays its children out in a row; the top padding keeps them clear of the lip.
 */
export function InputFrame({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const cw = useColorway();
  const { compact } = useScreen();
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', minHeight: compact ? 48 : 52, paddingTop: VOXEL }, style]}>
      <SunkenFace color={cw.field} lip={cw.lip} />
      {children}
    </View>
  );
}

type NoticeTone = 'info' | 'warn' | 'ok' | 'fail';

const NOTICE_GLYPH: Record<NoticeTone, GlyphName> = { info: 'circle-info', warn: 'square-alert', ok: 'checkbox-on', fail: 'cancel' };

/** One inline message: what is going on and what to do about it. */
export function Notice({
  tone = 'info',
  title,
  detail,
  children,
}: {
  tone?: NoticeTone;
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  const cw = useColorway();
  const color = { info: cw.textDim, warn: cw.run, ok: cw.ok, fail: cw.dangerText }[tone];
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      accessibilityLiveRegion="polite"
      accessible
      accessibilityLabel={[title, detail].filter(Boolean).join('. ')}
      style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}
    >
      <Glyph name={NOTICE_GLYPH[tone]} size={24} color={color} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text variant="label" weight="medium" color={tone === 'info' ? cw.text : color}>
          {title}
        </Text>
        {detail ? (
          <Text variant="label" tone="dim">
            {detail}
          </Text>
        ) : null}
        {children}
      </View>
    </Animated.View>
  );
}

/** A label and description on the left, a control on the right. */
export function SettingRow({ title, detail, children }: { title: string; detail?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text>{title}</Text>
        {typeof detail === 'string' ? (
          <Text variant="label" tone="dim">
            {detail}
          </Text>
        ) : (
          detail
        )}
      </View>
      {children}
    </View>
  );
}
