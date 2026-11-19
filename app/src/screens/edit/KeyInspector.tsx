/**
 * Key editor. Every change goes straight to the store (no Save button, as on iOS).
 * A key that was never set up is removed when its editor goes away.
 * Wide screens show it as a side pane next to the keys; compact screens as a sheet.
 */
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeInRight } from 'react-native-reanimated';

import { sublegend } from '../../lib/describe';
import type { Action, AppEntry } from '../../protocol';
import type { DeckKey, KeyIcon, Page } from '../../state/model';
import { entryFor, useStore } from '../../state/store';
import { springs } from '../../theme/motion';
import { CapSwatches, Choice, Field, GhostButton, IconButton } from '../../ui/controls';
import { type GlyphName, resolveGlyph } from '../../ui/Icon';
import { Keycap } from '../../ui/Keycap';
import { PANEL_FRONT, PanelFace } from '../../ui/Panel';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { MacroEditor, StepEditor } from './ActionEditors';
import { useVault } from '../../auth/useVault';
import { otpFaces } from '../deck/OtpFace';
import {
  type ActionKind,
  KEY_KINDS,
  type KeyKind,
  actionProblem,
  defaultAction,
  iconAppOf,
  isBlankKey,
  keyKind,
  withLaunchApp,
  withOtpAccount,
} from './actionModel';
import { OtpEditor } from './OtpEditor';
import { GlyphPickerSheet } from './GlyphPicker';
import { EnvProvider, Notice, Section, useEditorEnv, useEnv, Well } from './parts';
import { ConfirmDelete, TryIt } from './TryIt';

interface KeyInspectorProps {
  agentId: string;
  pageId: string;
  index: number;
  onClose: () => void;
}

const PANE_MIN_W = 420;
const PANE_MAX_W = 500;
const LABEL_MAX = 40;

export function KeyInspectorPane(props: KeyInspectorProps) {
  const { width } = useScreen();
  const paneW = Math.max(PANE_MIN_W, Math.min(PANE_MAX_W, width * 0.32));
  return (
    <Animated.View
      entering={FadeInRight.springify(springs.smooth.duration).dampingRatio(springs.smooth.dampingRatio)}
      accessibilityLabel="Key settings"
      style={{ width: paneW, alignSelf: 'stretch', flexShrink: 0, paddingBottom: PANEL_FRONT }}
    >
      <PanelFace />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 28, paddingTop: 22, paddingBottom: 6 }}>
        <Text variant="heading" accessibilityRole="header" style={{ flex: 1 }}>
          Edit key
        </Text>
        <IconButton icon="close" label="Done editing this key" onPress={props.onClose} />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 28, paddingTop: 12 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <KeyEditor key={`${props.pageId}:${props.index}`} {...props} />
      </ScrollView>
    </Animated.View>
  );
}

export function KeyInspectorSheet(props: KeyInspectorProps & { visible: boolean }) {
  const { visible, ...rest } = props;
  return (
    <Sheet visible={visible} onClose={props.onClose} title="Edit key" maxWidth={640}>
      <KeyEditor key={`${props.pageId}:${props.index}`} {...rest} />
    </Sheet>
  );
}

/** How many editors have each key open; StrictMode and quick re-opens mount twice. */
const openEditors = new Map<string, number>();

function discardIfBlank(agentId: string, pageId: string, keyId: string): void {
  const state = useStore.getState();
  const page = entryFor(state.decks, agentId)?.pages.find((p) => p.id === pageId);
  const index = page?.slots.findIndex((k) => k?.id === keyId) ?? -1;
  const key = page?.slots[index];
  if (key && isBlankKey(key)) state.setKey(agentId, pageId, index, null);
}

/** Removes the key when the last editor showing it goes away, if it is still blank. */
function useDiscardBlankKeyOnLeave(agentId: string, pageId: string, keyId: string | undefined): void {
  useEffect(() => {
    if (!keyId) return;
    const token = `${agentId}/${pageId}/${keyId}`;
    openEditors.set(token, (openEditors.get(token) ?? 0) + 1);
    return () => {
      openEditors.set(token, (openEditors.get(token) ?? 1) - 1);
      // Wait a tick so a remount of the same editor (StrictMode, pane re-render) keeps the key.
      setTimeout(() => {
        if ((openEditors.get(token) ?? 0) > 0) return;
        openEditors.delete(token);
        discardIfBlank(agentId, pageId, keyId);
      }, 0);
    };
  }, [agentId, pageId, keyId]);
}

