// Generates src/net/unicodeTables.ts (and test/confusableSample.ts) from the Unicode Character
// Database and the UTS #39 security data, pinned to one Unicode version. The app uses the tables
// to compare computer names by how they read (nameSkeleton), to drop characters that draw nothing,
// and for the UTS #39 Highly Restrictive mixed-script check, without relying on the JS engine's
// own Unicode tables.
//
// Inputs are Unicode data files, licensed under the Unicode License v3
// (https://www.unicode.org/license.txt); the generated files carry the same notice.
//
// Run (the files go in a folder of their own, outside the repo):
//   V=16.0.0; D=$(mktemp -d)
//   curl -sfSL -o $D/confusables.txt https://www.unicode.org/Public/security/$V/confusables.txt
//   for f in DerivedCoreProperties.txt ScriptExtensions.txt Scripts.txt PropertyValueAliases.txt UnicodeData.txt extracted/DerivedGeneralCategory.txt; do
//     curl -sfSL -o $D/$(basename $f) https://www.unicode.org/Public/$V/ucd/$f; done
//   node scripts/gen-unicode-tables.mjs $D
//
// The output is deterministic: running it again on the same files writes byte-identical files.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNICODE_VERSION = '16.0.0';
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const TABLES_OUT = join(APP_DIR, 'src', 'net', 'unicodeTables.ts');
const SAMPLE_OUT = join(APP_DIR, 'test', 'confusableSample.ts');
/** At least this many confusables.txt pairs go into the test sample. */
const SAMPLE_SIZE = 240;

/**
 * Draw nothing, but are not Default_Ignorable_Code_Point (or are, and listed for the record):
 * the Braille blank, the musical null notehead, the Hangul fillers, and the object replacement
 * character (a placeholder for an embedded object, which a name never has).
 */
const EXTRA_DRAWS_NOTHING = [0x2800, 0x1d159, 0x115f, 0x1160, 0x3164, 0xffa0, 0xfffc];

/** Apostrophe look-alikes that confusables.txt maps elsewhere or not at all; folded to "'". */
const EXTRA_SAME = [[0x27, 0x2018, 0x2019, 0x201b, 0x2b9, 0x2bc, 0x2032, 0x60, 0xb4]];

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('Usage: node scripts/gen-unicode-tables.mjs <folder holding the Unicode data files>');
  process.exit(1);
}

function readData(name) {
  const text = readFileSync(join(dataDir, name), 'utf8');
  if (!['PropertyValueAliases.txt', 'UnicodeData.txt'].includes(name) && !text.includes(`-${UNICODE_VERSION}`) && !text.includes(`Version: ${UNICODE_VERSION}`)) {
    const dated = text.split('\n', 3).join(' ');
    // confusables.txt carries only a date; the URL pins its version.
    if (name !== 'confusables.txt') throw new Error(`${name} is not Unicode ${UNICODE_VERSION}: ${dated}`);
  }
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(';').map((field) => field.trim()));
}

const hex = (h) => parseInt(h, 16);

function parseRange(field) {
  const [start, end] = field.split('..').map(hex);
  return [start, end ?? start];
}

