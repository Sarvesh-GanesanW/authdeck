import { create } from 'zustand';

/** Which authenticator surface is open. AuthHost renders it; anything can open one. */
export type AuthSurface = 'vault' | 'add-account' | 'intro' | 'recovery-setup' | 'restore' | 'join';

interface AuthUiState {
  surface: AuthSurface | null;
  /**
   * The vault screen, when a sheet was opened from it: closing the sheet goes back there rather
   * than to the deck (AuthHost shows one surface at a time).
   */
  returnTo: 'vault' | null;
  open(surface: AuthSurface): void;
  close(): void;
}

export const useAuthUi = create<AuthUiState>()((set) => ({
  surface: null,
  returnTo: null,
  open: (surface) =>
    set((s) => ({ surface, returnTo: surface !== 'vault' && (s.surface === 'vault' || (s.surface !== null && s.returnTo === 'vault')) ? 'vault' : null })),
  close: () => set((s) => ({ surface: s.surface !== 'vault' ? s.returnTo : null, returnTo: null })),
}));
