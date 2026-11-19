/** Camera sheet that reads the pairing QR code the agent prints. Not offered on the web. */
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { haptics } from '../../lib/haptics';
import { isOlderPairLink, type PairLink, parsePairLink } from '../../net/discovery';
import { GhostButton, PrimaryButton } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { Bands, outlineBands, SunkenFace, VOXEL } from '../../ui/voxel';

/** The camera sits in a sunken socket this many dp deep on each side. */
const CAMERA_FRAME = 2 * VOXEL;

/** How long a "not a AuthDeck code" message stays before the same code may trigger it again. */
const WRONG_CODE_COOLDOWN_MS = 2500;

export function ScanSheet({
  visible,
  onClose,
  onLink,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  onLink: (link: PairLink) => void;
  /** Sheets stacked on the scanner, such as the question about the scanned computer. */
  children?: ReactNode;
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Scan the QR code"
      subtitle="Point the camera at the code in the AuthDeck agent window."
      maxWidth={560}
    >
      {visible ? <Scanner onLink={onLink} /> : null}
      {children}
    </Sheet>
  );
}

function Scanner({ onLink }: { onLink: (link: PairLink) => void }) {
  const cw = useColorway();
  const { compact } = useScreen();
  const [permission, requestPermission] = useCameraPermissions();
  const [wrongCode, setWrongCode] = useState<'other' | 'older' | null>(null);
  const handled = useRef(false);
  const lastWrong = useRef(0);

  // Ask on open only while the person has never answered; after that the buttons below take over.
  const undetermined = permission?.status === 'undetermined';
  useEffect(() => {
    if (undetermined) void requestPermission();
  }, [undetermined, requestPermission]);

  const onScanned = useCallback(
    ({ data }: BarcodeScanningResult) => {
      if (handled.current) return;
      const link = parsePairLink(data);
      if (link) {
        handled.current = true;
        haptics.success();
        onLink(link);
        return;
      }
      const now = Date.now();
      if (now - lastWrong.current < WRONG_CODE_COOLDOWN_MS) return;
      lastWrong.current = now;
      haptics.warning();
      setWrongCode(isOlderPairLink(data) ? 'older' : 'other');
    },
    [onLink],
  );

  if (!permission) {
    return <Text tone="dim">Opening the camera…</Text>;
  }

  if (!permission.granted) {
    return (
      <View style={{ gap: 16, alignItems: 'flex-start' }}>
        <View style={styles.row}>
          <Glyph name="camera" size={24} color={cw.textDim} />
          <Text weight="semibold" style={{ flex: 1 }}>
            AuthDeck can't use the camera
          </Text>
        </View>
        <Text tone="dim">
          {permission.canAskAgain
            ? 'Allow camera access to scan the code. AuthDeck only uses it to read the pairing QR code.'
            : 'Camera access is turned off for AuthDeck. Turn it on in Settings, or close this and pick the computer from the list or enter its address.'}
        </Text>
        {permission.canAskAgain ? (
          <PrimaryButton label="Allow camera" icon="camera" onPress={() => void requestPermission()} />
        ) : (
          <GhostButton label="Open Settings" icon="settings-cog" onPress={() => void Linking.openSettings()} />
        )}
      </View>
    );
  }

  const size = compact ? undefined : 460;
  return (
    <View style={{ gap: 14 }}>
      <View
        style={{
          width: size ?? '100%',
          aspectRatio: 1,
          alignSelf: 'center',
          padding: CAMERA_FRAME,
          paddingTop: CAMERA_FRAME + VOXEL,
        }}
      >
        <SunkenFace color={cw.plate} lip={cw.lip} steps={2} />
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onScanned}
          accessibilityLabel="Camera view for the pairing QR code"
        />
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <View style={{ width: '64%', aspectRatio: 1, opacity: 0.9 }}>
            <Bands bands={outlineBands(2, VOXEL)} color={cw.focus} />
          </View>
        </View>
      </View>
      <Text tone={wrongCode ? 'danger' : 'dim'} center accessibilityLiveRegion="polite">
        {wrongCode === 'older'
          ? 'That QR code is from an older AuthDeck agent. Update the agent on the computer, then scan its new code.'
          : wrongCode === 'other'
            ? "That QR code isn't a AuthDeck pairing code. Scan the one the agent prints when it starts."
            : 'AuthDeck shows the computer the code names before anything is paired.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
