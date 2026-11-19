/**
 * Pairing logic that does not draw anything: who we are pairing with, the PIN exchange,
 * saving the result, and the words shown when it fails.
 */
import * as Device from 'expo-device';
import { Platform as RNPlatform } from 'react-native';

import type { PairRequest } from '../../link/handshakes';
import { parseLinkPublicKey } from '../../link/keys';
import { RequestError, pairWithPin, pairWithQr, plainRefusalWords } from '../../net/client';
import { connection } from '../../net/connection';
import { isAllowedHost, type PairLink } from '../../net/discovery';
import { deviceLinkKey } from '../../net/linkIdentity';
import { inTwoLines, keyWordsOf } from '../../net/linkState';
import {
  type PairingRoute,
  type PairingStart,
  type RefusalReason,
  type SavedConflict,
  acceptedIdentity,
  couldPassFor,
  decidePairing,
  isSameComputerName,
  sameLinkKey,
} from '../../net/trust';
import type { AgentInfo, DeviceForm, ErrorCode, Platform } from '../../protocol';
import { toBase64Url } from '../../vault/bytes';
import type { Computer } from '../../state/model';
import { useStore } from '../../state/store';

export const PIN_LENGTH = 6;

/** The command users run on the computer, as printed in docs/agent.md. */
export const AGENT_COMMAND = 'node authdeck-agent.cjs';

/** A computer we are about to pair with. Platform is unknown until it answers (QR links). */
export interface PairTarget {
  name: string;
  platform: Platform | null;
  hosts: string[];
  port: number;
  /** Known when it came from the network list, an address check or a re-pair; the computer must answer with it. */
  agentId: string | null;
  /** Where the person started: decides whether a PIN may re-key a computer saved before link keys. */
  startedFrom: PairingStart;
}

/**
 * A QR code or link. Scanned with this app's camera from a saved computer's Re-pair
 * (`repairAgentId`), it counts as started from that entry: the computer must answer with its id.
 * A link from another app never does.
 */
export function targetFromLink(link: PairLink, repairAgentId: string | null = null): PairTarget {
  const fromEntry = repairAgentId !== null && !link.fromOtherApp;
  return {
    name: link.name,
    platform: null,
    hosts: link.hosts,
    port: link.port,
    agentId: fromEntry ? repairAgentId : null,
    startedFrom: fromEntry ? 'saved' : link.fromOtherApp ? 'link' : 'qr',
  };
}

/** A saved computer's Re-pair. */
export function targetFromComputer(c: Computer): PairTarget {
  return { name: c.name, platform: c.platform, hosts: c.hosts, port: c.port, agentId: c.agentId, startedFrom: 'saved' };
}

/** The name the computer lists this device under (`devices` on the agent). */
function deviceName(): string {
  if (RNPlatform.OS === 'web') return 'AuthDeck in a browser';
  return Device.deviceName ?? Device.modelName ?? 'AuthDeck tablet';
}

function deviceForm(): DeviceForm | undefined {
  if (Device.deviceType === Device.DeviceType.PHONE) return 'phone';
  if (Device.deviceType === Device.DeviceType.TABLET) return 'tablet';
  return undefined;
}

function pairRequest(): PairRequest {
  const form = deviceForm();
  return { deviceId: useStore.getState().deviceId, deviceName: deviceName(), ...(form ? { form } : {}) };
}

/** A pairing the computer accepted, not saved yet. */
export interface PairResult {
  target: PairTarget;
  route: PairingRoute;
  agent: AgentInfo;
  host: string;
  /** The computer's link key the handshake proved, base64url. */
  linkKey: string;
}

/** Pairs by PIN: CPace with the PIN, then a handshake that swaps both link keys. */
export async function pairByPin(target: PairTarget, pin: string, signal?: AbortSignal): Promise<PairResult> {
  try {
    const { agent, agentKey, host } = await pairWithPin(target.hosts, target.port, pin, await deviceLinkKey(), pairRequest(), signal);
    return { target, route: 'pin', agent, host, linkKey: toBase64Url(agentKey) };
  } catch (e) {
    // Whoever answered a PIN is not proven to be a saved computer when it refuses.
    throw inAppWords(e);
  }
}

