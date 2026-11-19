/** "Test on computer" button with the result shown in place, and an inline delete confirmation. */
import { type ComponentRef, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { formatDuration } from '../../lib/describe';
import { haptics } from '../../lib/haptics';
import { RequestError } from '../../net/client';
import { connection } from '../../net/connection';
import type { Action, RunResult } from '../../protocol';
import { GhostButton } from '../../ui/controls';
import { Well } from '../../ui/Panel';
import { useRevealInSheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { VOXEL } from '../../ui/voxel';
import { Notice, useEnv, useOnline } from './parts';

type Outcome =
  | { phase: 'idle' }
  | { phase: 'run' }
  | { phase: 'ok'; title: string; detail?: string; output?: string }
  | { phase: 'fail'; title: string; detail?: string; output?: string };

const OUTPUT_LINES = 12;

function describeResult(action: Action, res: RunResult): Outcome {
  const output = res.output ? res.output.split('\n').slice(-OUTPUT_LINES).join('\n').trimEnd() : undefined;
  if (res.exitCode !== undefined && res.exitCode !== 0) {
    return { phase: 'fail', title: `It failed with exit code ${res.exitCode}`, detail: 'The last lines of output are below.', output };
  }
  const isBackground = action.type === 'command' && action.mode === 'background';
  return {
    phase: 'ok',
    title: isBackground ? `It worked, in ${formatDuration(res.durationMs)}` : 'It worked',
    detail: res.note,
    output,
  };
}

export function TryIt({ action, problem }: { action: Action | null; problem: string | null }) {
  const { agentId, computerName, pageCwd } = useEnv();
  const online = useOnline(agentId);
  const [outcome, setOutcome] = useState<Outcome>({ phase: 'idle' });
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // A result describes the action as it was; drop it once the action changes.
  useEffect(() => {
    setOutcome((o) => (o.phase === 'run' ? o : { phase: 'idle' }));
  }, [action]);

  const run = async () => {
    if (!action) return;
    setOutcome({ phase: 'run' });
    try {
      const res = await connection.run(action, pageCwd);
      if (!alive.current) return;
      const next = describeResult(action, res);
      if (next.phase === 'ok') haptics.success();
      else haptics.error();
      setOutcome(next);
    } catch (e) {
      if (!alive.current) return;
      haptics.error();
      const err = e instanceof RequestError ? e : null;
      setOutcome({
        phase: 'fail',
        title: err?.message ?? (e instanceof Error ? e.message : 'It did not run.'),
        detail: err?.hint,
      });
    }
  };

  const blocked = !action
    ? 'Choose what the key does first.'
    : problem
      ? 'Finish setting up the key to test it.'
      : !online
        ? `${computerName} is offline. Testing works again once it reconnects.`
        : null;

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row' }}>
        <GhostButton
          label={outcome.phase === 'run' ? 'Running…' : 'Test on computer'}
          icon="play"
          onPress={run}
          disabled={!!blocked || outcome.phase === 'run'}
        />
      </View>
      {blocked && outcome.phase !== 'run' ? (
        <Text variant="label" tone="faint">
          {blocked}
        </Text>
      ) : null}
      {outcome.phase === 'ok' || outcome.phase === 'fail' ? (
        <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} style={{ gap: 10 }}>
          <Notice tone={outcome.phase} title={outcome.title} detail={outcome.detail} />
          {outcome.output ? (
            <Well style={{ maxHeight: 200, paddingTop: VOXEL }}>
              <ScrollView contentContainerStyle={{ padding: 12 }} nestedScrollEnabled accessibilityLabel="Command output">
                <Text variant="mono" tone="dim" selectable>
                  {outcome.output}
                </Text>
              </ScrollView>
            </Well>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** A destructive button that asks once, in place, before acting. Works the same on web. */
export function ConfirmDelete({
  label,
  question,
  detail,
  confirmLabel,
  onConfirm,
  disabled,
}: {
  label: string;
  question: string;
  detail?: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  // The question opens under the button, often below the fold of the sheet: bring it into view.
  const reveal = useRevealInSheet();
  const questionRef = useRef<ComponentRef<typeof View>>(null);
  if (!asking) {
    return (
      <View style={{ flexDirection: 'row' }}>
        <GhostButton
          label={label}
          icon="trash"
          danger
          disabled={disabled}
          onPress={() => {
            haptics.warning();
            setAsking(true);
          }}
        />
      </View>
    );
  }
  return (
    <Animated.View
      ref={questionRef}
      entering={FadeIn.duration(180)}
      style={{ gap: 12 }}
      accessibilityLiveRegion="polite"
      onLayout={() => reveal(questionRef.current)}
    >
      <View style={{ gap: 4 }}>
        <Text weight="semibold">{question}</Text>
        {detail ? (
          <Text variant="label" tone="dim">
            {detail}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <GhostButton label="Cancel" onPress={() => setAsking(false)} />
        <GhostButton
          label={confirmLabel}
          icon="trash"
          danger
          onPress={() => {
            haptics.success();
            onConfirm();
          }}
        />
      </View>
    </Animated.View>
  );
}
