/**
 * The new device's side of joining a vault: name it, ask, wait for a trusted device to answer,
 * then compare the six-digit code shown on both before the trusted one approves.
 */
import * as Device from 'expo-device';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import type { JoinState, SurfaceProps } from '../../auth/contract';
import { useAuthUi } from '../../auth/ui';
import { useVault } from '../../auth/useVault';
import { haptics } from '../../lib/haptics';
import { Field, GhostButton, PrimaryButton } from '../../ui/controls';
import { Text } from '../../ui/Text';
import { CheckCode, FlowSheet, type FlowView, formatClock, Notice, plainError, useSecondsLeft } from './parts';

const MAX_NAME_LENGTH = 40;
const FACT_LABEL_WIDTH = 104;

function defaultDeviceName(): string {
  if (Platform.OS === 'web') return 'This browser';
  return Device.deviceName ?? Device.modelName ?? '';
}

export function JoinFlow({ onClose }: SurfaceProps) {
  const vault = useVault();
  const open = useAuthUi((s) => s.open);
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = vault.join?.role === 'new' ? vault.join : null;
  const secondsLeft = useSecondsLeft(join?.expiresAt ?? null);

  const close = () => {
    if (join && join.stage !== 'done') vault.cancelJoin();
    onClose();
  };

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      await vault.requestJoin(name.trim());
    } catch (e) {
      haptics.error();
      setError(plainError(e, "The request couldn't be sent. Check that the computer is online, then try again."));
    } finally {
      setBusy(false);
    }
  };

  const tryAgain = () => {
    vault.cancelJoin();
    void ask();
  };

  const view: FlowView = join
    ? joinView(join, { secondsLeft, close, tryAgain, openVault: () => open('vault') })
    : {
        title: 'Join a vault',
        onClose: close,
        footer: <PrimaryButton label="Ask to join" icon="smartphone" busy={busy} disabled={!name.trim() || !vault.computerOnline} onPress={() => void ask()} />,
        body: (
          <>
            <Text tone="dim">
              A phone or tablet that is already in your vault lets this one in, after you check that both show the same code. Both need to be connected to the
              same computer.
            </Text>
            <Field
              label="Name this device"
              value={name}
              onChangeText={setName}
              placeholder="Pixel 8"
              maxLength={MAX_NAME_LENGTH}
              returnKeyType="go"
              onSubmitEditing={() => void ask()}
            />
            <Text variant="caption" tone="faint">
              Your other devices list it under this name.
            </Text>
            {vault.computerOnline ? null : <Notice tone="warn">Your computer isn't connected. The request goes through it, so connect it first.</Notice>}
            {error ? <Notice tone="danger">{error}</Notice> : null}
          </>
        ),
      };

  return <FlowSheet view={view} maxWidth={600} />;
}

type JoinContext = { secondsLeft: number; close: () => void; tryAgain: () => void; openVault: () => void };

function joinView(join: JoinState, ctx: JoinContext): FlowView {
  const peer = join.peerName ?? 'your other device';
  const countdown = (
    <Text variant="caption" tone="faint" center>
      The request ends in {formatClock(ctx.secondsLeft)}
    </Text>
  );
  const cancel = <GhostButton label="Cancel" onPress={ctx.close} />;

  switch (join.stage) {
    case 'waiting':
      return {
        title: 'Waiting for a trusted device to answer',
        onClose: ctx.close,
        footer: cancel,
        body: (
          <>
            <Text tone="dim">Open AuthDeck on a phone or tablet that is already in your vault. It asks whether to let this device join.</Text>
            <Notice tone="info" icon="hourglass">
              Nothing to type here yet. A check code appears once a device answers.
            </Notice>
            {countdown}
          </>
        ),
      };
    case 'compare':
      return {
        title: 'Compare the codes',
        onClose: ctx.close,
        footer: cancel,
        body: (
          <>
            <Text tone="dim">Check that {peer} shows the same code, and that the device below is the one you are approving on.</Text>
            {join.code ? <CheckCode code={join.code} large /> : null}
            <PeerFacts join={join} />
            <Notice tone="warn">If the codes match, approve on {peer}. If they don't, deny it there: another device may be asking in your name.</Notice>
            {countdown}
          </>
        ),
      };
    case 'done':
      return {
        title: 'This device has joined',
        onClose: ctx.close,
        footer: <PrimaryButton label="Open vault" onPress={ctx.openVault} />,
        body: <Notice tone="ok">{`${peer} approved it. Your codes are on this device now.`}</Notice>,
      };
    case 'failed':
      return join.stuck ? stuckView(join, join.stuck, ctx) : failedView(join, ctx);
    case 'expired':
      return failedView(join, ctx);
  }
}

