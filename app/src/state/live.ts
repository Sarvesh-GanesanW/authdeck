/**
 * Live, non-persisted state: connection status, what the computer reports, key run states, toasts.
 */
import { create } from 'zustand';

import type { AgentInfo, AppEntry, AppIcon, FocusInfo } from '../protocol';

export type ConnStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'unauthorized';
export type KeyRunState = 'run' | 'ok' | 'fail';

export interface CommandOutput {
  title: string;
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

export interface Toast {
  id: number;
  tone: 'ok' | 'fail' | 'info';
  title: string;
  detail?: string;
  output?: CommandOutput;
  /** A button on the banner, e.g. Undo. */
  action?: { label: string; run: () => void };
}

interface Live {
  status: ConnStatus;
  agent: AgentInfo | null;
  /** Address currently in use. */
  host: string | null;
  focus: FocusInfo | null;
  apps: AppEntry[] | null;
  appsError: string | null;
  icons: Record<string, AppIcon | null>;
  keyStates: Record<string, KeyRunState>;
  /** Bumped each time a key fails, so the key can shake once. */
  failTicks: Record<string, number>;
  toast: Toast | null;
  /** Output sheet currently open. */
  output: CommandOutput | null;

  setStatus: (status: ConnStatus) => void;
  setKeyState: (keyId: string, state: KeyRunState | null) => void;
  showToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
  showOutput: (o: CommandOutput | null) => void;
}

let toastSeq = 0;
/** Timers that clear a key's ok or fail light. */
const lightTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useLive = create<Live>()((set) => ({
  status: 'idle',
  agent: null,
  host: null,
  focus: null,
  apps: null,
  appsError: null,
  icons: {},
  keyStates: {},
  failTicks: {},
  toast: null,
  output: null,

  setStatus: (status) => set({ status }),
  setKeyState: (keyId, state) => {
    const t = lightTimers.get(keyId);
    if (t) clearTimeout(t);
    set((s) => {
      const keyStates = { ...s.keyStates };
      if (state) keyStates[keyId] = state;
      else delete keyStates[keyId];
      const failTicks = state === 'fail' ? { ...s.failTicks, [keyId]: (s.failTicks[keyId] ?? 0) + 1 } : s.failTicks;
      return { keyStates, failTicks };
    });
    if (state === 'ok' || state === 'fail') {
      lightTimers.set(
        keyId,
        setTimeout(() => useLive.getState().setKeyState(keyId, null), state === 'ok' ? 2000 : 4000),
      );
    }
  },
  showToast: (t) => set({ toast: { ...t, id: ++toastSeq } }),
  dismissToast: (id) => set((s) => (s.toast?.id === id ? { toast: null } : s)),
  showOutput: (output) => set({ output }),
}));
