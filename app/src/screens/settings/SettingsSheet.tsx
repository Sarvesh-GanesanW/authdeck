/** App settings: colourway, behaviour switches, the authenticator, the computer in use, deck backup, about. */
import { useState } from 'react';
import { Platform, View } from 'react-native';

import appConfig from '../../../app.json';
import { useVault } from '../../auth/useVault';
import { platformName } from '../../lib/describe';
import { haptics } from '../../lib/haptics';
import { connection } from '../../net/connection';
import { useLive } from '../../state/live';
import { useActiveComputer, useActiveDeck, useStore } from '../../state/store';
import { GhostButton } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { pickAfterEditUnlock } from '../deck/editGate';
import { OsTile } from '../pair/ComputerTile';
import { AuthenticatorSection } from './AuthenticatorSection';
import { ColorwayPicker } from './ColorwayPicker';
import { ComputerSheet } from './ComputerSheet';
import { type ConfirmRequest, ConfirmSheet } from './ConfirmSheet';
import { backupFileName, backupJson, parseBackup, pickBackupText, saveBackupFile } from './deckBackup';
import { Group, Row, Section, SwitchRow, ValueRow } from './rows';

const APP_VERSION = appConfig.expo.version;
const isWeb = Platform.OS === 'web';

export function SettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [showComputers, setShowComputers] = useState(false);
  // Closing settings closes the stacked computer list too, so it doesn't pop back next time.
  if (!visible && showComputers) setShowComputers(false);

  return (
    <Sheet visible={visible} onClose={onClose} title="Settings" maxWidth={720} tall>
      <Section title="Colourway">
        <ColorwayPicker value={settings.colorway} onChange={(colorway) => setSettings({ colorway })} />
      </Section>

      <Section title="Behaviour">
        <Group>
          {isWeb ? null : (
            <SwitchRow
              label="Haptics"
              detail="A light tap when you press keys and pick options."
              value={settings.haptics}
              onChange={(v) => setSettings({ haptics: v })}
            />
          )}
          <SwitchRow
            label="Key sounds"
            detail="A mechanical click when you press keys and controls."
            value={settings.keySounds}
            onChange={(v) => setSettings({ keySounds: v })}
          />
          <SwitchRow
            label="Keep screen awake"
            detail="The deck stays on while AuthDeck is open."
            value={settings.keepAwake}
            onChange={(v) => setSettings({ keepAwake: v })}
          />
          <SwitchRow
            label="Switch pages with the app in front"
            detail="Shows a page when its linked app comes to the front on the computer."
            value={settings.autoSwitch}
            onChange={(v) => setSettings({ autoSwitch: v })}
          />
          <SwitchRow
            label="Show shortcuts on keys"
            detail="Prints the keys or command on the front edge of each key."
            value={settings.sublegends}
            onChange={(v) => setSettings({ sublegends: v })}
          />
        </Group>
      </Section>

      <AuthenticatorSection onLeave={onClose} />
      <ComputerSection onManage={() => setShowComputers(true)} />
      <BackupSection />

      <Section title="About">
        <Group>
          <ValueRow label="AuthDeck" value={`Version ${APP_VERSION}`} />
        </Group>
      </Section>

      <ComputerSheet visible={showComputers} onClose={() => setShowComputers(false)} onLeave={onClose} />
    </Sheet>
  );
}

