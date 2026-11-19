/**
 * Reads 2FA QR codes with the camera (the pattern from screens/pair/ScanSheet). Browsers have no
 * scanner here, so the web gets a field for pasting the otpauth:// link instead.
 */
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useRef, useState } from 'react';
import { cameraStep } from './cameraStep';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { Field, GhostButton, PrimaryButton } from '../../ui/controls';
import { Glyph } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useColorway, useScreen } from '../../ui/theme';
import { Bands, outlineBands, SunkenFace, VOXEL } from '../../ui/voxel';

/** The camera keeps reporting a code while it is in view; the same text counts once in this window. */
const SAME_CODE_COOLDOWN_MS = 2500;
const CAMERA_FRAME = 2 * VOXEL;
const canUseCamera = Platform.OS !== 'web';

export function scannerHeight(compact: boolean): number {
  return compact ? 232 : 300;
}

export function QrScanner({ onCode, onTypeKey, label }: { onCode: (text: string) => void; onTypeKey: () => void; label: string }) {
  return canUseCamera ? <CameraScanner onCode={onCode} onTypeKey={onTypeKey} label={label} /> : <PasteLink onCode={onCode} />;
}

function CameraScanner({ onCode, onTypeKey, label }: { onCode: (text: string) => void; onTypeKey: () => void; label: string }) {
  const cw = useColorway();
  const { compact } = useScreen();
  const [permission, requestPermission] = useCameraPermissions();
  const last = useRef({ text: '', at: 0 });

  // Never asked on open: the system prompt comes only once the person picks scanning.

  const onScanned = useCallback(
    ({ data }: BarcodeScanningResult) => {
      const now = Date.now();
      if (data === last.current.text && now - last.current.at < SAME_CODE_COOLDOWN_MS) return;
      last.current = { text: data, at: now };
      onCode(data);
    },
    [onCode],
  );

  const step = cameraStep(permission);
  if (step === 'loading') return <Text tone="dim">Opening the camera…</Text>;
  if (step === 'ask') return <CameraAsk onScan={() => void requestPermission()} onTypeKey={onTypeKey} />;
  if (step === 'blocked') {
    return <CameraBlocked canAskAgain={permission!.canAskAgain} onAllow={() => void requestPermission()} onTypeKey={onTypeKey} />;
  }
  return (
    <View style={{ height: scannerHeight(compact), padding: CAMERA_FRAME, paddingTop: CAMERA_FRAME + VOXEL }}>
      <SunkenFace color={cw.socket} lip={cw.lip} steps={2} />
      <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScanned} accessibilityLabel={label} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
        <View style={{ height: '70%', aspectRatio: 1, opacity: 0.9 }}>
          <Bands bands={outlineBands(2, VOXEL)} color={cw.ok} />
        </View>
      </View>
    </View>
  );
}

function CameraAsk({ onScan, onTypeKey }: { onScan: () => void; onTypeKey: () => void }) {
  const cw = useColorway();
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Glyph name="camera" size={24} color={cw.textDim} />
        <Text weight="semibold" style={{ flex: 1 }}>
          Scan the QR code
        </Text>
      </View>
      <Text tone="dim">AuthDeck asks for camera access when you choose to scan, and only uses it to read the code. Or type the key the site shows.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <PrimaryButton label="Scan QR code" icon="camera" onPress={onScan} />
        <GhostButton label="Type the key" icon="keyboard" onPress={onTypeKey} />
      </View>
    </View>
  );
}

function CameraBlocked({ canAskAgain, onAllow, onTypeKey }: { canAskAgain: boolean; onAllow: () => void; onTypeKey: () => void }) {
  const cw = useColorway();
  const how =
    Platform.OS === 'ios'
      ? 'Open Settings, tap AuthDeck, then turn on Camera.'
      : 'Open Settings, then Permissions, then Camera, and choose Allow only while using the app.';
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Glyph name="camera" size={24} color={cw.textDim} />
        <Text weight="semibold" style={{ flex: 1 }}>
          AuthDeck can't use the camera
        </Text>
      </View>
      <Text tone="dim">
        {canAskAgain
          ? 'Allow camera access to scan the QR code. AuthDeck only uses it to read the code.'
          : `Camera access is turned off for AuthDeck. ${how} Or type the key the site shows under its QR code.`}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {canAskAgain ? (
          <PrimaryButton label="Allow camera" icon="camera" onPress={onAllow} />
        ) : (
          <GhostButton label="Open Settings" icon="settings-cog" onPress={() => void Linking.openSettings()} />
        )}
        <GhostButton label="Type the key" icon="keyboard" onPress={onTypeKey} />
      </View>
    </View>
  );
}

/** Web only: paste the link a QR code holds. */
function PasteLink({ onCode }: { onCode: (text: string) => void }) {
  const [text, setText] = useState('');
  const submit = () => {
    if (text.trim()) onCode(text.trim());
  };
  return (
    <View style={{ gap: 12 }}>
      <Field
        label="Link from the QR code"
        value={text}
        onChangeText={setText}
        onSubmitEditing={submit}
        placeholder="otpauth://totp/…"
        autoCapitalize="none"
        returnKeyType="done"
      />
      <View style={{ alignItems: 'flex-start' }}>
        <GhostButton small icon="qr-code" label="Read the link" disabled={!text.trim()} onPress={submit} />
      </View>
    </View>
  );
}

/** Where the camera was, once a code is read: the corners and a "Found GitHub" badge. */
export function FoundFrame({ label }: { label: string }) {
  const cw = useColorway();
  const { compact } = useScreen();
  return (
    <View accessibilityRole="image" accessibilityLabel={label} style={{ height: scannerHeight(compact), alignItems: 'center', justifyContent: 'center' }}>
      <SunkenFace color={cw.socket} lip={cw.lip} steps={2} />
      <View style={{ height: '72%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Bands bands={outlineBands(2, VOXEL)} color={cw.ok} />
        <Glyph name="qr-code" size={96} color={cw.textFaint} />
      </View>
      <View
        style={{ position: 'absolute', bottom: 14, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8 }}
      >
        <View style={[StyleSheet.absoluteFill, { backgroundColor: cw.plate }]} />
        <Glyph name="check" size={24} color={cw.ok} />
        <Text variant="label" weight="semibold" color={cw.ok}>
          {label}
        </Text>
      </View>
    </View>
  );
}