/** Code points whose property field (column 1) is one of `values`. */
function rangesWith(rows, values) {
  return rows.filter((row) => values.includes(row[1])).map((row) => parseRange(row[0]));
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

const inRanges = (ranges) => {
  const set = new Set();
  for (const [s, e] of ranges) for (let cp = s; cp <= e; cp++) set.add(cp);
  return set;
};

/** "gap.length" per range, base 36, gap from the end of the previous range. */
function encodeRanges(ranges) {
  let next = 0;
  return ranges
    .map(([start, end]) => {
      const token = `${(start - next).toString(36)}.${(end - start + 1).toString(36)}`;
      next = end + 1;
      return token;
    })
    .join(',');
}

// --- Characters that draw nothing, and combining marks -------------------------------------------

const coreProps = readData('DerivedCoreProperties.txt');
const generalCategory = readData('DerivedGeneralCategory.txt');
const drawsNothingRanges = mergeRanges([
  ...rangesWith(coreProps, ['Default_Ignorable_Code_Point']),
  ...rangesWith(generalCategory, ['Cf']),
  // Control characters (C0, DEL, C1): a name has no use for them, and most draw nothing.
  ...rangesWith(generalCategory, ['Cc']),
  ...EXTRA_DRAWS_NOTHING.map((cp) => [cp, cp]),
]);
const markRanges = mergeRanges(rangesWith(generalCategory, ['Mn', 'Me']));
// Punctuation (every P* category): left out of a name's reading, so "Ada's" and "Adas" read alike.
const punctuationRanges = mergeRanges(rangesWith(generalCategory, ['Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po']));
const drawsNothing = inRanges(drawsNothingRanges);
const marks = inRanges(markRanges);

/** What the app does to a name before it looks anything up: NFKD, then no marks, blanks or spaces. */
function reduce(text) {
  return [...text.normalize('NFKD')]
    .map((c) => c.codePointAt(0))
    .filter((cp) => !drawsNothing.has(cp) && !marks.has(cp) && !/\s/u.test(String.fromCodePoint(cp)));
}

// --- Scripts (Script_Extensions, falling back to Script) -----------------------------------------

const shortScript = new Map(
  readData('PropertyValueAliases.txt')
    .filter((row) => row[0] === 'sc')
    .flatMap((row) => row.slice(1).map((alias) => [alias, row[1]])),
);
const scriptOf = new Map();
for (const [field, script] of readData('Scripts.txt')) {
  const [start, end] = parseRange(field);
  const short = shortScript.get(script);
  if (!short) throw new Error(`Scripts.txt names an unknown script: ${script}`);
  for (let cp = start; cp <= end; cp++) scriptOf.set(cp, short);
}
for (const [field, scripts] of readData('ScriptExtensions.txt')) {
  const [start, end] = parseRange(field);
  const set = scripts.split(/\s+/).sort().join(' ');
  for (let cp = start; cp <= end; cp++) scriptOf.set(cp, set);
}
const scriptSets = [...new Set(scriptOf.values())].sort();
const scriptSetIndex = new Map(scriptSets.map((set, i) => [set, i]));
const scriptRanges = [];
for (const cp of [...scriptOf.keys()].sort((a, b) => a - b)) {
  const index = scriptSetIndex.get(scriptOf.get(cp));
  const last = scriptRanges[scriptRanges.length - 1];
  if (last && last[1] === cp - 1 && last[2] === index) last[1] = cp;
  else scriptRanges.push([cp, cp, index]);
}
function encodeScriptRanges() {
  let next = 0;
  return scriptRanges
    .map(([start, end, index]) => {
      const token = `${(start - next).toString(36)}.${(end - start + 1).toString(36)}.${index.toString(36)}`;
      next = end + 1;
      return token;
    })
    .join(',');
}

// --- Confusables, without case -------------------------------------------------------------------
//
// UTS #39 maps each character to a prototype, case-sensitively. Names here compare without case,
// so a name's reading is: its prototype, lowercased, mapped again, until nothing changes. That
// keeps "I" (prototype "l") apart from "i", and folds "М" (prototype "M") through "m" to "rn".
// Small capitals have no lowercase partner, so each is mapped to its letter, and so is the
// prototype it shares with other alphabets (ᴋ, κ and к read as ĸ, which reads as k).

const confusables = readData('confusables.txt').map(([source, target]) => ({
  source: hex(source),
  target: target.split(/\s+/).map(hex),
}));

/** Code points the app can meet after `reduce`: only these get entries. */
const isLookupKey = (cp) => reduce(String.fromCodePoint(cp)).join() === String(cp);

const prototypeOf = new Map();
for (const { source, target } of confusables) {
  if (isLookupKey(source)) prototypeOf.set(source, reduce(String.fromCodePoint(...target)));
}
for (const [first, ...rest] of EXTRA_SAME) for (const cp of rest) prototypeOf.set(cp, [first]);

// confusables.txt maps some Latin capitals with a stroke, hook or descender to the plain letter
// plus a combining mark (Ꝁ → K + U+0335) but leaves their small forms out (ꝁ). Marks are dropped
// from a reading, so K̵ reads as k; the small form is the same letter with the same mark, so it
// reads as the small plain letter. Only Latin: other scripts are caught as mixed alphabets.
const unicodeData = readData('UnicodeData.txt');
const confusableTarget = new Map(confusables.map(({ source, target }) => [source, target]));
const isAsciiLetter = (cp) => /^[A-Za-z]$/.test(String.fromCodePoint(cp));
for (const [code, , category, , , , , , , , , , upper] of unicodeData) {
  const cp = hex(code);
  if (category !== 'Ll' || !upper || confusableTarget.has(cp) || scriptOf.get(cp) !== 'Latn' || !isLookupKey(cp)) continue;
  const target = confusableTarget.get(hex(upper));
  if (!target || target.length < 2 || !isAsciiLetter(target[0]) || !target.slice(1).every((part) => marks.has(part))) continue;
  prototypeOf.set(cp, [String.fromCodePoint(target[0]).toLowerCase().codePointAt(0)]);
}

const smallCapitals = unicodeData
  .map(([code, name]) => [hex(code), /^LATIN LETTER SMALL CAPITAL ([A-Z])$/.exec(name)?.[1]])
  .filter(([, letter]) => letter);
for (const [cp, letter] of smallCapitals) {
  const latin = [letter.toLowerCase().codePointAt(0)];
  const shared = prototypeOf.get(cp);
  // A prototype that is ASCII already reads as a letter of its own; leave its group alone.
  if (shared?.length === 1 && shared[0] >= 0x80) prototypeOf.set(shared[0], latin);
  prototypeOf.set(cp, latin);
}

const MAX_ROUNDS = 8;
/** One code point's reading: prototype, then lowercase, repeated until it settles. */
function readingOf(cp) {
  let current = [cp];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const next = current.flatMap((part) => prototypeOf.get(part) ?? [part]).flatMap((part) => reduce(String.fromCodePoint(part).toLowerCase()));
    if (next.join() === current.join()) return current;
    current = next;
  }
  throw new Error(`U+${cp.toString(16)} does not settle in ${MAX_ROUNDS} rounds`);
}

