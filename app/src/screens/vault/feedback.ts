/** Banners for vault actions, through the app's existing toast. */
import { haptics } from '../../lib/haptics';
import { failureHint } from '../../net/client';
import { useLive } from '../../state/live';

export function showDone(title: string) {
  haptics.success();
  useLive.getState().showToast({ tone: 'ok', title });
}

/** A failed vault action as a red banner: what failed, then the plain sentence and the computer's next step. */
export function showFailure(title: string, error: unknown) {
  haptics.error();
  const message = error instanceof Error ? error.message : 'Try again.';
  useLive.getState().showToast({ tone: 'fail', title, detail: [message, failureHint(error)].filter(Boolean).join(' ') });
}
