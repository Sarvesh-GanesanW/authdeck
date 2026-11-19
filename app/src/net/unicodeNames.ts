/**
 * Unicode rules for computer names, from tables generated out of the Unicode data (see
 * unicodeTables.ts and scripts/gen-unicode-tables.mjs), so they don't depend on the JS engine's
 * own Unicode tables:
 *
 * - which characters draw nothing (`drawsNothing`);
 * - how a name reads (`readingSkeleton`): the UTS #39 skeleton, without case or punctuation,
 *   after NFKD with marks, blanks and spaces removed;
 * - whether a name keeps to one script or an accepted combination (`isHighlyRestrictive`, UTS #39
 *   section 5.2).
 */
import { CONFUSABLE_ENTRIES, DRAWS_NOTHING_RANGES, MARK_RANGES, PUNCTUATION_RANGES, SCRIPT_RANGES, SCRIPT_SETS } from './unicodeTables';

type Range = readonly [start: number, end: number, value: number];

const BASE = 36;

/** Decodes "gap.length[.value]" tokens into sorted, inclusive ranges. */
function decodeRanges(encoded: string): Range[] {
  let next = 0;
  return encoded.split(',').map((token) => {
    const [gap, length, value] = token.split('.').map((part) => parseInt(part, BASE)) as [number, number, number?];
    const start = next + gap;
    next = start + length;
    return [start, next - 1, value ?? 0];
  });
}

/** The range holding `cp`, by binary search. */
function rangeOf(ranges: readonly Range[], cp: number): Range | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid]!;
    if (cp < range[0]) high = mid - 1;
    else if (cp > range[1]) low = mid + 1;
    else return range;
  }
  return null;
}

function decodeConfusables(encoded: string): Map<number, string> {
  const readings = new Map<number, string>();
  let cp = 0;
  for (const token of encoded.split(',')) {
    const [delta, reading] = token.split('.') as [string, string];
    cp += parseInt(delta, BASE);
    readings.set(cp, reading ? String.fromCodePoint(...reading.split(':').map((part) => parseInt(part, BASE))) : '');
  }
  return readings;
}

/** Decoded on first use: the tables are only needed when a name is checked. */
let tables: { drawsNothing: Range[]; marks: Range[]; punctuation: Range[]; scripts: Range[]; readings: Map<number, string> } | null = null;
function loaded() {
  tables ??= {
    drawsNothing: decodeRanges(DRAWS_NOTHING_RANGES),
    marks: decodeRanges(MARK_RANGES),
    punctuation: decodeRanges(PUNCTUATION_RANGES),
    scripts: decodeRanges(SCRIPT_RANGES),
    readings: decodeConfusables(CONFUSABLE_ENTRIES),
  };
  return tables;
}

const codePoints = (text: string): number[] => Array.from(text, (char) => char.codePointAt(0)!);

/** Default-ignorable, format and control characters, and blanks that draw nothing (U+2800, the Hangul fillers, U+FFFC). */
export function drawsNothing(cp: number): boolean {
  return rangeOf(loaded().drawsNothing, cp) !== null;
}

const isMark = (cp: number): boolean => rangeOf(loaded().marks, cp) !== null;
const isPunctuation = (char: string): boolean => rangeOf(loaded().punctuation, char.codePointAt(0)!) !== null;
const isSpace = (char: string): boolean => /\s/.test(char);

/** `text` without the characters that draw nothing. */
export function withoutInvisible(text: string): string {
  return Array.from(text)
    .filter((char) => !drawsNothing(char.codePointAt(0)!))
    .join('');
}

/** Compatibility-decomposed, without marks, spaces or characters that draw nothing. */
function reduced(text: string): string {
  return Array.from(text.normalize('NFKD'))
    .filter((char) => {
      const cp = char.codePointAt(0)!;
      return !drawsNothing(cp) && !isMark(cp) && !isSpace(char);
    })
    .join('');
}

/**
 * How `name` reads: two names a person can't tell apart get the same skeleton. Spaces don't
 * count, so a blank that draws a gap matches a space, and neither do case, accents or punctuation
 * ("Ada's" and "Adas" read alike).
 */
export function readingSkeleton(name: string): string {
  const { readings } = loaded();
  const read = Array.from(reduced(name), (char) => readings.get(char.codePointAt(0)!) ?? char.toLowerCase()).join('');
  // Lowercasing can bring back a dot (İ); the generator settled everything else. Punctuation goes
  // last, after the readings, so a punctuation mark that reads as a letter (׀ as l) still counts.
  return Array.from(reduced(read))
    .filter((char) => !isPunctuation(char))
    .join('');
}

/** Script codes UTS #39 adds to a character's set, so Han mixes with each writing system that uses it. */
const AUGMENTED: Record<string, readonly string[]> = {
  Hani: ['Hanb', 'Jpan', 'Kore'],
  Hira: ['Jpan'],
  Kana: ['Jpan'],
  Hang: ['Kore'],
  Bopo: ['Hanb'],
};
/** Common and Inherited characters go with any script. */
const ANY_SCRIPT = new Set(['Zyyy', 'Zinh']);
const UNKNOWN_SCRIPT = 'Zzzz';
/** The combinations Highly Restrictive allows beside Latin: Japanese, Chinese with Bopomofo, Korean. */
const WITH_LATIN = ['Jpan', 'Hanb', 'Kore'];

/** The augmented Script_Extensions of each character that has a script of its own. */
function scriptSets(text: string): Set<string>[] {
  const { scripts } = loaded();
  const sets: Set<string>[] = [];
  for (const cp of codePoints(text)) {
    const range = rangeOf(scripts, cp);
    const codes = range ? SCRIPT_SETS[range[2]]!.split(' ') : [UNKNOWN_SCRIPT];
    if (codes.every((code) => ANY_SCRIPT.has(code))) continue;
    sets.push(new Set(codes.flatMap((code) => [code, ...(AUGMENTED[code] ?? [])])));
  }
  return sets;
}

function intersect(sets: Set<string>[]): Set<string> | null {
  if (sets.length === 0) return null;
  return sets.reduce((shared, set) => new Set([...shared].filter((code) => set.has(code))));
}

/**
 * UTS #39 Highly Restrictive: the whole name is in one script, or it is Latin with Japanese,
 * Chinese with Bopomofo, or Korean. Anything else (Latin with Cyrillic, Greek, Cherokee or Lisu)
 * is a name a look-alike could hide in.
 */
export function isHighlyRestrictive(name: string): boolean {
  const sets = scriptSets(name);
  const shared = intersect(sets);
  if (shared === null || shared.size > 0) return true;
  const nonLatin = intersect(sets.filter((set) => !set.has('Latn')));
  return nonLatin !== null && WITH_LATIN.some((code) => nonLatin.has(code));
}
