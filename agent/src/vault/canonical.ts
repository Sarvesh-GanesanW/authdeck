/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, integers only, and
 * strings in printable ASCII (everything else as a lower-case \\u escape). Hashes and signatures
 * are taken over this form, so every device must produce the same bytes for the same value; the
 * escaping keeps engines that treat lone surrogates differently (Hermes, Node) byte-identical.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Writes `value` canonically. Throws on floats, unsafe integers, undefined and other non-JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error(`Canonical JSON allows only safe integers, not ${String(value)}.`);
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return quote(value);
    case 'object': {
      if (Array.isArray(value)) {
        let out = '[';
        for (let i = 0; i < value.length; i++) out += (i === 0 ? '' : ',') + canonicalJson(value[i]);
        return `${out}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      let out = '{';
      for (let i = 0; i < keys.length; i++) out += `${i === 0 ? '' : ','}${quote(keys[i]!)}:${canonicalJson(record[keys[i]!])}`;
      return `${out}}`;
    }
    default:
      throw new Error(`Canonical JSON cannot hold a ${typeof value}.`);
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const FIRST_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7e;

// Printable ASCII other than the quote and backslash needs no escaping.
const PLAIN = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

function quote(text: string): string {
  if (PLAIN.test(text)) return `"${text}"`;
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === QUOTE) out += '\\"';
    else if (code === BACKSLASH) out += '\\\\';
    else if (code >= FIRST_PRINTABLE && code <= LAST_PRINTABLE) out += text[i];
    else out += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `${out}"`;
}