/**
 * Every code point the app can meet whose reading is not simply its lowercase; the app lowercases
 * the rest itself.
 */
const entries = [];
for (const cp of [...scriptOf.keys()].sort((a, b) => a - b)) {
  if (!isLookupKey(cp)) continue;
  const reading = readingOf(cp);
  const lower = reduce(String.fromCodePoint(cp).toLowerCase());
  if (reading.join() !== lower.join()) entries.push([cp, reading]);
}
function encodeConfusables() {
  let previous = 0;
  return entries
    .map(([cp, out]) => {
      const token = `${(cp - previous).toString(36)}.${out.map((part) => part.toString(36)).join(':')}`;
      previous = cp;
      return token;
    })
    .join(',');
}

// --- Output ---------------------------------------------------------------------------------------

const LICENCE = `Generated by scripts/gen-unicode-tables.mjs from Unicode ${UNICODE_VERSION} data (confusables.txt,
 * DerivedCoreProperties.txt, DerivedGeneralCategory.txt, Scripts.txt, ScriptExtensions.txt,
 * PropertyValueAliases.txt, UnicodeData.txt). Do not edit; run the script again.
 *
 * Unicode data: Copyright © 1991-2024 Unicode, Inc. Distributed under the Unicode License v3,
 * https://www.unicode.org/license.txt.`;

const splitLines = (text) => (text.match(/.{1,100}/g) ?? ['']).map((line) => `  '${line}'`).join(' +\n');

writeFileSync(
  TABLES_OUT,
  `/**
 * ${LICENCE}
 *
 * Every table is a string, decoded once by unicodeNames.ts. Numbers are base 36. Ranges are
 * "gap.length" tokens, each gap counted from the end of the previous range.
 */

export const UNICODE_VERSION = '${UNICODE_VERSION}';

/** Default_Ignorable_Code_Point, general categories Cf and Cc, and ${EXTRA_DRAWS_NOTHING.length} blanks: characters that draw nothing. */
export const DRAWS_NOTHING_RANGES =
${splitLines(encodeRanges(drawsNothingRanges))};

/** Nonspacing and enclosing marks (Mn, Me), removed from a name's skeleton. */
export const MARK_RANGES =
${splitLines(encodeRanges(markRanges))};

/** Punctuation (general categories Pc, Pd, Ps, Pe, Pi, Pf, Po), left out of a name's reading. */
export const PUNCTUATION_RANGES =
${splitLines(encodeRanges(punctuationRanges))};

/** Script_Extensions sets (short script codes, space-separated), indexed by SCRIPT_RANGES. */
export const SCRIPT_SETS: readonly string[] = ${JSON.stringify(scriptSets)};

/** "gap.length.set" tokens: each range's index into SCRIPT_SETS. Unlisted code points are Unknown. */
export const SCRIPT_RANGES =
${splitLines(encodeScriptRanges())};

/**
 * Confusables, read without case: "delta.cp:cp" tokens, the code point (counted from the previous
 * entry's) and what it reads as. Code points without an entry read as their lowercase.
 */
export const CONFUSABLE_ENTRIES =
${splitLines(encodeConfusables())};
`,
);

// An even spread of confusables.txt pairs whose source the app can meet, for the tests.
const testable = confusables.filter(({ source }) => isLookupKey(source) && reduce(String.fromCodePoint(source)).length > 0);
const stride = Math.max(1, Math.floor(testable.length / SAMPLE_SIZE));
const sample = testable.filter((_, i) => i % stride === 0).map(({ source, target }) => [source, target]);
writeFileSync(
  SAMPLE_OUT,
  `/**
 * ${LICENCE}
 *
 * Every ${stride}th pair of confusables.txt whose source can appear in a name: [source, target code points].
 */
export const CONFUSABLE_SAMPLE: readonly (readonly [number, readonly number[]])[] = ${JSON.stringify(sample)};
`,
);

console.log(
  `Unicode ${UNICODE_VERSION}: ${entries.length} confusable entries, ` +
    `${drawsNothingRanges.length} draws-nothing ranges, ${markRanges.length} mark ranges, ${punctuationRanges.length} punctuation ranges, ` +
    `${scriptRanges.length} script ranges ` +
    `in ${scriptSets.length} sets; ${sample.length} sample pairs.`,
);
