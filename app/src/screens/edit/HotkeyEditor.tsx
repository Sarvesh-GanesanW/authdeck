/** Editor for "Press keys": modifier caps, the main key, and an optional app to bring forward first. */
import { useState } from 'react';
import { View } from 'react-native';

import { formatHotkey, keyLabel, modifierGlyph, modifierName } from '../../lib/describe';
import { haptics } from '../../lib/haptics';
import { type HotkeyAction, type Modifier, NAMED_KEYS, type Platform, PRINTABLE_PUNCTUATION } from '../../protocol';
import { PressBlock, Switch } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { VOXEL } from '../../ui/voxel';
import { AppChoice } from './AppPicker';
import { Section, SettingRow, useEnv } from './parts';

/** Front face of a mini key; the top travels this far when pressed. */
const MINI_DEPTH = 2 * VOXEL;
const MINI_STEPS = 2;

/**
 * Modifiers shown per platform. On macOS meta is the same key as mod (⌘);
 * on Windows and Linux ctrl is the same key as mod (Ctrl). Each pair shows as one toggle.
 */
const SHOWN_MODIFIERS: Record<Platform, Modifier[]> = {
  macos: ['mod', 'ctrl', 'alt', 'shift'],
  windows: ['mod', 'alt', 'shift', 'meta'],
  linux: ['mod', 'alt', 'shift', 'meta'],
};
const ALIAS_OF_MOD: Record<Platform, Modifier> = { macos: 'meta', windows: 'ctrl', linux: 'ctrl' };

