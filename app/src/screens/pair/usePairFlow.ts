/** Binds the pairing flow (pairFlow.ts) to React, and says "Paired" when it is done. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useLive } from '../../state/live';
import { useUi } from '../../state/ui';
import { PairFlowController, type PairFlowState } from './pairFlow';
import type { PairProblem, PairTarget } from './pairing';

/** Long enough to see the slots turn green before the deck slides in. */
const SUCCESS_HOLD_MS = 700;

type Actions = Pick<
  PairFlowController,
  'choose' | 'typeDigit' | 'backspace' | 'pastePin' | 'retry' | 'offerLink' | 'confirmLink' | 'dismissLink' | 'pairAnyway' | 'keepSaved'
>;

export type PairFlow = PairFlowState & Actions;

function showPaired(name: string): void {
  useLive.getState().showToast({ tone: 'ok', title: `Paired with ${name}` });
  setTimeout(() => useUi.getState().finishPairing(), SUCCESS_HOLD_MS);
}

export function usePairFlow(initial: PairTarget | null, notice: PairProblem | null = null): PairFlow {
  const [controller] = useState(() => new PairFlowController(initial, { onPaired: showPaired }, notice));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useEffect(() => controller.leave, [controller]);
  return useMemo(
    () => ({
      ...state,
      choose: controller.choose,
      typeDigit: controller.typeDigit,
      backspace: controller.backspace,
      pastePin: controller.pastePin,
      retry: controller.retry,
      offerLink: controller.offerLink,
      confirmLink: controller.confirmLink,
      dismissLink: controller.dismissLink,
      pairAnyway: controller.pairAnyway,
      keepSaved: controller.keepSaved,
    }),
    [state, controller],
  );
}
