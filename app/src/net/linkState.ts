/** What the app says about a paired computer's encrypted link, for the computer settings sheet. */
import { linkKeyWords, parseLinkPublicKey } from '../link/keys';
import type { Computer } from '../state/model';
import { needsRepair } from '../state/store';

export type ComputerLink =
  /** Paired before the connection was encrypted: it must pair once more. */
  | { kind: 'repair'; title: string; detail: string }
  /** The computer's key, as six words to compare with its pairing screen. */
  | { kind: 'linked'; keyWords: string };

const WORD_SEPARATOR = ' · ';

/** A link key as the six words both screens show: "word · word · … · word", on one line. */
export function keyWordsOf(linkKey: string): string {
  return linkKeyWords(parseLinkPublicKey(linkKey)).join(WORD_SEPARATOR);
}

/** Key words as two lines of three: every screen shows them this way, so no word is ever cut off. */
export function keyWordLines(keyWords: string): string[] {
  const words = keyWords.split(WORD_SEPARATOR);
  if (words.length <= 3) return [keyWords];
  return [words.slice(0, 3).join(WORD_SEPARATOR), words.slice(3).join(WORD_SEPARATOR)];
}

/** keyWordLines as one text with a line break, for messages. */
export function inTwoLines(keyWords: string): string {
  return keyWordLines(keyWords).join('\n');
}

export const REPAIR_TITLE = 'Pair again: AuthDeck now encrypts the connection';

export function computerLink(computer: Computer): ComputerLink {
  if (needsRepair(computer)) {
    return {
      kind: 'repair',
      title: REPAIR_TITLE,
      detail: `${computer.name} was paired before the connection was encrypted. Pair it once more; its keys and pages stay.`,
    };
  }
  try {
    return { kind: 'linked', keyWords: keyWordsOf(computer.linkKey!) };
  } catch {
    // Drawn on screens: a key that no longer reads asks for a re-pair instead of crashing them.
    return { kind: 'repair', title: DAMAGED_KEY_TITLE, detail: `The key saved for ${computer.name} is damaged. Pair it again; its keys and pages stay.` };
  }
}

export const DAMAGED_KEY_TITLE = 'Pair again: the saved key is damaged';
