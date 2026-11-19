/**
 * Tapping a 2FA key: unlock the vault if needed, then have the computer type the code's digits.
 * Uses the same status lamp, haptics and banners as any other key.
 */
import type { VaultApi } from '../../auth/contract';
import { useAuthUi } from '../../auth/ui';
import { haptics } from '../../lib/haptics';
import { failureHint } from '../../net/client';
import { connection } from '../../net/connection';
import { useLive } from '../../state/live';
import type { DeckKey } from '../../state/model';

function plainMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function fail(keyId: string, title: string, detail?: string): void {
  haptics.error();
  useLive.getState().setKeyState(keyId, 'fail');
  useLive.getState().showToast({ tone: 'fail', title, detail });
}

export async function typeOtpCode(key: DeckKey, vault: VaultApi, computerName: string): Promise<void> {
  const live = useLive.getState();
  const accountId = key.otp?.accountId;
  if (!accountId || live.keyStates[key.id] === 'run') return;
  if (vault.status === 'none') {
    useAuthUi.getState().open('intro');
    return;
  }

  if (vault.status !== 'open') {
    try {
      await vault.unlock();
    } catch (e) {
      fail(key.id, plainMessage(e, 'The vault stayed locked.'), 'Tap the key to try again.');
      return;
    }
  }

  // Offline the code still shows on the key (now unlocked), so it can be typed by hand.
  if (useLive.getState().status !== 'online') {
    haptics.warning();
    useLive.getState().setKeyState(key.id, 'fail');
    useLive
      .getState()
      .showToast({
        tone: 'info',
        title: `${computerName} is offline`,
        detail: 'Read the code on the key and type it yourself. AuthDeck keeps trying to reconnect.',
      });
    connection.wake();
    return;
  }

  useLive.getState().setKeyState(key.id, 'run');
  try {
    await vault.typeCode(accountId);
  } catch (e) {
    fail(key.id, plainMessage(e, 'The code was not typed.'), failureHint(e));
    return;
  }
  haptics.success();
  useLive.getState().setKeyState(key.id, 'ok');
  // After unlocking, the snapshot passed in predates the account list; the key's label names it.
  const account = vault.accounts.find((a) => a.id === accountId);
  useLive.getState().showToast({ tone: 'ok', title: account ? account.issuer || account.label : key.label, detail: `Typed the code on ${computerName}` });
}