function ComputerSection({ onManage }: { onManage: () => void }) {
  const computer = useActiveComputer();
  const status = useLive((s) => s.status);
  const agent = useLive((s) => s.agent);
  const host = useLive((s) => s.host);
  const appCount = useLive((s) => s.apps?.length ?? null);
  const appsError = useLive((s) => s.appsError);
  const [rescanning, setRescanning] = useState(false);
  const [rescanned, setRescanned] = useState(false);
  if (!computer) return null;

  const online = status === 'online';
  const rescan = async () => {
    setRescanning(true);
    await connection.listApps(true);
    setRescanning(false);
    setRescanned(true);
    if (useLive.getState().appsError) haptics.error();
    else haptics.success();
  };

  const appsNote = rescanning
    ? 'Reading the apps installed on the computer…'
    : !online
      ? `Rescan works while ${computer.name} is online.`
      : rescanned && appsError
        ? appsError
        : rescanned && appCount !== null
          ? `Found ${appCount} apps.`
          : 'Use this after installing or removing apps on the computer.';

  return (
    <Section title="Computer">
      <Group>
        <Row label={computer.name} detail={online ? 'Connected' : status === 'unauthorized' ? 'Needs re-pairing' : 'Not connected right now'}>
          <OsTile platform={computer.platform} size={40} />
        </Row>
        <ValueRow label="System" value={platformName(computer.platform)} />
        <ValueRow label="Agent version" value={agent ? agent.version : 'Shown when connected'} />
        <ValueRow label="Address" value={`${host ?? computer.hosts[0] ?? 'Unknown'}:${computer.port}`} mono />
        <Row label="Installed apps" detail={appsNote}>
          <GhostButton small label="Rescan" icon="refresh" disabled={!online || rescanning} onPress={() => void rescan()} />
        </Row>
        <Row label="All computers" detail="Switch, add, re-pair or forget computers.">
          <GhostButton small label="Manage" icon="chevron-right" onPress={onManage} />
        </Row>
      </Group>
    </Section>
  );
}

function BackupSection() {
  const computer = useActiveComputer();
  const deck = useActiveDeck();
  const [message, setMessage] = useState<{ tone: 'dim' | 'danger'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const { requireUnlock } = useVault();
  if (!computer) return null;

  const exportDeck = async () => {
    if (!deck) return;
    try {
      await saveBackupFile(backupFileName(computer), backupJson(computer, deck));
      setMessage({ tone: 'dim', text: isWeb ? 'Backup downloaded.' : 'Backup ready. Save it where you like.' });
    } catch (e) {
      haptics.error();
      setMessage({ tone: 'danger', text: e instanceof Error ? e.message : 'Could not save the backup. Try again.' });
    }
  };

  const importDeck = async () => {
    setMessage(null);
    let text: string | null;
    try {
      // Importing replaces every key's action, so it asks for the same unlock as editing the deck.
      text = await pickAfterEditUnlock(requireUnlock, pickBackupText, (why) => setMessage({ tone: 'dim', text: why }));
    } catch (e) {
      haptics.error();
      const why = e instanceof Error ? ` ${e.message}` : '';
      setMessage({ tone: 'danger', text: `Could not read that file.${why} Pick it again.` });
      return;
    }
    if (text === null) return;
    const parsed = parseBackup(text);
    if (!parsed.ok) {
      haptics.error();
      setMessage({ tone: 'danger', text: parsed.problem });
      return;
    }
    const otherSystem = parsed.from && parsed.from.platform !== computer.platform;
    setConfirm({
      title: `Replace the deck for ${computer.name}?`,
      message:
        `The backup has ${parsed.deck.pages.length} pages and ${parsed.keyCount} keys` +
        (parsed.from ? `, from ${parsed.from.name}` : '') +
        `. It replaces every page on ${computer.name}, and the current pages can't be brought back, so export them first if you want to keep them.` +
        (otherSystem && parsed.from
          ? ` It was made on ${platformName(parsed.from.platform)}, so some shortcuts and app keys may need changing for ${platformName(computer.platform)}.`
          : ''),
      confirmLabel: 'Replace deck',
      danger: true,
      onConfirm: () => {
        useStore.getState().setDeck(computer.agentId, parsed.deck);
        useStore.getState().setPageIndex(computer.agentId, 0);
        haptics.success();
        setMessage({ tone: 'dim', text: `Imported ${parsed.deck.pages.length} pages.` });
      },
    });
  };

  return (
    <Section title="Deck backup" footer="A backup holds this computer's pages and keys as a JSON file.">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <GhostButton grow label="Export deck" icon="download" disabled={!deck} onPress={() => void exportDeck()} />
        <GhostButton grow label="Import deck" icon="upload" onPress={() => void importDeck()} />
      </View>
      {message ? (
        <Text variant="label" tone={message.tone} accessibilityLiveRegion="polite">
          {message.text}
        </Text>
      ) : null}
      <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />
    </Section>
  );
}