/** Pairs by QR code or link: it carries the computer's link key and a one-time secret. */
export async function pairByLink(link: PairLink, repairAgentId: string | null = null, signal?: AbortSignal): Promise<PairResult> {
  const agentKey = parseLinkPublicKey(link.agentKey);
  try {
    const { agent, host } = await pairWithQr(link.hosts, link.port, agentKey, link.secret, await deviceLinkKey(), pairRequest(), signal);
    return { target: targetFromLink(link, repairAgentId), route: link.fromOtherApp ? 'link' : 'qr', agent, host, linkKey: toBase64Url(agentKey) };
  } catch (e) {
    // A saved computer's key proves its refusal is its own; any other computer's words are not shown.
    throw savedComputerWithKey(link.agentKey, useStore.getState().computers) ? e : inAppWords(e);
  }
}

/** Refusals from a computer not saved here, in the app's own words for the code. */
const PAIRING_REFUSALS: Partial<Record<ErrorCode, { message: string; hint: string }>> = {
  unauthorized: { message: 'The computer did not accept this pairing.', hint: 'Scan the QR code the computer shows now, or type its PIN.' },
};
const PAIRING_REFUSED = {
  message: 'The computer did not pair with this device.',
  hint: 'Open the pairing screen in AuthDeck Agent on the computer and try again.',
};

function inAppWords(e: unknown): unknown {
  if (!(e instanceof RequestError) || !e.fromComputer) return e;
  const words = PAIRING_REFUSALS[e.code as ErrorCode] ?? plainRefusalWords(e.code) ?? PAIRING_REFUSED;
  return new RequestError(e.code, words.message, words.hint, true);
}

export const KEY_CHANGED_MESSAGE = "This isn't the computer you paired before. Only continue if you reinstalled or reset AuthDeck Agent on it.";

/** Said when a computer not saved here uses the name of one that is. */
export function nameClashMessage(name: string): string {
  return `You already have a computer called ${name}, and this is a different one. Only continue if you know why.`;
}

/** Asked when a computer saved before link keys is reached by QR code or link. */
export function legacyKeyQuestion(name: string): string {
  return `Do these words match the ones AuthDeck Agent shows on ${name}?`;
}

export { isSameComputerName, type SavedConflict };

const CONFLICT_MESSAGES: Record<SavedConflict, (saved: Computer) => string> = {
  key: () => KEY_CHANGED_MESSAGE,
  legacy: (saved) => legacyKeyQuestion(saved.name),
  name: (saved) => nameClashMessage(saved.name),
};

/**
 * The pairing would be mistaken for a saved computer: it answered with that computer's id but a
 * different key (`key`), it is a computer saved before link keys reached by QR code or link
 * (`legacy`), or it is a different computer using the same name (`name`). Ids and names are
 * public, so anything can claim them; the key is what identifies the computer. Holds the result
 * so the person can still save it on purpose, without pairing again (the computer has already
 * said yes).
 */
export class KeyChangedError extends Error {
  constructor(
    readonly result: PairResult,
    readonly saved: Computer,
    readonly conflict: SavedConflict = 'key',
  ) {
    super(CONFLICT_MESSAGES[conflict](saved));
    this.name = 'KeyChangedError';
  }
}

/** Both computers' key words, for a refusal where the person must tell them apart. */
export interface RefusalKeyWords {
  saved: string;
  answered: string;
}

function keyWordsBlock(name: string, words: RefusalKeyWords | undefined): string {
  if (!words) return '';
  return `\n\nKey words saved for ${name}:\n${inTwoLines(words.saved)}\n\nKey words of the computer that answered:\n${inTwoLines(words.answered)}`;
}

