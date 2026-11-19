import type { Action, Platform } from '../protocol';
import type { CapColor } from '../theme/colorways';

export type KeyIcon =
  // A pixel icon name such as "git-branch". Older decks may hold names from a previous icon set; see resolveGlyph.
  | { kind: 'glyph'; name: string }
  // The app's own icon, fetched from the computer.
  | { kind: 'app'; appId: string }
  | { kind: 'none' };

/** A 2FA key's account in the vault. The key shows its live code and types it when tapped. */
export interface OtpLink {
  /** Empty while the user has not picked an account yet. */
  accountId: string;
}

export interface DeckKey {
  id: string;
  label: string;
  icon: KeyIcon;
  color: CapColor;
  /** null until the user picks what the key does, and always null on a 2FA key. */
  action: Action | null;
  /** Set on a 2FA key instead of an action. */
  otp?: OtpLink;
}

export type Slot = DeckKey | null;

export interface FocusLink {
  appId: string;
  appName: string;
}

export interface Page {
  id: string;
  name: string;
  /** Ordered slots. The screen picks how many columns to show them in. */
  slots: Slot[];
  /** Default folder for commands on this page. */
  cwd?: string;
  /** Bring this page forward when this app is in front on the computer. */
  focusApp?: FocusLink | null;
  /** A 2FA page: its empty spots add vault accounts instead of keys. */
  otp?: boolean;
  /**
   * Set on the 2FA page every deck is given: the vault accounts already offered to it. Accounts
   * not in it are added while the page has room; one the person removed is not put back.
   */
  autoAccounts?: string[];
}

export interface Deck {
  pages: Page[];
  /** The deck was given its 2FA page once; it is never added again, even after it was deleted. */
  twoFaOffered?: true;
}

export interface Computer {
  agentId: string;
  name: string;
  platform: Platform;
  /** Addresses to try, most recently successful first. */
  hosts: string[];
  port: number;
  /** The computer's static link key (base64url), from its QR code or the PIN handshake. Missing
   *  on a computer paired before the connection was encrypted: it must be paired again. */
  linkKey?: string;
  pairedAt: number;
}

export const MIN_SLOTS = 4;
export const MAX_SLOTS = 48;
export const DEFAULT_SLOTS = 28;

export function newId(prefix = ''): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function emptyPage(name: string, size = DEFAULT_SLOTS): Page {
  return { id: newId('p'), name, slots: Array.from({ length: size }, () => null), focusApp: null };
}

export function resizeSlots(slots: Slot[], size: number): Slot[] {
  const n = Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, Math.round(size)));
  if (n >= slots.length) return [...slots, ...Array.from({ length: n - slots.length }, () => null)];
  // Shrinking: keep every key. Drop empty slots from the end first, then from anywhere.
  const out = [...slots];
  for (let i = out.length - 1; i >= 0 && out.length > n; i--) {
    if (out[i] === null) out.splice(i, 1);
  }
  return out;
}
