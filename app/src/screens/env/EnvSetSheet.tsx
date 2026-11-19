/**
 * One set, as a tall SecureSheet (values can be revealed, so it is kept out of screenshots,
 * recordings and the app switcher): its problems, the open grant, variables masked until revealed,
 * members, and the history from git. A removed set is read-only with one way out, deleting it
 * here; a set this phone isn't in offers asking to join or taking it over with the owner's phrase.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import type { EnvApi, EnvHistoryItemView, EnvMemberView, EnvProblemView, EnvSetDetail, EnvSetView } from '../../auth/envContract';
import { GhostButton } from '../../ui/controls';
import { SecureSheet } from '../../ui/SecureSheet';
import { Text } from '../../ui/Text';
import { useColorway } from '../../ui/theme';
import { VOXEL } from '../../ui/voxel';
import { fonts } from '../../theme/type';
import { Notice, plainError } from '../authflows/parts';
import { showDone, showFailure } from '../vault/feedback';
import { Alert, EmptyNote, Hint, StatusLight } from '../vault/parts';
import { EnvRow, MemberRow, RevealButton, SubHeading } from './parts';
import { envSheets, useEnvSheets } from './sheetState';
import { useEnv } from './source';
import { usePersonNameStep } from './steps';
import { useReveal } from './useReveal';
import {
  grantWords,
  joinBanner,
  LOADS_CODE_LINE,
  MASKED_VALUE,
  oldKeyText,
  orderProblems,
  personName,
  REFUSED_TITLE,
  removedRotate,
  setAbilities,
  setSubtitle,
  variableMeta,
  variablesHeading,
  waitingForOwner,
  when,
} from './view';

export function EnvSetSheet() {
  const env = useEnv();
  const setId = useEnvSheets((s) => s.setId);
  // Keep drawing the last set while the sheet slides away.
  const [shownId, setShownId] = useState(setId);
  if (setId && setId !== shownId) setShownId(setId);
  // Each opening reads the set afresh (its history above all), even when it is the same set again.
  const [lastSetId, setLastSetId] = useState(setId);
  const [openings, setOpenings] = useState(0);
  if (setId !== lastSetId) {
    setLastSetId(setId);
    if (setId) setOpenings((n) => n + 1);
  }
  const detail = shownId ? env.detail(shownId) : null;
  return (
    <SecureSheet
      visible={setId !== null}
      onClose={envSheets.closeSet}
      title={detail?.set.name ?? 'Set'}
      subtitle={detail ? setSubtitle(detail.set) : undefined}
      maxWidth={680}
      tall
    >
      {detail ? (
        <SetBody key={`${detail.set.id}:${openings}`} env={env} detail={detail} />
      ) : (
        <EmptyNote icon="file-text" title="This set is no longer here">
          <Text variant="caption" tone="dim" center>
            It was deleted from this phone, or the computer no longer lists it.
          </Text>
        </EmptyNote>
      )}
    </SecureSheet>
  );
}

function SetBody({ env, detail }: { env: EnvApi; detail: EnvSetDetail }) {
  const { set } = detail;
  const can = setAbilities(set.role);
  const joins = env.joinRequests.filter((r) => r.setId === set.id);
  return (
    <>
      {set.role === 'removed' ? <RemovedNotice env={env} set={set} /> : null}
      <Problems set={set} />
      {set.grant && set.grant.endsAt > Date.now() ? <GrantBanner env={env} set={set} /> : null}
      {set.role === 'outside' ? <OutsideNotice env={env} set={set} /> : null}
      {joins.map((request) => {
        const words = joinBanner(request);
        return (
          <Notice key={request.id} tone="warn" icon="user-plus">
            <Text variant="label" weight="semibold">
              {words.title}
            </Text>
            <Text variant="caption" tone="dim">
              {words.text}
            </Text>
            <View style={{ alignItems: 'flex-start', marginTop: 8 }}>
              <GhostButton small label="Review" onPress={() => envSheets.reviewJoin(request.id)} />
            </View>
          </Notice>
        );
      })}
      {set.role === 'outside' ? null : <Variables env={env} detail={detail} />}
      {set.role === 'outside' || set.role === 'removed' ? null : <Members env={env} detail={detail} />}
      {can.becomeOwner && set.role === 'member' ? <OwnerLost set={set} /> : null}
      {set.role === 'outside' ? null : <History env={env} set={set} />}
    </>
  );
}

function Problems({ set }: { set: EnvSetView }) {
  if (set.problems.length === 0) return null;
  return (
    <View style={{ gap: 12 }}>
      {orderProblems(set.problems).map((problem) =>
        problem.kind === 'epoch' ? (
          <OldKeyProblem key={problem.id} set={set} problem={problem} />
        ) : (
          <Alert key={problem.id} title={problem.title} tone={problem.severity === 'error' ? 'danger' : 'warning'}>
            {problem.hint ? `${problem.text} ${problem.hint}` : problem.text}
          </Alert>
        ),
      )}
    </View>
  );
}

/** Values under an old key: the owner reviews them; everyone else waits for the owner. */
function OldKeyProblem({ set, problem }: { set: EnvSetView; problem: EnvProblemView }) {
  const owner = set.role === 'owner';
  return (
    <Notice tone="warn">
      <Text variant="label" weight="semibold">
        {problem.title}
      </Text>
      <Text variant="caption" tone="dim">
        {owner ? oldKeyText(problem.names ?? []) : `${problem.text} ${waitingForOwner(set)}`}
      </Text>
      {owner ? (
        <View style={{ alignItems: 'flex-start', marginTop: 8 }}>
          <GhostButton small label="Review" onPress={() => envSheets.setOldKey(true)} />
        </View>
      ) : null}
    </Notice>
  );
}

