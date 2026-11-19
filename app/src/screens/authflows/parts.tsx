/** Pieces the authenticator flows share: check-code digits, notices, phrase words and fields. */
import * as ScreenCapture from 'expo-screen-capture';
import { Children, type ReactNode, type Ref, useContext, useEffect, useId, useState } from 'react';
import { Platform, TextInput, type TextInputInstance, type TextInputProps, type TextStyle, View } from 'react-native';

import { haptics } from '../../lib/haptics';
import { GhostButton } from '../../ui/controls';
import { Glyph, type GlyphName } from '../../ui/Icon';
import { Well } from '../../ui/Panel';
import { SecureSheet } from '../../ui/SecureSheet';
import { InModalWindowContext, Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { Bands, outlineBands, RaisedFace, Shape, SunkenFace, VOXEL } from '../../ui/voxel';
import { fonts } from '../../theme/type';
import { useSurfaceVisible } from '../../auth/surfaceVisibility';

const SECOND = 1000;

/** Seconds until `at`, ticking once a second; never below zero. */
export function useSecondsLeft(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const timer = setInterval(() => setNow(Date.now()), SECOND);
    return () => clearInterval(timer);
  }, [at]);
  return at === null ? 0 : Math.max(0, Math.ceil((at - now) / SECOND));
}

/** 272 -> "4:32". */
export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The engine rejects with plain sentences; anything else gets the fallback. */
export function plainError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Blocks screenshots and screen recording while mounted (iOS and Android; browsers can't). Each
 * mount uses its own key so two blocked screens don't release each other.
 *
 * On Android the block covers the app's window only, not a Modal's: a screen with a secret must
 * be drawn in a SecureSheet (FlowSheet with `secure`), which blocks capture itself. This hook
 * stays for screens drawn in the app window; in a development build it warns if it is used inside
 * a Modal, where it would claim a protection it doesn't give.
 */
export function useBlockScreenCapture(active = true): void {
  const key = `authdeck-secret-${useId()}`;
  const inModal = useContext(InModalWindowContext);
  useEffect(() => {
    if (__DEV__ && active && inModal) {
      console.warn('useBlockScreenCapture inside a Modal does not block capture of that Modal on Android: use SecureSheet.');
    }
  }, [active, inModal]);
  useEffect(() => {
    if (!active || Platform.OS === 'web') return;
    ScreenCapture.preventScreenCaptureAsync(key).catch((e: unknown) => {
      console.warn('Could not block screenshots on a screen with a secret:', e);
    });
    return () => {
      ScreenCapture.allowScreenCaptureAsync(key).catch((e: unknown) => {
        console.warn('Could not allow screenshots again after a screen with a secret:', e);
      });
    };
  }, [active, key]);
}

/** What a flow shows at one step: a single sheet whose content changes as the flow moves on. */
export interface FlowView {
  title: string;
  subtitle?: string;
  body: ReactNode;
  /** Pinned under the scrolling body: the step's actions. */
  footer?: ReactNode;
  onClose: () => void;
}

/**
 * The sheet a flow is drawn in. `secure` for any flow that shows or takes a secret (the recovery
 * phrase): it is then drawn in the app's window with capture blocked (SecureSheet).
 */
export function FlowSheet({ view, maxWidth = 600, secure = false }: { view: FlowView; maxWidth?: number; secure?: boolean }) {
  const visible = useSurfaceVisible();
  const SheetKind = secure ? SecureSheet : Sheet;
  return (
    <SheetKind visible={visible} onClose={view.onClose} title={view.title} subtitle={view.subtitle} maxWidth={maxWidth} footer={view.footer}>
      {view.body}
    </SheetKind>
  );
}

/** Six digits in voxel cells, split 3 + 3, as both devices show them. */
export function CheckCode({ code, large }: { code: string; large?: boolean }) {
  const cw = useColorway();
  const { compact } = useScreen();
  const big = large && !compact;
  const cell = big ? { width: 64, height: 84, font: 44 } : { width: 44, height: 60, font: 30 };
  const digits = code.split('');
  const half = Math.ceil(digits.length / 2);
  const spoken = `Check code ${digits.slice(0, half).join(' ')}, ${digits.slice(half).join(' ')}`;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={spoken}
      style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: big ? 8 : 6, paddingVertical: 8 }}
    >
      {digits.map((d, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: big ? 8 : 6 }}>
          {i === half ? <View style={{ width: big ? 16 : 12 }} /> : null}
          <View style={{ width: cell.width, height: cell.height, alignItems: 'center', justifyContent: 'center', paddingBottom: VOXEL }}>
            <RaisedFace tone={cw.float} depth={VOXEL} shadow={cw.shadow} />
            <Text style={{ fontFamily: fonts.plex.semibold, fontSize: cell.font, lineHeight: cell.font * 1.2, color: cw.text }}>{d}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/** A tinted box with an icon: warnings and notes the user should not miss. */
export function Notice({ tone = 'warn', icon, children }: { tone?: 'warn' | 'danger' | 'ok' | 'info'; icon?: GlyphName; children: ReactNode }) {
  const cw = useColorway();
  const color = { warn: cw.run, danger: cw.dangerText, ok: cw.ok, info: cw.textDim }[tone];
  const glyph = icon ?? (tone === 'ok' ? 'check' : tone === 'info' ? 'circle-info' : 'square-alert');
  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : undefined}
      style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14 }}
    >
      <Shape steps={1} color={cw.dark ? hexAlpha(color, 0.12) : hexAlpha(color, 0.16)} />
      <Glyph name={glyph} size={24} color={color} />
      <View style={{ flex: 1, gap: 4, paddingTop: 1 }}>{isPlainText(children) ? <Text variant="label">{children}</Text> : children}</View>
    </View>
  );
}

