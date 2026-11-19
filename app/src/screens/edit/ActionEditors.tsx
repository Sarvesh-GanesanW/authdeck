/** One editor per action type. Each takes the action and reports a whole new action on every change. */
import { useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { haptics } from '../../lib/haptics';
import type {
  AppEntry,
  CommandAction,
  LaunchAction,
  MacroAction,
  MacroStep,
  OpenAction,
  StepAction,
  TextAction,
  UrlAction,
} from '../../protocol';
import { newId } from '../../state/model';
import { springs } from '../../theme/motion';
import { Choice, Field, GhostButton, IconButton, LinkButton, Switch } from '../../ui/controls';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import {
  DEFAULT_STEP_DELAY_MS,
  DEFAULT_TIMEOUT_SEC,
  MAX_STEP_DELAY_MS,
  MAX_TIMEOUT_SEC,
  STEP_KINDS,
  type StepKind,
  defaultStepAction,
  newStep,
  parseWhole,
  urlWithScheme,
} from './actionModel';
import { AppChoice } from './AppPicker';
import { PathField } from './FolderPicker';
import { HotkeyEditor } from './HotkeyEditor';
import { SettingRow, useEnv, Well } from './parts';

const listMotion = LinearTransition.springify(springs.snappy.duration).dampingRatio(springs.snappy.dampingRatio);

/** Editor for any single-step action. `onPickLaunchApp` lets the key editor also update label and icon. */
export function StepEditor({
  action,
  onChange,
  onPickLaunchApp,
}: {
  action: StepAction;
  onChange: (a: StepAction) => void;
  onPickLaunchApp?: (app: AppEntry) => void;
}) {
  switch (action.type) {
    case 'launch':
      return <LaunchEditor action={action} onChange={onChange} onPickApp={onPickLaunchApp} />;
    case 'hotkey':
      return <HotkeyEditor action={action} onChange={onChange} />;
    case 'text':
      return <TextEditor action={action} onChange={onChange} />;
    case 'command':
      return <CommandEditor action={action} onChange={onChange} />;
    case 'url':
      return <UrlEditor action={action} onChange={onChange} />;
    case 'open':
      return <OpenEditor action={action} onChange={onChange} />;
  }
}

function LaunchEditor({
  action,
  onChange,
  onPickApp,
}: {
  action: LaunchAction;
  onChange: (a: LaunchAction) => void;
  onPickApp?: (app: AppEntry) => void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <AppChoice
        appId={action.appId || undefined}
        appName={action.appName}
        emptyText="No app chosen yet"
        pickerTitle="Open which app?"
        onPick={(app) => (onPickApp ? onPickApp(app) : onChange({ type: 'launch', appId: app.id, appName: app.name }))}
      />
      <Text variant="label" tone="faint">
        If the app is already open, it comes to the front.
      </Text>
    </View>
  );
}

function TextEditor({ action, onChange }: { action: TextAction; onChange: (a: TextAction) => void }) {
  return (
    <View style={{ gap: 16 }}>
      <Field
        label="Text to type"
        value={action.text}
        onChangeText={(text) => onChange({ ...action, text })}
        placeholder="git commit -m"
        multiline
        autoCapitalize="none"
        textAlignVertical="top"
        style={{ minHeight: 110 }}
      />
      <SettingRow title="Press Enter after" detail="Leave the text empty to make a key that only presses Enter.">
        <Switch value={!!action.pressEnter} label="Press Enter after" onChange={(pressEnter) => onChange({ ...action, pressEnter })} />
      </SettingRow>
    </View>
  );
}

/** A whole-number field that keeps what the user typed and reports only valid values. */
function NumberField({
  label,
  value,
  placeholder,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number | undefined;
  placeholder?: string;
  min: number;
  max: number;
  unit: string;
  onChange: (n: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const invalid = text.trim() !== '' && parseWhole(text, min, max) === null;
  return (
    <View style={{ gap: 6 }}>
      <Field
        label={`${label} (${unit})`}
        value={text}
        placeholder={placeholder}
        keyboardType="number-pad"
        inputMode="numeric"
        onChangeText={(t) => {
          setText(t);
          if (t.trim() === '') onChange(undefined);
          else {
            const n = parseWhole(t, min, max);
            if (n !== null) onChange(n);
          }
        }}
      />
      {invalid ? (
        <Text variant="label" tone="danger">
          Use a whole number from {min} to {max}.
        </Text>
      ) : null}
    </View>
  );
}

function CommandEditor({ action, onChange }: { action: CommandAction; onChange: (a: CommandAction) => void }) {
  const { pageCwd } = useEnv();
  const background = action.mode === 'background';
  return (
    <View style={{ gap: 16 }}>
      <Field
        label="Command"
        value={action.command}
        onChangeText={(command) => onChange({ ...action, command })}
        placeholder="npm test"
        autoCapitalize="none"
      />
      <View style={{ gap: 8 }}>
        <Choice
          label="Where it runs"
          value={action.mode}
          onChange={(mode) => onChange({ ...action, mode, timeoutSec: mode === 'background' ? action.timeoutSec : undefined })}
          options={[
            { value: 'terminal', label: 'In a terminal', icon: 'terminal' },
            { value: 'background', label: 'In the background', icon: 'hourglass' },
          ]}
        />
        <Text variant="label" tone="faint">
          {background
            ? 'Runs hidden. AuthDeck waits for it and shows the exit code and output.'
            : 'Opens a new terminal window on the computer and runs it there. The window stays open.'}
        </Text>
      </View>
      <View style={{ gap: 6 }}>
        <PathField
          label="Working folder"
          value={action.cwd ?? ''}
          placeholder={pageCwd ? `Page's folder: ${pageCwd}` : 'Home folder'}
          pickerTitle="Run the command in"
          onChange={(cwd) => onChange({ ...action, cwd: cwd.trim() ? cwd : undefined })}
        />
        <Text variant="label" tone="faint">
          {pageCwd
            ? "Leave it empty to use the page's folder."
            : "Leave it empty to use your home folder, or set a project folder in the page's settings."}
        </Text>
      </View>
      {background ? (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
          <NumberField
            label="Stop it after"
            unit="seconds"
            value={action.timeoutSec}
            placeholder={String(DEFAULT_TIMEOUT_SEC)}
            min={1}
            max={MAX_TIMEOUT_SEC}
            onChange={(timeoutSec) => onChange({ ...action, timeoutSec })}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

function UrlEditor({ action, onChange }: { action: UrlAction; onChange: (a: UrlAction) => void }) {
  const fixed = urlWithScheme(action.url);
  return (
    <View style={{ gap: 10 }}>
      <Field
        label="Address"
        value={action.url}
        onChangeText={(url) => onChange({ ...action, url })}
        placeholder="https://github.com"
        keyboardType="url"
        inputMode="url"
        autoCapitalize="none"
        onBlur={() => {
          const trimmed = action.url.trim();
          if (trimmed !== action.url) onChange({ ...action, url: trimmed });
        }}
      />
      {fixed ? <LinkButton label={`Use ${fixed}`} onPress={() => onChange({ ...action, url: fixed })} /> : null}
      <Text variant="label" tone="faint">
        Opens in the computer's default browser, or the app that handles the link.
      </Text>
    </View>
  );
}

function OpenEditor({ action, onChange }: { action: OpenAction; onChange: (a: OpenAction) => void }) {
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 6 }}>
        <PathField
          label="File or folder"
          value={action.path}
          placeholder="~/code/project"
          includeFiles
          onChange={(path) => onChange({ ...action, path })}
        />
        <Text variant="label" tone="faint">
          A relative path, like ., starts from the page's folder.
        </Text>
      </View>
      <View style={{ gap: 6 }}>
        <Text variant="label" tone="dim">
          Open with
        </Text>
        <AppChoice
          appId={action.withAppId}
          emptyText="The default app"
          pickerTitle="Open it with"
          onPick={(app) => onChange({ ...action, withAppId: app.id })}
          onClear={() => onChange({ ...action, withAppId: undefined })}
        />
      </View>
    </View>
  );
}

/** Stable ids for macro steps, kept in step with the list so reordering animates the right rows. */
function useStepIds(count: number) {
  const ids = useRef<string[]>([]);
  if (ids.current.length !== count) ids.current = Array.from({ length: count }, (_, i) => ids.current[i] ?? newId('s'));
  return ids;
}

export function MacroEditor({ action, onChange }: { action: MacroAction; onChange: (a: MacroAction) => void }) {
  const ids = useStepIds(action.steps.length);

  const setSteps = (steps: MacroStep[], nextIds: string[]) => {
    ids.current = nextIds;
    onChange({ ...action, steps });
  };
  const update = (i: number, step: MacroStep) =>
    setSteps(
      action.steps.map((s, j) => (j === i ? step : s)),
      ids.current,
    );
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    const steps = [...action.steps];
    const order = [...ids.current];
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    [order[i], order[j]] = [order[j]!, order[i]!];
    haptics.tick();
    setSteps(steps, order);
  };
  const remove = (i: number) => {
    haptics.tick();
    setSteps(
      action.steps.filter((_, j) => j !== i),
      ids.current.filter((_, j) => j !== i),
    );
  };
  const add = () => {
    haptics.tick();
    setSteps([...action.steps, newStep()], [...ids.current, newId('s')]);
  };

  return (
    <View style={{ gap: 12 }}>
      <Text variant="label" tone="faint">
        Steps run from top to bottom, with the wait you set between them.
      </Text>
      {action.steps.map((step, i) => (
        <Animated.View key={ids.current[i]} layout={listMotion} entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
          <StepCard
            index={i}
            count={action.steps.length}
            step={step}
            onChange={(s) => update(i, s)}
            onMove={(by) => move(i, by)}
            onRemove={() => remove(i)}
          />
        </Animated.View>
      ))}
      <Animated.View layout={listMotion}>
        <GhostButton label="Add a step" icon="plus" onPress={add} />
      </Animated.View>
    </View>
  );
}

function StepCard({
  index,
  count,
  step,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  step: MacroStep;
  onChange: (s: MacroStep) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const cw = useColorway();
  const n = index + 1;
  return (
    <Well raised accessibilityLabel={`Step ${n} of ${count}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text weight="semibold" style={{ flex: 1 }}>
          Step {n}
        </Text>
        <IconButton icon="chevron-up" label={`Move step ${n} up`} disabled={index === 0} onPress={() => onMove(-1)} />
        <IconButton icon="chevron-down" label={`Move step ${n} down`} disabled={index === count - 1} onPress={() => onMove(1)} />
        <IconButton icon="trash" label={`Delete step ${n}`} disabled={count <= 1} tint={cw.dangerText} onPress={onRemove} />
      </View>
      <Choice<StepKind>
        label={`What step ${n} does`}
        value={step.action.type}
        onChange={(kind) => kind !== step.action.type && onChange({ ...step, action: defaultStepAction(kind) })}
        options={STEP_KINDS}
      />
      <StepEditor action={step.action} onChange={(action) => onChange({ ...step, action })} />
      {index < count - 1 ? <DelayField value={step.delayMs} onChange={(delayMs) => onChange({ ...step, delayMs })} /> : null}
    </Well>
  );
}

function DelayField({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  return (
    <NumberField
      label="Then wait before the next step"
      unit="ms"
      value={value}
      placeholder={String(DEFAULT_STEP_DELAY_MS)}
      min={0}
      max={MAX_STEP_DELAY_MS}
      onChange={(ms) => onChange(ms ?? DEFAULT_STEP_DELAY_MS)}
    />
  );
}
