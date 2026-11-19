const DESKTOP_ENTRY_GROUP = 'Desktop Entry';

/** Key/value pairs of the [Desktop Entry] group, values with string escapes (\s \n \t \r \\) decoded. */
export function parseDesktopEntry(content: string): Map<string, string> {
  const fields = new Map<string, string>();
  let inEntry = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inEntry = line === `[${DESKTOP_ENTRY_GROUP}]`;
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!fields.has(key)) fields.set(key, decodeValueEscapes(line.slice(eq + 1).trim()));
  }
  return fields;
}

function decodeValueEscapes(value: string): string {
  return value.replace(/\\([sntr\\;])/g, (match, ch: string) => {
    switch (ch) {
      case 's': return ' ';
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '\\': return '\\';
      default: return match; // "\;" stays escaped for list splitting
    }
  });
}

/** Splits a `;`-separated list value, honouring "\;" escapes. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/(?<!\\);/)
    .map((part) => part.replace(/\\;/g, ';').trim())
    .filter(Boolean);
}

/** Localised value: Key[ll_CC], then Key[ll], then Key. `locale` is e.g. "de_DE.UTF-8". */
export function localized(fields: Map<string, string>, key: string, locale: string | undefined): string | undefined {
  const match = /^([a-z]{2,3})(_[A-Z]{2})?/.exec(locale ?? '');
  if (match) {
    const [, lang, country] = match;
    const candidates = country ? [`${key}[${lang}${country}]`, `${key}[${lang}]`] : [`${key}[${lang}]`];
    for (const candidate of candidates) {
      const value = fields.get(candidate);
      if (value) return value;
    }
  }
  return fields.get(key);
}

/**
 * Splits an Exec value into argv per the Desktop Entry spec: whitespace separates arguments,
 * double quotes group, and inside quotes \" \` \$ \\ are escapes. Single quotes are accepted
 * leniently as grouping because many real files use them.
 */
export function tokenizeExec(exec: string): string[] {
  const args: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < exec.length; i++) {
    const ch = exec[i]!;
    if (quote === '"') {
      if (ch === '\\' && i + 1 < exec.length && '"`$\\'.includes(exec[i + 1]!)) {
        current += exec[++i];
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
    } else if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === ' ' || ch === '\t') {
      if (hasToken) args.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

const FILE_FIELD_CODES = new Set(['%f', '%F', '%u', '%U']);

/**
 * Expands Exec field codes. Every code is dropped except the file/url codes when `file` is given,
 * which become that path. "%%" becomes "%". If a file is given but Exec has no file code, it is appended.
 */
export function expandExecArgs(args: readonly string[], file?: string): string[] {
  const out: string[] = [];
  let usedFile = false;
  for (const arg of args) {
    if (FILE_FIELD_CODES.has(arg)) {
      if (file !== undefined && !usedFile) {
        out.push(file);
        usedFile = true;
      }
      continue;
    }
    const expanded = arg.replace(/%(.)/g, (_match, code: string) => {
      if (code === '%') return '%';
      if (file !== undefined && !usedFile && 'fFuU'.includes(code)) {
        usedFile = true;
        return file;
      }
      return '';
    });
    if (expanded !== '' || !/%./.test(arg)) out.push(expanded);
  }
  if (file !== undefined && !usedFile) out.push(file);
  return out;
}

/** Quotes one argument for an Exec line (used for the autostart file). */
export function quoteExecArg(arg: string): string {
  if (/^[A-Za-z0-9_@+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/[\\"`$]/g, (ch) => `\\${ch}`).replace(/%/g, '%%')}"`;
}

/** Encodes a value for a .desktop file line (escapes backslashes and newlines). */
export function encodeDesktopValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}
