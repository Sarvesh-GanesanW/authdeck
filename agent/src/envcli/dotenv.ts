/**
 * Reading and writing `.env` files: what `push` and `init --from` read, and what `pull` writes.
 *
 * Reading follows the common dotenv dialect, without variable expansion (a `$` is kept as is):
 * - blank lines and lines starting with `#` are skipped; `export ` before a name is allowed;
 * - `NAME=value`, with spaces allowed around `=`;
 * - unquoted values are trimmed and end at ` #` (a `#` after whitespace starts a comment, so
 *   `A=#x` is "#x" but `A= # note` is empty);
 * - 'single' and `backtick` quotes are literal; "double" quotes understand \n \r \t \\ \" \' \$ \`
 *   (the last two as a shell reads them) and keep any other backslash as it is; all three may span
 *   several lines;
 * - after a closing quote only whitespace or a comment may follow;
 * - a name given twice keeps its last value, in the place it first appeared (as shells and
 *   dotenv loaders do).
 * Writing picks the plainest form that reads back to the same value with this reader and stays
 * data when a shell sources the file (`set -a; . ./.env`): a member chooses the values, so no value
 * may become a command.
 */
import { ENV_NAME_PATTERN, type EnvPlainValue } from '../envcore/types';

/** Why a .env file can't be read. `line` is 1-based; `name` is never part of a value. */
export type DotenvProblem =
  | { kind: 'bad-name'; line: number; name: string }
  | { kind: 'unclosed-quote'; line: number; name: string; quote: string }
  | { kind: 'after-quote'; line: number; name: string };

export type DotenvRead = { ok: true; values: EnvPlainValue[] } | { ok: false; problem: DotenvProblem };

/** Shown in place of a name when a line has no `=`: the line itself may be a pasted secret. */
export const NO_EQUALS_NAME = 'a line without "="';
/** Longest name echoed back in a bad-name error. */
const SHOWN_NAME_CHARS = 64;
const EXPORT_PREFIX = /^export\s+/;
const QUOTES = new Set(['"', "'", '`']);
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'", $: '$', '`': '`' };
/** Values made only of these characters are written without quotes. */
const BARE_VALUE = /^[A-Za-z0-9_./:@%+,=-]+$/;

export function parseDotenv(text: string): DotenvRead {
  const lines = text.replace(/^﻿/, '').split('\n').map((line) => line.replace(/\r$/, ''));
  const byName = new Map<string, string>();
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const trimmed = lines[index]!.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // Only the start: a quoted value may end its first line in spaces that belong to it.
    const assignment = lines[index]!.trimStart().replace(EXPORT_PREFIX, '');
    const equals = assignment.indexOf('=');
    if (equals < 0) return { ok: false, problem: { kind: 'bad-name', line: lineNumber, name: NO_EQUALS_NAME } };
    const name = assignment.slice(0, equals).trim();
    if (!ENV_NAME_PATTERN.test(name)) return { ok: false, problem: { kind: 'bad-name', line: lineNumber, name: name.slice(0, SHOWN_NAME_CHARS) } };
    const afterEquals = assignment.slice(equals + 1);
    const rest = afterEquals.trimStart();
    const quote = rest[0];
    if (quote === undefined || !QUOTES.has(quote)) {
      byName.set(name, bareValue(afterEquals));
      continue;
    }
    const quoted = readQuoted(quote, rest.slice(1), lines, index);
    if (!quoted) return { ok: false, problem: { kind: 'unclosed-quote', line: lineNumber, name, quote } };
    if (!isOnlyComment(quoted.after)) return { ok: false, problem: { kind: 'after-quote', line: quoted.endLine + 1, name } };
    byName.set(name, quoted.value);
    index = quoted.endLine;
  }
  return { ok: true, values: [...byName].map(([name, value]) => ({ name, value })) };
}

/** `A=#x` keeps "#x"; `A= # note` and `A=x # note` drop the comment. */
function bareValue(afterEquals: string): string {
  const comment = afterEquals.search(/\s#/);
  return (comment < 0 ? afterEquals : afterEquals.slice(0, comment)).trim();
}

function isOnlyComment(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/**
 * Reads a quoted value that starts at `start` (just past the opening quote) on line `startLine`,
 * continuing onto later lines until the closing quote. Null when it never closes.
 */
function readQuoted(quote: string, start: string, lines: string[], startLine: number): { value: string; after: string; endLine: number } | null {
  let value = '';
  let text = start;
  for (let line = startLine; line < lines.length; line++) {
    if (line > startLine) {
      value += '\n';
      text = lines[line]!;
    }
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (char === quote) return { value, after: text.slice(i + 1), endLine: line };
      if (quote === '"' && char === '\\' && i + 1 < text.length) {
        const next = text[++i]!;
        value += DOUBLE_QUOTE_ESCAPES[next] ?? `\\${next}`;
        continue;
      }
      value += char;
    }
  }
  return null;
}

/**
 * Single quotes are literal to shells and every dotenv reader alike, and hold line breaks. Not for
 * a ' (it would end them) or a carriage return before a line break (readers drop it as a CRLF end).
 */
const NEEDS_DOUBLE_QUOTES = /'|\r\n/;
/** What a shell reads specially inside double quotes, so a double-quoted value escapes it. */
const SHELL_SPECIAL_IN_DOUBLE_QUOTES = /[$`\\]/;

/**
 * One `NAME=value` line (or several, for a value with line breaks) that parseDotenv reads back
 * exactly and a shell reads as data. In double quotes every character a shell treats specially is
 * escaped; line breaks stay as they are, so shells read them too.
 */
export function formatDotenvLine({ name, value }: EnvPlainValue): string {
  if (value === '' || BARE_VALUE.test(value)) return `${name}=${value}`;
  if (!NEEDS_DOUBLE_QUOTES.test(value)) return `${name}='${value}'`;
  const escaped = value.replace(/[\\"$`]/g, (char) => `\\${char}`).replace(/\r(?=\n)/g, '\\r');
  return `${name}="${escaped}"`;
}

/**
 * Why a value can't go in a .env that every reader takes the same way, or null when it can. Such a
 * value needs double quotes and holds a character a shell reads specially there: escaped, it is
 * safe for shells and this reader, but common dotenv loaders keep the backslashes, so the value
 * would differ between programs.
 */
export function unportableDotenvValue(value: string): string | null {
  // A shell keeps the escaped \r as a backslash and an r, so the value would differ there.
  if (value.includes('\r\n')) return 'it has a carriage return before a line break';
  if (!NEEDS_DOUBLE_QUOTES.test(value) || !SHELL_SPECIAL_IN_DOUBLE_QUOTES.test(value)) return null;
  return "it has a ' together with $, ` or \\";
}

/** A whole .env file: an optional comment header, then one variable per line. */
export function formatDotenv(values: EnvPlainValue[], header: string[] = []): string {
  const lines = [...header.map((line) => `# ${line}`), ...values.map(formatDotenvLine)];
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
