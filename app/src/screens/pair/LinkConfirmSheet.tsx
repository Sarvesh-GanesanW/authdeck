/**
 * Asked before pairing from a QR code or a deep link: which computer the link names, at which
 * addresses, whether it is new or already saved here, and its key words to compare with the
 * computer's pairing screen. Nothing is sent to the computer until the person taps Pair.
 */
import { useState } from 'react';
import { View } from 'react-native';

import { outsideNetworkMessage } from '../../net/addresses';
import type { PairLink } from '../../net/discovery';
import { computerLink, inTwoLines, keyWordsOf } from '../../net/linkState';
import { MIXED_ALPHABETS_WARNING, mixesAlphabets } from '../../net/trust';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { useStore } from '../../state/store';
import { KeyWords } from '../../ui/KeyWords';
import { Text } from '../../ui/Text';
import { computerDetail, OsTile } from './ComputerTile';
import type { Computer } from '../../state/model';
import { type LinkStanding, NO_SAVED_KEY_WORDS, OTHER_APP_LINK_NOTICE, linkStanding, nameClashMessage } from './pairing';

export function LinkConfirmSheet({ link, onConfirm, onCancel }: { link: PairLink | null; onConfirm: () => void; onCancel: () => void }) {
  // Keep showing the last link while the sheet animates away.
  const [shown, setShown] = useState(link);
  if (link && link !== shown) setShown(link);
  const canPair = !!shown && shown.hosts.length > 0;
  return (
    <Sheet
      visible={!!link}
      onClose={onCancel}
      title="Pair with this computer?"
      subtitle="Check that the key words match the ones on the computer's pairing screen."
      maxWidth={560}
      footer={
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <GhostButton grow label="Cancel" onPress={onCancel} />
          {canPair ? <PrimaryButton grow label="Pair" icon="link" onPress={onConfirm} /> : null}
        </View>
      }
    >
      {shown ? <LinkDetails link={shown} /> : null}
    </Sheet>
  );
}

function LinkDetails({ link }: { link: PairLink }) {
  const computers = useStore((s) => s.computers);
  const addresses = link.hosts.map((h) => `${h}:${link.port}`).join(', ');
  const words = keyWordsOf(link.agentKey);
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <OsTile platform={null} size={48} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text weight="semibold">{link.name}</Text>
          <Text variant="label" tone="dim">
            {link.hosts.length > 0 ? addresses : computerDetail(null, null)}
          </Text>
        </View>
      </View>
      <KeyWords keyWords={words} large />
      {mixesAlphabets(link.name) ? <Text tone="danger">{MIXED_ALPHABETS_WARNING}</Text> : null}
      <Standing standing={linkStanding(link, computers)} />
      {link.fromOtherApp ? <Text tone="danger">{OTHER_APP_LINK_NOTICE}</Text> : null}
      <RefusedHosts link={link} />
    </View>
  );
}

/** Says plainly whether this computer is already saved here, and warns when a new one borrows a saved name. */
function Standing({ standing }: { standing: LinkStanding }) {
  if (standing.kind === 'saved') {
    return <Text>{`Already saved on this device as ${standing.computer.name}. Pairing again keeps its keys and pages.`}</Text>;
  }
  return (
    <View style={{ gap: 8 }}>
      <Text>New computer: it is not saved on this device yet.</Text>
      {standing.lookAlike ? (
        <Text tone="danger" accessibilityLiveRegion="polite">
          {`${nameClashMessage(standing.lookAlike.name)}\n\n${savedKeyWordsLine(standing.lookAlike)}`}
        </Text>
      ) : null}
    </View>
  );
}

/** The saved computer's key words, to set beside the link's. */
function savedKeyWordsLine(saved: Computer): string {
  const link = computerLink(saved);
  return `Saved ${saved.name}'s key words:\n${link.kind === 'linked' ? inTwoLines(link.keyWords) : NO_SAVED_KEY_WORDS}`;
}

function RefusedHosts({ link }: { link: PairLink }) {
  const [first, ...rest] = link.refusedHosts;
  if (!first) return null;
  if (link.hosts.length === 0) {
    return (
      <Text tone="danger" accessibilityLiveRegion="polite">
        {`${outsideNetworkMessage(first)} This link can't be used.`}
      </Text>
    );
  }
  const skipped = [first, ...rest].join(', ');
  return <Text tone="dim">{`AuthDeck won't try ${skipped}: outside your local network.`}</Text>;
}
