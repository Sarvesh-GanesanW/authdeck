/** Full output of a background command, opened from the result banner. */
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { formatDuration } from '../../lib/describe';
import { type CommandOutput, useLive } from '../../state/live';
import { GhostButton } from '../../ui/controls';
import { Well } from '../../ui/Panel';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';

/** The agent sends at most this much of a command's output (see RunResult.output). */
const OUTPUT_TAIL_CHARS = 8000;

export function OutputSheet() {
  const cw = useColorway();
  const output = useLive((s) => s.output);
  const showOutput = useLive((s) => s.showOutput);
  // Keep the last output on screen while the sheet animates closed.
  const [shown, setShown] = useState<CommandOutput | null>(output);
  useEffect(() => {
    if (output) setShown(output);
  }, [output]);

  const close = () => showOutput(null);
  const copy = async () => {
    if (!shown) return;
    await Clipboard.setStringAsync(shown.output);
    useLive.getState().showToast({ tone: 'ok', title: 'Output copied' });
  };

  const failed = shown ? shown.exitCode !== 0 : false;
  const subtitle = shown
    ? shown.exitCode === null
      ? `Stopped after ${formatDuration(shown.durationMs)}`
      : `Exit code ${shown.exitCode} after ${formatDuration(shown.durationMs)}`
    : undefined;

  return (
    <Sheet
      visible={!!output}
      onClose={close}
      title={shown?.title ?? 'Output'}
      subtitle={subtitle}
      tall
      noScroll
      maxWidth={860}
      footer={
        <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end' }}>
          <GhostButton label="Copy output" icon="copy" onPress={copy} disabled={!shown?.output} />
          <GhostButton label="Close" onPress={close} />
        </View>
      }
    >
      <View style={{ flex: 1, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 8, height: 8, backgroundColor: failed ? cw.danger : cw.ok }}>
            <View style={{ position: 'absolute', left: -4, top: -4, right: -4, bottom: -4, backgroundColor: failed ? cw.danger : cw.ok, opacity: 0.22 }} />
          </View>
          <Text variant="mono" tone="dim" numberOfLines={2} style={{ flex: 1 }} selectable>
            {shown?.command}
          </Text>
        </View>
        <Well color={cw.field} steps={2} style={{ flex: 1 }}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingTop: 20 }}>
            {shown?.output ? (
              <Text variant="mono" selectable>
                {shown.output}
              </Text>
            ) : (
              <Text tone="dim">The command printed nothing.</Text>
            )}
          </ScrollView>
        </Well>
        {shown && shown.output.length >= OUTPUT_TAIL_CHARS ? (
          <Text variant="caption" tone="faint">
            Showing the last 8,000 characters.
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}
