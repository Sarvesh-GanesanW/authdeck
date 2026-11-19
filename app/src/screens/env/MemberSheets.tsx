/**
 * The owner's member sheets: adding a member (one of your own devices, or a teammate through a
 * request file in the repo), and after a removal, the values to rotate at their providers.
 */
import { useState } from 'react';
import { Share, View } from 'react-native';

import type { EnvApi, EnvSetDetail } from '../../auth/envContract';
import { Choice, GhostButton, PrimaryButton } from '../../ui/controls';
import { Sheet, SHORT_WINDOW } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { VOXEL } from '../../ui/voxel';
import { fonts } from '../../theme/type';
import { showFailure } from '../vault/feedback';
import { EnvRow, FactTable } from './parts';
import { envSheets, useEnvSheets } from './sheetState';
import { useEnv } from './source';
import { personName, plural } from './view';

type Who = 'own' | 'teammate';

export function AddMemberSheet() {
  const env = useEnv();
  const open = useEnvSheets((s) => s.addMember);
  const setId = useEnvSheets((s) => s.setId);
  const detail = setId ? env.detail(setId) : null;
  return (
    <Sheet
      visible={open && detail !== null}
      onClose={() => envSheets.setAddMember(false)}
      title={detail ? `Add to ${detail.set.name}` : undefined}
      subtitle={detail ? plural(detail.members.length, 'member') : undefined}
      maxWidth={600}
    >
      {detail ? <AddMemberBody env={env} detail={detail} /> : null}
    </Sheet>
  );
}

function AddMemberBody({ env, detail }: { env: EnvApi; detail: EnvSetDetail }) {
  const [who, setWho] = useState<Who>('teammate');
  const { set } = detail;
  const share = async () => {
    try {
      await Share.share({ message: env.teammateSteps(set.id) });
    } catch (e) {
      showFailure("Couldn't open sharing", e);
    }
  };
  return (
    <>
      <Choice
        label="Who joins"
        value={who}
        onChange={setWho}
        options={[
          { value: 'own', label: 'My other device', icon: 'tablet' },
          { value: 'teammate', label: 'A teammate', icon: 'user' },
        ]}
      />
      {who === 'own' ? (
        <Steps
          steps={[
            `Pair your other phone or tablet with ${set.computerName}, if it isn't yet.`,
            `On it, open Vault › .env sets. ${set.name} shows as a set it isn't in: open it and tap Ask to join.`,
            'The request shows here at once. A 6-digit code shows on both screens: approve if they match.',
          ]}
        />
      ) : (
        <>
          <Steps
            steps={[
              `They clone ${set.repo ?? 'the repo'} and run authdeck env init in it. Their phone makes its keys and the command writes .authdeck/requests/<device>.json.`,
              'They commit it and push, or open a pull request.',
              `Once ${set.computerName} has the commit, the request shows here. Compare their name and six key words on a call or side by side, then approve.`,
            ]}
          />
          <FactTable
            facts={[
              { label: 'They can', value: `Read and change all ${plural(detail.variables.length, 'variable')}` },
              { label: "They can't", value: 'Add or remove members. Only this phone can.' },
            ]}
          />
          <GhostButton icon="share" label="Share these steps" onPress={() => void share()} />
        </>
      )}
    </>
  );
}

function Steps({ steps }: { steps: string[] }) {
  const cw = useColorway();
  return (
    <View style={{ gap: 14 }} accessibilityRole="list">
      {steps.map((step, i) => (
        <View key={step} style={{ flexDirection: 'row', gap: 12 }} accessible accessibilityLabel={`Step ${i + 1}: ${step}`}>
          <View style={{ width: 28, height: 28 + VOXEL, alignItems: 'center', justifyContent: 'center', paddingBottom: VOXEL, backgroundColor: cw.surfaceAlt }}>
            <Text variant="label" weight="semibold">
              {String(i + 1)}
            </Text>
          </View>
          <Text style={{ flex: 1 }}>{step}</Text>
        </View>
      ))}
    </View>
  );
}

/** After a removal, a take-over or an old-key fix: the values to change at their providers. */
export function RotateSheet() {
  const notice = useEnvSheets((s) => s.rotate);
  const [shown, setShown] = useState(notice);
  if (notice && notice !== shown) setShown(notice);
  const close = () => envSheets.showRotate(null);
  const screen = useScreen();
  // In a short window a fixed footer leaves no room for the names to rotate, so Done scrolls after them.
  const inline = screen.height < SHORT_WINDOW;
  const done = <PrimaryButton label="Done" onPress={close} />;
  return (
    <Sheet
      visible={notice !== null}
      onClose={close}
      title={shown?.title}
      subtitle={shown && shown.rotate.length > 0 ? 'Rotate these at their providers' : undefined}
      maxWidth={600}
      footer={inline ? undefined : done}
    >
      {shown ? <Text tone="dim">{shown.text}</Text> : null}
      {shown && shown.rotate.length > 0 ? (
        <>
          <View style={{ gap: 12 }}>
            {shown.rotate.map((name) => (
              <EnvRow key={name} icon="reload" title={name} mono lines={[]} />
            ))}
          </View>
          {shown.after ? (
            <Text variant="caption" tone="dim" style={{ fontFamily: fonts.plex.regular }}>
              {shown.after}
            </Text>
          ) : null}
        </>
      ) : null}
      {inline ? done : null}
    </Sheet>
  );
}