function sameKeys(m: Modifier, platform: Platform): Modifier[] {
  return m === 'mod' ? ['mod', ALIAS_OF_MOD[platform]] : [m];
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '1234567890'.split('');
const FUNCTION_KEYS = NAMED_KEYS.filter((k) => /^f\d+$/.test(k));
const SPECIAL_KEYS = NAMED_KEYS.filter((k) => !/^f\d+$/.test(k));

const SPOKEN_KEYS: Record<string, string> = {
  '`': 'backtick',
  '-': 'minus',
  '=': 'equals',
  '[': 'left bracket',
  ']': 'right bracket',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'quote',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  pageup: 'page up',
  pagedown: 'page down',
};

function spokenKey(key: string): string {
  return SPOKEN_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** A small keycap toggle in the deck's own style. */
function MiniCap({
  top,
  bottom,
  on,
  width,
  height,
  onPress,
  accessibilityLabel,
  role = 'switch',
}: {
  top: string;
  bottom?: string;
  on: boolean;
  width: number;
  height: number;
  onPress: () => void;
  accessibilityLabel: string;
  role?: 'switch' | 'button' | 'radio';
}) {
  const cw = useColorway();
  const tone = on ? cw.caps.a : cw.caps.mod;
  const checked = role === 'switch' ? { checked: on } : role === 'radio' ? { selected: on } : undefined;
  return (
    <PressBlock
      tone={tone}
      steps={MINI_STEPS}
      depth={MINI_DEPTH}
      onPress={onPress}
      accessibilityRole={role}
      accessibilityState={checked}
      accessibilityLabel={accessibilityLabel}
      style={{ width, height }}
      contentStyle={{ alignItems: 'center', justifyContent: 'center', gap: 1, paddingHorizontal: 4, paddingBottom: VOXEL }}
    >
      <Text variant="mono" weight="semibold" color={tone.legend} numberOfLines={1} style={{ fontSize: bottom ? 20 : 18 }}>
        {top}
      </Text>
      {bottom ? (
        <Text variant="mono" color={tone.legend} numberOfLines={1} style={{ fontSize: 11 }}>
          {bottom}
        </Text>
      ) : null}
    </PressBlock>
  );
}

export function HotkeyEditor({ action, onChange }: { action: HotkeyAction; onChange: (a: HotkeyAction) => void }) {
  const { platform } = useEnv();
  const cw = useColorway();
  const { compact } = useScreen();
  const [picking, setPicking] = useState(false);
  const [wantsFocusApp, setWantsFocusApp] = useState(false);
  const capW = compact ? 62 : 70;
  const capH = compact ? 68 : 76;

  const isOn = (m: Modifier) => sameKeys(m, platform).some((x) => action.modifiers.includes(x));
  const toggle = (m: Modifier) => {
    const keys = sameKeys(m, platform);
    const modifiers = isOn(m) ? action.modifiers.filter((x) => !keys.includes(x)) : [...action.modifiers, m];
    onChange({ ...action, modifiers });
  };

  const focusOn = wantsFocusApp || !!action.focusAppId;
  const shortcut = action.key ? formatHotkey(action, platform) : null;

  return (
    <View style={{ gap: 18 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        {SHOWN_MODIFIERS[platform].map((m) => (
          <MiniCap
            key={m}
            top={platform === 'macos' ? modifierGlyph(m, platform) : modifierName(m, platform)}
            bottom={platform === 'macos' ? modifierName(m, platform) : undefined}
            on={isOn(m)}
            width={platform === 'macos' ? capW : capW + 12}
            height={capH}
            onPress={() => toggle(m)}
            accessibilityLabel={modifierName(m, platform)}
          />
        ))}
        <Glyph name="plus" size={24} color={cw.textFaint} />
        <MiniCap
          top={action.key ? keyLabel(action.key, platform) : 'Key'}
          bottom={action.key ? undefined : 'Choose'}
          on={false}
          width={capW + 14}
          height={capH}
          role="button"
          onPress={() => setPicking(true)}
          accessibilityLabel={action.key ? `Key: ${spokenKey(action.key)}. Change key` : 'Choose the key to press'}
        />
      </View>
      <Text tone="dim" accessibilityLiveRegion="polite">
        {shortcut ? (
          <>
            Presses <Text variant="mono" weight="semibold">{shortcut}</Text> on {platformLabel(platform)}
          </>
        ) : (
          'Choose the key to press. Modifiers are optional.'
        )}
      </Text>
      <Section gap={10}>
        <SettingRow title="Bring an app to the front first" detail="So the shortcut goes to that app, not whatever is in front.">
          <Switch
            value={focusOn}
            label="Bring an app to the front first"
            onChange={(v) => {
              setWantsFocusApp(v);
              if (!v) onChange({ ...action, focusAppId: undefined });
            }}
          />
        </SettingRow>
        {focusOn ? (
          <AppChoice
            appId={action.focusAppId}
            emptyText="No app chosen yet"
            pickerTitle="Bring which app to the front?"
            onPick={(app) => onChange({ ...action, focusAppId: app.id })}
          />
        ) : null}
      </Section>
      <KeyPickerSheet
        visible={picking}
        platform={platform}
        selected={action.key}
        onClose={() => setPicking(false)}
        onPick={(key) => onChange({ ...action, key })}
      />
    </View>
  );
}

function platformLabel(p: Platform): string {
  return p === 'macos' ? 'the Mac' : p === 'windows' ? 'the Windows PC' : 'the Linux computer';
}

function KeyPickerSheet({
  visible,
  platform,
  selected,
  onClose,
  onPick,
}: {
  visible: boolean;
  platform: Platform;
  selected: string;
  onClose: () => void;
  onPick: (key: string) => void;
}) {
  const { compact } = useScreen();
  const size = compact ? 50 : 58;
  const group = (title: string, keys: readonly string[], wide = false) => (
    <Section label={title} gap={10}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup" accessibilityLabel={title}>
        {keys.map((k) => (
          <MiniCap
            key={k}
            top={keyLabel(k, platform)}
            on={k === selected}
            width={wide ? size + 30 : size}
            height={size + 4}
            role="radio"
            accessibilityLabel={spokenKey(k)}
            onPress={() => {
              haptics.tick();
              onPick(k);
              onClose();
            }}
          />
        ))}
      </View>
    </Section>
  );
  return (
    <Sheet visible={visible} onClose={onClose} title="Choose a key" subtitle="The key pressed together with the modifiers." maxWidth={820}>
      {group('Letters', LETTERS)}
      {group('Numbers', DIGITS)}
      {group('Symbols', PRINTABLE_PUNCTUATION)}
      {group('Special keys', SPECIAL_KEYS, true)}
      {group('Function keys', FUNCTION_KEYS, true)}
      {platform !== 'macos' ? (
        <Text variant="caption" tone="faint">
          On Windows, and on Linux setups that use ydotool, symbol keys are pressed where they sit on a US keyboard. On other layouts the
          shortcut may land on a different character.
        </Text>
      ) : null}
    </Sheet>
  );
}