function useSlot(agentId: string, pageId: string, index: number): { page: Page | null; key: DeckKey | null } {
  const page = useStore((s) => entryFor(s.decks, agentId)?.pages.find((p) => p.id === pageId) ?? null);
  return { page, key: page?.slots[index] ?? null };
}

function KeyEditor({ agentId, pageId, index, onClose }: KeyInspectorProps) {
  const { page, key: liveKey } = useSlot(agentId, pageId, index);
  // Keep showing the last state while a closing sheet animates away after a delete.
  const lastKey = useRef(liveKey);
  if (liveKey) lastKey.current = liveKey;
  const key = liveKey ?? lastKey.current;
  const env = useEditorEnv(agentId, page?.cwd);
  useDiscardBlankKeyOnLeave(agentId, pageId, key?.id);

  if (!env) return <Notice tone="warn" title="This computer is no longer paired" detail="Pair it again from Settings to edit its keys." />;
  if (!key) return <Notice title="There is no key here" detail="It may have been moved or deleted. Close this panel and pick a key." />;

  const keyId = key.id;
  /** Applies a change to the key as it is in the store now, wherever it has moved to. */
  const update = (fn: (k: DeckKey) => DeckKey) => {
    const s = useStore.getState();
    const slots = entryFor(s.decks, agentId)?.pages.find((p) => p.id === pageId)?.slots ?? [];
    const at = slots[index]?.id === keyId ? index : slots.findIndex((k) => k?.id === keyId);
    const current = slots[at];
    if (current) s.setKey(agentId, pageId, at, fn(current));
  };
  const remove = () => {
    const slots = entryFor(useStore.getState().decks, agentId)?.pages.find((p) => p.id === pageId)?.slots ?? [];
    const at = slots.findIndex((k) => k?.id === keyId);
    if (at >= 0) useStore.getState().setKey(agentId, pageId, at, null);
    onClose();
  };

  return (
    <EnvProvider value={env}>
      <Animated.View entering={FadeIn.duration(160)} style={{ gap: 26 }}>
        <PreviewAndLabel keyData={key} onLabel={(label) => update((k) => ({ ...k, label }))} />
        <IconAndColour keyData={key} onIcon={(icon) => update((k) => ({ ...k, icon }))} onColour={(color) => update((k) => ({ ...k, color }))} />
        <WhenPressed keyData={key} onKey={update} onPickLaunchApp={(app) => update((k) => withLaunchApp(k, app))} />
        <View style={{ gap: 18 }}>
          {key.otp ? null : <TryIt action={key.action} problem={key.action ? actionProblem(key.action) : null} />}
          <ConfirmDelete
            label="Delete key"
            question="Delete this key?"
            detail="Its spot on the page becomes empty. This cannot be undone."
            confirmLabel="Delete key"
            onConfirm={remove}
          />
        </View>
      </Animated.View>
    </EnvProvider>
  );
}

function PreviewAndLabel({ keyData, onLabel }: { keyData: DeckKey; onLabel: (label: string) => void }) {
  const cw = useColorway();
  const { compact } = useScreen();
  const showSub = useStore((s) => s.settings.sublegends);
  const { platform } = useEnv();
  const sub = showSub ? sublegend(keyData.action, platform) : '';
  const capW = compact ? 108 : 128;
  const capH = capW * 1.09;
  return (
    <View style={{ flexDirection: 'row', gap: compact ? 16 : 22, alignItems: 'center' }}>
      <View accessible accessibilityLabel={`Preview: ${keyData.label || 'no label'}`}>
        <Keycap
          width={capW}
          height={capH}
          tone={cw.caps[keyData.color]}
          label={keyData.label}
          sublegend={sub || undefined}
          icon={keyData.icon}
          {...(keyData.otp ? otpFaces(keyData, cw.caps[keyData.color], capW, capH, true) : null)}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Field
          label="Label"
          value={keyData.label}
          onChangeText={onLabel}
          placeholder="Name this key"
          maxLength={LABEL_MAX}
          returnKeyType="done"
        />
      </View>
    </View>
  );
}

