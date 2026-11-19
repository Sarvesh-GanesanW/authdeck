/**
 * Which env sheet is open. The section and the set sheet open them; EnvSheets draws them at the
 * vault screen's root and EnvHostSheets (in AuthHost) draws the join review. Secret-showing sheets
 * are SecureSheets, drawn in the app window, so they can't live inside the vault's scroll view.
 */
import { create } from 'zustand';

import type { RotateWords } from './view';

export type VariableSheetMode = { mode: 'add' } | { mode: 'edit'; name: string };

/** A yes/no question whose action may fail: the sheet stays open with the failure's sentence. */
export interface EnvConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => Promise<void>;
}

interface EnvSheetsState {
  /** The open set. Closing it closes everything opened from it. */
  setId: string | null;
  variable: VariableSheetMode | null;
  addMember: boolean;
  becomeOwner: boolean;
  /** After removing a member, taking a set over or fixing old-key values: what to rotate. */
  rotate: RotateWords | null;
  /** The owner's review of values under an old key. */
  oldKey: boolean;
  confirm: EnvConfirm | null;
  /** A teammate's join request picked from the list, shown by EnvHostSheets. */
  reviewJoinId: string | null;
  /** This phone's own join request whose owner words are being checked, by set. */
  ownerWordsSetId: string | null;
}

const CLOSED: EnvSheetsState = {
  setId: null,
  variable: null,
  addMember: false,
  becomeOwner: false,
  rotate: null,
  oldKey: false,
  confirm: null,
  reviewJoinId: null,
  ownerWordsSetId: null,
};

export const useEnvSheets = create<EnvSheetsState>()(() => CLOSED);

const set = (patch: Partial<EnvSheetsState>) => useEnvSheets.setState(patch);

export const envSheets = {
  openSet: (setId: string) => set({ ...CLOSED, setId }),
  closeSet: () => set({ setId: null, variable: null, addMember: false, becomeOwner: false, rotate: null, oldKey: false, confirm: null, ownerWordsSetId: null }),
  openVariable: (variable: VariableSheetMode) => set({ variable }),
  closeVariable: () => set({ variable: null }),
  setAddMember: (open: boolean) => set({ addMember: open }),
  setBecomeOwner: (open: boolean) => set({ becomeOwner: open }),
  showRotate: (rotate: RotateWords | null) => set({ rotate }),
  setOldKey: (open: boolean) => set({ oldKey: open }),
  confirm: (confirm: EnvConfirm | null) => set({ confirm }),
  reviewJoin: (requestId: string | null) => set({ reviewJoinId: requestId }),
  checkOwnerWords: (setId: string | null) => set({ ownerWordsSetId: setId }),
  closeAll: () => set(CLOSED),
};
