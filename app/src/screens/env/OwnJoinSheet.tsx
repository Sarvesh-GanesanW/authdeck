/**
 * This phone asking to join one of its person's sets (the new device's side): waiting for a
 * device already in the set, then the 6-digit code to compare, then in.
 */
import { useState } from 'react';
import { View } from 'react-native';

import type { EnvApi, EnvJoinState } from '../../auth/envContract';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { CheckCode, Notice, useSecondsLeft } from '../authflows/parts';
import { showFailure } from '../vault/feedback';
import { ButtonRow } from './parts';
import { useEnv } from './source';
import { minutesSeconds } from './view';

export function OwnJoinSheet() {
  const env = useEnv();
  const join = env.join;
  const [shown, setShown] = useState(join);
  if (join && join !== shown) setShown(join);
  return (
    <Sheet visible={join !== null} onClose={env.cancelJoin} title={shown ? `Join ${shown.setName}` : undefined} maxWidth={520} footer={shown ? <Footer env={env} join={shown} /> : null}>
      {shown ? <JoinBody join={shown} /> : null}
    </Sheet>
  );
}

function JoinBody({ join }: { join: EnvJoinState }) {
  const secondsLeft = useSecondsLeft(join.expiresAt);
  const ends =
    join.expiresAt !== null && (join.stage === 'waiting' || join.stage === 'compare') ? (
      <Text variant="caption" tone="faint" center>
        {`The request ends in ${minutesSeconds(secondsLeft)}`}
      </Text>
    ) : null;
  switch (join.stage) {
    case 'waiting':
      return (
        <>
          <Text tone="dim">{`Waiting for one of your devices in ${join.setName}. Open AuthDeck on it: the request shows there at once.`}</Text>
          {ends}
        </>
      );
    case 'compare':
      return (
        <>
          <Text tone="dim">{`Check that ${join.peerName ?? 'your other device'} shows this same code, then approve there.`}</Text>
          {join.code ? <CheckCode code={join.code} large /> : null}
          {ends}
        </>
      );
    case 'done':
      return <Notice tone="ok">{`This phone is a member of ${join.setName} now. It can read its variables and answer your computer's requests.`}</Notice>;
    case 'failed':
      return <Notice tone="danger">{join.error ?? `This phone couldn't join ${join.setName}. Try again.`}</Notice>;
    case 'expired':
      return <Text tone="dim">Nobody approved it in time, so this phone wasn't added. Ask again when your other device is at hand.</Text>;
  }
}

function Footer({ env, join }: { env: EnvApi; join: EnvJoinState }) {
  if (join.stage === 'done') return <PrimaryButton label="Done" onPress={env.cancelJoin} />;
  if (join.stage === 'failed' || join.stage === 'expired') {
    const again = () => {
      env.requestJoin(join.setId).catch((e: unknown) => showFailure(`Could not ask to join ${join.setName}`, e));
    };
    return (
      <ButtonRow>
        <GhostButton label="Close" onPress={env.cancelJoin} />
        <PrimaryButton label="Ask again" onPress={again} />
      </ButtonRow>
    );
  }
  return <GhostButton label="Cancel" onPress={env.cancelJoin} />;
}
