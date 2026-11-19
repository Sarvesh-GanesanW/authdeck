/**
 * When the app trusts a computer: one rule, used by every pairing path (QR code, link, PIN, a
 * pairing that finishes unattended) and by every connect (connection.ts).
 *
 * 0. Ids must agree: a pairing started from an entry that named the computer's id (a saved
 *    computer's Re-pair, the network list, a typed address, both read from /hello) and answered
 *    by a computer giving another id is refused. From a saved computer's Re-pair, its agent may
 *    have been reset, or another computer answered: the person sees both computers' key words and
 *    is told to forget it and pair again only if they reset it.
 * 1. A key is pinned: a saved computer with a link key is that key. Another key for its id is a
 *    key conflict, asked about.
 * 2. A computer saved before link keys (no `linkKey`) takes a key without question only through a
 *    pairing the person started from that saved entry (its Re-pair, by PIN or by this app's camera).
 *    A link from another app is refused for it outright. Anything else, a PIN typed
 *    for a computer picked from the network list included, asks the person to compare key words:
 *    the PIN proves which screen the person read, not that the screen belongs to the saved computer.
 * 3. Names must agree: a QR code or link that names one computer, answered by a computer giving
 *    another name, is refused. This holds when the id matches a saved computer too.
 * 4. Names are compared by skeleton (`nameSkeleton`, UTS #39 confusables without case or
 *    punctuation), so characters that draw nothing, look-alike letters (ASCII ones too) and
 *    apostrophes don't make two names differ. A name clashes with a saved one when the skeletons
 *    are equal or one starts with the other (`couldPassFor`): a long name cut off reads as a shorter one.
 * 5. A rename or platform change reported on connect is kept only when the new name does not
 *    clash with another saved computer. A computer that gives another id under its pinned key is
 *    not the saved computer: connection.ts counts that attempt as failed.
 */
import { parseLinkPublicKey } from '../link/keys';
import type { Platform } from '../protocol';
import type { Computer } from '../state/model';
import { toBase64Url } from '../vault/bytes';
import { isHighlyRestrictive, readingSkeleton, withoutInvisible } from './unicodeNames';

/**
 * A name as stored and shown: without characters that draw nothing (control characters included),
 * trimmed, and at most 64 characters (as the agent allows). Whitespace becomes a space first, so a
 * tab or line break still separates two words.
 */
export const MAX_COMPUTER_NAME_CHARS = 64;

/**
 * How much of a raw name cleanName reads, in UTF-16 units: four per kept character leaves room for
 * surrogate pairs and some invisible characters, and keeps cleaning a name of megabytes (from a
 * link, or saved by an older build) as cheap as cleaning a short one.
 */
const MAX_RAW_NAME_UNITS = 4 * MAX_COMPUTER_NAME_CHARS;

/** The first `units` UTF-16 units of `text`, without a high surrogate cut from its pair. */
function leadingUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  const lastKept = text.charCodeAt(units - 1);
  const splitsPair = lastKept >= 0xd800 && lastKept <= 0xdbff;
  return text.slice(0, splitsPair ? units - 1 : units);
}

export function cleanName(name: string): string {
  const bounded = leadingUnits(name, MAX_RAW_NAME_UNITS);
  const cleaned = withoutInvisible(bounded.replace(/\s+/g, ' ')).replace(/ +/g, ' ').trim();
  return Array.from(cleaned).slice(0, MAX_COMPUTER_NAME_CHARS).join('').trim();
}

/** A name reduced to how it reads, so two names a person can't tell apart compare equal. */
export function nameSkeleton(name: string): string {
  return readingSkeleton(name);
}

export function isSameComputerName(a: string, b: string): boolean {
  return nameSkeleton(a) === nameSkeleton(b);
}

/**
 * Whether one name could be taken for the other: the same skeleton, or one non-empty skeleton
 * starting with the other. A list too narrow for a long name shows only its start, so
 * "Ada's MacBook Pro (spare)" must not join a saved "Ada's MacBook Pro" unasked.
 */
export function couldPassFor(a: string, b: string): boolean {
  const first = nameSkeleton(a);
  const second = nameSkeleton(b);
  if (first === second) return true;
  return first !== '' && second !== '' && (first.startsWith(second) || second.startsWith(first));
}

/**
 * True when the name mixes scripts in a way UTS #39 does not allow for Highly Restrictive
 * identifiers (Latin with Cyrillic, Greek, Cherokee, Lisu...), the usual look-alike trick.
 */
export function mixesAlphabets(name: string): boolean {
  return !isHighlyRestrictive(cleanName(name));
}

export const MIXED_ALPHABETS_WARNING = 'This name mixes letters from different alphabets.';

export function sameLinkKey(a: string, b: string): boolean {
  try {
    return toBase64Url(parseLinkPublicKey(a)) === toBase64Url(parseLinkPublicKey(b));
  } catch {
    return false;
  }
}

