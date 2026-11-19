/** Cross-screen UI state that is not persisted. */
import { create } from 'zustand';

import type { PairLink } from '../net/discovery';

/** Why a saved computer is being paired again: `unpaired` when the computer refused this device. */
export type RepairReason = 'unpaired' | null;

interface Ui {
  /** Show the pairing screen even though a computer is already paired. */
  pairing: boolean;
  /** A pairing link that arrived from a QR code or deep link. */
  pairLink: PairLink | null;
  /** Re-pair this computer (its token was refused). */
  repairAgentId: string | null;
  repairReason: RepairReason;
  startPairing: (link?: PairLink | null, repairAgentId?: string | null, reason?: RepairReason) => void;
  finishPairing: () => void;
}

export const useUi = create<Ui>()((set) => ({
  pairing: false,
  pairLink: null,
  repairAgentId: null,
  repairReason: null,
  startPairing: (link = null, repairAgentId = null, reason = null) =>
    set({ pairing: true, pairLink: link, repairAgentId, repairReason: repairAgentId ? reason : null }),
  finishPairing: () => set({ pairing: false, pairLink: null, repairAgentId: null, repairReason: null }),
}));

/**
 * The active computer refused this device (it was unpaired there): open the pairing screen for it,
 * unless the person is already pairing. Returns whether the pairing screen was opened.
 */
export function showUnpaired(agentId: string): boolean {
  const ui = useUi.getState();
  if (ui.pairing) return false;
  ui.startPairing(null, agentId, 'unpaired');
  return true;
}