const REFUSAL_DETAILS: Record<RefusalReason, (name: string, words?: RefusalKeyWords) => string> = {
  name: () =>
    'The computer that answered gives a different name, so AuthDeck did not pair with it. Scan the QR code AuthDeck Agent shows on the computer you want, or type its PIN.',
  id: () =>
    'The computer that answered is not the one you picked, so AuthDeck did not pair with it. Scan the QR code AuthDeck Agent shows on the computer you want. ' +
    'If AuthDeck Agent was reset on it, pick it again from the network list.',
  // Only the id is known to differ: the answer may come from a reset agent or from another computer
  // (a QR code put in front of the person's Re-pair), so this is no reason to forget the saved one.
  reset: (name, words) =>
    `A computer with a different id answered. If you reset AuthDeck Agent on ${name}, forget it and pair it again.${keyWordsBlock(name, words)}`,
  'legacy-link': (name) => `To pair ${name} again, open it in Computers and tap Re-pair.`,
};

/**
 * A pairing refused outright by the trust rule (net/trust.ts): the QR code or link named one
 * computer and another answered (rule 3), the entry named one id and another answered (rule 0),
 * or a link from another app reached a computer saved before link keys (rule 2). Never saved, and
 * the words are the app's own: the answering computer's name is not shown.
 */
export class NameMismatchError extends Error {
  readonly detail: string;
  constructor(
    readonly named: string,
    readonly reason: RefusalReason = 'name',
    keyWords?: RefusalKeyWords,
  ) {
    super(reason === 'name' || reason === 'id' ? `This isn't ${named}.` : `Did not pair with ${named}.`);
    this.name = 'NameMismatchError';
    this.detail = REFUSAL_DETAILS[reason](named, keyWords);
  }
}

/** The saved computer with this link key, if any: the link's key is what identifies the computer. */
export function savedComputerWithKey(linkKey: string, computers: Computer[]): Computer | null {
  return computers.find((c) => !!c.linkKey && sameLinkKey(c.linkKey, linkKey)) ?? null;
}

/** A saved computer whose name could be taken for any of `names` (see couldPassFor). */
export function savedComputerNamed(names: string[], computers: Computer[]): Computer | null {
  return computers.find((c) => names.some((name) => couldPassFor(name, c.name))) ?? null;
}

/**
 * Whether a pairing link names a computer saved here (matched by its key, which the link carries),
 * or a new one; a new one may still use a saved computer's name.
 */
export type LinkStanding = { kind: 'saved'; computer: Computer } | { kind: 'new'; lookAlike: Computer | null };

export function linkStanding(link: PairLink, computers: Computer[]): LinkStanding {
  const saved = savedComputerWithKey(link.agentKey, computers);
  return saved ? { kind: 'saved', computer: saved } : { kind: 'new', lookAlike: savedComputerNamed([link.name], computers) };
}

/** Shown on a link that arrived from another app rather than this app's camera. */
export const OTHER_APP_LINK_NOTICE = 'This link came from another app. Pair only if you just opened it from AuthDeck Agent on your computer.';

export interface SaveChoice {
  /** The conflict question the person saw and answered with "pair anyway". Covers that conflict only. */
  confirmed?: SavedConflict;
  /** The person chose this computer (tapped Pair, typed its PIN): switch to it. */
  activate?: boolean;
}

/**
 * Stores the computer and returns its name; it becomes the active computer only when `activate`
 * says the person chose it. A known computer keeps its deck (a re-pair, or the same QR scanned
 * twice); a new one gets its starter deck from connection.ts once online. Whether it may be
 * saved is decided by `decidePairing` (net/trust.ts): throws `NameMismatchError` when the QR code
 * or link named another computer, and `KeyChangedError` when it could be mistaken for a saved
 * computer, unless the person `confirmed` that very conflict.
 */