/** Who answered and which vault this joins, so the person can tell the right device answered. */
function PeerFacts({ join }: { join: JoinState }) {
  const facts: [string, string | null | undefined][] = [
    ['Answered by', join.peerName],
    ['Its key words', join.peerKeyWords],
    ['Joining', join.vaultName],
  ];
  const shown = facts.filter((fact): fact is [string, string] => !!fact[1]);
  if (shown.length === 0) return null;
  return (
    <View style={{ gap: 4 }}>
      {shown.map(([label, value]) => (
        <View key={label} style={{ flexDirection: 'row', gap: 12 }}>
          <Text variant="caption" tone="faint" style={{ width: FACT_LABEL_WIDTH }}>
            {label}
          </Text>
          <Text variant="caption" weight="semibold" style={{ flex: 1 }}>
            {value}
          </Text>
        </View>
      ))}
      {join.peerKeyWords ? (
        <Text variant="caption" tone="faint">
          The key words are under Trusted devices in that device's vault.
        </Text>
      ) : null}
    </View>
  );
}

const STUCK_TEXT: Record<NonNullable<JoinState['stuck']>, { title: string; fallback: string; explain: string }> = {
  intercepted: {
    title: 'This join was intercepted',
    fallback: 'Something between the two devices changed the request on its way.',
    explain:
      "The vault lists this device with a key it never sent, so it can't use that approval. Someone else may have approved it first, with their own key.",
  },
  unapproved: {
    title: 'This join is stuck',
    fallback: 'The vault holds no approval this device can use.',
    explain: "Your other device said it approved this one, but the vault doesn't hold an approval this device can use, so waiting longer won't help.",
  },
};

/** The join can't finish: nothing was added, and only cancelling it (or starting again) moves on. */
function stuckView(join: JoinState, stuck: NonNullable<JoinState['stuck']>, ctx: JoinContext): FlowView {
  const text = STUCK_TEXT[stuck];
  return {
    title: text.title,
    onClose: ctx.close,
    footer: (
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <GhostButton grow label="Cancel this join" onPress={ctx.close} />
        <PrimaryButton grow label="Start again" icon="refresh" onPress={ctx.tryAgain} />
      </View>
    ),
    body: (
      <>
        <Notice tone="danger">{join.error ?? text.fallback}</Notice>
        <Text tone="dim">{text.explain}</Text>
        <Text tone="dim">
          This device was not added and holds nothing from the vault. Cancel this join: it makes new keys, so the next try starts clean. Approve on your other
          device only when the code, its name and its key words all match what this device shows.
        </Text>
      </>
    ),
  };
}

function failedView(join: JoinState, ctx: JoinContext): FlowView {
  const expired = join.stage === 'expired';
  return {
    title: expired ? 'The request ran out of time' : "Joining didn't work",
    onClose: ctx.close,
    footer: (
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <GhostButton grow label="Close" onPress={ctx.close} />
        <PrimaryButton grow label="Try again" icon="refresh" onPress={ctx.tryAgain} />
      </View>
    ),
    body: (
      <Notice tone="danger">
        {join.error ??
          (expired
            ? 'No device approved it within five minutes. Ask again and keep your other device at hand.'
            : 'The other device turned the request down or stopped answering. Ask again.')}
      </Notice>
    ),
  };
}
