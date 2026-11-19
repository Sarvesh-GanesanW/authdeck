/**
 * A sheet for screens that show or take a secret: the recovery phrase, a 2FA setup key, an
 * account import. It looks and moves like Sheet, but draws in the app's own window rather than a
 * Modal window. On Android, blocking screenshots (FLAG_SECURE) applies to the app window only; a
 * Modal is a separate window the block doesn't reach, so a secret drawn there could be captured
 * by a screenshot or the recents thumbnail. One path on iOS too.
 *
 * Render it only where AuthHost renders its surfaces, at the app root: the sheet covers the app
 * from there. While it is open, Modal sheets step aside (see useInWindowSheets in Sheet.tsx), so
 * none can sit above it.
 */
import * as ScreenCapture from 'expo-screen-capture';
import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';

import { GhostButton, PrimaryButton } from './controls';
import { captureTestModes, SecureCapture, withCaptureTestModes } from './secureCapture';
import { Sheet, type SheetProps, useInWindowSheets } from './Sheet';
import { Text } from './Text';

/** Longer than the sheet's closing spring. */
const RELEASE_AFTER_CLOSE_MS = 800;

/** Whether this platform blocks screenshots of a SecureSheet; browsers can't. */
export const CAN_BLOCK_SCREEN_CAPTURE = Platform.OS !== 'web';

export const CAPTURE_FAILED_TEXT = "AuthDeck couldn't hide this screen from screenshots and screen recording.";

/** One for the app: blocks are counted across every SecureSheet. */
const capture = new SecureCapture(
  withCaptureTestModes(
    {
      prevent: (key) => ScreenCapture.preventScreenCaptureAsync(key),
      allow: (key) => ScreenCapture.allowScreenCaptureAsync(key),
      // iOS draws a snapshot of the app for the app switcher; FLAG_SECURE already covers Android's.
      ...(Platform.OS === 'ios'
        ? {
            hideSnapshot: () => ScreenCapture.enableAppSwitcherProtectionAsync(),
            showSnapshot: () => ScreenCapture.disableAppSwitcherProtectionAsync(),
          }
        : {}),
    },
    captureTestModes,
  ),
);

type CaptureState = 'pending' | 'blocked' | 'failed' | 'shownAnyway';

export function SecureSheet(props: Omit<SheetProps, 'inWindow'>) {
  const state = useBlockCapture(props.visible);
  useEffect(() => {
    if (!props.visible) return;
    useInWindowSheets.setState((s) => ({ open: s.open + 1 }));
    return () => useInWindowSheets.setState((s) => ({ open: Math.max(0, s.open - 1) }));
  }, [props.visible]);

  // The secret is drawn only once capture is blocked, or the person chose to see it anyway.
  if (state.value === 'blocked' || state.value === 'shownAnyway') return <Sheet {...props} inWindow />;
  if (state.value === 'pending') return <Sheet {...props} footer={undefined} inWindow>{null}</Sheet>;
  return (
    <Sheet
      {...props}
      inWindow
      footer={
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <GhostButton grow label="Cancel" onPress={props.onClose} />
          <PrimaryButton grow label="Show anyway" onPress={state.showAnyway} />
        </View>
      }
    >
      <Text>{CAPTURE_FAILED_TEXT}</Text>
    </Sheet>
  );
}

/**
 * Blocks screenshots, screen recording and (on iOS) the app-switcher snapshot while `active`.
 * Each activation takes a block of its own, so closing and quickly reopening can't let the first
 * activation's delayed release lift the second one's block.
 */
function useBlockCapture(active: boolean): { value: CaptureState; showAnyway: () => void } {
  const [value, setValue] = useState<CaptureState>(CAN_BLOCK_SCREEN_CAPTURE ? 'pending' : 'blocked');
  useEffect(() => {
    if (!active || !CAN_BLOCK_SCREEN_CAPTURE) return;
    setValue('pending');
    let current = true;
    const block = capture.block();
    void block.ready.then((ok) => {
      if (!current) return;
      if (!ok) console.warn('Could not block screenshots on a screen with a secret.');
      setValue(ok ? 'blocked' : 'failed');
    });
    return () => {
      current = false;
      // The sheet still shows its content while it slides away: release once it is gone.
      block.release(RELEASE_AFTER_CLOSE_MS);
    };
  }, [active]);
  return { value, showAnyway: () => setValue('shownAnyway') };
}