/** Strings and numbers (also several, as `{name} isn't…` makes) are set as one label. */
function isPlainText(children: ReactNode): boolean {
  return Children.toArray(children).every((c) => typeof c === 'string' || typeof c === 'number');
}

/** "#FFC857" + 0.12 -> "#FFC8571F". Colourway colours are 6-digit hex. */
function hexAlpha(hex: string, alpha: number): string {
  return `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

/** The 12 words in two columns, numbered down the left column first, as written on paper. */
export function PhraseWords({ words }: { words: string[] }) {
  const cw = useColorway();
  const half = Math.ceil(words.length / 2);
  const columns = [words.slice(0, half), words.slice(half)];
  return (
    <Well steps={2} style={{ flexDirection: 'row', gap: 12, padding: 16, paddingTop: 16 + VOXEL }}>
      {columns.map((column, c) => (
        <View key={c} style={{ flex: 1, gap: 10 }} accessibilityRole="list">
          {column.map((word, i) => {
            const n = c * half + i + 1;
            return (
              <View
                key={n}
                accessible
                accessibilityLabel={`Word ${n}: ${word}`}
                style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 10 }}
              >
                <Shape steps={1} color={cw.control.top} />
                <Text variant="caption" tone="faint" weight="medium" style={{ width: 20, textAlign: 'right' }}>
                  {n}
                </Text>
                <Text weight="semibold" selectable={false} style={{ fontSize: 16 }}>
                  {word}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </Well>
  );
}

/** The voxel ring shows focus, so the browser's own outline is turned off (a web-only style). */
const WEB_NO_OUTLINE = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;

/** A numbered sunken input for one phrase word, outlined when the word is wrong or unknown. */
export function WordField({ number, flagged, ref, ...input }: TextInputProps & { number: number; flagged: boolean; ref?: Ref<TextInputInstance> }) {
  const cw = useColorway();
  const { compact } = useScreen();
  const [focused, setFocused] = useState(false);
  const ring = flagged ? cw.danger : focused ? cw.focus : null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: compact ? 48 : 52, paddingTop: VOXEL }}>
      <SunkenFace color={cw.field} lip={cw.lip} />
      {ring ? <Bands bands={outlineBands(1, VOXEL)} color={ring} /> : null}
      <Text variant="caption" tone="faint" weight="medium" style={{ width: 34, textAlign: 'right' }}>
        {number}
      </Text>
      <TextInput
        ref={ref}
        placeholderTextColor={cw.textFaint}
        selectionColor={cw.focus}
        accessibilityLabel={`Word ${number}`}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        importantForAutofill="no"
        // Gboard still suggests (and learns) words unless the field is a password-type field.
        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
        {...input}
        onFocus={(e) => {
          setFocused(true);
          input.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          input.onBlur?.(e);
        }}
        style={[
          WEB_NO_OUTLINE,
          {
            // Positioned so it paints above the absolutely placed field faces on the web.
            position: 'relative',
            flex: 1,
            minWidth: 0,
            alignSelf: 'stretch',
            color: flagged ? cw.dangerText : cw.text,
            paddingLeft: 10,
            paddingRight: 12,
            paddingBottom: VOXEL,
            fontFamily: fonts.plex.semibold,
            fontSize: compact ? 15 : 16,
          },
        ]}
      />
    </View>
  );
}

/** Words from the list that match what is being typed; tapping one fills the field. */
export function Suggestions({ words, onPick }: { words: string[]; onPick: (word: string) => void }) {
  if (words.length === 0) return null;
  return (
    <View accessibilityLabel="Suggested words" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {words.map((w) => (
        <GhostButton
          key={w}
          small
          label={w}
          onPress={() => {
            haptics.tick();
            onPick(w);
          }}
        />
      ))}
    </View>
  );
}
