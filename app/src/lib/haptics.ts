/** Haptics that follow the iOS patterns, respecting the user's setting. No-ops on web. */
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

import { useStore } from '../state/store';

const enabled = () => Platform.OS !== 'web' && useStore.getState().settings.haptics;

function safe(p: Promise<void>) {
  p.catch(() => undefined);
}

export const haptics = {
  /** Finger down on a key. */
  press() {
    if (enabled()) safe(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
  },
  /** Long press recognised, drag picked up. */
  lift() {
    if (enabled()) safe(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
  },
  /** Moving between slots, toggles, picking an option. */
  tick() {
    if (enabled()) safe(Haptics.selectionAsync());
  },
  success() {
    if (enabled()) safe(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
  },
  error() {
    if (enabled()) safe(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
  },
  warning() {
    if (enabled()) safe(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
  },
};
