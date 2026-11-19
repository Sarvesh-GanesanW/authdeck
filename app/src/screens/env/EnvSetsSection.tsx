/**
 * The ".env sets" section of the Vault: join requests waiting at the top, then one row per set
 * with its role and the one thing worth knowing (a problem, an open grant, the removal). Under
 * Accounts on phones; at the top of the middle column on tablets (`inColumn`). Tapping a set
 * opens its sheet, which EnvSheets draws at the vault screen's root.
 */
import { View } from 'react-native';

import type { EnvApi, EnvJoinRequestView, EnvOwnRequestView, EnvSetView } from '../../auth/envContract';
import { GhostButton } from '../../ui/controls';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { Alert, EmptyNote, Hint, SectionHeading, SectionWell, Tag } from '../vault/parts';
import { EnvRow, useLineColor } from './parts';
import { envSheets } from './sheetState';
import { useEnv } from './source';
import { envSectionState, joinBanner, orderSets, ownerWords, ownRequestStatus, personName, setRow, when } from './view';

export function EnvSetsSection({ inColumn = false }: { inColumn?: boolean }) {
  const env = useEnv();
  const state = envSectionState(env);
  const count = env.sets.length;
  const heading = <SectionHeading title=".env sets" accessory={state === 'list' && count > 0 ? <Tag label={String(count)} /> : null} />;
  const body = (
    <>
      {env.agentTooOld ? (
        <Alert title="Update AuthDeck Agent" tone="warning">
          A paired computer's AuthDeck Agent is too old for env sets. Update it on that computer to see and use its sets.
        </Alert>
      ) : null}
      <SectionBody env={env} state={state} />
    </>
  );
  if (inColumn) {
    return (
      <View style={{ gap: 12, marginBottom: 14 }}>
        {heading}
        {body}
      </View>
    );
  }
  return (
    <SectionWell>
      {heading}
      {body}
    </SectionWell>
  );
}

function SectionBody({ env, state }: { env: EnvApi; state: ReturnType<typeof envSectionState> }) {
  switch (state) {
    case 'loading':
      return <Hint>Reading your env sets…</Hint>;
    case 'locked':
      return (
        <EmptyNote icon="lock" title="Env sets are locked">
          <Text variant="caption" tone="dim" center>
            They open with the vault. Requests from your computer still reach you and ask you to unlock first.
          </Text>
        </EmptyNote>
      );
    case 'empty':
      return (
        <EmptyNote icon="file-text" title="No env sets yet">
          <Text variant="caption" tone="dim" center>
            In a project folder on your computer, run authdeck env init. Its variables move into the repo, encrypted for your devices, and this phone approves
            each use.
          </Text>
        </EmptyNote>
      );
    case 'list':
      return (
        <>
          {env.joinRequests.map((request) => (
            <JoinBanner key={request.id} request={request} />
          ))}
          {orderSets(env.sets).map((set) => (
            <SetListRow key={set.id} set={set} />
          ))}
          {env.ownRequests.map((request) => (
            <OwnRequestRow key={request.setId} env={env} request={request} />
          ))}
          <Hint style={{ marginTop: 4 }}>Values are encrypted in each project's repo. A computer gets them only when this phone allows it.</Hint>
        </>
      );
  }
}

function JoinBanner({ request }: { request: EnvJoinRequestView }) {
  const cw = useColorway();
  const words = joinBanner(request);
  return (
    <Alert title={words.title} tone="warning">
      <View style={{ gap: 12 }}>
        <Text variant="caption" color={cw.run} style={{ opacity: 0.85 }}>
          {words.text}
        </Text>
        <View style={{ alignItems: 'flex-start' }}>
          <GhostButton small label="Review" onPress={() => envSheets.reviewJoin(request.id)} />
        </View>
      </View>
    </Alert>
  );
}

function SetListRow({ set }: { set: EnvSetView }) {
  const cw = useColorway();
  const lineColor = useLineColor();
  const row = setRow(set, Date.now());
  return (
    <EnvRow
      icon="file-text"
      iconColor={set.role === 'removed' ? cw.dangerText : undefined}
      title={row.title}
      lines={[{ text: row.detail }, { text: row.status, color: lineColor(row.tone) }]}
      trailing={<Tag label={row.tag} />}
      onPress={() => envSheets.openSet(set.id)}
      accessibilityLabel={`${row.title}, ${row.tag}. ${row.detail}. ${row.status}`}
    />
  );
}

/**
 * A join request this phone made for a teammate's set: the words to read to its owner, and a way
 * into the check of the owner's six words (OwnerWordsSheet). The set isn't taken until they match.
 */
function OwnRequestRow({ env, request }: { env: EnvApi; request: EnvOwnRequestView }) {
  const cw = useColorway();
  const now = Date.now();
  const status = ownRequestStatus(request, env.sets);
  return (
    <EnvRow
      icon="hourglass"
      title={request.setName}
      lines={
        status?.refused
          ? [{ text: status.text, color: cw.dangerText }]
          : [
              { text: `Asked to join ${when(request.madeAt, now)} from ${request.computerName}. Read these words to ${personName(request.ownerLabel)}:` },
              { text: request.keyWords.join(' '), selectable: true },
              ...(status ? [{ text: status.text }] : []),
            ]
      }
      trailing={<Tag label={status?.refused ? 'refused' : 'waiting'} />}
      action={
        request.ownerConfirmed || status?.refused ? undefined : (
          <GhostButton small label={ownerWords(request.ownerLabel).check} onPress={() => envSheets.checkOwnerWords(request.setId)} />
        )
      }
      accessibilityLabel={
        status?.refused
          ? `${request.setName}, refused. ${status.text}`
          : `${request.setName}, ${status?.text ?? `waiting for ${personName(request.ownerLabel)}`}. Key words: ${request.keyWords.join(' ')}`
      }
    />
  );
}