type IconMode = KeyIcon['kind'];

function IconAndColour({
  keyData,
  onIcon,
  onColour,
}: {
  keyData: DeckKey;
  onIcon: (icon: KeyIcon) => void;
  onColour: (c: DeckKey['color']) => void;
}) {
  const [picking, setPicking] = useState(false);
  const iconApp = iconAppOf(keyData.action);
  const icon = keyData.icon;
  const appIconId = icon.kind === 'app' ? icon.appId : iconApp;

  const symbol = icon.kind === 'glyph' ? resolveGlyph(icon.name) : null;
  const options: { value: IconMode; label: string; icon?: GlyphName }[] = [
    { value: 'glyph', label: 'Symbol', icon: symbol ?? 'shapes' },
    ...(appIconId ? [{ value: 'app' as const, label: "App's icon", icon: 'app-windows' as const }] : []),
    { value: 'none', label: 'None', icon: 'cancel' },
  ];

  const choose = (mode: IconMode) => {
    // Picking a symbol needs the grid; the choice changes once one is chosen.
    if (mode === 'glyph') setPicking(true);
    else if (mode === 'app' && appIconId) onIcon({ kind: 'app', appId: appIconId });
    else if (mode === 'none') onIcon({ kind: 'none' });
  };

  return (
    <View style={{ gap: 22 }}>
      <Section label="Icon">
        <Choice<IconMode> label="Icon" value={icon.kind} onChange={choose} options={options} />
        {symbol ? (
          <View style={{ flexDirection: 'row' }}>
            <GhostButton small label="Change symbol" icon={symbol} onPress={() => setPicking(true)} />
          </View>
        ) : null}
      </Section>
      <Section label="Colour">
        <CapSwatches value={keyData.color} onChange={onColour} />
      </Section>
      <GlyphPickerSheet
        visible={picking}
        onClose={() => setPicking(false)}
        selected={icon.kind === 'glyph' ? icon.name : undefined}
        onPick={(name) => onIcon({ kind: 'glyph', name })}
      />
    </View>
  );
}

function WhenPressed({
  keyData,
  onKey,
  onPickLaunchApp,
}: {
  keyData: DeckKey;
  onKey: (fn: (k: DeckKey) => DeckKey) => void;
  onPickLaunchApp: (app: AppEntry) => void;
}) {
  const { action } = keyData;
  const kind = keyKind(keyData);
  const accounts = useVault().accounts;
  // Remember what was typed for each kind, so switching back and forth loses nothing.
  const drafts = useRef<Partial<Record<ActionKind, Action>>>({});
  const onAction = (next: Action) => onKey((k) => ({ ...k, action: next }));
  const switchTo = (next: KeyKind) => {
    if (kind === next) return;
    if (action) drafts.current[action.type] = action;
    if (next === 'otp') {
      onKey((k) => ({ ...k, action: null, otp: { accountId: '' } }));
      return;
    }
    const restored = drafts.current[next] ?? defaultAction(next);
    onKey(({ otp: _otp, ...k }) => ({ ...k, action: restored }));
  };
  const problem = action ? actionProblem(action) : null;
  return (
    <Section label="When pressed" gap={14}>
      <Choice<KeyKind | ''> label="When pressed" value={kind ?? ''} onChange={(k) => k && switchTo(k)} options={KEY_KINDS} />
      {keyData.otp ? (
        <Animated.View key="otp" entering={FadeIn.duration(180)}>
          <Well>
            <OtpEditor
              accountId={keyData.otp.accountId}
              onPick={(account) => {
                const previous = accounts.find((a) => a.id === keyData.otp?.accountId);
                onKey((k) => withOtpAccount(k, account, previous));
              }}
            />
          </Well>
        </Animated.View>
      ) : action ? (
        <Animated.View key={action.type} entering={FadeIn.duration(180)}>
          <Well>
            {action.type === 'macro' ? (
              <MacroEditor action={action} onChange={onAction} />
            ) : (
              <StepEditor action={action} onChange={onAction} onPickLaunchApp={onPickLaunchApp} />
            )}
          </Well>
        </Animated.View>
      ) : (
        <Text tone="dim">Choose what happens on the computer when you tap this key.</Text>
      )}
      {problem ? <Notice title="Not finished yet" detail={problem} /> : null}
    </Section>
  );
}