function GrantBanner({ env, set }: { env: EnvApi; set: EnvSetView }) {
  const [busy, setBusy] = useState(false);
  const words = grantWords(set.grant!);
  const end = async () => {
    setBusy(true);
    try {
      await env.endGrant(set.id);
      showDone(`Ended ${set.name} on ${set.grant!.computerName}`);
    } catch (e) {
      showFailure(`Could not end ${set.name} on ${set.grant!.computerName}`, e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice tone="ok" icon="clock">
      <Text variant="label" weight="semibold">
        {words.title}
      </Text>
      <Text variant="caption" tone="dim">
        {words.text}
      </Text>
      <View style={{ alignItems: 'flex-start', marginTop: 8 }}>
        <GhostButton small label={busy ? 'Ending…' : 'End now'} disabled={busy} onPress={() => void end()} />
      </View>
    </Notice>
  );
}

function RemovedNotice({ env, set }: { env: EnvApi; set: EnvSetView }) {
  const cw = useColorway();
  const askDelete = () =>
    envSheets.confirm({
      title: `Delete ${set.name} from this phone?`,
      message: `The values this phone saw are deleted here. ${set.name} itself doesn't change for its members.`,
      confirmLabel: 'Delete',
      danger: true,
      action: async () => {
        await env.deleteRemovedSet(set.id);
        envSheets.closeSet();
        showDone(`Deleted ${set.name} from this phone`);
      },
    });
  return (
    <Alert title="You were removed">
      <View style={{ gap: 12 }}>
        <Text variant="caption" color={cw.dangerText} style={{ opacity: 0.85 }}>
          {`${set.removedNote ?? `This phone was removed from ${set.name}.`} The values you saw stay readable here until you delete them.`}
        </Text>
        <View style={{ alignItems: 'flex-start' }}>
          <GhostButton small danger icon="trash" label="Delete from this phone" onPress={askDelete} />
        </View>
      </View>
    </Alert>
  );
}

function OutsideNotice({ env, set }: { env: EnvApi; set: EnvSetView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Joining labels this person to the set's members: their name is asked once, here.
  const name = usePersonNameStep(env, !busy);
  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      await name.save();
      await env.requestJoin(set.id);
    } catch (e) {
      setError(plainError(e, `Couldn't ask to join ${set.name}. Check that ${set.computerName} is online, then try again.`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {set.refusedNote ? <Alert title={REFUSED_TITLE}>{set.refusedNote}</Alert> : null}
      <Text tone="dim">
        {`${set.name} is on ${set.computerName}, but this phone isn't one of its ${set.memberCount} members. If one of your other devices is in it, ask to join: a 6-digit code shows on both, and that device approves.`}
      </Text>
      {name.field}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <GhostButton icon="user-plus" label={busy ? 'Asking…' : 'Ask to join'} disabled={busy || !set.computerOnline || !name.ready} onPress={() => void ask()} />
        <GhostButton icon="key" label="Use the owner's recovery phrase" onPress={() => envSheets.setBecomeOwner(true)} />
      </View>
      {set.computerOnline ? null : <Hint>{`${set.computerName} is offline. Asking to join goes through it, so connect it first.`}</Hint>}
      <Hint>The recovery phrase is for a set whose owner's phone is lost: it makes this phone the owner.</Hint>
    </>
  );
}

function Variables({ env, detail }: { env: EnvApi; detail: EnvSetDetail }) {
  const { set, variables } = detail;
  const can = setAbilities(set.role);
  const reveal = useReveal();
  const warn = useColorway().run;
  const now = Date.now();
  const toggle = (name: string) =>
    reveal.toggle(name, () => env.reveal(set.id, name)).catch((e: unknown) => showFailure(`Could not show ${name}`, e));
  return (
    <View style={{ gap: 12 }}>
      <SubHeading
        title={variablesHeading(set, variables.length)}
        action={can.editVariables ? { label: 'Add', icon: 'plus', onPress: () => envSheets.openVariable({ mode: 'add' }) } : undefined}
      />
      {variables.length === 0 ? (
        <Hint>{can.editVariables ? 'No variables yet. Add one, or push a .env from the computer.' : 'No variables.'}</Hint>
      ) : (
        variables.map((variable) => {
          const shown = reveal.shown?.name === variable.name ? reveal.shown : null;
          return (
            <EnvRow
              key={variable.name}
              title={variable.name}
              mono
              lines={[
                shown ? { text: shown.value, selectable: true, numberOfLines: 4 } : { text: MASKED_VALUE },
                { text: variableMeta(variable, now, shown ? reveal.secondsLeft : null) },
                ...(variable.loadsCode ? [{ text: LOADS_CODE_LINE, color: warn }] : []),
              ]}
              warning={variable.loadsCode}
              trailing={
                can.reveal ? (
                  <RevealButton shown={!!shown} name={variable.name} disabled={reveal.loading === variable.name} onPress={() => void toggle(variable.name)} />
                ) : null
              }
              onPress={can.editVariables ? () => envSheets.openVariable({ mode: 'edit', name: variable.name }) : undefined}
              accessibilityLabel={`${variable.name}, version ${variable.version}${variable.loadsCode ? `. ${LOADS_CODE_LINE}` : ''}${can.editVariables ? '. Edit' : ''}`}
            />
          );
        })
      )}
      {can.reveal ? <Hint>A shown value hides itself after 30 seconds.</Hint> : null}
    </View>
  );
}

function Members({ env, detail }: { env: EnvApi; detail: EnvSetDetail }) {
  const { set, members } = detail;
  const can = setAbilities(set.role);
  // With app lock on, removeMember asks for the device's unlock; cancelling it rejects, and the
  // confirm sheet shows the sentence and stays open.
  const remove = async (member: EnvMemberView) => {
    const { rotate } = await env.removeMember(set.id, member.id);
    envSheets.showRotate(removedRotate(member.label, rotate));
  };

  const askRemove = (member: EnvMemberView) =>
    envSheets.confirm({
      title: `Remove ${member.label}?`,
      message:
        `${set.name} gets a new key and every value is encrypted again, so ${personName(member.label)}'s device can't read changes from now on. ` +
        'It keeps the values it already saw: you are shown which to rotate.',
      confirmLabel: 'Remove',
      danger: true,
      action: () => remove(member),
    });

  return (
    <View style={{ gap: 12 }}>
      <SubHeading
        title={`Members · ${members.length}`}
        action={can.manageMembers ? { label: 'Add', icon: 'plus', onPress: () => envSheets.setAddMember(true) } : undefined}
      />
      {members.map((member) => (
        <MemberRow
          key={member.id}
          member={member}
          onRemove={can.manageMembers && !member.thisDevice ? () => askRemove(member) : undefined}
        />
      ))}
      <Hint>
        {can.manageMembers
          ? 'Members are devices, labelled by person. Only this phone can add or remove them.'
          : 'Members are devices, labelled by person. Only the owner adds or removes them.'}
      </Hint>
    </View>
  );
}

/** A member whose owner lost their phone: the owner's recovery phrase hands the set to this one. */
function OwnerLost({ set }: { set: EnvSetView }) {
  return (
    <View style={{ gap: 8 }}>
      <Text variant="label" tone="dim">
        Owner's phone lost?
      </Text>
      <Hint>{`With ${set.ownerLabel ? `${personName(set.ownerLabel)}'s` : "the owner's"} recovery phrase, this phone can become the owner of ${set.name}.`}</Hint>
      <View style={{ alignItems: 'flex-start' }}>
        <GhostButton small icon="key" label="Become owner" onPress={() => envSheets.setBecomeOwner(true)} />
      </View>
    </View>
  );
}

function History({ env, set }: { env: EnvApi; set: EnvSetView }) {
  const [items, setItems] = useState<EnvHistoryItemView[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (before?: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await env.history(set.id, before);
      setItems((current) => (before ? [...current, ...page.items] : page.items));
      setMore(page.more);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : `The history of ${set.name} couldn't be read. Check that ${set.computerName} is online.`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Read once per set; the sheet is keyed by set id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.id]);

  const unsigned = items.some((item) => !item.signed);
  const cw = useColorway();
  const now = Date.now();
  return (
    <View style={{ gap: 4 }}>
      <SubHeading
        title="History, from git"
        accessory={
          items.length > 0 ? (
            unsigned ? <StatusLight label="Some changes aren't signed" color={cw.run} /> : <StatusLight label="Signatures check out" color={cw.ok} />
          ) : null
        }
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items.length === 0 && !loading && !error ? <Hint>No commits touch this set yet.</Hint> : null}
      <View accessibilityRole="list">
        {items.map((item, i) => (
          <HistoryRow key={item.commit} item={item} first={i === 0} now={now} />
        ))}
      </View>
      {loading ? <Hint>Reading the git log…</Hint> : null}
      {more && !loading ? (
        <View style={{ alignItems: 'flex-start', marginTop: 8 }}>
          <GhostButton small label="Show older" onPress={() => void load(items[items.length - 1]?.commit)} />
        </View>
      ) : null}
    </View>
  );
}

function HistoryRow({ item, first, now }: { item: EnvHistoryItemView; first: boolean; now: number }) {
  const cw = useColorway();
  const byline = `${item.by} · ${item.commit.slice(0, 7)}`;
  return (
    <View
      accessible
      accessibilityLabel={`${when(item.time, now)}: ${item.text}, by ${item.by}${item.signed ? '' : ", not signed by a member"}`}
      style={{ flexDirection: 'row', gap: 12, paddingVertical: 12, borderTopWidth: first ? 0 : VOXEL / 2, borderTopColor: cw.line }}
    >
      <View style={{ width: 10, height: 10, marginTop: 5, backgroundColor: item.signed ? cw.ok : cw.run }} />
      <Text variant="caption" tone="dim" style={{ width: 72, marginTop: 1 }}>
        {when(item.time, now)}
      </Text>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text weight="semibold">{item.text}</Text>
        <Text variant="caption" tone="dim" style={{ fontFamily: fonts.plex.regular }}>
          {byline}
        </Text>
        {item.signed ? null : (
          <Text variant="caption" weight="medium" color={cw.run}>
            Not signed by a member: shown, never trusted.
          </Text>
        )}
      </View>
    </View>
  );
}