/** How the computer was reached: a PIN typed from its screen, the app's camera, or a link from elsewhere. */
export type PairingRoute = 'pin' | 'qr' | 'link';

/**
 * Where the person started the pairing: a saved computer's Re-pair (by PIN, or by scanning its QR
 * code with this app's camera), a computer picked from the network list, a typed address, or a
 * QR code or link.
 */
export type PairingStart = 'saved' | 'network' | 'address' | 'qr' | 'link';

/** Why a pairing needs the person's decision before it is saved. */
export type SavedConflict =
  /** A saved computer's id, with another key. */
  | 'key'
  /** A computer saved before link keys, not re-paired from its own entry: its key words must be compared. */
  | 'legacy'
  /** Another computer using a saved computer's name. */
  | 'name';

/** What one finished pairing handshake claims. */
export interface PairingClaim {
  route: PairingRoute;
  startedFrom: PairingStart;
  /** The name the person picked: the QR code's or link's, or the listed computer's for a PIN. */
  named: string;
  /** The id the starting entry named (the saved computer's, or /hello's), or null for a QR code or link. */
  expectedAgentId: string | null;
  /** Who answered, as the handshake reported it. */
  agentId: string;
  agentName: string;
  /** The computer's link key the handshake proved, base64url. */
  linkKey: string;
}

/** Why a pairing is refused outright. */
export type RefusalReason =
  /** The QR code or link named another computer than the one that answered. */
  | 'name'
  /** The network list or typed address named another computer than the one that answered. */
  | 'id'
  /** A saved computer's Re-pair was answered with another id: its agent was reset, or another computer answered. */
  | 'reset'
  /** A link from another app answered by a computer saved before link keys: only its own Re-pair may re-key it. */
  | 'legacy-link';

export type TrustDecision =
  /** Save it; `known` is the saved entry it updates, if any. */
  | { kind: 'trust'; known: Computer | null }
  /** Never saved. */
  | { kind: 'refuse'; reason: RefusalReason; saved?: Computer }
  /** Save only if the person says so. */
  | { kind: 'ask'; conflict: SavedConflict; saved: Computer };

/** Another saved computer (not `agentId`) whose name could be taken for `name`. */
function namesake(name: string, agentId: string | null, computers: Computer[]): Computer | null {
  return computers.find((c) => c.agentId !== agentId && couldPassFor(c.name, name)) ?? null;
}

/** The rule above, for one pairing. Pure: the caller saves, asks or refuses. */
export function decidePairing(claim: PairingClaim, computers: Computer[]): TrustDecision {
  if (claim.expectedAgentId !== null && claim.expectedAgentId !== claim.agentId) {
    return { kind: 'refuse', reason: claim.startedFrom === 'saved' ? 'reset' : 'id' };
  }
  // A PIN pairing's target name came from the unauthenticated network list, so only a QR code or
  // link (whose key the handshake proved) makes a name promise.
  if (claim.route !== 'pin' && !isSameComputerName(claim.named, claim.agentName)) return { kind: 'refuse', reason: 'name' };
  const sameId = computers.find((c) => c.agentId === claim.agentId) ?? null;
  if (sameId?.linkKey) {
    return sameLinkKey(sameId.linkKey, claim.linkKey) ? { kind: 'trust', known: sameId } : { kind: 'ask', conflict: 'key', saved: sameId };
  }
  if (sameId) {
    // Saved before link keys: nothing proves this is the same computer. A link from another app
    // never re-keys it; its own Re-pair (PIN, or this app's camera) does; anything else asks.
    if (claim.route === 'link') return { kind: 'refuse', reason: 'legacy-link', saved: sameId };
    const repairedFromItsEntry = claim.startedFrom === 'saved';
    return repairedFromItsEntry ? { kind: 'trust', known: sameId } : { kind: 'ask', conflict: 'legacy', saved: sameId };
  }
  const lookAlike = namesake(claim.named, null, computers) ?? namesake(claim.agentName, null, computers);
  return lookAlike ? { kind: 'ask', conflict: 'name', saved: lookAlike } : { kind: 'trust', known: null };
}

/**
 * The name and platform to keep for a saved computer that reports `reported`: its own, cleaned,
 * unless that name reads like another saved computer's, in which case the saved ones stay.
 */
export function acceptedIdentity(
  saved: Pick<Computer, 'agentId' | 'name' | 'platform'>,
  reported: { name: string; platform: Platform },
  computers: Computer[],
): { name: string; platform: Platform } {
  const name = cleanName(reported.name);
  if (!name || namesake(name, saved.agentId, computers)) return { name: cleanName(saved.name) || saved.name, platform: saved.platform };
  return { name, platform: reported.platform };
}