export function savePairing(result: PairResult, { confirmed, activate = false }: SaveChoice = {}): string {
  const { target, agent, host, linkKey } = result;
  const store = useStore.getState();
  const decision = decidePairing(
    {
      route: result.route,
      startedFrom: target.startedFrom,
      named: target.name,
      expectedAgentId: target.agentId,
      agentId: agent.agentId,
      agentName: agent.name,
      linkKey,
    },
    store.computers,
  );
  if (decision.kind === 'refuse') {
    const saved = decision.saved ?? store.computers.find((c) => c.agentId === target.agentId) ?? null;
    const words = decision.reason === 'reset' ? { saved: savedKeyWords(saved), answered: keyWordsOf(linkKey) } : undefined;
    throw new NameMismatchError(saved?.name ?? target.name, decision.reason, words);
  }
  if (decision.kind === 'ask' && decision.conflict !== confirmed) throw new KeyChangedError(result, decision.saved, decision.conflict);
  const hosts = [host, ...target.hosts.filter((h) => h !== host)].filter(isAllowedHost).slice(0, 6);
  const wasActive = store.activeId === agent.agentId;
  const known = store.computers.find((c) => c.agentId === agent.agentId);
  const identity = known ? acceptedIdentity(known, agent, store.computers) : { name: agent.name, platform: agent.platform };
  const fresh = { linkKey, hosts, port: target.port, ...identity };
  if (known) store.updateComputer(agent.agentId, fresh);
  else store.addComputer({ agentId: agent.agentId, pairedAt: Date.now(), ...fresh }, null);
  if (activate && !wasActive) store.setActive(agent.agentId);
  // Switching computers reconnects by itself; staying on the same one needs a nudge to use the new key.
  if (wasActive) connection.restart();
  return identity.name;
}

/** Shown in place of the saved key words for a computer saved before link keys. */
export const NO_SAVED_KEY_WORDS = 'none (saved before AuthDeck used keys)';

/** A saved computer's key words, or why there are none to show. */
function savedKeyWords(saved: Computer | null): string {
  if (!saved?.linkKey) return NO_SAVED_KEY_WORDS;
  try {
    return keyWordsOf(saved.linkKey);
  } catch {
    return 'unreadable';
  }
}

/** What the conflict question shows: the saved key words beside the new ones. */
export function keyChangeWords(e: KeyChangedError): { name: string; conflict: SavedConflict; message: string; savedWords: string; newWords: string } {
  return { name: e.saved.name, conflict: e.conflict, message: e.message, savedWords: savedKeyWords(e.saved), newWords: keyWordsOf(e.result.linkKey) };
}

export interface PairProblem {
  kind: 'bad_pin' | 'locked' | 'unreachable' | 'other';
  title: string;
  detail?: string;
}

/** Said when the computer takes no PIN: its pairing window is closed (or paused after wrong PINs). */
export function pairingClosedWords(name: string): { title: string; detail: string } {
  return {
    title: `${name} isn't taking a PIN right now.`,
    detail: `Open pairing in AuthDeck Agent on ${name} (or run "authdeck-agent pair" there). If it says pairing is paused, wait, then type the new PIN.`,
  };
}

/** Shown when the pairing screen opens because the computer unpaired this device. */
export function unpairedNotice(name: string): PairProblem {
  return {
    kind: 'other',
    title: `${name} unpaired this device.`,
    detail: `Open pairing in AuthDeck Agent on ${name}, then type the PIN it shows. Your pages stay as they are.`,
  };
}

export function describePairError(e: unknown, target: PairTarget): PairProblem {
  if (!(e instanceof RequestError)) {
    return {
      kind: 'other',
      title: 'Pairing stopped unexpectedly.',
      detail: e instanceof Error ? `${e.message} Try again.` : 'Try again.',
    };
  }
  switch (e.code) {
    case 'bad_pin':
      return {
        kind: 'bad_pin',
        title: e.message,
        detail: e.hint ?? `Type the 6-digit PIN shown in the AuthDeck agent window on ${target.name}.`,
      };
    case 'locked':
      return { kind: 'locked', ...pairingClosedWords(target.name) };
    case 'version':
      return { kind: 'other', title: e.message, detail: e.hint };
    case 'offline':
    case 'timeout':
      return {
        kind: 'unreachable',
        title: `Could not reach ${target.name}.`,
        detail:
          'Check that the agent is still running and that both devices are on the same Wi-Fi. ' +
          'On Windows, allow Node.js through the firewall on private networks.',
      };
    default:
      return { kind: 'other', title: e.message, detail: e.hint ?? 'Try again.' };
  }
}
