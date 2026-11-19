/**
 * A variable typed or pasted on the phone: the checks the variable sheet shows, and "Paste lines
 * from a .env". Pure. The env core checks the same caps again when it seals.
 */
import { ENV_LIMITS, ENV_NAME_PATTERN, envFileProblemWords } from '../../envcore/types';
import { utf8Encode } from '../../vault/bytes';

const NAME_HINT = envFileProblemWords({ kind: 'bad-name', line: 1, name: '' }, { file: '', set: '', where: 'phone' }).hint;
const EXPORT_PREFIX = /^export\s+/;
/** An unquoted value ends at " #": the rest is a comment, as dotenv loaders read it. */
const TRAILING_COMMENT = /\s+#.*$/;

/** Plain-sentence problems with a name and value; empty when both are fine. */
export function checkVariable(name: string, value: string): string[] {
  const problems: string[] = [];
  if (!name) problems.push('Give the variable a name.');
  else if (!ENV_NAME_PATTERN.test(name)) problems.push(`${name} can't be a variable name. ${NAME_HINT}`);
  if (utf8Encode(value).length > ENV_LIMITS.valueBytes) problems.push(`The value is larger than ${ENV_LIMITS.valueBytes / 1024} KB.`);
  return problems;
}

/** A value as written after `=`: quotes removed ("\n" becomes a line break inside double quotes). */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === '"' ? inner.replace(/\\n/g, '\n') : inner;
  }
  return trimmed.replace(TRAILING_COMMENT, '');
}

/**
 * Reads NAME=value lines, skipping blanks and comments. A line without `=`, a bad name or a value
 * over the cap is left out with a sentence; a name given twice keeps the later line. Never throws.
 */
export function parseDotenv(text: string): { values: { name: string; value: string }[]; problems: string[] } {
  const values: { name: string; value: string }[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const body = line.trim().replace(EXPORT_PREFIX, '');
    if (!body || body.startsWith('#')) return;
    const eq = body.indexOf('=');
    if (eq <= 0) {
      problems.push(`Line ${lineNumber} has no NAME=value, so it was left out.`);
      return;
    }
    const name = body.slice(0, eq).trim();
    const value = unquote(body.slice(eq + 1));
    if (!ENV_NAME_PATTERN.test(name)) {
      problems.push(`Line ${lineNumber}: ${name} can't be a variable name, so it was left out.`);
      return;
    }
    if (utf8Encode(value).length > ENV_LIMITS.valueBytes) {
      problems.push(`Line ${lineNumber}: ${name} is larger than ${ENV_LIMITS.valueBytes / 1024} KB, so it was left out.`);
      return;
    }
    const earlier = values.findIndex((v) => v.name === name);
    if (earlier >= 0) {
      problems.push(`${name} appears twice; the later line (${lineNumber}) is used.`);
      values.splice(earlier, 1);
    }
    values.push({ name, value });
  });
  if (values.length > ENV_LIMITS.names) problems.push(`A set holds at most ${ENV_LIMITS.names} variables; only the first ${ENV_LIMITS.names} were kept.`);
  return { values: values.slice(0, ENV_LIMITS.names), problems };
}
