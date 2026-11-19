/**
 * Adding accounts three ways: scan a site's QR code, type its key, or import a Google
 * Authenticator export. A centred sheet on tablets; nearly full height on phones.
 */
import { useState } from 'react';
import { View } from 'react-native';

import type { SurfaceProps } from '../../auth/contract';
import { useVault } from '../../auth/useVault';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import type { GlyphName } from '../../ui/Icon';
import { SecureSheet } from '../../ui/SecureSheet';
import { Text } from '../../ui/Text';
import { useScreen } from '../../ui/theme';
import { useImportStep } from './ImportStep';
import { useManualStep } from './ManualStep';
import { useScanStep } from './ScanStep';
import { useSurfaceVisible } from '../../auth/surfaceVisibility';
import { pausedNote, unheardNote } from './addFlow';

type Way = 'scan' | 'manual' | 'import';

const WAYS: Record<Way, { title: string; button: string; icon: GlyphName }> = {
  scan: { title: 'Add account', button: 'Scan a QR code', icon: 'qr-code' },
  manual: { title: 'Type the key', button: 'Type the key', icon: 'keyboard' },
  import: { title: 'Import accounts', button: 'Import', icon: 'download' },
};

/** Under the buttons on the scan step, as in the design: where Import comes from. */
const IMPORT_FOOTNOTE = 'Import moves accounts from Google Authenticator\'s "Transfer accounts" QR code.';

export function AddAccountSheet({ onClose }: SurfaceProps) {
  const vault = useVault();
  const [addAnyway, setAddAnyway] = useState(false);
  if (vault.removed) return <BlockedSheet title="This device was removed" text={vault.removed} onClose={onClose} />;
  if (vault.secretsPaused) return <BlockedSheet title="Adding accounts is paused" text={pausedNote(vault.warnings)} onClose={onClose} />;
  const unheard = unheardNote(vault.warnings);
  if (unheard && !addAnyway) return <UnheardSheet note={unheard} onAddAnyway={() => setAddAnyway(true)} onClose={onClose} />;
  return <AddAccountSteps onClose={onClose} />;
}

/** While the engine refuses new secrets (paused, or this device was removed), say why instead of offering steps. */
function BlockedSheet({ title, text, onClose }: SurfaceProps & { title: string; text: string }) {
  const visible = useSurfaceVisible();
  return (
    <SecureSheet visible={visible} onClose={onClose} title={title} maxWidth={560} footer={<PrimaryButton label="Close" onPress={onClose} />}>
      <Text tone="dim">{text}</Text>
    </SecureSheet>
  );
}

/** An admin device has been quiet: ask before writing a secret a hidden removal could expose. */
function UnheardSheet({ note, onAddAnyway, onClose }: SurfaceProps & { note: string; onAddAnyway: () => void }) {
  const visible = useSurfaceVisible();
  const footer = (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <GhostButton grow label="Cancel" onPress={onClose} />
      <PrimaryButton grow label="Add anyway" onPress={onAddAnyway} />
    </View>
  );
  return (
    <SecureSheet visible={visible} onClose={onClose} title="Add anyway?" maxWidth={560} footer={footer}>
      <Text tone="dim">{note}</Text>
    </SecureSheet>
  );
}

function AddAccountSteps({ onClose }: SurfaceProps) {
  const { compact } = useScreen();
  const visible = useSurfaceVisible();
  const [way, setWay] = useState<Way>('scan');
  const [handedOver, setHandedOver] = useState<string | null>(null);
  const typeKey = () => setWay('manual');

  const scan = useScanStep({
    onDone: onClose,
    onTypeKey: typeKey,
    onMigration: (text) => {
      setHandedOver(text);
      setWay('import');
    },
  });
  const manual = useManualStep({ onDone: onClose });
  const importStep = useImportStep({ onDone: onClose, onTypeKey: typeKey, firstCode: handedOver });
  const step = way === 'scan' ? scan : way === 'manual' ? manual : importStep;

  const others = (Object.keys(WAYS) as Way[]).filter((w) => w !== way);
  const footer = (
    <View style={{ gap: 12 }}>
      {step.action}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {others.map((w) => (
          <GhostButton key={w} grow small={compact} label={WAYS[w].button} icon={WAYS[w].icon} onPress={() => setWay(w)} />
        ))}
      </View>
      {way === 'scan' ? (
        <Text variant="caption" tone="faint" center>
          {IMPORT_FOOTNOTE}
        </Text>
      ) : null}
    </View>
  );

  return (
    <SecureSheet visible={visible} onClose={onClose} title={WAYS[way].title} maxWidth={560} tall={compact} footer={footer}>
      {step.body}
    </SecureSheet>
  );
}
